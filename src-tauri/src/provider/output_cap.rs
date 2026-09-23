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
//! [`OUTPUT_TOKEN_CAP`]. That value rides below the cataloged families'
//! current flagship ceilings -- not below every endpoint's ceiling: a miss
//! on a sub-cap family the catalog does not carry (the qwen-class 8K
//! lines) or on an aliased name of a cataloged model (a deployment id)
//! sends a value the endpoint may reject. The catalog's worst HIT failure
//! mode repeats the old bug's shape (a lower-than-necessary ceiling),
//! never a rejected request.

/// The global output-token cap (issue #1001): the assembled request's
/// model-blind default, the no-catalog fallback, and the clamp ceiling --
/// one constant for all three roles (the opencode form; separate
/// fallback/clamp constants were considered and rejected as YAGNI).
/// 32000 rides below the cataloged families' current flagship ceilings (a
/// miss on an uncataloged sub-cap family can exceed that endpoint's
/// ceiling and be rejected) while clearing the ~8KB-argument tool-call
/// shape that broke at 4096.
pub(crate) const OUTPUT_TOKEN_CAP: u32 = 32_000;

/// The static low-cap prefix catalog (issue #1001): ONLY models whose
/// documented output ceiling sits below [`OUTPUT_TOKEN_CAP`] -- a high-cap
/// entry is equivalent to the fallback, so it would be dead weight (the
/// audit test below holds the invariant). Longest prefix wins, so dated
/// variants (`claude-3-haiku-20240307`, `gpt-4o-2024-08-06`) hit their
/// base entry, and nested lines (`deepseek-v2.5` inside `deepseek-v2`)
/// resolve to their own ceiling. A prefix matches only its bare id and its
/// hyphenated variants ([`hits_family`]'s boundary): dotted next
/// generations (`glm-4.5` inside `glm-4`, `gpt-4.1` inside `gpt-4`) are
/// their own models and fall to the miss path -- a bare `starts_with`
/// would forward-capture them into the parent's retired-era ceiling.
/// Prefixes are stored lowercase; the lookup normalizes the model name
/// before matching (the audit holds that invariant too). Values follow
/// models.dev (anomalyco/models.dev).
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
    // glm line (glm-4 and its -plus/-air/-flash variants share 4096; the
    // dotted 4.5/4.6 generations are high-cap and miss to the fallback)
    ("glm-4", 4_096),
    // gpt legacy line
    ("gpt-3.5-turbo", 4_096),
    ("gpt-4", 8_192),
    ("gpt-4-turbo", 4_096),
    // also gpt-4o-mini (16384, same as the 4o base)
    ("gpt-4o", 16_384),
    // the 4.5 generation: cataloged, not left to the miss path, because
    // its 16384 ceiling sits below the cap -- a miss would send 32000 to
    // an endpoint that rejects it
    ("gpt-4.5", 16_384),
];

/// Resolve a model name against the catalog: longest matching prefix wins,
/// after lowercasing the name (catalog prefixes are stored lowercase
/// already -- the audit test holds that). `None` = no entry, fallback
/// territory.
fn catalog_output(model_name: &str) -> Option<u32> {
    let normalized = model_name.to_lowercase();
    LOW_CAP_PREFIXES
        .iter()
        .filter(|(prefix, _)| hits_family(&normalized, prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, output)| *output)
}

