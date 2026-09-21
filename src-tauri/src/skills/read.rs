//! The `read_skill_file` gateway meta-tool (ADR-0111, issue #714; gate
//! recalibrated by ADR-0119 Decision 4): the restricted read surface over
//! an INVOKED skill's attachment tree.
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
//! Like [`crate::skills::invocation`], this is a gateway-local meta call
//! served BEFORE the approval gate on both dispatch faces: reading is the
//! same risk class as the invoked body (a prompt-injection surface), so
//! the session-invoked set plus the lexical/canonical bounds above are the
//! only trust gates (Decision 5, calibrated by ADR-0119 Decision 4). The
//! classification IS pure -- a read mutates nothing, so unlike invocation
//! there is no transition and no persist. Failure states carry
//! self-correcting signals (ADR-0077): a name nobody invoked this session
//! points at `invoke_skill` (and lists the already-invoked names), and a
//! bad path lists the skill's real readable files (Decision 4 -- discovery
//! rides the invocation, never a directory advertisement).
//!
//! Execution is text relay (Decision 7): the description teaches that a
//! script's text, once read, goes to a registered CLI tool's content
//! parameter. Nothing here executes anything.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::provider::tool_calling::{ToolDefinition, ToolUse};

/// The `read_skill_file` tool name. Invoked-conditional (ADR-0111 Decision 1
/// calibrated by ADR-0119 Decision 4): only a turn whose session-INVOKED set
/// is non-empty pays the standing tool cost -- skills never invoked this
/// session have no readable files by definition.
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

/// What one read classifies against: the turn-start session-INVOKED
/// snapshot (read eligibility -- a mid-turn invocation joins the NEXT turn's
/// snapshot, the no-competition-with-assembly posture of ADR-0111 Decision 3
/// carried over by ADR-0119 Decision 4), the enable-axis disabled names
/// (ADR-0119 Decision 3's eligibility gate crosses the read surface: a
/// disabled name's invocation record still lands -- the honest-degrade
/// shape -- but its files stay closed until the axis re-enables it), and
/// the registry root for the live name resolution (a mid-session registry
/// delete is an honest error, never a stale turn-start snapshot).
pub(crate) struct SkillReadGate<'a> {
    /// The turn-start invoked names -- read eligibility. The session-level
    /// invoked set (a monotonic fold of the turn invocation records),
    /// snapshotted at the turn boundary so a mid-turn `invoke_skill` lands
    /// the read surface on the NEXT turn.
    pub(crate) invoked: &'a [String],
    /// The machine-level disabled skill names (ADR-0118 enablement axis) --
    /// the same list the submit-time materialization consults, so a name
    /// disabled between pick and submit cannot open files through its
    /// landed record.
    pub(crate) disabled: &'a [String],
    /// The skills registry root, for the live entry lookup.
    pub(crate) root: &'a Path,
}

