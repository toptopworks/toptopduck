//! The `read_skill_file` gateway meta-tool (ADR-0111, issue #714): the
//! restricted read surface over an ACTIVATED skill's attachment tree.
//!
//! Progressive disclosure's third layer: a skill is more than its injected
//! body, and the extra files (`references/`, `assets/`, `scripts/`, and
//! `SKILL.md` itself -- no subdirectory is privileged) become readable on
//! demand through this one channel. The app reads on the agent's behalf and
//! the agent never sees an absolute path (a revealed path is the raw material
//! of a general file-read primitive).
//!
//! The reachability boundary is the gate trilogy (ADR-0111 Decision 2): a
//! lexically-rejected request path (`..` components, absolute, Windows drive /
//! UNC) never touches the filesystem; the anchor is the canonicalized
//! registry entry root (a linked import's external directory IS the skill);
//! and the canonicalized target must sit component-level under that anchor
//! and be a regular file -- an in-tree symlink pointing outside follows to
//! its real target and is refused as out of bounds.
//!
//! Like [`crate::skills::activation`], this is a gateway-local meta call
//! served BEFORE the approval gate on both dispatch faces: reading is the
//! same risk class as the injected body (a prompt-injection surface), so
//! mounting + activation are the only trust gates (Decision 5). The
//! classification IS pure -- a read mutates nothing, so unlike activation
//! there is no transition and no persist. Failure states carry
//! self-correcting signals (ADR-0077): an unmounted name lists the mounted
//! names, a mounted-but-inactive name points at `activate_skill`, and a bad
//! path lists the skill's real readable files (Decision 4 -- discovery rides
//! the injected body, never a directory advertisement).
//!
//! Execution is text relay (Decision 7): the description teaches that a
//! script's text, once read, goes to a registered CLI tool's content
//! parameter. Nothing here executes anything.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::skills::SkillPromptFragment;

/// The `read_skill_file` tool name. Mount-conditional (ADR-0111 Decision 1):
/// only a turn whose ACTIVATED set is non-empty pays the standing tool cost
/// -- mounted-but-inactive skills have no readable files by definition.
pub(crate) const READ_SKILL_FILE: &str = "read_skill_file";

/// The byte cap for one served file (ADR-0111 Decision 6): what rides
/// directly into model context. Over the cap the read is REFUSED, not
/// truncated -- a silently truncated reference misleads; a refusal is an
/// explicit fact the agent can route around (large files go through a
/// registered CLI tool). Deliberately separate from the CLI channel's 8MB
/// output cap: each guards its own surface.
const MAX_READ_BYTES: u64 = 1024 * 1024;

/// The entry cap for the readable-files listing (ADR-0111 Decision 4): the
/// failure signal is for self-correction, not enumeration -- past the cap the
/// listing truncates with an honest count marker.
const LISTING_ENTRY_CAP: usize = 50;

/// The NUL-scan window for the binary heuristic (ADR-0111 Decision 6): a NUL
/// byte within this prefix classifies the file as binary. A NUL deeper than
/// the window is served as (lossy) text -- the heuristic is a cheap sniff,
/// not a guarantee, and there is no binary consumer to be exact for.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// What one read classifies against: the turn's mounted fragments (the
/// unmounted-name failure signal), the turn-start ACTIVATED snapshot (read
/// eligibility -- a mid-turn activation joins the NEXT turn's snapshot, the
/// no-competition-with-assembly posture of ADR-0111 Decision 3), and the
/// registry root for the live name resolution (a mid-session registry delete
/// is an honest error, never a stale turn-start snapshot).
pub(crate) struct SkillReadGate<'a> {
    /// The turn's mounted-skill fragments, in mount order (the same slice the
    /// activation channel and the prompt assembly consume).
    pub(crate) fragments: &'a [SkillPromptFragment],
    /// The turn-start activated names -- read eligibility.
    pub(crate) activated: &'a [String],
    /// The skills registry root, for the live entry lookup.
    pub(crate) root: &'a Path,
}

