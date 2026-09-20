//! The turn output-token cap (issue #1001): the single formula that sizes
//! every built-in turn's reply budget --
//! `min(catalog[model].output ?? OUTPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP)`.
//!
//! The retired `MAX_REPLY_TOKENS = 4096` (and the bridge face's matching
//! `DEFAULT_MAX_TOKENS`) was a claude-3-haiku-era ceiling that
//! deterministically truncated long tool-call arguments: a multi-KB `python`
//! code payload plus the round's reasoning exhausted the budget mid-JSON,
//! and the upstream parse error read as an opaque execution failure that
//! every retry reproduced (the cap is a constraint on generation, and
//! regeneration writes the same long code). The replacement follows the
//! opencode shape -- one global constant as both the no-catalog fallback
//! and the clamp, never a user-facing setting.
//!
//! Failure direction is deliberately asymmetric: a catalog hit can only
//! UNDER-cap (a stale entry names a ceiling at or below what the endpoint
//! accepts today), while a miss or a clamped entry still lands on
//! [`OUTPUT_TOKEN_CAP`] -- the value modern endpoints accept by default --
//! so the catalog's worst failure mode repeats the old bug's shape (a
//! lower-than-necessary ceiling), never a request the endpoint rejects.

/// The global output-token cap (issue #1001): the assembled request's
/// model-blind default, the no-catalog fallback, and the clamp ceiling --
/// one constant for all three roles (the opencode form; separate
/// fallback/clamp constants were considered and rejected as YAGNI).
/// 32000 rides below every modern endpoint's output ceiling while clearing
/// the ~8KB-argument tool-call shape that broke at 4096.
pub(crate) const OUTPUT_TOKEN_CAP: u32 = 32_000;

/// The static low-cap prefix catalog (issue #1001): ONLY models whose
/// documented output ceiling sits below [`OUTPUT_TOKEN_CAP`] -- a high-cap
/// entry is equivalent to the fallback, so it would be dead weight (the
/// audit test below holds the invariant). Longest prefix wins, so dated
/// variants (`claude-3-haiku-20240307`, `gpt-4o-2024-08-06`) hit their
/// base entry, and nested lines (`deepseek-v2.5` inside `deepseek-v2`)
/// resolve to their own ceiling. Prefixes are stored lowercase; the lookup
/// normalizes the model name before matching (the audit holds that
/// invariant too). Values follow models.dev (anomalyco/models.dev).
const LOW_CAP_PREFIXES: &[(&str, u32)] = &[
    // anthropic 3.x generation
    ("claude-3-haiku", 4_096),
    ("claude-3-opus", 4_096),
    ("claude-3-sonnet", 4_096),
    // covers both 3.5 children (sonnet + haiku; both ceiling at 8192)
    ("claude-3-5", 8_192),
    // deepseek line (reasoner-tier ids are high-cap: fallback territory)
    ("deepseek-chat", 8_192),
    ("deepseek-coder", 4_096),
    ("deepseek-v2", 4_096),
    ("deepseek-v2.5", 8_192),
    // glm line (glm-4 and its -plus/-air/-flash variants share 4096)
    ("glm-4", 4_096),
    // gpt legacy line
    ("gpt-3.5-turbo", 4_096),
    ("gpt-4", 8_192),
    ("gpt-4-turbo", 4_096),
    // also gpt-4o-mini (16384, same as the 4o base)
    ("gpt-4o", 16_384),
];

/// Resolve a model name against the catalog: longest matching prefix wins,
/// after lowercasing the name (catalog prefixes are stored lowercase
/// already -- the audit test holds that). `None` = no entry, fallback
/// territory.
fn catalog_output(model_name: &str) -> Option<u32> {
    let normalized = model_name.to_lowercase();
    LOW_CAP_PREFIXES
        .iter()
        .filter(|(prefix, _)| normalized.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, output)| *output)
}

/// Fold a catalog answer (or its absence) through the formula's
/// clamp stage: `entry ?? CAP`, then `min(_, CAP)`. The min is inert while
/// the catalog holds only sub-CAP entries (the audit's invariant) -- it
/// exists so a drifted entry can never exceed what the fallback would
/// have sent.
fn clamp_entry(entry: Option<u32>) -> u32 {
    entry.unwrap_or(OUTPUT_TOKEN_CAP).min(OUTPUT_TOKEN_CAP)
}

