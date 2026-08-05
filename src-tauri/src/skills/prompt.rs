//! Per-turn skill resolution for prompt injection + provenance (issue #364,
//! ADR-0086).
//!
//! The mounted-skills set lives on the session timeline; at turn assembly time
//! the engine resolves each mounted name against the registry root to produce a
//! [`SkillPromptFragment`] carrying (a) the verbatim Markdown body that rides
//! the system prompt and (b) the SHA-256 of the WHOLE `SKILL.md` bytes that
//! anchors resume's stale-degrade check. A skill that left the registry (or
//! whose `SKILL.md` is unreadable) degrades honestly -- empty body, empty hash,
//! a warn log -- so the turn still proceeds and the provenance records the name
//! for resume's "gone" signal.

use std::path::Path;

use super::frontmatter::split_frontmatter;
use super::model::is_valid_skill_name;
use crate::util::sha256_hex;

/// The one file the registry reads / writes per skill directory (mirrors
/// [`super::registry::SKILL_MD`]; kept private here to avoid a cross-module
/// `pub(crate)` leak).
const SKILL_MD: &str = "SKILL.md";

/// One mounted skill resolved for prompt injection + provenance (issue #364,
/// ADR-0086). Carries the spec `name` (stable identity), the verbatim Markdown
/// body (frontmatter stripped -- the prompt fragment), and the SHA-256 of the
/// WHOLE `SKILL.md` bytes (frontmatter + body) at the turn's assembly time.
///
/// The hash is the stale-degrade anchor: on resume the engine recomputes the
/// skill's current hash and compares (ADR-0086 Decision 2). An empty hash means
/// no baseline -- either a v3->v4 migration product or a skill whose
/// `SKILL.md` was unreadable at turn time -- and never trips the check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPromptFragment {
    /// The skill's spec `name` (kebab-case identity, ADR-0086 Decision 2).
    pub name: String,
    /// The Markdown body after the frontmatter -- verbatim, the prompt fragment
    /// injected on mount. Empty when the `SKILL.md` was unreadable at turn time
    /// (honest degrade -- nothing to inject).
    pub body: String,
    /// SHA-256 hex of the WHOLE `SKILL.md` bytes (frontmatter + body) at the
    /// turn's assembly time. Empty string when no baseline exists (unreadable
    /// at turn time); a live v4 turn otherwise records the real digest.
    pub content_hash: String,
}

/// Resolve the mounted-skill names into prompt fragments for both the system
/// prompt injection and the turn's skill provenance (issue #364). `mounted` is
/// the session's mounted set in first-mount insertion order; the returned
/// fragments preserve that order so the assembled prompt reads deterministically.
///
/// Each name resolves against `<root>/<name>/SKILL.md`. A name that is not
/// spec-shaped (the mount API does not validate, so a direct IPC could land a
/// non-spec name) is treated as unreadable -- it never reaches the filesystem
/// (the join stays traversal-safe). A spec-shaped name whose `SKILL.md` is
/// missing or unreadable (deleted after mounting, permissions, IO error)
/// degrades honestly: empty body + empty hash + a warn log. The body, when
/// readable, is split out of the frontmatter verbatim -- a malformed YAML
/// mapping still yields its body (the fence split is structural, not semantic),
/// so an externally corrupted skill keeps injecting its prose until the user
/// repairs or unmounts it.
pub fn resolve_prompt_fragments(root: &Path, mounted: &[String]) -> Vec<SkillPromptFragment> {
    mounted.iter().map(|name| resolve_one(root, name)).collect()
}

/// Resolve one mounted skill into its fragment, or an empty-body / empty-hash
/// fragment on any failure (honest degrade). Kept separate so the per-skill
/// failure mode is explicit and the `?` operator stays out of the map closure
/// (a single unreadable skill never fails the whole turn).
fn resolve_one(root: &Path, name: &str) -> SkillPromptFragment {
    // Defense in depth: the mount API does not validate names, so a non-spec
    // name could reach here via direct IPC. Refuse to join it onto the root --
    // `is_valid_skill_name` is the directory-name rule (kebab-case), which
    // also keeps the join traversal-safe.
    if !is_valid_skill_name(name) {
        log::warn!(
            target: "skills",
            "mounted skill `{name}` is not a spec-shaped name -- \
             injecting no body, recording empty hash",
        );
        return SkillPromptFragment {
            name: name.to_string(),
            body: String::new(),
            content_hash: String::new(),
        };
    }
    let path = root.join(name).join(SKILL_MD);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!(
                target: "skills",
                "mounted skill `{name}` is unreadable at turn time \
                 (`{}`: {e}) -- injecting no body, recording empty hash",
                path.display(),
            );
            return SkillPromptFragment {
                name: name.to_string(),
                body: String::new(),
                content_hash: String::new(),
            };
        }
    };
    // SHA-256 of the WHOLE file bytes (frontmatter + body + trailing newline)
    // -- ADR-0086 Decision 2. Shared via crate::util::sha256_hex (review I3).
    let content_hash = sha256_hex(&bytes);
    // The body is the Markdown after the frontmatter fence. The split is
    // structural (fence lines), not semantic (YAML parse), so a body is still
    // recoverable when an externally edited frontmatter is malformed YAML --
    // the user's prompt fragment stays live until they repair or unmount.
    let raw = String::from_utf8_lossy(&bytes);
    let body = match split_frontmatter(&raw) {
        Ok((_, body)) => body,
        Err(reason) => {
            log::warn!(
                target: "skills",
                "mounted skill `{name}` has a malformed SKILL.md fence ({reason}) \
                 -- injecting no body, recording hash only",
            );
            String::new()
        }
    };
    SkillPromptFragment {
        name: name.to_string(),
        body,
        content_hash,
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
        assert_eq!(f.body, "Always name the method you used.\n");
        // The hash is the SHA-256 of the WHOLE file (frontmatter + body),
        // recomputed here from the bytes actually on disk.
        let raw = std::fs::read(root.join("sql-coach").join(SKILL_MD)).unwrap();
        assert_eq!(f.content_hash, sha256_hex(&raw));
        assert!(!f.content_hash.is_empty());
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
        // A traversal-shaped name landing in mounted_skills via direct IPC.
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
            fragments[0].body.is_empty(),
            "unparseable body is not injected"
        );
        assert_eq!(fragments[0].content_hash, sha256_hex(raw.as_bytes()));
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
