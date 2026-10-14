//! The static context-window catalog (issue #1290, calibrating ADR-0130
//! Decision 4): the occupancy ring's denominator source for channels that
//! report no window of their own.
//!
//! The pre-#1290 design made an explicit per-profile config field the
//! only denominator source -- a field that never shipped an editor, so the
//! built-in runtime and the windowless CLI channels (claude-code / codex
//! probes carry no window field, verified field-by-field in ADR-0130) sat
//! on hollow rings forever. The calibration replaces the config source
//! with this catalog: keyed on the model actually serving the turn
//! (built-in: the profile's model; claude stream-json: the `SystemInit`
//! frame's model; codex: the session model), stamped at the collection
//! point so numerator and denominator carry the same moment. A miss is the
//! hollow ring -- the honest degrade, never a guessed window.
//!
//! The table rides releases and follows models.dev values (the same source
//! `output_cap`'s low-cap catalog cites); new families join by adding rows
//! (purely additive). The rejected alternatives -- a per-profile manual
//! field, a user-triggered catalog refresh, an externalized user-editable
//! table -- are recorded in ADR-0130's Considered section.

use super::output_cap::hits_family;

/// The static context-window catalog (issue #1290): `model family prefix ->
/// context window in tokens`. Longest prefix wins, the same
/// [`hits_family`] boundary the output-cap catalog applies -- a prefix
/// matches its bare id and hyphenated variants, while dotted next
/// generations (`glm-4.5` inside `glm-4`, `gpt-4.1` inside `gpt-4`) are
/// their own models and carry their own rows. Prefixes are stored
/// lowercase; the lookup normalizes the model name (the audit holds both
/// invariants). Scope: the families the `Protocol` docs name as the
/// compatible surface (OpenAI direct / DeepSeek / GLM / Qwen / Ollama),
/// the two CLI runtimes' model families (Anthropic / OpenAI), and the
/// further families user-configurable endpoints commonly serve
/// (llama / mistral / kimi / minimax / gemini / grok).
///
/// Values follow models.dev at family granularity: each row carries its
/// generation's standard window, and dated / suffixed variants ride their
/// family row; marketing-alias variants that ship a smaller window
/// (OpenAI's `-chat-latest` / `-spark` lines) are NOT chased -- the family
/// value stands. Generation rows that RAISED the window inside a
/// hyphenated family (claude 4-6+ inside `claude-opus-4`, mistral
/// `large-4` inside `mistral-large`) carry their own rows so the longest
/// prefix can outrank the parent's older window. Dated variants that
/// LOWERED the window carry their own rows on the same terms
/// (`mistral-large-2411` at 131_072 under the 262_144 family row).
/// Refresh the rows as
/// families ship.
const CONTEXT_WINDOW_PREFIXES: &[(&str, u64)] = &[
    // anthropic -- 4.5 and earlier document 200K; every line from 4.6 on
    // ships 1M (the bare `claude` row is the current-generation floor)
    ("claude", 1_000_000),
    ("claude-3", 200_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4-6", 1_000_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4", 200_000),
    // openai -- the 5.4+ / 6 lines at 1.05M, the 5 / 5.1 / 5.2 family at
    // 400K, the o-series at 200K
    ("gpt-6", 1_050_000),
    ("gpt-5.6", 1_050_000),
    ("gpt-5.5", 1_050_000),
    ("gpt-5.4", 1_050_000),
    ("gpt-daybreak-blue", 1_050_000),
    ("gpt-daybreak-red", 400_000),
    ("gpt-5.3", 400_000),
    ("gpt-5.2", 400_000),
    ("gpt-5.1", 400_000),
    ("gpt-5", 400_000),
    ("gpt-4.1", 1_047_576),
    ("gpt-4.5", 128_000),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("gpt-4", 8_192),
    ("gpt-3.5-turbo", 16_385),
    ("o1", 200_000),
    ("o3", 200_000),
    ("o4", 200_000),
    // deepseek -- the v4 generation at 1M; the v3 era at 131K
    ("deepseek-v4", 1_000_000),
    ("deepseek-flash", 1_000_000),
    ("deepseek-v3.2", 131_072),
    ("deepseek-v3", 131_072),
    ("deepseek-chat", 128_000),
    ("deepseek-reasoner", 128_000),
    ("deepseek-v2", 128_000),
    ("deepseek-coder", 128_000),
    // glm -- 5.2/5.3 at 1M; 4.6 through 5.1 at ~200K; 4.5 at 131K
    ("glm-5.3", 1_000_000),
    ("glm-5.2", 1_000_000),
    ("glm-5.1", 204_800),
    ("glm-5", 204_800),
    ("glm-4.7", 204_800),
    ("glm-4.6", 204_800),
    ("glm-4.5", 131_072),
    ("glm-4", 128_000),
    // qwen -- the 3.6+ and api plus/flash/turbo lines at 1M; the 3.5
    // open-weights family at 262K; the 3 instruct family at 131K
    ("qwen3.8", 1_000_000),
    ("qwen3.7", 1_000_000),
    ("qwen3.6", 1_000_000),
    ("qwen3.5-flash", 1_000_000),
    ("qwen3.5-plus", 1_000_000),
    ("qwen3.5", 262_144),
    ("qwen3-coder", 262_144),
    ("qwen3-max", 262_144),
    ("qwen3", 131_072),
    ("qwen-plus", 1_000_000),
    ("qwen-flash", 1_000_000),
    ("qwen-turbo", 1_000_000),
    ("qwen-max", 131_072),
    ("qwen2.5", 131_072),
    // llama (the 3.1+ long-window lines; the 3.0 line predates them)
    ("llama-4", 128_000),
    ("llama-3.3", 128_000),
    ("llama-3.2", 128_000),
    ("llama-3.1", 128_000),
    ("llama-3", 8_192),
    // mistral -- large-4 at 1M; the current large/small/medium families
    // at 262K; nemo and the 2025-era small at 128K
    ("mistral-large-4", 1_048_576),
    ("mistral-large-2411", 131_072),
    ("mistral-large", 262_144),
    ("mistral-medium", 262_144),
    ("mistral-small-2506", 128_000),
    ("mistral-small", 262_144),
    ("mistral-nemo", 128_000),
    ("ministral-3b", 131_072),
    ("ministral-8b", 262_144),
    ("magistral-medium", 262_144),
    ("codestral", 256_000),
    // kimi (moonshot) -- the k2 lines at 262K, the k3 generation at 1M
    ("kimi-k3", 1_048_576),
    ("kimi-k2.7", 262_144),
    ("kimi-k2.6", 262_144),
    ("kimi-k2.5", 262_144),
    ("kimi-k2", 262_144),
    // minimax -- the m2 family at ~205K, the m3 generation at 1M (the
    // bare row is the family floor; reseller-trimmed windows are not
    // chased)
    ("minimax-m3", 1_000_000),
    ("minimax", 204_800),
    // gemini -- the pro / flash text lines document 1M across the 2.5
    // through current generations (the bare row is the family floor)
    ("gemini", 1_048_576),
    // grok -- the 4.20 / 4.3 generation at 1M, the 4.5+ lines at 500K
    ("grok-4.20", 1_000_000),
    ("grok-4.3", 1_000_000),
    ("grok-4.5", 500_000),
    ("grok-4.6", 500_000),
    ("grok-4.7", 500_000),
];

