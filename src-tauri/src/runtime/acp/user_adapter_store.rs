//! The user-defined adapter registry (issue #1341): the user-authored half of
//! the adapter table, persisted as `user-adapters.json` under the OS
//! app-data dir.
//!
//! Two read faces with deliberately different failure semantics (the sidecar
//! honest-degrade stance does NOT apply here -- user input must never
//! silently vanish): the picker face ([`UserAdapterStore::load_for_picker`])
//! never refuses (a corrupt store only means the user rows are absent from
//! the picker; the built-in rows still render), while the management face
//! ([`UserAdapterStore::list`]) reports the failure explicitly and a failed
//! read never rewrites the file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::adapter::{v1_adapters, StreamFormat};
use crate::persistence::io::{write_str_atomic, WritePerms};

/// The sidecar file name (resolved against the OS app-data dir by the setup
/// hook, the same anchoring the catalog cache uses).
pub const USER_ADAPTERS_FILE_NAME: &str = "user-adapters.json";
/// The one document version this build reads and writes (ADR-0036-style
/// version routing: a newer file refuses, an older one does not exist).
const USER_ADAPTERS_FORMAT_VERSION: u32 = 1;

/// One user-defined adapter row. The storage AND wire shape (crosses IPC
/// verbatim; env may carry plaintext keys, which is why the file is written
/// with private permissions). Unknown fields refuse on the read side: a
/// mistyped hand-edit key must not parse clean only to vanish on the next
/// successful save.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserAdapterRow {
    /// `user:<short-uuid>` -- minted at create, never reused.
    pub id: String,
    /// The picker label (maps onto `AdapterSpec::display_name`).
    pub name: String,
    /// The launch target: a bare binary name (resolved by the PATH scan,
    /// PATHEXT-aware on Windows) or an absolute path (used verbatim, never
    /// PATHEXT-completed). A single argv token by construction -- see
    /// [`is_valid_command_token`].
    pub command: String,
    /// The argv prefix after the command.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables for the spawned CLI (API keys etc.).
    /// BTreeMap so the serialized file diffs stably.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// `false` keeps the row out of the picker projection (the row and its
    /// id stay resolvable for sessions / defaults that already name it).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Stored for the schema's forward shape (loosening is a validation-only
    /// change later), but only `acp` parses today: this first knife adds
    /// user rows on the ACP channel alone.
    pub stream_format: StreamFormat,
}

fn default_enabled() -> bool {
    true
}

/// The persisted document. Unknown fields refuse (same hand-edit honesty
/// as the row).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UserAdaptersDoc {
    format_version: u32,
    adapters: Vec<UserAdapterRow>,
}

/// Mint a fresh row id: `user:` + the first 8 hex of a v4 uuid.
pub fn mint_user_adapter_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("user:{}", &hex[..8])
}

/// A user row's command is ONE argv token (issue #1341): no whitespace, no
/// quote characters. The frontend's file picker bypasses hand-typing, and
/// the form rejects a violation immediately; this is the backend boundary of
/// the same rule.
pub fn is_valid_command_token(command: &str) -> bool {
    !command.is_empty()
        && !command
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
}

/// Parse a document string (the pure seam the unit tests exercise). Version
/// routing first (ADR-0036), then the per-row `stream_format` gate: both
/// fail as explicit errors, so neither read face can accept a shape this
/// build would misinterpret.
fn parse_doc(raw: &str) -> Result<Vec<UserAdapterRow>, String> {
    let doc: UserAdaptersDoc = serde_json::from_str(raw).map_err(|e| format!("parse: {e}"))?;
    if doc.format_version != USER_ADAPTERS_FORMAT_VERSION {
        return Err(format!(
            "format_version {} is not supported by this build ({}); refusing",
            doc.format_version, USER_ADAPTERS_FORMAT_VERSION
        ));
    }
    // Id namespace rules (the file is hand-editable, so the parse boundary
    // enforces them): a row id may not collide with a built-in id -- the
    // merge resolves first-match v1-then-user, so a colliding row would be
    // silently shadowed, and deleting it would drop the built-in's catalog
    // cache -- and ids must be unique within the document (update finds the
    // first row, delete removes all: the same broken input must not carry
    // two different meanings).
    let builtin_ids: std::collections::HashSet<&str> =
        v1_adapters().iter().map(|spec| spec.id.as_str()).collect();
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for row in &doc.adapters {
        if row.stream_format != StreamFormat::Acp {
            return Err(format!(
                "adapter `{}` carries stream_format `{:?}`; user-defined adapters only support `acp`",
                row.id, row.stream_format
            ));
        }
        if builtin_ids.contains(row.id.as_str()) {
            return Err(format!(
                "adapter id `{}` collides with a built-in adapter id; user-defined rows must not shadow built-ins",
                row.id
            ));
        }
        if !seen_ids.insert(row.id.as_str()) {
            return Err(format!("duplicate adapter id `{}` in the registry", row.id));
        }
    }
    Ok(doc.adapters)
}