/// The dispatch seam's cap formula (issue #1001):
/// `min(catalog[model] ?? OUTPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP)`. Called once
/// per turn at the live factory, keyed on the same facts that built the
/// model handle (zero drift between the cap and the model actually
/// serving the turn).
pub(crate) fn output_token_cap(model_name: &str) -> u32 {
    clamp_entry(catalog_output(model_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A catalog hit carries its documented ceiling, and a dated variant
    /// resolves to its base entry through the prefix match.
    #[test]
    fn catalog_hit_pins_the_documented_ceiling() {
        assert_eq!(output_token_cap("claude-3-haiku-20240307"), 4_096);
        assert_eq!(output_token_cap("claude-3-opus-20240229"), 4_096);
        assert_eq!(output_token_cap("claude-3-sonnet-20240229"), 4_096);
        assert_eq!(output_token_cap("claude-3-5-sonnet-20241022"), 8_192);
        assert_eq!(output_token_cap("gpt-4o-2024-08-06"), 16_384);
    }

    /// Longest prefix wins: a nested line takes its own ceiling over its
    /// parent prefix's.
    #[test]
    fn longest_prefix_wins_over_nested_shorter_ones() {
        // deepseek-v2.5 (8192), not deepseek-v2 (4096)
        assert_eq!(output_token_cap("deepseek-v2.5-1210"), 8_192);
        // gpt-4o / gpt-4o-mini (16384), not gpt-4 (8192)
        assert_eq!(output_token_cap("gpt-4o-mini"), 16_384);
        // gpt-4-turbo (4096), not gpt-4 (8192)
        assert_eq!(output_token_cap("gpt-4-turbo-2024-04-09"), 4_096);
        // the bare parent still hits its own entry
        assert_eq!(output_token_cap("deepseek-v2"), 4_096);
        assert_eq!(output_token_cap("gpt-4"), 8_192);
    }

    /// The model name is lowercased before matching, so picker cased
    /// variants (`GPT-4o`, `Claude-3-Haiku`) resolve identically.
    #[test]
    fn matching_lowercases_the_model_name() {
        assert_eq!(output_token_cap("GPT-4o"), 16_384);
        assert_eq!(output_token_cap("Claude-3-Haiku-20240307"), 4_096);
        assert_eq!(output_token_cap("DeepSeek-Chat"), 8_192);
        assert_eq!(output_token_cap("GLM-4-Plus"), 4_096);
    }

    /// A miss falls back to the global cap -- including models whose real
    /// ceilings sit ABOVE the cap (a high-cap catalog entry is equivalent
    /// to the fallback, which is why none are listed).
    #[test]
    fn a_miss_falls_back_to_the_global_cap() {
        assert_eq!(output_token_cap("claude-opus-4-8"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("claude-3-7-sonnet"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("deepseek-reasoner"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("some-brand-new-model"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap(""), OUTPUT_TOKEN_CAP);
    }

    /// The formula's min semantics: a missing entry resolves to the cap,
    /// and an at/over-cap entry clamps down to it (the clamp is inert
    /// under the audit's sub-cap invariant -- this pin is what reddens if
    /// the `.min` is dropped).
    #[test]
    fn clamp_entry_applies_the_min_semantics() {
        assert_eq!(clamp_entry(None), OUTPUT_TOKEN_CAP);
        assert_eq!(clamp_entry(Some(4_096)), 4_096);
        assert_eq!(clamp_entry(Some(OUTPUT_TOKEN_CAP)), OUTPUT_TOKEN_CAP);
        assert_eq!(clamp_entry(Some(OUTPUT_TOKEN_CAP * 2)), OUTPUT_TOKEN_CAP);
    }

    /// The catalog audit (issue #1001's shape rules): every entry sits
    /// strictly below the global cap (a high-cap entry duplicates the
    /// fallback), and every prefix is stored lowercase (an uppercase
    /// prefix could never match the lowercased lookup -- a silently dead
    /// entry).
    #[test]
    fn catalog_entries_are_all_low_cap_and_lowercase() {
        for (prefix, output) in LOW_CAP_PREFIXES {
            assert!(
                *output < OUTPUT_TOKEN_CAP,
                "{prefix}: entry {output} is not below the cap ({OUTPUT_TOKEN_CAP}) \
                 -- high-cap entries are fallback territory, drop them"
            );
            assert_eq!(
                *prefix,
                prefix.to_lowercase(),
                "{prefix}: prefixes must be stored lowercase (the lookup normalizes \
                 only the model name)"
            );
        }
    }
}
