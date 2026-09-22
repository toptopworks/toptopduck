//! Per-turn skill resolution for prompt injection + provenance (issue #364,
//! ADR-0086; disclosure levels per ADR-0110, issue #700; invocation
//! semantics per ADR-0119).
//!
//! The discovery snapshot and the invocation records are the two inputs:
//! at turn assembly time the engine resolves each snapshot name against
//! the registry root to produce a [`SkillPromptFragment`] carrying (a) the
//! frontmatter `description` that rides the built-in prompt's metadata
//! index (L1 -- the snapshot lists every enabled name uniformly), (b) the
//! Markdown body that enters the context at the name's invocation (L2 --
//! a turn-scoped single expansion pinned to the invocation-time bytes;
//! verbatim except over [`SKILL_BODY_MAX_BYTES`]), and (c) the SHA-256 of
//! the WHOLE `SKILL.md` bytes that anchors
//! the drift check. A name that left the registry (or whose `SKILL.md` is
//! unreadable) degrades honestly -- empty description, empty body, empty
//! hash, a warn log -- so the turn still proceeds. Provenance follows the
//! invocation records (issues #700/#702, recalibrated by ADR-0119): every
//! turn records exactly the names invoked on it -- user picks at submit,
//! agent calls mid-turn -- with each name's hash pinned at its last
//! invocation of the turn; the empty-hash record is the "gone" signal.

use std::path::Path;

use super::frontmatter::split_frontmatter;
use super::model::is_valid_skill_name;
use crate::util::sha256_hex;

/// The one file the registry reads / writes per skill directory (mirrors
/// [`super::registry::SKILL_MD`]; kept private here to avoid a cross-module
/// `pub(crate)` leak).
const SKILL_MD: &str = "SKILL.md";

/// The byte cap for an injected skill body (issue #1019; extended to the
/// delegation channel by issue #1025): unlike the 1 MiB `read_skill_file`
/// cap (ADR-0111 Decision 6 -- an agent-initiated read that can be
/// REFUSED), both injection channels inject UNCONDITIONALLY into context
/// (the activation channel at invocation, the delegation channel into the
/// sub-agent's preamble), so the cap sits at the largest body a context
/// survives whole -- one shared constant so the two channels cannot
/// disagree on the defense. Over the cap the body truncates -- never
/// refuses (ADR-0110: a degraded skill never silently disappears) -- on a
/// char boundary, with an explicit self-heal marker the model can relay.
/// Body caliber only: the activation-side hash below still covers the
/// WHOLE file, so the drift anchor stays exact.
pub(crate) const SKILL_BODY_MAX_BYTES: usize = 100 * 1024;

/// One named skill resolved for prompt injection or invocation (issue #364,
/// ADR-0086; calibrated by ADR-0119). Carries the spec `name` (stable
/// identity), the Markdown
/// body (frontmatter stripped -- the prompt fragment; verbatim except over
/// [`SKILL_BODY_MAX_BYTES`]), and the SHA-256 of the
/// WHOLE `SKILL.md` bytes (frontmatter + body) at the resolve site's pin
/// time.
///
/// The hash is the stale-degrade anchor: on resume the engine recomputes the
/// skill's current hash and compares (ADR-0086 Decision 2). An empty hash means
/// no baseline -- either a v3->v4 migration product or a skill whose
/// `SKILL.md` was unreadable at turn time -- and never trips the check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPromptFragment {
    /// The skill's spec `name` (kebab-case identity, ADR-0086 Decision 2).
    pub name: String,
    /// The frontmatter `description`, verbatim (ADR-0110 Decision 1: mounting
    /// injects metadata only -- this is the discovery-index entry's payload).
    /// Empty when the `SKILL.md` degraded below the key (unreadable, broken
    /// fence, malformed YAML, the key absent/wrong-typed, or a non-spec
    /// name that never reaches the filesystem) -- the index entry stays
    /// with an empty description so the skill never silently disappears
    /// from the discoverable set.
    pub description: String,
    /// The Markdown body after the frontmatter -- verbatim, the prompt fragment
    /// injected on activation (ADR-0110 Decision 2), except over
    /// [`SKILL_BODY_MAX_BYTES`]: an oversized body rides char-boundary-
    /// truncated with an explicit marker (issue #1019) while the hash below
    /// still covers the whole file. Empty when the `SKILL.md`
    /// was unreadable at turn time, or the name failed the spec check so the
    /// file was never read (honest degrade -- nothing to inject).
    pub body: String,
    /// SHA-256 hex of the WHOLE `SKILL.md` bytes (frontmatter + body),
    /// pinned at the fragment's read time -- assembly for the system-prompt
    /// injection, the invocation's pin time on the invocation channel
    /// (ADR-0119). Empty string when no baseline exists (unreadable at
    /// read time); a live v4 turn otherwise records the real digest.
    pub content_hash: String,
}

