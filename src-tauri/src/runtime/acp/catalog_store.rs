//! The adapter catalog cache sidecar (ADR-0096 D5, issue #536).
//!
//! A separate app-data file `adapter-catalogs.json` -- NOT app-config: the
//! catalog is an observation snapshot, not user intent, and app-config's
//! frontend optimistic full-file write-back would silently clobber a backend
//! probe write (a concurrent-write race); a separate file removes the race
//! structurally. The probe click is the ONLY write point -- the catalogs
//! each turn's handshake produces are never written back (write
//! amplification with no payoff; the cache semantics are "a snapshot the
//! user explicitly verified").
//!
//! Corrupt-file tolerance is honest-degrade: a file that fails to parse is
//! treated as an empty cache (catalogs empty, consumers fall back to their
//! empty state) and the first probe rebuilds the file. No `format_version`
//! -- the data is a pure cache, never migrated, just rebuilt. Tolerance is
//! also forward-shape: the map is read as untyped JSON and each entry
//! parsed individually, so an entry written by a newer shape (extra /
//! renamed fields, an unknown `probe_kind`) is dropped rather than bricking
//! the whole cache.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::runtime::acp::adapter::DiscoveredRuntime;
use crate::runtime::acp::probe::{CatalogModel, ModelCatalogOutcome};

/// The file name under the OS app-data directory.
pub const CATALOGS_FILE_NAME: &str = "adapter-catalogs.json";

/// The temp-file suffix for the atomic write (same directory as the target
/// so the rename is intra-volume -- mirrors `persistence::io`).
const TMP_SUFFIX: &str = ".tmp";

/// Which probe channel produced the cached catalog (ADR-0096 D2 -- the
/// per-format dispatch dimension, not the CLI identity). Serialized as the
/// bare lowercase name; an unknown value at parse time drops the entry
/// (a newer app's shape, honest-degrade).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeKind {
    Acp,
    JsonEventStream,
}

/// The per-adapter outcome the cache stores: the probe result that produced
/// it, tagged by channel. The JsonEventStream degraded state (`Unavailable`) is never
/// cached -- the entry then keeps the last usable catalog or stays absent,
/// so the cache always holds a usable snapshot (ADR-0096 D5: only a
/// successful catalog is a cache point).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CachedOutcome {
    Acp { discovered: DiscoveredRuntime },
    JsonEventStream { models: Vec<CatalogModel> },
}

impl AdapterCatalogEntry {
    /// Whether the tagged channel matches the outcome payload's variant.
    /// serde parses each field independently, so a hand-edited file can pair
    /// `probe_kind: "acp"` with a JsonEventStream outcome; the load path drops such an
    /// entry on the same per-entry honest-degrade footing as an unparsable
    /// one (the file is a human-inspectable artifact).
    fn is_consistent(&self) -> bool {
        matches!(
            (self.probe_kind, &self.outcome),
            (ProbeKind::Acp, CachedOutcome::Acp { .. })
                | (
                    ProbeKind::JsonEventStream,
                    CachedOutcome::JsonEventStream { .. }
                )
        )
    }
}

impl CachedOutcome {
    /// Build the cacheable outcome from a probe success, or `None` for the
    /// degraded state (not cached -- see the type comment). Returns the
    /// producing channel alongside so the caller stamps the entry's
    /// `probe_kind` from the SAME dispatch (one match, no drift between the
    /// tag and the payload).
    pub fn from_probe(probe: &crate::runtime::acp::probe::ProbeOk) -> Option<(ProbeKind, Self)> {
        use crate::runtime::acp::probe::ProbeOk;
        match probe {
            ProbeOk::Acp { discovered } => Some((
                ProbeKind::Acp,
                Self::Acp {
                    discovered: discovered.clone(),
                },
            )),
            ProbeOk::JsonEventStream {
                outcome: ModelCatalogOutcome::Available { models },
            } => Some((
                ProbeKind::JsonEventStream,
                Self::JsonEventStream {
                    models: models.clone(),
                },
            )),
            ProbeOk::JsonEventStream {
                outcome: ModelCatalogOutcome::Unavailable { .. },
            } => None,
        }
    }
}