impl SkillReadGate<'_> {
    /// The all-empty gate for dispatch-level tests that never touch the read
    /// surface: empty sets refuse everything (the unmounted-surface
    /// posture), so a read call under it is inert by construction.
    #[cfg(test)]
    pub(crate) fn inert() -> SkillReadGate<'static> {
        SkillReadGate {
            fragments: &[],
            activated: &[],
            root: Path::new(""),
        }
    }
}

/// The resolver's outcome -- the two-variant shape of
/// [`crate::skills::activation::SkillActivationOutcome`], which is itself the
/// owning pair of [`crate::mcp::meta_tools::MetaDispatch`]'s two servable
/// arms: both dispatch faces keep their matches total with no panicking arms.
#[derive(Debug)]
pub(crate) enum SkillReadOutcome {
    /// A served read: the trace summary (skill name + path) and the
    /// model-facing payload (the file text as a PLAIN string).
    Local { summary: String, payload: Value },
    /// A refused read: the self-correcting message, served as the bare error
    /// result with no trace row.
    Refused(String),
}

/// The tool definition as advertised on both tool surfaces (the built-in
/// table and the gateway `tools/list`), attached only when the turn's
/// activated set is non-empty. English by the two-surface language split.
/// The description teaches the rules and carries the execution pointer
/// (ADR-0111 Decision 7) but never enumerates files (Decision 4).
pub(crate) fn read_skill_file_definition() -> ToolDefinition {
    ToolDefinition {
        name: READ_SKILL_FILE.to_string(),
        description: format!(
            "Read one attachment file of an ACTIVATED skill -- any file in its directory \
             tree (references/, assets/, scripts/, or SKILL.md itself; no subdirectory is \
             privileged). Paths are '/'-separated and relative to the skill's root; `..` \
             components, absolute paths, and Windows drive / UNC forms are refused. Only \
             text files up to {} MiB are served. A missing, out-of-bounds, or directory \
             path lists the skill's readable files. To execute a script, read its text \
             here and pass it to a registered CLI tool's content parameter (for example \
             python's `script`).",
            MAX_READ_BYTES / 1024 / 1024
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The activated skill's name (kebab-case), as named in \
                         the injected skill body."
                },
                "path": {
                    "type": "string",
                    "description": "The file's '/'-separated path relative to the skill's \
                         directory, e.g. references/notes.md or scripts/run.py."
                }
            },
            "required": ["name", "path"],
        }),
    }
}

/// Classify one `read_skill_file` call against the gate (ADR-0111 Decisions
/// 2-4; issue #714's locked four cases): served / name unmounted (lists every
/// mounted name) / name mounted but not activated (points at
/// `activate_skill`) / path missing, out of bounds, or a directory (lists the
/// skill's readable files). Pure -- no state changes anywhere.
pub(crate) fn resolve_skill_read(call: &ToolUse, gate: &SkillReadGate<'_>) -> SkillReadOutcome {
    let Some(name) = str_param(&call.input, "name") else {
        return SkillReadOutcome::Refused(missing_param_failure("name"));
    };
    let Some(path) = str_param(&call.input, "path") else {
        return SkillReadOutcome::Refused(missing_param_failure("path"));
    };
    if !gate.fragments.iter().any(|f| f.name == name) {
        return SkillReadOutcome::Refused(not_mounted_failure(name, gate.fragments));
    }
    if !gate.activated.iter().any(|a| a == name) {
        return SkillReadOutcome::Refused(not_activated_failure(name));
    }
    if lexical_reject(path) {
        return SkillReadOutcome::Refused(lexical_failure(path));
    }
    let Some(anchor) = canonical_anchor(gate.root, name) else {
        return SkillReadOutcome::Refused(registry_miss_failure(name));
    };
    let target = anchor.join(path.trim_end_matches(['/', '\\']));
    let Some((resolved, is_file)) = canonical_file(&target) else {
        return SkillReadOutcome::Refused(path_failure(name, path, &readable_listing(&anchor)));
    };
    if !resolved.starts_with(&anchor) || !is_file {
        return SkillReadOutcome::Refused(path_failure(name, path, &readable_listing(&anchor)));
    }
    serve_file(name, path, &resolved, &anchor)
}