/// The managed state: the resolved sidecar path plus the in-process write
/// lock. One instance is managed by Tauri, so the mutex serializes every
/// read-modify-write (concurrent edits queue; neither row is lost).
pub struct UserAdapterStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl UserAdapterStore {
    /// Wrap the resolved app-data path (created by the setup hook with the
    /// same honest temp-dir fallback the other app-data roots use).
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// The registry path (display / diagnostics).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The picker-face read: NEVER refuses. Any failure (missing file, IO
    /// error, corrupt shape, newer format) means the user rows are simply
    /// absent -- the built-in rows render unchanged (`list_adapters` stays
    /// read-only-and-cannot-refuse). Warns once per read so a broken file is
    /// diagnosable from the log dir.
    pub fn load_for_picker(&self) -> Vec<UserAdapterRow> {
        match self.list() {
            Ok(rows) => rows,
            Err(detail) => {
                log::warn!(
                    target: "toptopduck::user_adapters",
                    "user adapter registry {} unreadable, user rows absent from the picker: {}",
                    self.path.display(),
                    detail
                );
                Vec::new()
            }
        }
    }

    /// The management-face read (settings tab): an honest error. A missing
    /// file is the normal first-run state and lists empty; every other
    /// failure surfaces, and the caller never rewrites the file on a failed
    /// read -- the user's input is never silently dropped (the sidecar's
    /// honest-degrade stance is a deliberate divergence, issue #1341).
    pub fn list(&self) -> Result<Vec<UserAdapterRow>, String> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(format!("read {}: {e}", self.path.display()));
            }
        };
        parse_doc(&raw)
    }

    /// One read-modify-write under the in-process lock: load, let the caller
    /// mutate the rows (its Result controls whether anything persists), save
    /// atomically. The write only happens when the mutation succeeded, so a
    /// rejected edit never touches the file.
    pub fn mutate<T>(
        &self,
        f: impl FnOnce(&mut Vec<UserAdapterRow>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Poisoning only happens on a panic mid-mutation; refusing the whole
        // face (not silently proceeding) is the honest answer for a store
        // whose rows are user input.
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("user adapter registry write lock poisoned".to_string());
        };
        let mut rows = self.list()?;
        let out = f(&mut rows)?;
        save_doc(&self.path, &rows)?;
        Ok(out)
    }
}