/// Resolve the mounted-skill names into prompt fragments for both the system
/// prompt injection and the turn's skill provenance (issue #364). `mounted` is
/// the session's mounted set in first-mount insertion order; the returned
/// fragments preserve that order so the assembled prompt reads deterministically.
///
/// Each name resolves through the shadowing order (ADR-0121 Decision 5): a
/// directory at `<root>/<name>` wins, the reserved-subtree copy
/// `<root>/.system/<name>` is the fallback, so a mounted builtin serves from
/// the reserved subtree and a shadowing fork serves its own body. A name
/// that is not spec-shaped (the mount API does not validate, so a direct
/// IPC could land a non-spec name) is treated as unreadable -- it never
/// reaches the filesystem (the join stays traversal-safe). A spec-shaped
/// name that no longer resolves on disk (deleted after mounting -- neither
/// arm of the shadowing order exists) or whose `SKILL.md` is unreadable
/// (permissions, IO error) degrades honestly: empty description + empty
/// body + empty hash + a warn log. The body, when readable, is split out of the frontmatter verbatim --
/// a malformed YAML mapping still yields its body (the fence split is
/// structural, not semantic), so an externally corrupted skill keeps injecting
/// its prose until the user repairs or unmounts it; only its description
/// degrades to empty in that case.
pub fn resolve_prompt_fragments(root: &Path, mounted: &[String]) -> Vec<SkillPromptFragment> {
    mounted.iter().map(|name| resolve_one(root, name)).collect()
}

/// Resolve one named skill into its fragment, or an empty-body / empty-hash
/// fragment on any failure (honest degrade). Serves both callers -- the
/// snapshot's index resolution and the invocation channel's record
/// materialization. Kept separate so the per-skill failure mode is explicit
/// and the `?` operator stays out of the map closure (a single unreadable
/// skill never fails the whole turn).
/// The degrade shape shared by every failure arm of [`resolve_one`]: the
/// skill keeps its name in the disclosure while contributing no body.
fn empty_fragment(name: &str) -> SkillPromptFragment {
    SkillPromptFragment {
        name: name.to_string(),
        description: String::new(),
        body: String::new(),
        content_hash: String::new(),
    }
}

/// The injection channel a capped body rides (issue #1025): the truncation
/// core below is shared, only the honest-degrade tail is face-specific --
/// the activation channel anchors a whole-file hash and gates
/// `read_skill_file` on the invoked set (a truncated skill is in it by
/// definition -- its invocation record has landed, though a mid-turn
/// invocation joins the turn-start snapshot the next turn), while the
/// delegation channel has neither: the bound skill is typically NOT in
/// the main turn's invoked set, so a read-back referral would be a dead
/// end and the user-relay remedy is the only honest one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InjectionFace {
    /// The activation channel (`resolve_one`): tool result + turn preamble.
    Activation,
    /// The delegation channel (`DelegationSpec::from_entry`): the
    /// sub-agent's preamble.
    Delegation,
}

