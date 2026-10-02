//! Session organization sidecar (ADR-0127, issue #1174): pin / archive state
//! for the session list. Organization is shell-layer state, deliberately
//! OUTSIDE the `.duck` content domain -- it lives in
//! `sessions_root/index.json`, keyed by the session directory uuid
//! (ADR-0089's `{uuid}/session.duck` layout). An organizational change
//! therefore never rewrites a recipe, never disturbs its mtime, and never
//! crosses the single-writer gate (ADR-0035).
//!
//! Failure posture: a missing sidecar is the zero state (first launch,
//! silent); an unreadable / corrupt one degrades to empty sets with a WARN --
//! the list stays usable, the visible cost is lost pins, and the next
//! successful write heals the file.

use crate::persistence::io::save_json_atomic;
use crate::persistence::SaveError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// The sidecar file name inside the sessions root.
pub const SIDECAR_NAME: &str = "index.json";
/// The only sidecar format this version writes and reads.
const SIDECAR_FORMAT: u32 = 1;

/// Pin / archive organization state (ADR-0127). `pinned` is an MRU
/// head-insert ordered array (Decision 5): array position IS the display
/// order, no timestamps. `pinned` and `archived` are kept disjoint by
/// construction -- archiving removes from `pinned` in the same atomic write
/// (Decision 3), so "archived but pinned" is unreachable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOrganization {
    pub format: u32,
    pub pinned: Vec<String>,
    pub archived: Vec<String>,
}

impl Default for SessionOrganization {
    fn default() -> Self {
        Self {
            format: SIDECAR_FORMAT,
            pinned: Vec::new(),
            archived: Vec::new(),
        }
    }
}

/// Serializes every read-modify-write of the sidecar (scan sweep, the two
/// set commands, open-is-unarchive). Whole-file rewrites make concurrent
/// RMWs last-writer-wins, so a scan's prune-and-rewrite racing a user pin
/// would silently drop the pin; one process-wide lock removes the race. Same
/// posture as the single-writer registry in `registry.rs`.
fn sidecar_lock() -> &'static Mutex<()> {
    static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
    &LOCK
}

fn sidecar_path(root: &Path) -> PathBuf {
    root.join(SIDECAR_NAME)
}

/// The sidecar key for a session: the `{uuid}` directory name of its
/// `session.duck` path. The directory is the session's stable identity
/// (ADR-0089), so the sidecar survives a sessions_root move that
/// absolute duck_paths would not.
pub fn session_dir_uuid(duck_path: &str) -> Option<String> {
    Path::new(duck_path)
        .parent()?
        .file_name()?
        .to_str()
        .map(str::to_owned)
}

/// Read the sidecar. Missing = zero state, silent (same posture as
/// `scan_sessions_dir`'s NotFound branch); unreadable / corrupt / foreign
/// format = WARN + empty sets (ADR-0127: the list must not break on a bad
/// sidecar).
fn load(root: &Path) -> SessionOrganization {
    let path = sidecar_path(root);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return SessionOrganization::default()
        }
        Err(e) => {
            log::warn!(
                target: "toptopduck::persistence",
                "session organization sidecar unreadable ({}): {e}; degrading to empty sets",
                path.display()
            );
            return SessionOrganization::default();
        }
    };
    match serde_json::from_str::<SessionOrganization>(&text) {
        Ok(org) if org.format == SIDECAR_FORMAT => org,
        Ok(org) => {
            log::warn!(
                target: "toptopduck::persistence",
                "session organization sidecar has unsupported format {} ({}); \
                 degrading to empty sets",
                org.format,
                path.display()
            );
            SessionOrganization::default()
        }
        Err(e) => {
            log::warn!(
                target: "toptopduck::persistence",
                "session organization sidecar corrupt ({}): {e}; degrading to empty sets",
                path.display()
            );
            SessionOrganization::default()
        }
    }
}

/// Read under the lock, hand the caller the mutation, persist only when the
/// state actually changed, and return the post-mutation state. Idempotent
/// no-ops therefore never touch the disk (and never "heal" a corrupt file the
/// user has not acted on).
fn modify(
    root: &Path,
    f: impl FnOnce(&mut SessionOrganization),
) -> Result<SessionOrganization, SaveError> {
    let _guard = sidecar_lock().lock().expect("sidecar lock poisoned");
    let mut org = load(root);
    let before = org.clone();
    f(&mut org);
    if org != before {
        save_json_atomic(&sidecar_path(root), &org)?;
    }
    Ok(org)
}