/// Serialize + persist the document: pretty JSON (hand-editable, stable
/// diffs), one ride on the shared atomic-write core on the private-
/// permissions face (a crash before the rename leaves the prior file
/// intact).
fn save_doc(target: &Path, rows: &[UserAdapterRow]) -> Result<(), String> {
    let doc = UserAdaptersDoc {
        format_version: USER_ADAPTERS_FORMAT_VERSION,
        adapters: rows.to_vec(),
    };
    let json = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    // The registry file's directory may not exist yet (first save on a fresh
    // install); the shared core deliberately does not create it.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    write_str_atomic(target, &json, WritePerms::Private).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(id: &str) -> UserAdapterRow {
        UserAdapterRow {
            id: id.to_string(),
            name: "My CLI".to_string(),
            command: "my-cli".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::from([("MY_KEY".to_string(), "secret".to_string())]),
            enabled: true,
            stream_format: StreamFormat::Acp,
        }
    }

    fn temp_store() -> (tempfile::TempDir, UserAdapterStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(USER_ADAPTERS_FILE_NAME);
        (dir, UserAdapterStore::new(path))
    }

    #[test]
    fn missing_file_lists_empty_on_both_faces() {
        // First run: no file yet. NOT an error on either face (the picker
        // shows built-ins only; the settings tab shows an empty registry).
        let (_dir, store) = temp_store();
        assert_eq!(store.list().expect("list"), Vec::new());
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn mutate_persists_and_round_trips() {
        let (_dir, store) = temp_store();
        let row = store
            .mutate(|rows| {
                rows.push(sample_row("user:11111111"));
                Ok(rows[0].clone())
            })
            .expect("create");
        assert_eq!(row.id, "user:11111111");
        assert_eq!(
            store.list().expect("list"),
            vec![sample_row("user:11111111")]
        );
        // The document carries the version stamp.
        let raw = std::fs::read_to_string(store.path()).expect("read");
        assert!(raw.contains("\"format_version\": 1"), "doc: {raw}");
    }

    /// Issue #1348: saving creates the registry file's parent directory on
    /// first write (fresh install) -- the shared core deliberately does not.
    #[test]
    fn mutate_creates_missing_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join(USER_ADAPTERS_FILE_NAME);
        let store = UserAdapterStore::new(path);
        store
            .mutate(|rows| {
                rows.push(sample_row("user:11111111"));
                Ok(())
            })
            .expect("create");
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[test]
    fn a_rejected_mutation_never_touches_the_file() {
        let (_dir, store) = temp_store();
        store
            .mutate(|rows| {
                rows.push(sample_row("user:11111111"));
                Ok(())
            })
            .expect("seed");
        let err = store
            .mutate(|rows| {
                let _ = rows;
                Err::<(), _>("validation rejected".to_string())
            })
            .expect_err("rejected mutation");
        assert_eq!(err, "validation rejected");
        // The seed row survived untouched.
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[test]
    fn corrupt_file_splits_the_two_faces() {
        // The picker never refuses (empty user rows); the management face
        // errors; and neither read rewrites the original bytes.
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), b"{ not json").expect("write");
        assert!(store.load_for_picker().is_empty());
        assert!(store.list().is_err());
        assert_eq!(
            std::fs::read(store.path()).expect("read"),
            b"{ not json".to_vec(),
            "a failed read never rewrites the file"
        );
    }

    #[test]
    fn a_newer_format_version_refuses() {
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), br#"{"format_version": 2, "adapters": []}"#).expect("write");
        let err = store.list().expect_err("newer format refuses");
        assert!(err.contains("format_version 2"), "{err}");
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn a_non_acp_stream_format_row_fails_to_parse() {
        let (_dir, store) = temp_store();
        std::fs::write(
            store.path(),
            br#"{"format_version": 1, "adapters": [{"id": "user:1", "name": "n", "command": "c", "stream_format": "codex_event_stream"}]}"#,
        )
        .expect("write");
        let err = store.list().expect_err("non-acp stream_format refuses");
        assert!(err.contains("stream_format"), "{err}");
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn missing_optional_fields_default() {
        // A hand-edited minimal row (no args / env / enabled) parses with the
        // documented defaults.
        let (_dir, store) = temp_store();
        std::fs::write(
            store.path(),
            br#"{"format_version": 1, "adapters": [{"id": "user:1", "name": "n", "command": "c", "stream_format": "acp"}]}"#,
        )
        .expect("write");
        let rows = store.list().expect("list");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].args.is_empty());
        assert!(rows[0].env.is_empty());
        assert!(rows[0].enabled, "enabled defaults to true");
    }

    #[test]
    fn command_token_validation() {
        assert!(is_valid_command_token("my-cli"));
        assert!(is_valid_command_token(r"C:\tools\cli.exe"));
        assert!(is_valid_command_token("/usr/local/bin/cli"));
        assert!(!is_valid_command_token(""));
        assert!(!is_valid_command_token("my cli"));
        assert!(!is_valid_command_token("my\tcli"));
        assert!(!is_valid_command_token(r#""my-cli""#));
        assert!(!is_valid_command_token("'my-cli'"));
    }

    #[test]
    fn an_id_colliding_with_a_builtin_refuses() {
        // A hand-edited row cannot shadow a built-in: the merge resolves
        // first-match v1-then-user, so a colliding id would silently resolve
        // to the built-in spec (and deleting it would drop the built-in's
        // catalog cache).
        let (_dir, store) = temp_store();
        let builtin_id = v1_adapters()[0].id.as_str().to_string();
        std::fs::write(
            store.path(),
            format!(
                r#"{{"format_version": 1, "adapters": [{{"id": "{builtin_id}", "name": "n", "command": "c", "stream_format": "acp"}}]}}"#
            ),
        )
        .expect("write");
        let err = store.list().expect_err("builtin-id collision refuses");
        assert!(err.contains("built-in adapter id"), "{err}");
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn duplicate_ids_within_the_registry_refuse() {
        let (_dir, store) = temp_store();
        std::fs::write(
            store.path(),
            r#"{"format_version": 1, "adapters": [{"id": "user:1", "name": "a", "command": "c", "stream_format": "acp"}, {"id": "user:1", "name": "b", "command": "c", "stream_format": "acp"}]}"#,
        )
        .expect("write");
        let err = store.list().expect_err("duplicate id refuses");
        assert!(err.contains("duplicate adapter id"), "{err}");
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn an_unknown_field_refuses_instead_of_vanishing() {
        // A mistyped key (args -> argss) parses the row but silently drops
        // the user's value, and the next successful save erases the key;
        // refusing keeps hand-edits honest (the module's own stance that
        // user input must never silently vanish).
        let (_dir, store) = temp_store();
        std::fs::write(
            store.path(),
            r#"{"format_version": 1, "adapters": [{"id": "user:1", "name": "n", "command": "c", "argss": ["--acp"], "stream_format": "acp"}]}"#,
        )
        .expect("write");
        let err = store.list().expect_err("unknown field refuses");
        assert!(err.contains("unknown field"), "{err}");
        assert!(store.load_for_picker().is_empty());
    }

    #[test]
    fn minted_ids_are_prefixed_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let id = mint_user_adapter_id();
            assert!(id.starts_with("user:"), "{id}");
            assert_eq!(id.len(), "user:".len() + 8, "{id}");
            assert!(seen.insert(id.clone()), "collision: {id}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_private_0600() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, store) = temp_store();
        store
            .mutate(|rows| {
                rows.push(sample_row("user:11111111"));
                Ok(())
            })
            .expect("save");
        let mode = std::fs::metadata(store.path())
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