/// Cap an injected body at [`SKILL_BODY_MAX_BYTES`] (issue #1019; extended
/// to the delegation channel by issue #1025): step back to a char boundary,
/// then append the honest-degrade marker on its own line. Single seam per
/// channel, every face -- the capped activation body rides the tool result
/// and the turn preamble through the same fragment (`from_fragment` pins it
/// into the invocation record so historical replays render the truncated
/// state), while the capped delegation body rides the sub-agent's preamble
/// through `DelegationSpec::skill_injections`.
pub(crate) fn cap_body(name: &str, body: String, face: InjectionFace) -> String {
    if body.len() <= SKILL_BODY_MAX_BYTES {
        return body;
    }
    let actual = body.len();
    // The cap position may fall inside a multi-byte code point -- step back
    // to the boundary before it so no character is split.
    let mut end = SKILL_BODY_MAX_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let (warn_note, remedy) = match face {
        InjectionFace::Activation => (
            "the hash still covers the whole file",
            "Ask the user to shrink or split `SKILL.md`, or read the whole \
             file via `read_skill_file` (it serves up to 1 MiB).",
        ),
        InjectionFace::Delegation => (
            "the sub-agent has no reliable read-back path",
            "Ask the user to shrink or split `SKILL.md` to load it whole.",
        ),
    };
    log::warn!(
        target: "skills",
        "skill `{name}` body is {actual} bytes, over the {SKILL_BODY_MAX_BYTES}-byte \
         injection cap -- truncating ({warn_note}; shrink or split `SKILL.md` \
         to serve the body whole)",
    );
    let mut capped = body[..end].trim_end().to_string();
    capped.push_str(&format!(
        "\n\n[Truncated: this skill's body is {actual} bytes, over the \
         {SKILL_BODY_MAX_BYTES}-byte injection cap. Only the leading part was \
         loaded. {remedy}]\n"
    ));
    capped
}

pub(crate) fn resolve_one(root: &Path, name: &str) -> SkillPromptFragment {
    // Defense in depth: the mount API does not validate names, so a non-spec
    // name could reach here via direct IPC. Refuse to join it onto the root --
    // `is_valid_skill_name` is the directory-name rule (kebab-case), which
    // also keeps the join traversal-safe.
    if !is_valid_skill_name(name) {
        log::warn!(
            target: "skills",
            "skill `{name}` is not a spec-shaped name -- \
             injecting no body, recording empty hash",
        );
        return empty_fragment(name);
    }
    let path = match crate::skills::builtin::resolve_skill_dir(root, name) {
        Some(dir) => dir.join(SKILL_MD),
        None => {
            log::warn!(
                target: "skills",
                "skill `{name}` has no registry directory at resolve time \
                 -- injecting no body, recording empty hash",
            );
            return empty_fragment(name);
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!(
                target: "skills",
                "skill `{name}` is unreadable at resolve time \
                 (`{}`: {e}) -- injecting no body, recording empty hash",
                path.display(),
            );
            return empty_fragment(name);
        }
    };
    // SHA-256 of the WHOLE file bytes (frontmatter + body + trailing newline)
    // -- ADR-0086 Decision 2. Shared via crate::util::sha256_hex (review I3).
    let content_hash = sha256_hex(&bytes);
    // The body is the Markdown after the frontmatter fence. The split is
    // structural (fence lines), not semantic (YAML parse), so a body is still
    // recoverable when an externally edited frontmatter is malformed YAML --
    // the user's prompt fragment stays live until they repair or unmount.
    // ONE YAML parse feeds the description: a malformed YAML logs a single
    // degrade line and contributes no metadata, but the body is still
    // injected. The decode rides the shared non-UTF-8 observability warn
    // (`decode_skill_md_lossy`, issue #1025) so the resolve face and the
    // registry's assemble face cannot drift apart.
    let raw = super::decode_skill_md_lossy(&bytes, name);
    let (description, body) = match split_frontmatter(&raw) {
        Ok((yaml, body)) => match serde_yaml::from_str::<serde_yaml::Value>(&yaml) {
            Ok(serde_yaml::Value::Mapping(mapping)) => {
                // An ABSENT description degrades silently by design: the
                // index entry stays renderable with an empty description
                // (ADR-0110 -- a skill never silently disappears from the
                // discoverable set). A PRESENT-but-wrong-typed one is the
                // same corruption class as the unparseable-YAML arm below
                // and logs the same way (review B, issue #707).
                let description = match mapping.get(serde_yaml::Value::String("description".into()))
                {
                    Some(serde_yaml::Value::String(s)) => s.clone(),
                    Some(_) => {
                        log::warn!(
                            target: "skills",
                            "skill `{name}` has a wrong-typed `description` -- \
                             the index entry degrades to an empty description",
                        );
                        String::new()
                    }
                    None => String::new(),
                };
                (description, body)
            }
            _ => {
                log::warn!(
                    target: "skills",
                    "skill `{name}` has unparseable frontmatter YAML -- \
                     the description contributes nothing (the body is still injected)",
                );
                (String::new(), body)
            }
        },
        Err(reason) => {
            log::warn!(
                target: "skills",
                "skill `{name}` has a malformed SKILL.md fence ({reason}) \
                 -- injecting no body, recording hash only",
            );
            (String::new(), String::new())
        }
    };
    SkillPromptFragment {
        name: name.to_string(),
        description,
        body: cap_body(name, body, InjectionFace::Activation),
        content_hash,
    }
}