/// One adapter's cache entry (ADR-0096 D5): the catalog plus the wall-clock
/// probe timestamp. Display-only -- it never participates in the picker's
/// priority chain (ADR-0096 D6).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AdapterCatalogEntry {
    /// The channel that produced the catalog (selects the consumer's
    /// per-format rendering).
    pub probe_kind: ProbeKind,
    pub outcome: CachedOutcome,
    /// Unix epoch milliseconds. A display-only freshness stamp.
    pub probed_at_millis: i64,
}

/// The cache document: one entry per adapter id, keyed by the spec id
/// (`gemini-cli`, `codex`, ...).
pub type AdapterCatalogs = HashMap<String, AdapterCatalogEntry>;

/// The managed state: the resolved sidecar path plus the in-process write
/// lock. One instance is managed by Tauri, so the mutex serializes every
/// read-modify-write through the single writer (concurrent probes of
/// different adapters queue; neither entry is lost). No lock is held across
/// the load() read path -- it never takes the mutex.
pub struct AdapterCatalogStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl AdapterCatalogStore {
    /// Wrap the resolved app-data path (created by the setup hook with the
    /// same honest temp-dir fallback the other app-data roots use).
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// The sidecar path (display / diagnostics).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the whole cache. Honest-degrade on every failure mode (missing
    /// file, IO error, invalid JSON, a per-entry parse failure): the failed
    /// entries drop, the rest survive, the caller never sees an error -- an
    /// unreadable cache is an empty cache. Never refuses and never takes
    /// the write lock, so the IPC read command stays lock-light.
    pub fn load(&self) -> AdapterCatalogs {
        let Ok(raw) = std::fs::read_to_string(&self.path) else {
            return HashMap::new();
        };
        match load_from_str(&raw) {
            Ok(map) => map,
            Err(detail) => {
                log::warn!(
                    target: "toptopduck::catalog_cache",
                    "adapter catalog cache {} unreadable, treating as empty: {}",
                    self.path.display(),
                    detail
                );
                HashMap::new()
            }
        }
    }

    /// Overwrite ONE adapter's entry, leaving every other adapter's entry
    /// untouched (ADR-0096 D5: re-probing an adapter replaces only its own
    /// slot). Read-modify-write under the in-process write lock, then one
    /// atomic temp+rename write. Write failures are logged and swallowed:
    /// the probe result still returns to the caller (the cache is an
    /// enhancement, never a dependency of the probe's own answer).
    pub fn store_entry(&self, adapter_id: &str, entry: AdapterCatalogEntry) {
        // Poisoning only happens on a panic mid-write; treating the cache as
        // unlockable (skip the write, keep serving reads) is the honest
        // degrade for a pure-cache artifact.
        let Ok(_guard) = self.write_lock.lock() else {
            log::warn!(
                target: "toptopduck::catalog_cache",
                "catalog cache write lock poisoned; skipping cache write for `{adapter_id}`"
            );
            return;
        };
        if let Err(detail) = self.store_entry_locked(adapter_id, entry) {
            log::warn!(
                target: "toptopduck::catalog_cache",
                "adapter catalog cache write failed for `{adapter_id}` (probe result unaffected): {detail}"
            );
        }
    }

    /// The locked read-modify-write core, split out so the failure detail
    /// reads as one typed Result.
    fn store_entry_locked(
        &self,
        adapter_id: &str,
        entry: AdapterCatalogEntry,
    ) -> Result<(), String> {
        let mut catalogs = self.load();
        catalogs.insert(adapter_id.to_string(), entry);
        let json =
            serde_json::to_string_pretty(&catalogs).map_err(|e| format!("serialize: {e}"))?;
        write_atomic(&self.path, &json)
    }
}

/// Parse a cache document string into the typed map (the pure seam the unit
/// tests exercise). Per-entry tolerance: the raw map is walked as untyped
/// JSON so one unparsable entry drops without discarding the rest.
fn load_from_str(raw: &str) -> Result<AdapterCatalogs, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("parse: {e}"))?;
    let Some(obj) = value.as_object() else {
        return Err("top-level value is not an object".to_string());
    };
    let mut out = HashMap::new();
    for (id, entry_value) in obj {
        match serde_json::from_value::<AdapterCatalogEntry>(entry_value.clone()) {
            Ok(entry) if entry.is_consistent() => {
                out.insert(id.clone(), entry);
            }
            Err(e) => {
                // A single bad entry (hand-edited, or a newer app's shape)
                // drops; the rest of the cache stays usable.
                log::warn!(
                    target: "toptopduck::catalog_cache",
                    "adapter catalog entry `{id}` unparsable, dropped: {e}"
                );
            }
            Ok(_) => {
                log::warn!(
                    target: "toptopduck::catalog_cache",
                    "adapter catalog entry `{id}` has a mismatched probe_kind/outcome pair, dropped"
                );
            }
        }
    }
    Ok(out)
}