/// The scan-side read: join source for `list_sessions` and the tray. While
/// holding the lock, prune keys whose session directories the scan did not
/// see (externally deleted / stale) and persist the pruned state -- the
/// sidecar stays bounded and self-heals (ADR-0127 Decision 2). Orphan
/// keys are inert anyway (no row to join), so a failed prune save is only
/// logged, never fatal to the scan.
pub fn load_and_sweep(root: &Path, known: &HashSet<String>) -> SessionOrganization {
    modify(root, |org| {
        org.pinned.retain(|k| known.contains(k));
        org.archived.retain(|k| known.contains(k));
    })
    .unwrap_or_else(|e| {
        log::warn!(
            target: "toptopduck::persistence",
            "session organization sweep failed for {}: {e}; keeping the unswept state",
            root.display()
        );
        load(root)
    })
}

/// Pin (head-insert, MRU-first display order) or unpin a session. Pinning an
/// archived session is an idempotent no-op (the archive view exposes no pin
/// action; this is the backend backstop -- ADR-0127 Decision 3). Unknown
/// uuids are NOT probed for existence: a stale-list pin of a deleted session
/// becomes an orphan key the next sweep removes.
pub fn set_pinned(root: &Path, uuid: &str, pinned: bool) -> Result<(), SaveError> {
    modify(root, |org| {
        if pinned {
            if !org.archived.iter().any(|k| k == uuid) && !org.pinned.iter().any(|k| k == uuid) {
                org.pinned.insert(0, uuid.to_owned());
            }
        } else {
            org.pinned.retain(|k| k != uuid);
        }
    })
    .map(|_| ())
}

/// Archive or restore a session. Archiving removes from `pinned` and adds to
/// `archived` in the SAME atomic write (Decision 3: the frontend cannot
/// observe an archived-but-pinned intermediate). Unknown uuids are safe
/// without existence probing -- set removal cannot introduce an unknown
/// reference.
pub fn set_archived(root: &Path, uuid: &str, archived: bool) -> Result<(), SaveError> {
    modify(root, |org| {
        if archived {
            org.pinned.retain(|k| k != uuid);
            if !org.archived.iter().any(|k| k == uuid) {
                org.archived.push(uuid.to_owned());
            }
        } else {
            org.archived.retain(|k| k != uuid);
        }
    })
    .map(|_| ())
}