impl crate::model::SkillInvocation {
    /// Pin the fragment -> record mapping shared by both invocation
    /// producers (#987 C): the name, body, and `content_hash` all come
    /// from the SAME `resolve_one` fragment, so no call site can pair a
    /// name with a foreign drift anchor. Note the one-arm exception to
    /// empty-implies-empty: the unreadable-file degrade records both
    /// empty, while a readable-but-malformed fence records the REAL hash
    /// over an empty body (resolve_one's "recording hash only" arm --
    /// the activation-side semantics, preserved as-is).
    pub(crate) fn from_fragment(
        fragment: &SkillPromptFragment,
        actor: crate::model::SkillLifecycleActor,
    ) -> Self {
        Self {
            name: fragment.name.clone(),
            body: fragment.body.clone(),
            actor,
            content_hash: fragment.content_hash.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write one skill directory with a `---`-fenced SKILL.md (frontmatter +
    /// body). `body` is inserted verbatim between the closing fence and EOF.
    fn put_skill(root: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(root.join(name)).unwrap();
        let content = format!("---\nname: {name}\ndescription: Test skill {name}.\n---\n{body}");
        std::fs::write(root.join(name).join(SKILL_MD), content).unwrap();
    }

    /// The builtin posture's on-disk shape (ADR-0121): a spec-valid skill
    /// tree living ONLY under the reserved subtree, nothing at the registry
    /// root -- so a resolver must take the shadowing order's fallback arm
    /// to serve it at all.
    fn put_system_skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(".system").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let content = format!("---\nname: {name}\ndescription: Test skill {name}.\n---\n{body}");
        std::fs::write(dir.join(SKILL_MD), content).unwrap();
    }

    /// A skill present only under the reserved subtree serves its body and
    /// its real hash -- the production default posture for a builtin. A
    /// resolver that joins `root/<name>` directly finds nothing and
    /// silently degrades to the empty fragment (the review-pass wiring
    /// mutant).
    #[test]
    fn a_builtin_tree_under_the_reserved_subtree_serves_its_body() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_system_skill(root, "pandoc", "Embedded body.\n");
        let fragments = resolve_prompt_fragments(root, &["pandoc".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].name, "pandoc");
        assert_eq!(fragments[0].body, "Embedded body.\n");
        let raw = std::fs::read(root.join(".system").join("pandoc").join(SKILL_MD)).unwrap();
        assert_eq!(fragments[0].content_hash, sha256_hex(&raw));
    }

    /// Under shadowing (ADR-0121 Decision 5) a local directory owning the
    /// name wins: the fragment carries the fork's body, not the reserved
    /// subtree's.
    #[test]
    fn a_shadowing_fork_wins_over_the_reserved_subtree_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_system_skill(root, "pandoc", "Embedded body.\n");
        put_skill(root, "pandoc", "Fork body.\n");
        let fragments = resolve_prompt_fragments(root, &["pandoc".to_string()]);
        assert_eq!(fragments[0].body, "Fork body.\n");
    }