impl SkillReadGate<'_> {
    /// The all-empty gate for dispatch-level tests that never touch the read
    /// surface: an empty invoked set refuses everything, so a read call
    /// under it is inert by construction.
    #[cfg(test)]
    pub(crate) fn inert() -> SkillReadGate<'static> {
        SkillReadGate {
            invoked: &[],
            disabled: &[],
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
/// table and the gateway `tools/list`), attached only when the session's
/// invoked set is non-empty. English by the two-surface language split.
/// The description teaches the rules and carries the execution pointer
/// (ADR-0111 Decision 7) but never enumerates files (Decision 4).
pub(crate) fn read_skill_file_definition() -> ToolDefinition {
    ToolDefinition {
        name: READ_SKILL_FILE.to_string(),
        description: format!(
            "Read one attachment file of an INVOKED skill -- any file in its directory \
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
                    "description": "The invoked skill's name (kebab-case), as named in \
                         the invoked skill body."
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
/// 2-4, calibrated by ADR-0119 Decision 4): served / name disabled on the
/// enable axis (its invocation record landed, its files stay closed) / name
/// not invoked this session (points at `invoke_skill` and lists the
/// already-invoked names) / path missing, out of bounds, or a directory
/// (lists the skill's readable files). Pure -- no state changes anywhere.
pub(crate) fn resolve_skill_read(call: &ToolUse, gate: &SkillReadGate<'_>) -> SkillReadOutcome {
    let Some(name) = str_param(&call.input, "name") else {
        return SkillReadOutcome::Refused(missing_param_failure("name"));
    };
    let Some(path) = str_param(&call.input, "path") else {
        return SkillReadOutcome::Refused(missing_param_failure("path"));
    };
    if !gate.invoked.iter().any(|a| a == name) {
        return SkillReadOutcome::Refused(not_invoked_failure(name, gate.invoked));
    }
    if gate.disabled.iter().any(|d| d == name) {
        return SkillReadOutcome::Refused(disabled_failure(name));
    }
    if lexical_reject(path) {
        return SkillReadOutcome::Refused(lexical_failure(path));
    }
    let Some(anchor) = canonical_anchor(gate.root, name) else {
        return SkillReadOutcome::Refused(registry_miss_failure(name));
    };
    let target = anchor.join(path.trim_end_matches(['/', '\\']));
    let Some((resolved, is_file)) = canonical_file(&target) else {
        return path_refusal(name, path, &anchor);
    };
    if !resolved.starts_with(&anchor) || !is_file {
        return path_refusal(name, path, &anchor);
    }
    serve_file(name, path, &resolved, &anchor)
}

/// Read and classify the resolved file's content (ADR-0111 Decision 6): the
/// byte cap refuses (never truncates), the NUL sniff refuses binary, and
/// surviving text is served lossy UTF-8. A NotFound between resolution and
/// read is the path failure (with the full skill listing) -- the file that
/// just resolved is already gone. Any OTHER IO failure (permission, sharing
/// conflict) is its own refusal WITHOUT a listing: the listing is built
/// without opening files, so it would still name this very path and point
/// the agent's self-correction at the same file.
fn serve_file(name: &str, path: &str, resolved: &Path, anchor: &Path) -> SkillReadOutcome {
    let len = match std::fs::metadata(resolved) {
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return path_refusal(name, path, anchor)
        }
        Err(_) => return SkillReadOutcome::Refused(read_failure(name, path)),
    };
    if len > MAX_READ_BYTES {
        return SkillReadOutcome::Refused(over_cap_failure(name, path, len));
    }
    let bytes = match std::fs::read(resolved) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return path_refusal(name, path, anchor)
        }
        Err(_) => return SkillReadOutcome::Refused(read_failure(name, path)),
    };
    // The cap re-checked on the bytes actually read: a file growing between
    // the metadata probe and the read would ride over the pre-read check.
    if bytes.len() as u64 > MAX_READ_BYTES {
        return SkillReadOutcome::Refused(over_cap_failure(name, path, bytes.len() as u64));
    }
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return SkillReadOutcome::Refused(binary_failure(name, path));
    }
    // Lossy-decoded on serve (the doc posture above), but the replacement
    // is silent by default -- and this face is the remedy the injection
    // cap's marker itself prescribes, so it must not hand back quiet
    // U+FFFD content either. One ladder-shaped warn makes the divergence
    // observable (issue #1025) -- the parity signal for the resolve-time
    // and assemble-time warns.
    if std::str::from_utf8(&bytes).is_err() {
        log::warn!(
            target: "skills",
            "skill `{name}` file `{path}` holds non-UTF-8 bytes -- the served \
             text rides lossy U+FFFD replacements; re-save the file as UTF-8 \
             to reconcile it",
        );
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
/// `invoke_skill` style, shared by both dispatch sites through the
/// resolver).
fn missing_param_failure(param: &str) -> String {
    format!("read_skill_file failed: parameter `{param}`: expected a non-empty string")
}

/// The not-invoked failure (ADR-0111 Decision 4, calibrated by ADR-0119
/// Decision 4): reading rides the session's invoked set, so the fix is one
/// `invoke_skill` away -- and the error lists every already-invoked name so
/// the agent can route to a readable skill in one hop.
fn not_invoked_failure(name: &str, invoked: &[String]) -> String {
    if invoked.is_empty() {
        format!(
            "read_skill_file: `{name}` has not been invoked. No skills are invoked yet \
             this session; call `invoke_skill` first -- only an invoked skill's files \
             are readable."
        )
    } else {
        format!(
            "read_skill_file: `{name}` has not been invoked. Invoked skills: {}. Call \
             `invoke_skill` with this name first -- only an invoked skill's files are \
             readable.",
            invoked.join(", ")
        )
    }
}

/// The enable-axis failure (ADR-0119 Decision 3's gate crossing the read
/// surface): the name IS invoked -- its empty-body record landed, the badge
/// shows the attempt -- but the skill is disabled, so its files stay closed
/// until the axis re-enables it. Self-correcting in the same register as
/// the not-invoked refusal: the fix names the operator action, not a
/// different call.
fn disabled_failure(name: &str) -> String {
    format!(
        "read_skill_file: `{name}` is invoked but disabled on the enable axis. \
         Its files stay closed until the skill is re-enabled."
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
/// readable files, capped with an honest truncation marker. An incomplete
/// walk (a read error under the tree) is marked as such -- enumeration
/// failure is never narrated as an empty or complete set.
fn path_failure(name: &str, path: &str, listing: &[String], incomplete: bool) -> String {
    let mut files = if listing.is_empty() {
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
    if incomplete {
        files.push_str(" (listing incomplete: a read error occurred)");
    }
    format!(
        "read_skill_file: `{path}` does not name a readable file in skill `{name}` \
         (missing, out of bounds, or a directory). Readable files: {files}."
    )
}

/// The serve-time IO failure (permission, sharing conflict -- the file is
/// present under the anchor but not readable): its own refusal, WITHOUT the
/// listing, which would still name this very path and point the agent's
/// self-correction at the same file.
fn read_failure(name: &str, path: &str) -> String {
    format!(
        "read_skill_file: `{path}` in skill `{name}` could not be read (an IO \
         error such as a permission or sharing conflict); retrying will not \
         help until the error clears."
    )
}

/// Any path-level refusal (Decision 4): the fixed message plus the skill's
/// live readable listing (with the walk's incompleteness, when present).
fn path_refusal(name: &str, path: &str, anchor: &Path) -> SkillReadOutcome {
    let (listing, incomplete) = readable_listing(anchor);
    SkillReadOutcome::Refused(path_failure(name, path, &listing, incomplete))
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

/// The anchor (Decision 2, piece 1): the canonicalized registry entry root,
/// resolved through the shadowing order (ADR-0121 Decision 5) -- a local
/// directory owning the name wins, the reserved-subtree copy is the
/// fallback, so invocation and reads resolve to the fork under shadowing. A
/// linked import's symlink / junction resolves to the external directory --
/// that IS the skill body. `None` when the name is not spec-shaped (defense
/// in depth -- the mount API does not validate, mirroring
/// [`crate::skills::prompt`]) or the entry no longer resolves on disk.
pub(crate) fn canonical_anchor(root: &Path, name: &str) -> Option<PathBuf> {
    // Defense in depth for the `TurnInputs::empty` sentinel root: an empty
    // path joins into a RELATIVE name that canonicalize would resolve
    // against the process CWD. Refuse it as a registry miss rather than
    // trust the sentinel-always-pairs-with-empty-sets convention.
    if root.as_os_str().is_empty() {
        return None;
    }
    if !crate::skills::model::is_valid_skill_name(name) {
        return None;
    }
    std::fs::canonicalize(crate::skills::builtin::resolve_skill_dir(root, name)?).ok()
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
/// an ancestor would otherwise walk forever). Returns the listing plus
/// whether the walk hit a read error (an incomplete listing is marked in
/// the refusal, never silently shrunk).
fn readable_listing(anchor: &Path) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut visited = HashSet::from([anchor.to_path_buf()]);
    let complete = walk_tree(anchor, anchor, &mut visited, &mut out);
    out.sort();
    (out, !complete)
}

/// One directory level of the listing walk. Recursion descends only into
/// directories known to sit under the anchor: real subdirectories (a real
/// directory cannot point elsewhere) and symlinks / junctions whose
/// canonicalized target is still contained. Everything else -- out-pointing
/// links, broken links, non-regular types -- is simply absent. Returns
/// whether the level enumerated cleanly; a read error marks the walk
/// incomplete up the chain instead of silently shrinking the listing.
fn walk_tree(
    anchor: &Path,
    dir: &Path,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<String>,
) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut complete = true;
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            complete = false;
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
                    complete &= walk_tree(anchor, &path, visited, out);
                }
            } else if meta.is_file() {
                push_relative(anchor, &path, out);
            }
        } else if ft.is_dir() {
            complete &= walk_tree(anchor, &path, visited, out);
        } else if ft.is_file() {
            // The builtin alignment marker (ADR-0121) is bookkeeping, never
            // skill content. It sits at the subtree top, so only a TOP-LEVEL
            // file of that name is excluded -- mirroring the fingerprint
            // input's own top-level-only exclusion -- while a deeper file of
            // the same name is an ordinary attachment.
            if path.parent() == Some(anchor)
                && path.file_name().and_then(|n| n.to_str())
                    == Some(crate::skills::builtin::FINGERPRINT_FILE)
            {
                continue;
            }
            push_relative(anchor, &path, out);
        }
    }
    complete
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

        /// The builtin posture's on-disk shape (ADR-0121): a spec-valid
        /// skill tree living ONLY under the reserved subtree, nothing at
        /// the registry root.
        fn put_system_skill(&self, name: &str) {
            let dir = self.root.path().join(".system").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\n---\nBody.\n"),
            )
            .unwrap();
        }

        fn put_system_file(&self, name: &str, rel: &str, bytes: &[u8]) {
            let path = self.root.path().join(".system").join(name).join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn gate<'a>(&'a self, invoked: &'a [String]) -> SkillReadGate<'a> {
            SkillReadGate {
                invoked,
                disabled: &[],
                root: self.root.path(),
            }
        }

        /// The enable-axis variant: the same gate shape carrying a disabled
        /// list.
        fn gated<'a>(&'a self, invoked: &'a [String], disabled: &'a [String]) -> SkillReadGate<'a> {
            SkillReadGate {
                invoked,
                disabled,
                root: self.root.path(),
            }
        }
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
        let activated = activated(&["sql-coach"]);
        resolve_skill_read(&call, &fx.gate(&activated))
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

    /// A non-UTF-8 file still serves its text lossy (U+FFFD stand-ins) --
    /// the divergence the serve-time warn makes observable (issue #1025),
    /// on the very face the injection cap's own marker prescribes as the
    /// whole-file remedy. Pins the lossy posture so the warn's arrival
    /// cannot regress the serve itself.
    #[test]
    fn non_utf8_file_serves_lossy() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_file(
            "sql-coach",
            "references/notes.md",
            b"Use CTEs with \xFF inside.\n",
        );
        match read(&fx, "references/notes.md") {
            SkillReadOutcome::Local { payload, .. } => {
                assert_eq!(
                    payload,
                    Value::String("Use CTEs with \u{FFFD} inside.\n".to_string())
                );
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// The restricted read face over a reserved-subtree tree (issue #1020's
    /// AC 8): a skill existing only under `.system/` resolves through the
    /// shadowing order's fallback arm -- its attachments read and the skill
    /// stays invokable. A resolver joining `root/<name>` directly finds
    /// nothing here (the review-pass wiring mutant).
    #[test]
    fn a_builtin_tree_under_the_reserved_subtree_serves_attachments() {
        let fx = Fixture::new();
        fx.put_system_skill("sql-coach");
        fx.put_system_file("sql-coach", "scripts/run.py", b"print('ok')\n");
        match read(&fx, "scripts/run.py") {
            SkillReadOutcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach: scripts/run.py");
                assert_eq!(payload, Value::String("print('ok')\n".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    /// The alignment marker is bookkeeping, hidden from the readable
    /// listing ONLY at the tree top (mirroring the fingerprint input's own
    /// top-level-only exclusion); a deeper `.fingerprint` is an ordinary
    /// attachment (ADR-0121).
    #[test]
    fn the_listing_hides_the_top_level_marker_and_keeps_deeper_namesakes() {
        let fx = Fixture::new();
        fx.put_system_skill("sql-coach");
        fx.put_system_file("sql-coach", ".fingerprint", b"marker\n");
        fx.put_system_file("sql-coach", "references/.fingerprint", b"notes\n");
        let anchor = fx.root.path().join(".system").join("sql-coach");
        let (listing, incomplete) = readable_listing(&anchor);
        assert!(!incomplete);
        assert!(
            !listing.contains(&".fingerprint".to_string()),
            "the marker stays hidden: {listing:?}"
        );
        assert!(
            listing.contains(&"references/.fingerprint".to_string()),
            "a deeper namesake is an attachment: {listing:?}"
        );
        assert!(listing.contains(&"SKILL.md".to_string()));
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
    /// the one-hop self-correction signal, mirroring `invoke_skill`.
    #[test]
    fn not_invoked_name_lists_every_invoked_name() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        fx.put_skill("pdf-tools");
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "ghost", "path": "SKILL.md"}),
        };
        let activated = activated(&["sql-coach"]);
        match resolve_skill_read(&call, &fx.gate(&activated)) {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("ghost"), "{message}");
                assert!(message.contains("sql-coach"), "{message}");
                // ADR-0119: the failure lists the INVOKED names (the one-hop
                // routing signal) + the invoke_skill pointer -- not the
                // registry contents.
                assert!(message.contains("invoke_skill"), "{message}");
                assert!(!message.contains("pdf-tools"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A name on an EMPTY invoked surface names the empty surface + the fix.
    #[test]
    fn not_invoked_with_empty_set_names_the_empty_surface() {
        let fx = Fixture::new();
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "ghost", "path": "SKILL.md"}),
        };
        match resolve_skill_read(&call, &fx.gate(&[])) {
            SkillReadOutcome::Refused(message) => assert_eq!(
                message,
                "read_skill_file: `ghost` has not been invoked. No skills are invoked yet \
                 this session; call `invoke_skill` first -- only an invoked skill's files \
                 are readable."
            ),
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A registry-existing name nobody invoked this session is refused with
    /// the pointer to `invoke_skill` (read rides the invoked gate, ADR-0119
    /// Decision 4) -- existence on disk is not eligibility.
    #[test]
    fn not_invoked_registry_name_points_to_invoke_skill() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({"name": "sql-coach", "path": "SKILL.md"}),
        };
        let activated = activated(&["other-skill"]);
        match resolve_skill_read(&call, &fx.gate(&activated)) {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("sql-coach"), "{message}");
                assert!(message.contains("invoke_skill"), "{message}");
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
            let activated = activated(&["sql-coach"]);
            match resolve_skill_read(&call, &fx.gate(&activated)) {
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

    /// A sibling whose name is a STRING prefix of the anchor must not
    /// satisfy containment -- the component-level comparison is the security
    /// core (Decision 2). A junction inside the skill pointing at the
    /// sibling refuses on read and never appears in the listing; a
    /// string-prefix implementation would serve the sibling's file.
    #[test]
    fn sibling_prefix_directory_is_refused_and_absent_from_listing() {
        let fx = Fixture::new();
        let dir = fx.put_skill("sql-coach");
        let sibling = fx.put_skill("sql-coach-2");
        std::fs::write(sibling.join("secret.md"), b"sibling secret\n").unwrap();
        link_dir(&sibling, &dir.join("linked"));
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
        match read(&fx, "linked") {
            SkillReadOutcome::Refused(message) => {
                assert!(!message.contains("secret"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// Mutually-pointing in-tree links terminate at one expansion per
    /// canonical directory (the visited-set guard): without it the walk
    /// re-expands the cycle until the OS link-resolution depth cuts it off,
    /// listing every file once per extra loop. `in-a.md` appears exactly
    /// twice -- its real path and the one link path the walk legitimately
    /// descends -- and never a third.
    #[test]
    fn link_cycle_expands_each_directory_once() {
        let fx = Fixture::new();
        let dir = fx.put_skill("sql-coach");
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("in-a.md"), b"a\n").unwrap();
        link_dir(&b, &a.join("to-b"));
        link_dir(&a, &b.join("to-a"));
        match read(&fx, "nope") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("Readable files:"), "{message}");
                let listing = message.split("Readable files: ").nth(1).expect("listing");
                let count = listing.matches("in-a.md").count();
                assert_eq!(count, 2, "{message}");
                assert!(!listing.contains("to-b/to-a/to-b"), "{message}");
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

    /// A NUL at the window's LAST byte still refuses; one at the FIRST byte
    /// past the window serves -- the exact off-by-one boundary of the sniff.
    #[test]
    fn nul_at_sniff_window_boundary() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let mut last = vec![b'x'; BINARY_SNIFF_BYTES];
        last[BINARY_SNIFF_BYTES - 1] = 0;
        fx.put_file("sql-coach", "references/edge-last.md", &last);
        match read(&fx, "references/edge-last.md") {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("binary"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        let mut past = vec![b'x'; BINARY_SNIFF_BYTES + 1];
        past[BINARY_SNIFF_BYTES] = 0;
        fx.put_file("sql-coach", "references/edge-past.md", &past);
        match read(&fx, "references/edge-past.md") {
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

    /// Review Important 2 (#991): a disabled name's landed record opens no
    /// files. The invocation record still lands (the honest-degrade shape --
    /// the badge reads the attempt), but the enable-axis cross keeps the
    /// read surface closed: a name disabled between pick and submit cannot
    /// read its own files through the record. Without the cross, this call
    /// would serve the SKILL.md that is on disk.
    #[test]
    fn disabled_invoked_name_is_refused_on_the_enable_axis() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let disabled = activated(&["sql-coach"]);
        let call = ToolUse {
            id: "tu_r".to_string(),
            name: READ_SKILL_FILE.to_string(),
            input: json!({ "name": "sql-coach", "path": "SKILL.md" }),
        };
        match resolve_skill_read(&call, &fx.gated(&activated(&["sql-coach"]), &disabled)) {
            SkillReadOutcome::Refused(message) => {
                assert!(message.contains("disabled"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    /// A file of exactly the cap serves -- the cap refuses only strictly
    /// over-cap files (Decision 6), pinning the `>` boundary.
    #[test]
    fn exactly_cap_file_is_served() {
        let fx = Fixture::new();
        fx.put_skill("sql-coach");
        let exact = vec![b'z'; MAX_READ_BYTES as usize];
        fx.put_file("sql-coach", "references/exact.md", &exact);
        match read(&fx, "references/exact.md") {
            SkillReadOutcome::Local { .. } => {}
            other => panic!("expected Local, got {other:?}"),
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
        let activated = activated(&["linked-skill"]);
        match resolve_skill_read(&call, &fx.gate(&activated)) {
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