/// Write a string payload atomically: `<target>.tmp` in the same directory,
/// fsync, rename over the target (mirrors `persistence::io::save_atomic`;
/// a crash before the rename leaves the prior target intact).
fn write_atomic(target: &Path, json: &str) -> Result<(), String> {
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "could not derive temp file path".to_string())?;
    let tmp = target.with_file_name(format!("{file_name}{TMP_SUFFIX}"));
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        file.sync_all().map_err(|e| format!("sync temp: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

/// Now, wall-clock milliseconds since the Unix epoch (the entry stamp).
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acp_entry(model: &str, at: i64) -> AdapterCatalogEntry {
        AdapterCatalogEntry {
            probe_kind: ProbeKind::Acp,
            outcome: CachedOutcome::Acp {
                discovered: DiscoveredRuntime {
                    models: vec![model.to_string()],
                    current_model: Some(model.to_string()),
                    thought_levels: vec![],
                    current_thought_level: None,
                    model_config_id: None,
                    thought_level_config_id: None,
                    adapter_id: Some("gemini-cli".to_string()),
                },
            },
            probed_at_millis: at,
        }
    }

    fn codex_entry(at: i64) -> AdapterCatalogEntry {
        AdapterCatalogEntry {
            probe_kind: ProbeKind::JsonEventStream,
            outcome: CachedOutcome::JsonEventStream {
                models: vec![CatalogModel {
                    id: "gpt-5.2-codex".to_string(),
                    display_name: "GPT-5.2 Codex".to_string(),
                    is_default: true,
                    default_reasoning_effort: "medium".to_string(),
                    supported_reasoning_efforts: vec!["low".into(), "medium".into()],
                }],
            },
            probed_at_millis: at,
        }
    }

    fn temp_store() -> (tempfile::TempDir, AdapterCatalogStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AdapterCatalogStore::new(dir.path().join(CATALOGS_FILE_NAME));
        (dir, store)
    }

    #[test]
    fn load_missing_file_is_empty() {
        let (_dir, store) = temp_store();
        assert!(store.load().is_empty());
    }

    #[test]
    fn load_corrupt_file_degrades_to_empty() {
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), b"{ not json").expect("write");
        assert!(store.load().is_empty());
    }

    #[test]
    fn load_non_object_top_level_degrades_to_empty() {
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), b"[1,2,3]").expect("write");
        assert!(store.load().is_empty());
    }

    #[test]
    fn store_entry_round_trips() {
        let (_dir, store) = temp_store();
        store.store_entry("gemini-cli", acp_entry("opus", 1_000));
        let loaded = store.load();
        assert_eq!(loaded.get("gemini-cli"), Some(&acp_entry("opus", 1_000)));
    }

    #[test]
    fn retest_overwrites_only_that_adapter() {
        let (_dir, store) = temp_store();
        store.store_entry("gemini-cli", acp_entry("opus", 1_000));
        store.store_entry("codex", codex_entry(2_000));
        // Re-probe gemini-cli: only its slot moves.
        store.store_entry("gemini-cli", acp_entry("sonnet", 3_000));
        let loaded = store.load();
        assert_eq!(loaded.get("gemini-cli"), Some(&acp_entry("sonnet", 3_000)));
        assert_eq!(loaded.get("codex"), Some(&codex_entry(2_000)));
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn concurrent_store_entries_both_land() {
        // Two adapters probed concurrently: the in-process lock serializes
        // the read-modify-write, so neither entry is lost (issue #536 AC:
        // multi-adapter entry independence under concurrency).
        let dir = tempfile::tempdir().expect("tempdir");
        let store = std::sync::Arc::new(AdapterCatalogStore::new(
            dir.path().join(CATALOGS_FILE_NAME),
        ));
        let a = std::thread::spawn({
            let store = store.clone();
            move || store.store_entry("gemini-cli", acp_entry("opus", 1_000))
        });
        let b = std::thread::spawn({
            let store = store.clone();
            move || store.store_entry("codex", codex_entry(2_000))
        });
        a.join().expect("thread a");
        b.join().expect("thread b");
        let loaded = store.load();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get("gemini-cli"), Some(&acp_entry("opus", 1_000)));
        assert_eq!(loaded.get("codex"), Some(&codex_entry(2_000)));
    }

    #[test]
    fn one_bad_entry_drops_others_survive() {
        let (_dir, store) = temp_store();
        store.store_entry("gemini-cli", acp_entry("opus", 1_000));
        // Hand-corrupt one entry's shape, leaving the other intact.
        let raw = std::fs::read_to_string(store.path()).expect("read");
        let mut doc: serde_json::Value = serde_json::from_str(&raw).expect("valid json doc");
        doc["codex"] = serde_json::json!({"probe_kind": "from-the-future"});
        std::fs::write(store.path(), serde_json::to_string(&doc).unwrap()).expect("write");
        let loaded = store.load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("gemini-cli"), Some(&acp_entry("opus", 1_000)));
    }

    #[test]
    fn store_rebuilds_over_a_corrupt_file() {
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), b"garbage").expect("write");
        store.store_entry("codex", codex_entry(5_000));
        assert_eq!(store.load().get("codex"), Some(&codex_entry(5_000)));
        assert_eq!(store.load().len(), 1);
    }

    #[test]
    fn unavailable_codex_outcome_is_not_cacheable() {
        use crate::runtime::acp::probe::{ModelCatalogOutcome, ProbeOk};
        let degraded = ProbeOk::JsonEventStream {
            outcome: ModelCatalogOutcome::Unavailable {
                detail: "not logged in".to_string(),
            },
        };
        assert_eq!(CachedOutcome::from_probe(&degraded), None);
    }

    #[test]
    fn from_probe_tags_the_channel_with_the_payload() {
        use crate::runtime::acp::probe::ProbeOk;
        let (kind, outcome) = CachedOutcome::from_probe(&ProbeOk::Acp {
            discovered: DiscoveredRuntime::empty(),
        })
        .expect("acp caches");
        assert_eq!(kind, ProbeKind::Acp);
        assert!(matches!(outcome, CachedOutcome::Acp { .. }));
    }

    // The branch a real successful codex probe takes: an available catalog
    // caches as the JsonEventStream-tagged outcome (the integration fixtures hand-build
    // entries, so this is the only pin on the clone + tag).
    #[test]
    fn from_probe_caches_an_available_codex_catalog() {
        use crate::runtime::acp::probe::{ModelCatalogOutcome, ProbeOk};
        let models = match codex_entry(0).outcome {
            CachedOutcome::JsonEventStream { models } => models,
            other => panic!("fixture is not a JsonEventStream outcome: {other:?}"),
        };
        let probe = ProbeOk::JsonEventStream {
            outcome: ModelCatalogOutcome::Available { models },
        };
        let (kind, outcome) = CachedOutcome::from_probe(&probe).expect("available catalog caches");
        assert_eq!(kind, ProbeKind::JsonEventStream);
        assert_eq!(outcome, codex_entry(0).outcome);
    }

    // A hand-edited file can pair an acp tag with a JsonEventStream payload (serde
    // parses the fields independently); the load drops the entry instead of
    // surfacing an inconsistent one to the consumer's per-format dispatch.
    #[test]
    fn mismatched_kind_outcome_pair_drops() {
        let (_dir, store) = temp_store();
        store.store_entry("gemini-cli", acp_entry("opus", 1_000));
        let raw = std::fs::read_to_string(store.path()).expect("read");
        let mut doc: serde_json::Value = serde_json::from_str(&raw).expect("valid json doc");
        doc["codex"] = serde_json::json!({
            "probe_kind": "acp",
            "outcome": { "json_event_stream": { "models": [] } },
            "probed_at_millis": 2_000
        });
        std::fs::write(store.path(), serde_json::to_string(&doc).unwrap()).expect("write");
        let loaded = store.load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("gemini-cli"), Some(&acp_entry("opus", 1_000)));
    }
}
