//! Adapter catalog cache sidecar integration tests (ADR-0096 D5, issue #536).
//!
//! Pins the FILE-level behavior of the `AdapterCatalogStore` sidecar: the
//! documented file name under the root, the on-disk JSON shape (pretty,
//! snake_case, string-keyed), the restart read (a fresh store over the same
//! path sees the same content -- the read the settings tab performs after an
//! app restart), and multi-adapter independence under concurrent writes.
//! The pure semantic seams (overwrite-only-own-entry, corrupt-file
//! honest-degrade, per-entry tolerance) are covered by the module's unit
//! tests -- these tests do not duplicate them.

use std::sync::Arc;

use toptopduck_lib::runtime::acp::adapter::DiscoveredRuntime;
use toptopduck_lib::runtime::acp::catalog_store::{
    AdapterCatalogEntry, AdapterCatalogStore, CachedOutcome, ProbeKind, CATALOGS_FILE_NAME,
};
use toptopduck_lib::runtime::acp::probe::CodexModel;

/// The file the store mints under the given root: `adapter-catalogs.json`
/// (ADR-0096 D5 names the file).
#[test]
fn store_writes_the_documented_file_name() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = AdapterCatalogStore::new(dir.path().join(CATALOGS_FILE_NAME));
    assert!(store.path().ends_with(CATALOGS_FILE_NAME));
    assert!(store.load().is_empty());
    store.store_entry("claude-code", acp_entry(1_000));
    assert!(dir.path().join(CATALOGS_FILE_NAME).is_file());
}

/// The restart read: entries written by one store instance survive into a
/// FRESH instance over the same path (the settings tab's after-restart
/// display), with other adapters' entries alongside.
#[test]
fn a_fresh_store_over_the_same_path_reads_the_prior_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(CATALOGS_FILE_NAME);
    AdapterCatalogStore::new(path.clone()).store_entry("claude-code", acp_entry(1_000));
    AdapterCatalogStore::new(path.clone()).store_entry("codex", codex_entry(2_000));

    let reopened = AdapterCatalogStore::new(path);
    let loaded = reopened.load();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded.get("claude-code"), Some(&acp_entry(1_000)));
    assert_eq!(loaded.get("codex"), Some(&codex_entry(2_000)));
}

/// AC (multi-adapter entry independence under concurrent sessions): two
/// adapters stored from two threads both land -- the in-process write lock
/// serializes the read-modify-write, so neither entry is lost.
#[test]
fn concurrent_multi_adapter_writes_land_independently() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(AdapterCatalogStore::new(
        dir.path().join(CATALOGS_FILE_NAME),
    ));

    let a = std::thread::spawn({
        let store = store.clone();
        move || store.store_entry("claude-code", acp_entry(1_000))
    });
    let b = std::thread::spawn({
        let store = store.clone();
        move || store.store_entry("codex", codex_entry(2_000))
    });
    a.join().expect("thread a");
    b.join().expect("thread b");

    let loaded = store.load();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded.get("claude-code"), Some(&acp_entry(1_000)));
    assert_eq!(loaded.get("codex"), Some(&codex_entry(2_000)));
}

/// The on-disk JSON shape is human-inspectable (pretty, snake_case,
/// string-keyed map) -- the cache file is a readable artifact, matching the
/// recipe / app-config file conventions.
#[test]
fn file_shape_is_pretty_snake_case_json() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(CATALOGS_FILE_NAME);
    let store = AdapterCatalogStore::new(path.clone());
    store.store_entry("codex", codex_entry(1_725_000_000_000));

    let raw = std::fs::read_to_string(&path).expect("read");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
    assert_eq!(doc["codex"]["probe_kind"], "codex");
    assert_eq!(doc["codex"]["probed_at_millis"], 1_725_000_000_000i64);
    assert!(raw.contains('\n'), "pretty-printed");
}

// --- fixtures --------------------------------------------------------------

fn acp_entry(at: i64) -> AdapterCatalogEntry {
    AdapterCatalogEntry {
        probe_kind: ProbeKind::Acp,
        outcome: CachedOutcome::Acp {
            discovered: DiscoveredRuntime {
                models: vec!["fake-opus".to_string()],
                current_model: Some("fake-opus".to_string()),
                thought_levels: vec!["low".to_string(), "high".to_string()],
                current_thought_level: Some("high".to_string()),
                model_config_id: None,
                thought_level_config_id: None,
                adapter_id: Some("claude-code".to_string()),
            },
        },
        probed_at_millis: at,
    }
}

fn codex_entry(at: i64) -> AdapterCatalogEntry {
    AdapterCatalogEntry {
        probe_kind: ProbeKind::Codex,
        outcome: CachedOutcome::Codex {
            models: vec![CodexModel {
                id: "gpt-5.2-codex".to_string(),
                display_name: "GPT-5.2 Codex".to_string(),
                is_default: true,
                default_reasoning_effort: "medium".to_string(),
                supported_reasoning_efforts: vec!["low".to_string(), "medium".to_string()],
            }],
        },
        probed_at_millis: at,
    }
}