/// Open-is-unarchive (ADR-0127 Decision 4): after `open_duck` binds, a hit in
/// `archived` is removed in the same single write. File-picker and
/// OS-association entry points thereby auto-restore a session without going
/// through the sidebar -- "open but archived" is unreachable.
pub fn unarchive_if_archived(root: &Path, uuid: &str) -> Result<(), SaveError> {
    modify(root, |org| {
        org.archived.retain(|k| k != uuid);
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar_exists(root: &Path) -> bool {
        root.join(SIDECAR_NAME).try_exists().expect("try_exists")
    }

    fn read_sidecar(root: &Path) -> SessionOrganization {
        serde_json::from_str(
            &std::fs::read_to_string(root.join(SIDECAR_NAME)).expect("read sidecar"),
        )
        .expect("parse sidecar")
    }

    #[test]
    fn pin_head_inserts_in_mru_order_and_round_trips() {
        // ADR-0127 Decision 5: pinning is a head insert -- array position is
        // the display order, most recently pinned first.
        let root = tempfile::tempdir().expect("tempdir");
        set_pinned(root.path(), "b", true).expect("pin b");
        set_pinned(root.path(), "a", true).expect("pin a");
        assert_eq!(read_sidecar(root.path()).pinned, vec!["a", "b"]);
        // Unpin removes; the survivor keeps its relative order.
        set_pinned(root.path(), "a", false).expect("unpin a");
        assert_eq!(read_sidecar(root.path()).pinned, vec!["b"]);
        assert_eq!(read_sidecar(root.path()).format, SIDECAR_FORMAT);
    }

    #[test]
    fn archiving_removes_the_pin_in_the_same_write() {
        // ADR-0127 Decision 3: archive = remove from pinned + add to archived
        // in ONE atomic write; the sets stay disjoint.
        let root = tempfile::tempdir().expect("tempdir");
        set_pinned(root.path(), "a", true).expect("pin a");
        set_pinned(root.path(), "b", true).expect("pin b");
        set_archived(root.path(), "a", true).expect("archive a");
        let org = read_sidecar(root.path());
        assert_eq!(org.pinned, vec!["b"]);
        assert_eq!(org.archived, vec!["a"]);
    }

    #[test]
    fn pinning_an_archived_session_is_a_noop() {
        // ADR-0127 Decision 3 backend backstop: pinning an archived session
        // neither adds it to pinned nor disturbs archived.
        let root = tempfile::tempdir().expect("tempdir");
        set_archived(root.path(), "a", true).expect("archive a");
        set_pinned(root.path(), "a", true).expect("pin a (no-op)");
        let org = read_sidecar(root.path());
        assert!(org.pinned.is_empty());
        assert_eq!(org.archived, vec!["a"]);
    }

    #[test]
    fn noop_mutations_never_create_the_sidecar() {
        // Idempotent no-ops (unknown-uuid removals, re-asserting state) must
        // not materialize index.json -- a root with no organization state
        // stays file-free.
        let root = tempfile::tempdir().expect("tempdir");
        set_pinned(root.path(), "ghost", false).expect("unpin unknown");
        set_archived(root.path(), "ghost", false).expect("unarchive unknown");
        unarchive_if_archived(root.path(), "ghost").expect("unarchive unknown (open path)");
        assert!(
            !sidecar_exists(root.path()),
            "no-op writes must not create index.json"
        );
        // Re-asserting an existing state is equally inert.
        set_pinned(root.path(), "a", true).expect("pin a");
        set_pinned(root.path(), "a", true).expect("pin a again");
        set_archived(root.path(), "b", true).expect("archive b");
        set_archived(root.path(), "b", true).expect("archive b again");
        let org = read_sidecar(root.path());
        assert_eq!(org.pinned, vec!["a"]);
        assert_eq!(org.archived, vec!["b"]);
    }

    #[test]
    fn missing_sidecar_is_the_silent_zero_state() {
        // First launch: no index.json anywhere -- reads are empty, nothing is
        // created by reading.
        let root = tempfile::tempdir().expect("tempdir");
        let known = HashSet::from(["a".to_owned()]);
        assert_eq!(
            load_and_sweep(root.path(), &known),
            SessionOrganization::default()
        );
        assert!(!sidecar_exists(root.path()));
    }

    #[test]
    fn corrupt_sidecar_degrades_to_empty_and_the_next_write_heals() {
        // ADR-0127: a corrupt sidecar costs the pins (visible, tolerable) but
        // never the list; the next organizational write rewrites valid JSON.
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join(SIDECAR_NAME), "{ not json").expect("write garbage");
        let known = HashSet::from(["a".to_owned()]);
        assert_eq!(
            load_and_sweep(root.path(), &known),
            SessionOrganization::default()
        );
        set_archived(root.path(), "a", true).expect("archive after corruption");
        let org = read_sidecar(root.path());
        assert_eq!(
            org,
            SessionOrganization {
                format: SIDECAR_FORMAT,
                archived: vec!["a".into()],
                pinned: vec![],
            }
        );
    }

    #[test]
    fn unarchive_removes_the_member_and_leaves_non_members_alone() {
        // ADR-0127 Decision 4: open-is-unarchive -- a member leaves `archived`
        // (and only `archived`; pins are untouched by restore semantics).
        let root = tempfile::tempdir().expect("tempdir");
        set_archived(root.path(), "a", true).expect("archive a");
        set_archived(root.path(), "b", true).expect("archive b");
        set_pinned(root.path(), "c", true).expect("pin c");
        unarchive_if_archived(root.path(), "a").expect("unarchive a");
        unarchive_if_archived(root.path(), "ghost").expect("unarchive ghost");
        let org = read_sidecar(root.path());
        assert_eq!(org.archived, vec!["b"]);
        assert_eq!(org.pinned, vec!["c"]);
    }

    #[test]
    fn sweep_prunes_keys_missing_from_the_scan_set() {
        // ADR-0127 Decision 2: orphan keys (externally deleted session dirs)
        // are pruned during the scan, keeping the sidecar bounded.
        let root = tempfile::tempdir().expect("tempdir");
        set_pinned(root.path(), "live", true).expect("pin live");
        set_pinned(root.path(), "gone", true).expect("pin gone");
        set_archived(root.path(), "gone-too", true).expect("archive gone-too");
        let known = HashSet::from(["live".to_owned()]);
        let swept = load_and_sweep(root.path(), &known);
        assert_eq!(swept.pinned, vec!["live"]);
        assert!(swept.archived.is_empty());
        // The prune is persisted, not just projected.
        assert_eq!(read_sidecar(root.path()), swept);
    }

    #[test]
    fn session_dir_uuid_takes_the_parent_directory_name() {
        // The sidecar key is the {uuid} directory (ADR-0089), not the duck
        // file name and not the full path.
        let sep = std::path::MAIN_SEPARATOR;
        let duck = format!("C:{sep}sessions{sep}abc-123{sep}session.duck");
        assert_eq!(session_dir_uuid(&duck).as_deref(), Some("abc-123"));
        assert_eq!(session_dir_uuid("session.duck"), None);
    }
}