/// Read and classify the resolved file's content (ADR-0111 Decision 6): the
/// byte cap refuses (never truncates), the NUL sniff refuses binary, and
/// surviving text is served lossy UTF-8. An IO failure between resolution
/// and read is the path failure (with the full skill listing) -- the file
/// that just resolved is already gone.
fn serve_file(name: &str, path: &str, resolved: &Path, anchor: &Path) -> SkillReadOutcome {
    let len = match std::fs::metadata(resolved) {
        Ok(meta) => meta.len(),
        Err(_) => {
            return SkillReadOutcome::Refused(path_failure(name, path, &readable_listing(anchor)))
        }
    };
    if len > MAX_READ_BYTES {
        return SkillReadOutcome::Refused(over_cap_failure(name, path, len));
    }
    let bytes = match std::fs::read(resolved) {
        Ok(b) => b,
        Err(_) => {
            return SkillReadOutcome::Refused(path_failure(name, path, &readable_listing(anchor)))
        }
    };
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return SkillReadOutcome::Refused(binary_failure(name, path));
    }
    SkillReadOutcome::Local {
        summary: format!("{name}: {path}"),
        payload: Value::String(String::from_utf8_lossy(&bytes).into_owned()),
    }
}

/// A non-empty string parameter, or `None` for missing / non-string / empty.
fn str_param<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The fixed malformed-input message (the `mcp_search_tools` /
/// `activate_skill` style, shared by both dispatch sites through the
/// resolver).
fn missing_param_failure(param: &str) -> String {
    format!("read_skill_file failed: parameter `{param}`: expected a non-empty string")
}

/// The unmounted-name failure (ADR-0111 Decision 4): mirror the
/// `activate_skill` shape -- every mounted name in the error so the agent can
/// retry with a real one in one hop.
fn not_mounted_failure(name: &str, fragments: &[SkillPromptFragment]) -> String {
    let mounted: Vec<&str> = fragments.iter().map(|f| f.name.as_str()).collect();
    if mounted.is_empty() {
        format!("read_skill_file: `{name}` is not mounted. No skills are mounted this turn.")
    } else {
        format!(
            "read_skill_file: `{name}` is not mounted. Mounted skills this turn: {}.",
            mounted.join(", ")
        )
    }
}

/// The mounted-but-inactive failure (Decision 3): reading rides the same gate
/// as body injection, so the fix is one `activate_skill` away.
fn not_activated_failure(name: &str) -> String {
    format!(
        "read_skill_file: `{name}` is mounted but not activated. Call `activate_skill` \
         with this name first -- only an activated skill's files are readable."
    )
}

/// The registry-miss failure: the live lookup could not canonicalize
/// `<root>/<name>` (deleted mid-session, or a non-spec name that slipped past
/// mount validation). An honest error, never a stale turn-start body.
fn registry_miss_failure(name: &str) -> String {
    format!(
        "read_skill_file: skill `{name}` is no longer readable under the registry root \
         (its directory is missing); re-import the skill to read its files."
    )
}

/// The lexical-rejection failure (Decision 2): teaches the one legal form.
fn lexical_failure(path: &str) -> String {
    format!(
        "read_skill_file: `{path}` must be a '/'-separated path relative to the skill's \
         directory: `..` components, absolute paths, and Windows drive / UNC forms are \
         refused."
    )
}

/// The path failure (Decision 4): names the three causes and lists the real
/// readable files, capped with an honest truncation marker.
fn path_failure(name: &str, path: &str, listing: &[String]) -> String {
    let files = if listing.is_empty() {
        "none found".to_string()
    } else if listing.len() > LISTING_ENTRY_CAP {
        format!(
            "{} (+{} more not listed)",
            listing[..LISTING_ENTRY_CAP].join(", "),
            listing.len() - LISTING_ENTRY_CAP
        )
    } else {
        listing.join(", ")
    };
    format!(
        "read_skill_file: `{path}` does not name a readable file in skill `{name}` \
         (missing, out of bounds, or a directory). Readable files: {files}."
    )
}

/// The binary refusal (Decision 6): structured error, no binary consumer.
fn binary_failure(name: &str, path: &str) -> String {
    format!(
        "read_skill_file: `{path}` in skill `{name}` is binary (a NUL byte within the \
         first {BINARY_SNIFF_BYTES} bytes); only text files are readable."
    )
}

/// The over-cap refusal (Decision 6): reports the real byte count and points
/// at the CLI channel.
fn over_cap_failure(name: &str, path: &str, len: u64) -> String {
    format!(
        "read_skill_file: `{path}` in skill `{name}` is {len} bytes, over the \
         {MAX_READ_BYTES}-byte read cap; process it with a registered CLI tool instead."
    )
}

/// The lexical gate (Decision 2, piece 2): pure, ahead of any filesystem
/// access. Rejects `..` on either separator form, any absolute shape
/// (leading `/`, leading `\\`, which also covers UNC), and drive-letter
/// components (`C:` / `C:\\` / `C:x` -- a colon in the second byte).
fn lexical_reject(raw: &str) -> bool {
    if raw.starts_with('/') || raw.starts_with('\\') {
        return true;
    }
    raw.split(['/', '\\'])
        .any(|comp| comp == ".." || comp.as_bytes().get(1).is_some_and(|&b| b == b':'))
}

/// The anchor (Decision 2, piece 1): the canonicalized registry entry root.
/// A linked import's symlink / junction resolves to the external directory --
/// that IS the skill body. `None` when the name is not spec-shaped (defense
/// in depth -- the mount API does not validate, mirroring
/// [`crate::skills::prompt`]) or the entry no longer resolves on disk.
fn canonical_anchor(root: &Path, name: &str) -> Option<PathBuf> {
    if !crate::skills::model::is_valid_skill_name(name) {
        return None;
    }
    std::fs::canonicalize(root.join(name)).ok()
}

/// Canonicalize a target and report whether it is a regular file: `None` when
/// it does not resolve on disk. The canonical form follows every symlink, so
/// the caller's component-level containment check judges the REAL target.
fn canonical_file(target: &Path) -> Option<(PathBuf, bool)> {
    let resolved = std::fs::canonicalize(target).ok()?;
    let is_file = std::fs::metadata(&resolved).map(|m| m.is_file()).ok()?;
    Some((resolved, is_file))
}

/// The real readable set of one skill tree (Decision 4): every file that
/// passes the gate rules -- real regular files under the anchor, plus
/// in-tree symlinks that resolve to contained regular files. An
/// out-of-bounds symlink never appears; binary and over-cap files DO (they
/// are refused at read time, not hidden from the listing). Sorted for a
/// deterministic signal. A visited-set guards in-tree link cycles (a link to
/// an ancestor would otherwise walk forever).
fn readable_listing(anchor: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited = HashSet::from([anchor.to_path_buf()]);
    walk_tree(anchor, anchor, &mut visited, &mut out);
    out.sort();
    out
}

/// One directory level of the listing walk. Recursion descends only into
/// directories known to sit under the anchor: real subdirectories (a real
/// directory cannot point elsewhere) and symlinks / junctions whose
/// canonicalized target is still contained. Everything else -- out-pointing
/// links, broken links, non-regular types -- is simply absent.
fn walk_tree(anchor: &Path, dir: &Path, visited: &mut HashSet<PathBuf>, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if ft.is_symlink() {
            let Ok(resolved) = std::fs::canonicalize(&path) else {
                continue;
            };
            if !resolved.starts_with(anchor) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&resolved) else {
                continue;
            };
            if meta.is_dir() {
                // Walk the link path (children list under the names the tree
                // shows) while the cycle guard keys on the canonical target:
                // two links to one directory double-list nothing, and a link
                // to an ancestor dies on the pre-seeded anchor.
                if visited.insert(resolved) {
                    walk_tree(anchor, &path, visited, out);
                }
            } else if meta.is_file() {
                push_relative(anchor, &path, out);
            }
        } else if ft.is_dir() {
            walk_tree(anchor, &path, visited, out);
        } else if ft.is_file() {
            push_relative(anchor, &path, out);
        }
    }
}