/// A prefix matches only its family: the bare id itself, or a hyphenated
/// variant of it. Dotted next generations (`glm-4.5` inside `glm-4`,
/// `gpt-4.1` inside `gpt-4`) are their OWN models -- a bare `starts_with`
/// would forward-capture them into the parent's retired-era ceiling
/// (reproducing the original truncation bug for current flagships), so the
/// hyphen boundary keeps dated variants and `-plus`/`-air`/`-flash`-style
/// suffixes while dotted generations fall to the miss path.
fn hits_family(normalized: &str, prefix: &str) -> bool {
    normalized.starts_with(prefix)
        && normalized
            .get(prefix.len()..)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
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
    let entry = catalog_output(model_name);
    // The under-cap observation (issue #1003): every catalog hit is
    // sub-CAP by the audit's invariant, so the hit itself is the notable
    // event (most models miss and take the fallback) -- this path was
    // zero-signal before.
    if let Some(cap) = entry.filter(|&cap| cap < OUTPUT_TOKEN_CAP) {
        log::debug!(
            "output token cap {cap} for `{model_name}` sits below the {OUTPUT_TOKEN_CAP} fallback"
        );
    }
    clamp_entry(entry)
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

    /// Dotted next generations are their own models (the hyphen boundary
    /// in the family match): they fall to the miss path, never into the
    /// parent family's retired-era ceiling -- glm-4.5 at glm-4's 4096
    /// would reproduce the original truncation bug verbatim for a current
    /// flagship. The gpt 4.5 generation is the deliberate exception:
    /// cataloged, because its 16384 ceiling sits below the cap and a miss
    /// would send 32000 to an endpoint that rejects it.
    #[test]
    fn dotted_next_generations_miss_their_parent_families() {
        assert_eq!(output_token_cap("glm-4.5"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("glm-4.6"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("glm-4.5-air"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("gpt-4.1"), OUTPUT_TOKEN_CAP);
        assert_eq!(output_token_cap("gpt-4.1-mini"), OUTPUT_TOKEN_CAP);
        // the cataloged exception, dated variants included
        assert_eq!(output_token_cap("gpt-4.5-preview"), 16_384);
        // hyphenated variants of the SAME generation stay in the family
        assert_eq!(output_token_cap("glm-4-air"), 4_096);
        assert_eq!(output_token_cap("gpt-4-0613"), 8_192);
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

    /// The audit's shape rule as a predicate, defined separately so the
    /// strictness stays OBSERVABLE: the real catalog holds no at-cap row
    /// to tell a strict comparison from a lenient one apart, and the
    /// synthetic row below exercises exactly that boundary.
    fn is_sub_cap(output: u32) -> bool {
        output < OUTPUT_TOKEN_CAP
    }

    /// The catalog audit (issue #1001's shape rules): every entry sits
    /// strictly below the global cap (a high-cap entry duplicates the
    /// fallback), every prefix is stored lowercase (an uppercase prefix
    /// could never match the lowercased lookup -- a silently dead entry),
    /// non-empty (an empty prefix matches every model name), and unique
    /// (duplicate prefixes would resolve by array position -- the one
    /// input shape that slips past longest-prefix order independence).
    #[test]
    fn catalog_entries_are_all_low_cap_and_lowercase() {
        for (prefix, output) in LOW_CAP_PREFIXES {
            assert!(
                is_sub_cap(*output),
                "{prefix}: entry {output} is not below the cap ({OUTPUT_TOKEN_CAP}) \
                 -- high-cap entries are fallback territory, drop them"
            );
            assert!(
                !prefix.is_empty(),
                "an empty prefix matches every model name, capping all traffic"
            );
            assert_eq!(
                *prefix,
                prefix.to_lowercase(),
                "{prefix}: prefixes must be stored lowercase (the lookup normalizes \
                 only the model name)"
            );
        }
        let distinct: std::collections::HashSet<&str> =
            LOW_CAP_PREFIXES.iter().map(|(prefix, _)| *prefix).collect();
        assert_eq!(
            distinct.len(),
            LOW_CAP_PREFIXES.len(),
            "duplicate prefixes resolve by array position (a max-length tie keeps \
             the last) -- order independence needs them unique"
        );
        // The strictness boundary on a synthetic row the all-sub-cap
        // catalog cannot carry: at-cap must not count as low-cap, or the
        // comparison has drifted lenient.
        assert!(
            !is_sub_cap(OUTPUT_TOKEN_CAP),
            "an at-cap entry is fallback territory, not sub-cap"
        );
    }
}
