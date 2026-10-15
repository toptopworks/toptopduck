//! Turn-input construction shared by the stream-format drivers (ADR-0094
//! Decision 3, ADR-0095, ADR-0097 Decision 1/6).
//!
//! The format-neutral half of a non-ACP turn: flattening the windowed
//! prompt blocks into the stdin text (ADR-0094 Decision 3 -- the SAME
//! windowed context the ACP path sends as blocks, joined as text; ADR-0097
//! Decision 1 keeps the claude-code feed on the identical shape) and
//! building the argv segments that carry the model / thought-level
//! selections (ADR-0095, extended by ADR-0097 Decision 6's argv-shaped
//! effort surface). The per-format drivers keep everything wire-specific
//! (parsers, frame pumps, injection flags); these two helpers are the
//! shared surface, so a feed / injection change lands in one place, not in
//! each driver.

use crate::runtime::acp::adapter::{AdapterSpec, EffortSurface};
use crate::runtime::acp::wire::ContentBlock;

// ---------------------------------------------------------------------------
// Prompt flattening (pure)
// ---------------------------------------------------------------------------

/// Flatten the windowed [`ContentBlock`] array into a single text string for
/// stdin (ADR-0094 Decision 3: the same windowed context the ACP path sends
/// as blocks, here joined as text). Non-text blocks are skipped.
pub(crate) fn flatten_prompt(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| b.as_text().map(|t| t.to_string()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------------------------------------------------------------------------
// Selection argv injection (pure)
// ---------------------------------------------------------------------------

/// Build the argv segments carrying the ADR-0095 selections: the model as
/// `[model_arg, id]`, the thought level per the adapter's ONE effort
/// surface -- `["-c", "{key}={value}"]` for [`EffortSurface::ConfigKey`]
/// (the codex `-c` surface) or `[flag, level]` for
/// [`EffortSurface::ArgvFlag`] (claude-code's `--effort`, ADR-0097
/// Decision 6). A single exhaustive match over the enum: an adapter with
/// no surface contributes no effort flag, and dual surfaces (a
/// silent-precedence hazard) are unrepresentable. Pure -- adapters
/// without the matching spec fields contribute nothing (the CLI defaults
/// rule).
pub(crate) fn build_model_flags(
    adapter: &AdapterSpec,
    model: Option<&str>,
    thought_level: Option<&str>,
) -> Vec<String> {
    let mut flags = Vec::new();
    if let (Some(flag), Some(id)) = (adapter.model_arg, model) {
        flags.push(flag.to_string());
        flags.push(id.to_string());
    }
    if let Some(level) = thought_level {
        match adapter.effort {
            Some(EffortSurface::ConfigKey(key)) => {
                flags.push("-c".to_string());
                flags.push(format!("{key}={level}"));
            }
            Some(EffortSurface::ArgvFlag(flag)) => {
                flags.push(flag.to_string());
                flags.push(level.to_string());
            }
            None => {}
        }
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- flatten_prompt -----------------------------------------------------

    #[test]
    fn flatten_prompt_joins_text_blocks() {
        let blocks = vec![ContentBlock::text("first"), ContentBlock::text("second")];
        assert_eq!(flatten_prompt(&blocks), "first\n\nsecond");
    }

    #[test]
    fn flatten_prompt_skips_non_text() {
        let blocks = vec![ContentBlock::text("visible"), ContentBlock::Other];
        assert_eq!(flatten_prompt(&blocks), "visible");
    }

    #[test]
    fn flatten_prompt_empty_blocks_produces_empty() {
        assert_eq!(flatten_prompt(&[]), "");
    }

    // --- build_model_flags (ADR-0095/0097) -----------------------------------

    fn stub_spec(model_arg: Option<&'static str>, effort: Option<EffortSurface>) -> AdapterSpec {
        AdapterSpec {
            id: crate::runtime::acp::adapter::AdapterId::new("stub"),
            display_name: "stub",
            binary_names: &["nonexistent"],
            argv: &["--json"],
            stream_format: crate::runtime::acp::adapter::StreamFormat::CodexEventStream,
            probe_argv: None,
            model_arg,
            effort,
        }
    }

    /// Both selections land: `--model <id>` + `-c key=value`.
    #[test]
    fn model_flags_carry_model_and_effort() {
        let s = stub_spec(
            Some("--model"),
            Some(EffortSurface::ConfigKey("model_reasoning_effort")),
        );
        assert_eq!(
            build_model_flags(&s, Some("gpt-5.1"), Some("high")),
            vec![
                "--model".to_string(),
                "gpt-5.1".to_string(),
                "-c".to_string(),
                "model_reasoning_effort=high".to_string(),
            ]
        );
    }

    /// No selection / no spec field -> nothing appended (CLI defaults rule).
    #[test]
    fn model_flags_empty_without_selection_or_spec_fields() {
        let s = stub_spec(
            Some("--model"),
            Some(EffortSurface::ConfigKey("model_reasoning_effort")),
        );
        assert!(build_model_flags(&s, None, None).is_empty());
        let acp_like = stub_spec(None, None);
        assert!(build_model_flags(&acp_like, Some("m"), Some("high")).is_empty());
        // Half-selected: each selection independently contributes.
        assert_eq!(
            build_model_flags(&s, None, Some("low")),
            vec!["-c".to_string(), "model_reasoning_effort=low".to_string()]
        );
    }

    /// ADR-0097 Decision 6: the argv-shaped effort surface
    /// (`EffortSurface::ArgvFlag`) appends `[flag, level]` parallel to
    /// `model_arg` -- the claude-code `--effort` injection. The surface is
    /// one enum field, so the dual-surface hazard of the old two-Option
    /// shape (both set, the `-c` arm silently winning) cannot be
    /// constructed at all.
    #[test]
    fn model_flags_carry_argv_shaped_effort() {
        let s = stub_spec(Some("--model"), Some(EffortSurface::ArgvFlag("--effort")));
        assert_eq!(
            build_model_flags(&s, Some("claude-sonnet-4"), Some("high")),
            vec![
                "--model".to_string(),
                "claude-sonnet-4".to_string(),
                "--effort".to_string(),
                "high".to_string(),
            ]
        );
        // A level without the flag spec contributes nothing.
        assert_eq!(
            build_model_flags(&stub_spec(Some("--model"), None), None, Some("high")),
            Vec::<String>::new()
        );
    }
}