/// Record one listing entry as its '/'-joined path relative to the anchor
/// (the listing's addressing form matches the tool's input contract). The
/// backslash rewrite only ever fires on Windows (a Unix component may
/// literally contain one); a Unix file named `a\b` therefore lists as `a/b`
/// and cannot be read back under that name -- an accepted residual, bounded
/// by the self-correcting listing error rather than a wrong read.
fn push_relative(anchor: &Path, path: &Path, out: &mut Vec<String>) {
    if let Ok(rel) = path.strip_prefix(anchor) {
        out.push(
            rel.iter()
                .collect::<PathBuf>()
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::skills::SkillActivationFixture;

    /// The fixture every resolver test builds from: a temp registry root
    /// holding one spec-valid skill, the mounted fragments, and the activated
    /// snapshot.
    struct Fixture {
        root: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            Self { root }
        }

        fn put_skill(&self, name: &str) -> std::path::PathBuf {
            let dir = self.root.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\n---\nBody.\n"),
            )
            .unwrap();
            dir
        }

        fn put_file(&self, name: &str, rel: &str, bytes: &[u8]) {
            let path = self.root.path().join(name).join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn gate<'a>(
            &'a self,
            fragments: &'a [SkillPromptFragment],
            activated: &'a [String],
        ) -> SkillReadGate<'a> {
            SkillReadGate {
                fragments,
                activated,
                root: self.root.path(),
            }
        }
    }

    fn frag(name: &str) -> SkillPromptFragment {
        SkillActivationFixture::fragment(name, "body")
    }

    fn activated(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// One resolver call against a mounted + activated single-skill gate.
    fn resolve(fx: &Fixture, input: Value) -> SkillReadOutcome {
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input,
        };
        let fragments = vec![frag("sql-coach")];
        let activated = activated(&["sql-coach"]);
        resolve_skill_read(&call, &fx.gate(&fragments, &activated))
    }

    fn read(fx: &Fixture, path: &str) -> SkillReadOutcome {
        resolve(fx, json!({"name": "sql-coach", "path": path}))
    }

    /// A served read returns the file text verbatim, summarized by the skill
    /// name + the requested path.
    #[test]
    fn success_reads_text_file_verbatim() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file("sql-coach", "references/notes.md", b"Use CTEs.\n");
        match read(&fx, "references/notes.md") {
            SkillReadOutcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach: references/notes.md");
                assert_eq!(payload, Value::String("Use CTEs.\n".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// `SKILL.md` itself and `scripts/` are readable -- no subdirectory is
    /// privileged (ADR-0111 Decision 2).
    #[test]
    fn skill_md_and_scripts_are_readable_no_privilege_zone() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file("sql-coach", "scripts/run.py", b"print('hi')\n");
        for path in ["SKILL.md", "scripts/run.py"] {
            match read(&fx, path) {
                SkillReadOutcome::Local { .. } => {}
                other => panic!("`{path}` must be readable, got {other:?}"),
            }
        }
    }

    /// Invalid UTF-8 is served lossy, not refused (ADR-0111 Decision 6).
    #[test]
    fn invalid_utf8_is_served_lossy() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file(
            "sql-coach",
            "references/broken.md",
            &[0x61, 0xff, 0xfe, 0x62],
        );
        match read(&fx, "references/broken.md") {
            SkillReadOutcome::Local { payload, .. } => {
                let text = payload.as_str().expect("string payload");
                assert!(text.contains('\u{fffd}'), "lossy replacement: {text:?}");
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// An unmounted name is refused with EVERY mounted name in the error --
    /// the one-hop self-correction signal, mirroring `activate_skill`.
    #[test]
    fn unmounted_name_lists_every_mounted_name() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_skill("pdf-tools");
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "ghost", "path": "SKILL.md"}),
        };
        let fragments = vec![frag("sql-coach"), frag("pdf-tools")];
        let activated = activated(&["sql-coach"]);
        match resolve_skill_read(&call, &fx.gate(&fragments, &activated)) {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("ghost"), "{message}");
                assert!(message.contains("sql-coach"), "{message}");
                assert!(message.contains("pdf-tools"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// An unmounted name on an EMPTY mounted surface names the empty surface.
    #[test]
    fn unmounted_name_with_empty_mounted_set_names_the_empty_surface() {
        let fx = Fixture::new();
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "ghost", "path": "SKILL.md"}),
        };
        match resolve_skill_read(&call, &fx.gate(&[], &[])) {
            SkillReadOutcome::Refused(message) => assert_eq!(
                message,
                "read_skill_file: `ghost` is not mounted. No skills are mounted this turn."
            ),
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A mounted-but-not-activated name is refused with the pointer to
    /// `activate_skill` (read rides the activation gate, Decision 3).
    #[test]
    fn mounted_not_activated_points_to_activate_skill() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "sql-coach", "path": "SKILL.md"}),
        };
        let fragments = vec![frag("sql-coach")];
        let activated = activated(&["other-skill"]);
        match resolve_skill_read(&call, &fx.gate(&fragments, &activated)) {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("sql-coach"), "{message}");
                assert!(message.contains("activate_skill"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A malformed input (missing / non-string / empty `name` or `path`) is
    /// refused with the fixed message.
    #[test]
    fn malformed_input_is_refused_with_fixed_message() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        for input in [
            json!({}),
            json!({"name": "sql-coach"}),
            json!({"path": "SKILL.md"}),
            json!({"name": "", "path": "SKILL.md"}),
            json!({"name": "sql-coach", "path": ""}),
            json!({"name": 7, "path": "SKILL.md"}),
            Value::Null,
        ] {
            let call = ToolUse {
                id: "tu_r".to_string(),
                name: READ_SKILL_FILE.to_string(),
                input,
            };
            let fragments = vec![frag("sql-coach")];
            let activated = activated(&["sql-coach"]);
            match resolve_skill_read(&call, &fx.gate(&fragments, &activated)) {
                SkillReadOutcome::Refused(message) => {
                    let param = if message.contains("`name`") {
                        "name"
                    } else {
                        "path"
                    };
                    assert_eq!(
                        message,
                        format!(
                            "read_skill_file failed: parameter `{param}`: \
                             expected a non-empty string"
                        ),
                        "input: {}",
                        call.input
                    );
                }
                other => panic!("expected Refused, got {other:?}"),
            }
        }
    }

    /// The lexical gate (Decision 2): every escape / absolute / drive / UNC
    /// form is refused before any filesystem access, with the teaching
    /// message.
    #[test]
    fn lexical_rejections_are_refused_with_teaching_message() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        // A file literally named `x` at the root, so a `..`-free reading of
        // the same string could otherwise succeed.
        fx.put_file("sql-coach", "x", b"decoy\n");
        for path in [
            "../outside.md",
            "references/../../x",
            "/etc/passwd",
            "//server/share/x",
            "\\\\server\\share\\x",
            "\\windows\\system32\\x",
            "C:/boot.ini",
            "C:\\boot.ini",
            "c:x",
            "references\\..\\..\\x",
        ] {
            match read(&fx, path) {
                SkillReadOutcome::Refused(message) => {
                    assert!(message.contains("refused"), "`{path}`: {message}");
                    assert!(message.contains(path), "`{path}`: {message}");
                }
                other => panic!("`{path}` must be lexically refused, got {other:?}"),
            }
        }
    }

    /// A missing path, and a directory path, both produce the listing of the
    /// skill's readable files (Decision 4) -- sorted, '/'-joined.
    #[test]
    fn missing_or_directory_path_lists_readable_files() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file("sql-coach", "references/a.md", b"a\n");
        fx.put_file("sql-coach", "scripts/b.py", b"b\n");
        for path in ["references/missing.md", "references"] {
            match read(&fx, path) {
                SkillReadOutcome::Refused(message) => {
                    assert!(message.contains("Readable files:"), "`{path}`: {message}");
                    let listing = message
                        .split("Readable files: ")
                        .nth(1)
                        .expect("listing present");
                    let files: Vec<&str> = listing.trim_end_matches('.').split(", ").collect();
                    assert_eq!(
                        files,
                        vec!["SKILL.md", "references/a.md", "scripts/b.py"],
                        "`{path}`: {message}"
                    );
                }
                other => panic!("`{path}` must refuse with a listing, got {other:?}"),
            }
        }
    }

    /// An out-of-bounds link inside the tree is refused on read and absent
    /// from the listing (the security core, Decision 2). The link form is a
    /// directory symlink on Unix and a junction on Windows (`mklink /J`,
    /// no elevation) -- both resolve through canonicalize to the outside
    /// target.
    #[test]
    fn out_of_bounds_link_is_refused_and_absent_from_listing() {
        let fx = Fixture::new();
        let dir = fx.put_skill("sql-coach");
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), b"secret\n").unwrap();
        link_dir(outside.path(), &dir.join("linked"));
        // Reading through the link escapes the anchor -> refused + listing
        // (the refusal echoes the requested path; the LISTING must not name
        // the escaped file).
        match read(&fx, "linked/secret.md") {
            SkillReadOutcome::Refused(message) => {
                assert!(
                    message.contains("does not name a readable file"),
                    "{message}"
                );
                let listing = message.split("Readable files: ").nth(1).expect("listing");
                assert!(!listing.contains("secret"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        // The listing is the gated real set: the link's content never appears.
        match read(&fx, "linked") {
            SkillReadOutcome::Refused(message) => {
                assert!(!message.contains("secret"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// An in-tree symlink to an in-tree file passes the same gate and is
    /// readable (Unix-only: a Windows file symlink needs elevation).
    #[cfg(unix)]
    #[test]
    fn in_tree_symlink_to_in_tree_file_is_readable() {
        let fx = Fixture::new();
        let dir = fx.put_skill("sql-coach");
        fx.put_file("sql-coach", "references/real.md", b"real\n");
        std::os::unix::fs::symlink("references/real.md", dir.join("alias.md")).unwrap();
        match read(&fx, "alias.md") {
            SkillReadOutcome::Local { payload, .. } => {
                assert_eq!(payload, Value::String("real\n".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// A NUL byte in the first 8KB refuses as binary; the file still appears
    /// in the listing (read-time classification, not hiding).
    #[test]
    fn binary_file_is_refused_but_listed() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file("sql-coach", "assets/logo.bin", &[0x00, 0x01, 0x02, 0x03]);
        match read(&fx, "assets/logo.bin") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("binary"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        match read(&fx, "nope") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("assets/logo.bin"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A NUL byte PAST the sniff window is served lossy -- the heuristic is
    /// a prefix sniff by contract (Decision 6), and this pins the boundary.
    #[test]
    fn nul_past_sniff_window_is_served_lossy() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let mut bytes = vec![b'x'; BINARY_SNIFF_BYTES + 8];
        bytes[BINARY_SNIFF_BYTES + 4] = 0;
        fx.put_file("sql-coach", "references/late.md", &bytes);
        match read(&fx, "references/late.md") {
            SkillReadOutcome::Local { .. } => {}
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// An over-cap file is refused with its exact byte count (never
    /// truncated), and still appears in the listing.
    #[test]
    fn over_cap_file_is_refused_with_byte_count_but_listed() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let big = vec![b'y'; (MAX_READ_BYTES + 1) as usize];
        fx.put_file("sql-coach", "references/big.md", &big);
        match read(&fx, "references/big.md") {
            SkillReadOutcome::Refused(message) => {
                assert!(
                    message.contains(&format!("{}", MAX_READ_BYTES + 1)),
                    "{message}"
                );
                assert!(message.contains("CLI tool"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        match read(&fx, "nope") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("references/big.md"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// The listing truncates at the entry cap with an honest count marker
    /// (SKILL.md itself counts toward the cap -- no privilege zone).
    #[test]
    fn listing_truncates_at_entry_cap_with_honest_marker() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        for i in 0..(LISTING_ENTRY_CAP + 10) {
            fx.put_file(
                "sql-coach",
                &format!("references/f{i:03}.md"),
                format!("f{i}\n").as_bytes(),
            );
        }
        match read(&fx, "nope") {
            SkillReadOutcome::Refused(message) => {
                // 60 reference files + SKILL.md = 61 total; 50 listed, 11 over.
                assert!(message.contains("(+11 more not listed)"), "{message}");
                assert!(message.contains("references/f000.md"), "{message}");
                assert!(!message.contains("references/f060.md"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A mounted + activated skill whose directory no longer resolves under
    /// the root is an honest registry-miss error (the live lookup, not a
    /// stale snapshot).
    #[test]
    fn registry_miss_is_an_honest_error() {
        let fx = Fixture::new();
        // The skill exists on the mounted/activated lists but not on disk.
        match read(&fx, "SKILL.md") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("no longer readable"), "{message}");
                assert!(message.contains("sql-coach"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A linked (imported) skill reads through the link: the anchor IS the
    /// external directory (Decision 2, piece 1).
    #[test]
    fn linked_skill_reads_through_the_link() {
        let fx = Fixture::new();
        let outside = tempfile::tempdir().unwrap();
        let dir = outside.path().join("linked-skill");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: linked-skill\n---\nBody.\n",
        )
        .unwrap();
        std::fs::write(dir.join("references/x.md"), b"through the link\n").unwrap();
        link_dir(&dir, &fx.root.path().join("linked-skill"));
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "linked-skill", "path": "references/x.md"}),
        };
        let fragments = vec![frag("linked-skill")];
        let activated = activated(&["linked-skill"]);
        match resolve_skill_read(&call, &fx.gate(&fragments, &activated)) {
            SkillReadOutcome::Local { payload, .. } => {
                assert_eq!(payload, Value::String("through the link\n".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// The definition is well-formed and carries the locked name (the
    /// reserved-name guard and both surfaces key off it).
    #[test]
    fn definition_is_well_formed() {
        let def = read_skill_file_definition();
        assert_eq!(def.name, "read_skill_file");
        assert!(!def.description.is_empty());
        assert!(
            def.description.contains("python"),
            "execution pointer: {}",
            def.description
        );
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["properties"]["name"]["type"], "string");
        assert_eq!(def.input_schema["properties"]["path"]["type"], "string");
        assert_eq!(def.input_schema["required"][0], "name");
        assert_eq!(def.input_schema["required"][1], "path");
    }

    /// The no-elevation directory link helper (the import path's own
    /// fallback, `skills/import.rs`): symlink on Unix, symlink-then-junction
    /// on Windows.
    fn link_dir(source: &Path, link_path: &Path) {
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(source, link_path).unwrap();
        }
        #[cfg(target_os = "windows")]
        {
            if std::os::windows::fs::symlink_dir(source, link_path).is_ok() {
                return;
            }
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link_path)
                .arg(source)
                .output()
                .expect("mklink /J");
            assert!(output.status.success(), "mklink /J failed: {output:?}");
        }
    }
}