    #[test]
    fn empty_mounted_yields_empty_fragments() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_prompt_fragments(tmp.path(), &[]).is_empty());
    }

    #[test]
    fn fragment_carries_body_and_whole_file_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "sql-coach", "Always name the method you used.\n");

        let fragments = resolve_prompt_fragments(root, &["sql-coach".to_string()]);
        assert_eq!(fragments.len(), 1);
        let f = &fragments[0];
        assert_eq!(f.name, "sql-coach");
        // The helper writes `description: Test skill sql-coach.` -- the
        // frontmatter description rides the fragment verbatim (ADR-0110).
        assert_eq!(f.description, "Test skill sql-coach.");
        assert_eq!(f.body, "Always name the method you used.\n");
        // The hash is the SHA-256 of the WHOLE file (frontmatter + body),
        // recomputed here from the bytes actually on disk.
        let raw = std::fs::read(root.join("sql-coach").join(SKILL_MD)).unwrap();
        assert_eq!(f.content_hash, sha256_hex(&raw));
        assert!(!f.content_hash.is_empty());
    }

    #[test]
    fn description_degrades_to_empty_when_the_key_is_absent() {
        // ADR-0110: the discovery-index entry must stay renderable -- a
        // missing (or wrong-typed) `description` key degrades to an empty
        // string, never dropping the skill from the discoverable set.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("no-desc")).unwrap();
        std::fs::write(
            root.join("no-desc").join(SKILL_MD),
            "---\nname: no-desc\n---\nBody without a description.\n",
        )
        .unwrap();
        let fragments = resolve_prompt_fragments(root, &["no-desc".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].description, "");
        assert_eq!(fragments[0].body, "Body without a description.\n");
    }

    #[test]
    fn malformed_yaml_yields_empty_description_but_keeps_body() {
        // The fence split is structural: a malformed YAML mapping still
        // yields the body, but the description (a semantic read) degrades
        // to empty alongside the extension keys.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("bad-yaml")).unwrap();
        std::fs::write(
            root.join("bad-yaml").join(SKILL_MD),
            "---\nname: bad-yaml\ndescription: [unclosed\n---\nBody survives.\n",
        )
        .unwrap();
        let fragments = resolve_prompt_fragments(root, &["bad-yaml".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].description, "");
        assert_eq!(fragments[0].body, "Body survives.\n");
    }

    #[test]
    fn wrong_typed_description_key_degrades_to_empty_but_keeps_body() {
        // The ladder's wrong-typed rung: the YAML parses into a mapping but
        // `description` is a sequence, so the semantic read (`get_string`'s
        // `as_str`) yields None and the description degrades to empty --
        // distinct from the malformed-YAML arm above, which never parses.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("seq-desc")).unwrap();
        std::fs::write(
            root.join("seq-desc").join(SKILL_MD),
            "---\nname: seq-desc\ndescription: [a, b]\n---\nBody survives.\n",
        )
        .unwrap();
        let fragments = resolve_prompt_fragments(root, &["seq-desc".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].description, "");
        assert_eq!(fragments[0].body, "Body survives.\n");
    }

    #[test]
    fn fragments_preserve_mount_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "alpha", "Body A.\n");
        put_skill(root, "beta", "Body B.\n");
        let mounted = vec!["beta".to_string(), "alpha".to_string()];
        let fragments = resolve_prompt_fragments(root, &mounted);
        assert_eq!(
            fragments
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["beta", "alpha"],
            "mount order must be preserved, not sorted",
        );
        assert_eq!(fragments[0].body, "Body B.\n");
        assert_eq!(fragments[1].body, "Body A.\n");
    }

    #[test]
    fn missing_skill_degrades_to_empty_body_and_hash() {
        let tmp = tempfile::tempdir().unwrap();
        // `ghost` is mounted but its directory is gone (deleted after mounting).
        let fragments = resolve_prompt_fragments(tmp.path(), &["ghost".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].name, "ghost");
        assert!(
            fragments[0].description.is_empty(),
            "missing skill yields no description"
        );
        assert!(
            fragments[0].body.is_empty(),
            "missing skill injects no body"
        );
        assert!(
            fragments[0].content_hash.is_empty(),
            "missing skill records no baseline hash"
        );
    }

    #[test]
    fn non_spec_name_never_reaches_filesystem() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A traversal-shaped name reaching the assembly via a hand-edited
        // recipe.
        // The resolver must refuse to join it onto the root.
        std::fs::create_dir_all(root.join("escape")).unwrap();
        std::fs::write(root.join("escape").join("SKILL.md"), "secret").unwrap();
        let fragments = resolve_prompt_fragments(root, &["../escape".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert!(fragments[0].body.is_empty());
        assert!(fragments[0].content_hash.is_empty());
    }

    #[test]
    fn malformed_fence_yields_empty_body_but_keeps_hash() {
        // A SKILL.md whose fence is structurally broken (no closing `---`)
        // still hashes the whole file (the hash is over raw bytes) but injects
        // no body -- split_frontmatter cannot find the body boundary.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("broken")).unwrap();
        let raw = "---\nname: broken\ndescription: d\nno closing fence\n";
        std::fs::write(root.join("broken").join(SKILL_MD), raw).unwrap();
        let fragments = resolve_prompt_fragments(root, &["broken".to_string()]);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].name, "broken");
        assert!(
            fragments[0].description.is_empty(),
            "a broken fence yields no description"
        );
        assert!(
            fragments[0].body.is_empty(),
            "unparseable body is not injected"
        );
        assert_eq!(fragments[0].content_hash, sha256_hex(raw.as_bytes()));
    }

    /// A body over the injection cap truncates -- never refuses (ADR-0110: a
    /// degraded skill never silently disappears) -- with an explicit
    /// self-heal marker the model can relay, while the drift anchor still
    /// hashes the WHOLE file (issue #1019).
    #[test]
    fn over_cap_body_truncates_with_marker_and_keeps_whole_file_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let body = format!("{}\n", "x".repeat(SKILL_BODY_MAX_BYTES + 4096));
        put_skill(root, "huge", &body);
        let fragments = resolve_prompt_fragments(root, &["huge".to_string()]);
        let f = &fragments[0];
        // The index row is untouched -- only the body degrades.
        assert_eq!(f.description, "Test skill huge.");
        // The marker closes the body on its own line, naming the cap...
        assert!(
            f.body.ends_with("]\n"),
            "the truncated body ends with the marker"
        );
        assert!(
            f.body.contains(&format!("{SKILL_BODY_MAX_BYTES}-byte")),
            "the marker names the cap for the model to relay"
        );
        // The marker also reports the actual size and both self-heal paths:
        // the user-relay remedy and the model's own full-read channel
        // (ADR-0111 Decision 3 gates `read_skill_file` on the activated
        // set -- a truncated skill is by definition in it once its
        // invocation record lands in the turn-start snapshot).
        assert!(
            f.body.contains(&format!("is {} bytes", body.len())),
            "the marker reports the actual size"
        );
        assert!(
            f.body.contains("shrink or split"),
            "the marker keeps the user-relay remedy"
        );
        assert!(
            f.body.contains("read_skill_file"),
            "the marker names the model's own full-read channel"
        );
        assert!(
            f.body.contains("Only the leading part was loaded"),
            "the marker states the partial load"
        );
        assert!(
            f.body.contains("(it serves up to 1 MiB)"),
            "the marker keeps the read-back channel's size"
        );
        // ...and the run of x's was cut at the cap.
        assert!(
            !f.body.contains(&"x".repeat(SKILL_BODY_MAX_BYTES + 1)),
            "no over-cap run survived into the injection"
        );
        assert!(
            f.body.len() < SKILL_BODY_MAX_BYTES + 512,
            "the capped body stays near the cap"
        );
        // The hash still covers the whole file (ADR-0086 Decision 2 unchanged).
        let raw = std::fs::read(root.join("huge").join(SKILL_MD)).unwrap();
        assert_eq!(f.content_hash, sha256_hex(&raw));
        // The capped state pins into the invocation record and renders in
        // the turn preamble -- the replay face shows the truncation too
        // (the `cap_body` doc's both-faces claim).
        let record = crate::model::SkillInvocation::from_fragment(
            f,
            crate::model::SkillLifecycleActor::User,
        );
        let preamble = crate::provider::prompt::render_invocation_preamble(&[record]);
        assert!(preamble.contains("[Truncated"));
        assert!(!preamble.contains(&"x".repeat(SKILL_BODY_MAX_BYTES + 1)));
    }

    /// A SKILL.md holding non-UTF-8 bytes still serves its body lossy
    /// (U+FFFD stand-ins) while the hash anchors the ORIGINAL bytes -- the
    /// divergence the resolve-time warn makes observable (issue #1025).
    /// Pins the lossy posture so the warn's arrival cannot regress the
    /// load itself.
    #[test]
    fn non_utf8_body_serves_lossy_with_whole_file_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join("mixed-encoding");
        std::fs::create_dir_all(&dir).unwrap();
        // A lone 0xFF byte is invalid in every UTF-8 stride.
        let raw: &[u8] = b"---\nname: mixed-encoding\ndescription: Test skill mixed-encoding.\n---\nBody with \xFF bytes.\n";
        std::fs::write(dir.join(SKILL_MD), raw).unwrap();
        let fragments = resolve_prompt_fragments(root, &["mixed-encoding".to_string()]);
        assert_eq!(fragments.len(), 1);
        let f = &fragments[0];
        assert!(
            f.body.contains('\u{FFFD}'),
            "the invalid byte renders as the replacement char"
        );
        assert!(
            f.body.contains("Body with "),
            "the valid prefix rides verbatim"
        );
        assert_eq!(f.content_hash, sha256_hex(raw));
    }

    /// A cut point landing inside a whitespace run hands the marker a clean
    /// attachment: `trim_end` strips the dangling whitespace so the marker
    /// follows the last non-blank byte. The x-run and CJK fixtures never
    /// cut on whitespace, so this fixture is the only one that can tell a
    /// dropped `trim_end` from the real shape.
    #[test]
    fn cut_point_on_a_whitespace_run_trims_to_the_last_content_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // x*(cap-10), then a whitespace run the cut lands inside, then
        // trailing content pushing the file over the cap.
        let body = format!(
            "{}{}{}",
            "x".repeat(SKILL_BODY_MAX_BYTES - 10),
            " \t\n \t\n".repeat(8),
            "y".repeat(64),
        );
        put_skill(root, "padcut", &body);
        let fragments = resolve_prompt_fragments(root, &["padcut".to_string()]);
        assert!(
            fragments[0].body.contains(&format!(
                "{}\n\n[Truncated",
                "x".repeat(SKILL_BODY_MAX_BYTES - 10)
            )),
            "the marker attaches right after the last non-blank byte"
        );
    }

    /// A cap position falling INSIDE a multi-byte code point steps back to
    /// the boundary before it -- the truncation never splits a character.
    #[test]
    fn truncation_steps_back_to_a_char_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // cap-1 ASCII bytes then CJK (3 bytes/char): byte #cap falls inside
        // the first CJK char, so the cut must step back to `cap-1`.
        let body = format!("{}{}", "a".repeat(SKILL_BODY_MAX_BYTES - 1), "你好世界");
        put_skill(root, "wide", &body);
        let fragments = resolve_prompt_fragments(root, &["wide".to_string()]);
        let capped = &fragments[0].body;
        assert_eq!(
            capped.chars().take_while(|c| *c == 'a').count(),
            SKILL_BODY_MAX_BYTES - 1,
            "the cut steps back to the char boundary"
        );
        // The char after the ASCII run is the marker's leading newline, not
        // a split code point.
        assert_eq!(capped.chars().nth(SKILL_BODY_MAX_BYTES - 1), Some('\n'));
    }

    /// The cap truncates only strictly over-cap bodies: at exactly the cap
    /// the body rides verbatim with no marker -- the `<=` boundary pin
    /// (twin of the `read_skill_file` cap's exactly-cap test).
    #[test]
    fn exactly_cap_body_serves_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let body = "y".repeat(SKILL_BODY_MAX_BYTES);
        put_skill(root, "exact", &body);
        let fragments = resolve_prompt_fragments(root, &["exact".to_string()]);
        assert_eq!(fragments[0].body, body);
    }

    #[test]
    fn hash_is_sha256_of_whole_file_not_body_only() {
        // Two skills whose BODIES are identical but whose frontmatter differs
        // must produce DIFFERENT hashes (the hash is over the whole file,
        // ADR-0086 Decision 2 -- any frontmatter edit flips it).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let body = "Shared body.\n";
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(
            root.join("a").join(SKILL_MD),
            format!("---\nname: a\ndescription: one.\n---\n{body}"),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(
            root.join("b").join(SKILL_MD),
            format!("---\nname: b\ndescription: two.\n---\n{body}"),
        )
        .unwrap();
        let fragments = resolve_prompt_fragments(root, &["a".to_string(), "b".to_string()]);
        assert_ne!(
            fragments[0].content_hash, fragments[1].content_hash,
            "frontmatter difference must flip the whole-file hash",
        );
        assert_eq!(fragments[0].body, fragments[1].body);
    }
}