/// Resolve a model name against the catalog: longest matching prefix wins,
/// after lowercasing the name. `None` = no entry, the hollow ring.
pub(crate) fn context_window(model_name: &str) -> Option<u64> {
    let normalized = model_name.to_lowercase();
    CONTEXT_WINDOW_PREFIXES
        .iter()
        .filter(|(prefix, _)| hits_family(&normalized, prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, window)| *window)
}

/// Stamp the catalog's answer onto a reading as its denominator (#1290).
/// A window the channel itself reported (the ACP occupancy snapshot's
/// `size`) outranks the catalog -- the stamp only ever fills a windowless
/// reading, which is structurally the only shape it sees (the built-in and
/// CLI collection points build their snapshots windowless). `None` model
/// (the bridged face, a stream that never reported one) leaves the
/// snapshot hollow.
pub(crate) fn stamp(snapshot: &mut crate::model::OccupancySnapshot, model: Option<&str>) {
    if snapshot.limit.is_none() {
        snapshot.limit = model.and_then(context_window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window floor for the catalog audit: every entry sits at or above
    /// this, so a hand-maintained row that dropped a thousands factor (200
    /// for 200_000) reddens the audit instead of silently shrinking every
    /// ring on that family. The floor sits above every divided-by-1000
    /// landing (a 1M row lands at exactly 1_000, which an inclusive
    /// 1_000 floor passed) and at or below the table's smallest
    /// legitimate window (8_192).
    const CONTEXT_WINDOW_FLOOR: u64 = 8_000;

    /// A hit carries the family's window, dated and suffixed variants ride
    /// their base entry, and casing never matters.
    #[test]
    fn catalog_hit_pins_the_family_window() {
        assert_eq!(context_window("claude-sonnet-4-5"), Some(200_000));
        assert_eq!(context_window("claude-3-5-haiku-20241022"), Some(200_000));
        assert_eq!(context_window("gpt-4o-mini-2024-07-18"), Some(128_000));
        assert_eq!(context_window("deepseek-chat"), Some(128_000));
        assert_eq!(context_window("GLM-4.6"), Some(204_800));
        assert_eq!(context_window("Qwen2.5-72B-Instruct"), Some(131_072));
        // the current generations ride their family rows
        assert_eq!(context_window("claude-sonnet-5-5"), Some(1_000_000));
        assert_eq!(context_window("claude-opus-4-8"), Some(1_000_000));
        assert_eq!(context_window("gpt-6-sol"), Some(1_050_000));
        assert_eq!(context_window("glm-5.3"), Some(1_000_000));
        assert_eq!(context_window("deepseek-v4-pro"), Some(1_000_000));
        assert_eq!(context_window("kimi-k2.6"), Some(262_144));
        assert_eq!(context_window("grok-4.6"), Some(500_000));
        assert_eq!(context_window("MiniMax-M2.5"), Some(204_800));
        assert_eq!(context_window("gemini-3.8-flash"), Some(1_048_576));
        assert_eq!(context_window("kimi-k3"), Some(1_048_576));
    }

    /// Longest prefix wins: a dotted generation takes its own row over the
    /// parent family's, and the o-series' bare families resolve cleanly.
    #[test]
    fn longest_prefix_wins_over_the_parent_family() {
        // glm-4.6 (~200K), not glm-4 (128K)
        assert_eq!(context_window("glm-4.6-air"), Some(204_800));
        // a generation that RAISED the window inside a hyphenated family
        // outranks the parent's older row: claude-opus-4-6 (1M), not
        // claude-opus-4 (200K); mistral-large-4 (1M), not mistral-large
        // (262K)
        assert_eq!(context_window("claude-opus-4-6"), Some(1_000_000));
        assert_eq!(context_window("mistral-large-4"), Some(1_048_576));
        // gpt-4.1's own row, not gpt-4's legacy 8K
        assert_eq!(context_window("gpt-4.1-mini"), Some(1_047_576));
        // gpt-4-turbo (128K), not gpt-4 (8K)
        assert_eq!(context_window("gpt-4-turbo-2024-04-09"), Some(128_000));
        // the bare parents still hit their own rows
        assert_eq!(context_window("glm-4"), Some(128_000));
        assert_eq!(context_window("o3-mini"), Some(200_000));
    }

    /// A miss is the hollow ring -- never a guess, never a default window.
    #[test]
    fn a_miss_is_the_hollow_ring() {
        assert_eq!(context_window("some-brand-new-model"), None);
        assert_eq!(context_window(""), None);
        // an uncataloged family that shares no prefix with a cataloged one
        assert_eq!(context_window("doubao-1.5-pro"), None);
        // dotted generations miss their parent families (the shared
        // boundary rule, pinned here at this catalog's call site)
        assert_eq!(context_window("glm-4.9"), None);
        assert_eq!(context_window("gpt-4.2"), None);
    }

    /// The stamp only fills a windowless reading: a channel-reported window
    /// outranks the catalog, and a miss (or absent model) leaves it hollow.
    #[test]
    fn stamp_fills_only_windowless_readings() {
        let mut hollow = crate::model::OccupancySnapshot {
            tokens: 50,
            limit: None,
        };
        stamp(&mut hollow, Some("claude-sonnet-4-5"));
        assert_eq!(hollow.limit, Some(200_000));
        // a catalog miss stays hollow
        stamp(&mut hollow, None);
        assert_eq!(hollow.limit, Some(200_000), "the fill above stands");
        let mut uncataloged = crate::model::OccupancySnapshot {
            tokens: 50,
            limit: None,
        };
        stamp(&mut uncataloged, Some("doubao-1.5-pro"));
        assert_eq!(uncataloged.limit, None);
        // a channel-reported window is never overwritten
        let mut reported = crate::model::OccupancySnapshot {
            tokens: 50,
            limit: Some(65_536),
        };
        stamp(&mut reported, Some("claude-sonnet-4-5"));
        assert_eq!(reported.limit, Some(65_536));
    }

    /// The catalog audit (the output-cap catalog's shape rules plus the
    /// window floor): prefixes are unique, lowercase, and non-empty, and
    /// every window clears [`CONTEXT_WINDOW_FLOOR`] -- a row that dropped
    /// its thousands factor shrinks every ring on that family and must
    /// redden here, not ship.
    #[test]
    fn catalog_entries_are_unique_lowercase_and_above_the_floor() {
        for (prefix, window) in CONTEXT_WINDOW_PREFIXES {
            assert!(
                *window >= CONTEXT_WINDOW_FLOOR,
                "{prefix}: window {window} sits below the floor \
                 ({CONTEXT_WINDOW_FLOOR}) -- a dropped thousands factor?"
            );
            assert!(
                !prefix.is_empty(),
                "an empty prefix matches every model name"
            );
            assert_eq!(
                *prefix,
                prefix.to_lowercase(),
                "{prefix}: prefixes must be stored lowercase (the lookup \
                 normalizes only the model name)"
            );
        }
        let distinct: std::collections::HashSet<&str> =
            CONTEXT_WINDOW_PREFIXES.iter().map(|(p, _)| *p).collect();
        assert_eq!(
            distinct.len(),
            CONTEXT_WINDOW_PREFIXES.len(),
            "duplicate prefixes resolve by array position -- longest-prefix \
             order independence needs them unique"
        );
    }
}
