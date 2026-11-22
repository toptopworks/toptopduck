//! The runtime model catalog (issue #1638, ADR-0152): the models.dev-sourced
//! exact-id tier that lifts the occupancy denominator, the turn output cap,
//! and the effort tiers off the release cadence.
//!
//! The static prefix tables (`context_window` / `output_cap`) ride releases,
//! so a new model id sat hollow (context) or on the fallback (output) until
//! the next release shipped a hand-added row. This module adds the two
//! fresher tiers ahead of them, one shape for both:
//!
//! - **Build-time snapshot** -- the release flow's generator step fetches
//!   `https://models.dev/api.json`, trims it to a compact schema (unique
//!   model id -> display name / context window / output cap / effort tier
//!   values), and gzips it into the binary (`include_bytes!` via the build
//!   script's staged file; ~60KB). The repo carries no hand-maintained data
//!   file; a build without the generator step embeds an empty snapshot and
//!   every lookup falls to the prefix tables unchanged.
//! - **Disk cache** -- `<app_data_dir>/model-catalog.json.gz`, the SAME
//!   compact schema, so an upstream schema revamp only ever affects newly
//!   fetched data (additive serde fields keep an old cache parseable; a
//!   corrupt cache is silently skipped, never deleted).
//!
//! The lookup chain is **cache exact id -> snapshot exact id -> prefix
//! table -> hollow/fallback**; the prefix tables keep their role for
//! uncataloged aliases and custom deployment ids, refreshed only when a
//! whole new family ships. Ids are matched lowercased on both sides
//! (upstream ids carry casing like `MiniMax-M2`).
//!
//! Refresh is lazy and silent: nothing fetches at startup, on a schedule,
//! or on a miss -- only a cache older than 24h plus a consuming built-in
//! turn start (the live factory; the future posture menu joins at #1639)
//! spawns ONE detached background fetch that answers the triggering turn
//! from the old data. CLI channel occupancy stamps read the chain but
//! never trigger, so zero-profile and CLI-only setups make the process
//! egress nothing to this endpoint. Fetch/offline/parse failures keep the
//! old cache (or the snapshot) with no UI and no user-visible state; the
//! retry cadence is the same TTL, not a backoff ladder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::provider::output_cap;

/// The one public endpoint the catalog ever talks to (ADR-0152): a public,
/// unauthenticated JSON dump. Public so the release-flow generator bin
/// reuses the same fetch path.
pub const UPSTREAM_URL: &str = "https://models.dev/api.json";

/// Cache freshness and retry cadence in one constant: a fetched-at within
/// this window is fresh (zero egress), and a failed attempt also silences
/// further attempts for the same window (the lazy pipeline's self-heal
/// across long-running sessions -- deliberately not a backoff ladder).
const CATALOG_TTL_SECS: u64 = 24 * 60 * 60;

/// Per-request timeout for the background fetch (detached thread, so this
/// only bounds how long the silent worker lives).
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The staged snapshot bytes (ADR-0152): `include_bytes!` resolves against
/// the build script's `OUT_DIR` copy of `snapshots/model-catalog.gz` -- the
/// file the release generator writes into the gitignored staging dir. Absent
/// at build time, the build script stages an empty file and the embedded tier is
/// simply empty. Test builds keep the tier empty (and skip decoding) so the
/// suite never depends on a locally generated snapshot.
#[cfg(not(any(test, feature = "test-fixtures")))]
static SNAPSHOT_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/model-catalog.gz"));

/// The decoded embedded snapshot. Empty in test/test-fixtures builds: the
/// suite pins the chain through the pure tiered lookups and the disk-cache
/// seam, and must stay hermetic when a real snapshot happens to sit on the
/// dev machine's disk.
#[cfg(not(any(test, feature = "test-fixtures")))]
static SNAPSHOT: LazyLock<CompactCatalog> =
    LazyLock::new(|| decode_catalog(SNAPSHOT_BYTES).unwrap_or_default());

#[cfg(any(test, feature = "test-fixtures"))]
static SNAPSHOT: LazyLock<CompactCatalog> = LazyLock::new(CompactCatalog::default);

fn snapshot_catalog() -> &'static CompactCatalog {
    &SNAPSHOT
}

/// The compact catalog schema -- the single shape the snapshot and the disk
/// cache share (ADR-0152). Serde treats every field as optional/additive so
/// an older cache file keeps parsing after the schema grows (unknown fields
/// are ignored, absent fields default); a cache that no longer parses is
/// skipped silently, never rewritten from the snapshot.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CompactCatalog {
    /// Unix seconds of the successful upstream fetch this data came from;
    /// 0 for the empty shape (freshness reads it, lookups never do).
    #[serde(default)]
    pub(crate) fetched_at: u64,
    /// Lowercased unique model ids (upstream ids carry casing; both sides
    /// normalize so a cased picker entry resolves).
    #[serde(default)]
    pub(crate) models: HashMap<String, CompactEntry>,
}

/// One model's catalog payload. An entry with `None` in a field falls
/// through that field to the next tier (the 1.4% of upstream rows without
/// `limit.context` still get the prefix table's family answer).
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CompactEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_cap: Option<u32>,
    /// The discrete effort tier values (the `{"type": "effort", "values"}`
    /// reasoning option); `None` for toggle-only / budget-only rows -- v1
    /// consumes discrete tiers only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effort_tiers: Option<Vec<String>>,
}

/// Trim an upstream `api.json` document into the compact schema. Duplicate
/// model ids across providers resolve deterministically: a row whose
/// `canonical_model_id` names its own provider (the lab's own listing) is
/// AUTHORITATIVE and outranks any earlier writer -- resellers sorting
/// alphabetically ahead of the lab (digit-prefixed ids sort first) can
/// carry stale limits, and a stale sub-cap output row would under-cap a
/// current model (the #1001 truncation shape). Among non-canonical rows
/// the first sorted provider wins. Entries with no payload at all (no
/// name, no limits, no effort tiers) are dropped: they can answer nothing.
/// The snapshot and every runtime refresh share this trim, so the same
/// upstream bytes always produce the same catalog.
pub(crate) fn trim_upstream(api: &serde_json::Value, fetched_at: u64) -> CompactCatalog {
    let mut models = HashMap::new();
    let mut canonical_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let Some(providers) = api.as_object() else {
        return CompactCatalog { fetched_at, models };
    };
    let mut provider_ids: Vec<&String> = providers.keys().collect();
    provider_ids.sort();
    for provider_id in provider_ids {
        let Some(upstream_models) = providers[provider_id]
            .get("models")
            .and_then(|m| m.as_object())
        else {
            continue;
        };
        for (model_id, model) in upstream_models {
            let key = model_id.to_lowercase();
            // The lab's own row for this id: canonical_model_id names this
            // provider as the source.
            let is_canonical = model
                .get("canonical_model_id")
                .and_then(|v| v.as_str())
                .is_some_and(|canonical| {
                    canonical
                        .strip_prefix(provider_id)
                        .is_some_and(|rest| rest.starts_with('/'))
                });
            let outranks =
                is_canonical && !canonical_keys.contains(&key) && models.contains_key(&key);
            if models.contains_key(&key) && !outranks {
                continue;
            }
            let entry = compact_entry(model);
            if entry == CompactEntry::default() {
                continue;
            }
            models.insert(key.clone(), entry);
            if is_canonical {
                canonical_keys.insert(key);
            }
        }
    }
    CompactCatalog { fetched_at, models }
}

/// Project one upstream model row onto the compact entry: `name` (display),
/// `limit.context` / `limit.output`, and the `effort` reasoning option's
/// discrete `values` (toggle / budget_tokens rows carry no tier list).
/// Every field optional -- a malformed or partial row degrades to `None`
/// fields, never to a parse failure.
fn compact_entry(model: &serde_json::Value) -> CompactEntry {
    let effort_tiers = model
        .get("reasoning_options")
        .and_then(|options| options.as_array())
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("type").and_then(|t| t.as_str()) == Some("effort"))
        })
        .and_then(|option| option.get("values"))
        .and_then(|values| values.as_array())
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        });
    CompactEntry {
        display_name: model
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        // Upstream writes unknown limits as 0 (the image/embedding class);
        // a 0 output cap would stamp a guaranteed-rejected request (both
        // wire protocols floor max_tokens at 1), so 0 reads as absent.
        context_window: model
            .pointer("/limit/context")
            .and_then(|v| v.as_u64())
            .filter(|&v| v > 0),
        output_cap: model
            .pointer("/limit/output")
            .and_then(|v| v.as_u64())
            .filter(|&v| v > 0)
            .and_then(|v| u32::try_from(v).ok()),
        effort_tiers,
    }
}

/// Decode gzip+JSON bytes into a catalog. Empty input is the empty catalog
/// (the build script's placeholder); anything undecodable is `None` -- the
/// caller treats it as absent, which is the whole silent-failure posture.
pub(crate) fn decode_catalog(bytes: &[u8]) -> Option<CompactCatalog> {
    if bytes.is_empty() {
        return Some(CompactCatalog::default());
    }
    serde_json::from_reader(GzDecoder::new(bytes)).ok()
}

/// Encode a catalog as gzip+JSON (the snapshot and cache file format).
pub(crate) fn encode_catalog(catalog: &CompactCatalog) -> Result<Vec<u8>, std::io::Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    serde_json::to_writer(&mut encoder, catalog)?;
    encoder.finish()
}

// --- the lookup chain ----------------------------------------------------

/// Resolve the occupancy-ring denominator through the full chain: cache
/// exact id -> snapshot exact id -> the static prefix table (which keeps
/// the family-boundary semantics for uncataloged aliases and deployment
/// ids). `None` stays the hollow ring.
pub(crate) fn context_window(model_name: &str) -> Option<u64> {
    let cache = cache_catalog();
    tiered_context_window(cache.as_deref(), Some(snapshot_catalog()), model_name)
}

/// Resolve the turn output cap through the full chain, folded through the
/// output-cap formula (`entry ?? CAP`, then `min(_, CAP)`): an exact-id hit
/// with an output limit, else the low-cap prefix table, else the global
/// cap. An exact entry at/over the cap clamps to it, keeping the formula's
/// asymmetric failure direction.
pub(crate) fn output_cap(model_name: &str) -> u32 {
    let cache = cache_catalog();
    tiered_output_cap(cache.as_deref(), Some(snapshot_catalog()), model_name)
}

/// Resolve a model's discrete effort tiers (exact-id tiers only; the
/// prefix tables carry no reasoning data). The posture-menu consumption
/// entry -- dead code until #1639 wires its caller.
#[allow(dead_code)]
pub(crate) fn effort_tiers(model_name: &str) -> Option<Vec<String>> {
    let cache = cache_catalog();
    tiered_effort_tiers(cache.as_deref(), Some(snapshot_catalog()), model_name)
}

/// The pure chain over explicit tiers -- the seam the order-pinning tests
/// drive (the wrappers above only resolve the process-global tiers).
fn tiered_context_window(
    cache: Option<&CompactCatalog>,
    snapshot: Option<&CompactCatalog>,
    model_name: &str,
) -> Option<u64> {
    exact_entry(cache, snapshot, model_name)
        .and_then(|entry| entry.context_window)
        .or_else(|| crate::provider::context_window::context_window(model_name))
}

fn tiered_output_cap(
    cache: Option<&CompactCatalog>,
    snapshot: Option<&CompactCatalog>,
    model_name: &str,
) -> u32 {
    let exact = exact_entry(cache, snapshot, model_name).and_then(|entry| entry.output_cap);
    output_cap::clamp_entry(exact.or_else(|| output_cap::catalog_output(model_name)))
}

#[allow(dead_code)]
fn tiered_effort_tiers(
    cache: Option<&CompactCatalog>,
    snapshot: Option<&CompactCatalog>,
    model_name: &str,
) -> Option<Vec<String>> {
    exact_entry(cache, snapshot, model_name).and_then(|entry| entry.effort_tiers.clone())
}

/// Exact-id lookup across the two fresher tiers (cache outranks snapshot).
/// A hit with a missing field returns the entry anyway -- the per-field
/// `or_else` at each caller decides whether that falls through to the
/// prefix table.
fn exact_entry<'a>(
    cache: Option<&'a CompactCatalog>,
    snapshot: Option<&'a CompactCatalog>,
    model_name: &str,
) -> Option<&'a CompactEntry> {
    let normalized = model_name.to_lowercase();
    cache
        .and_then(|catalog| catalog.models.get(&normalized))
        .or_else(|| snapshot.and_then(|catalog| catalog.models.get(&normalized)))
}

// --- the disk cache and the lazy refresh ---------------------------------

/// The cache file's location, anchored once at app setup (the
/// `app_data_path` pattern). Unset in tests and bare library runs -- every
/// refresh-capable path early-returns on it, which is the zero-profile /
/// CLI-only zero-egress guarantee's structural half.
static CACHE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Anchor the disk cache location (app setup, once).
pub(crate) fn init_cache_path(path: PathBuf) {
    let _ = CACHE_PATH.set(path);
}

/// In-process cache state: the loaded catalog (read once from disk, then
/// only ever replaced by a successful in-process refresh) and the
/// attempt ledger that caps fetches at one per TTL window.
#[derive(Default)]
struct CacheState {
    loaded: Option<Arc<CompactCatalog>>,
    last_attempt: Option<u64>,
}

static CACHE_STATE: LazyLock<Mutex<CacheState>> =
    LazyLock::new(|| Mutex::new(CacheState::default()));

fn cache_state() -> MutexGuard<'static, CacheState> {
    CACHE_STATE
        .lock()
        .expect("model catalog state lock poisoned")
}

/// The cache tier: load the file once per process (under the caller's
/// held lock), then serve from memory. An absent or undecodable file
/// leaves the tier empty -- silent, and retryable by the next refresh.
fn load_cache_locked(state: &mut CacheState, path: &Path) {
    if state.loaded.is_some() {
        return;
    }
    if let Ok(bytes) = std::fs::read(path) {
        if let Some(catalog) = decode_catalog(&bytes) {
            state.loaded = Some(Arc::new(catalog));
        }
    }
}

fn cache_catalog() -> Option<Arc<CompactCatalog>> {
    let path = CACHE_PATH.get()?;
    cache_catalog_at(&CACHE_STATE, path)
}

/// Load-once-then-serve over an explicit state and cache path -- the seam
/// the disk-scenario tests drive. The process-global `CACHE_PATH`
/// anchors once per process, so a second disk scenario (a corrupt file
/// next to a healthy one) cannot ride the real entry points; it drives
/// this seam with its own state instead.
fn cache_catalog_at(state: &Mutex<CacheState>, path: &Path) -> Option<Arc<CompactCatalog>> {
    let mut state = state.lock().expect("model catalog state lock poisoned");
    load_cache_locked(&mut state, path);
    state.loaded.clone()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The refresh cadence as a pure decision: fetch only when the loaded
/// cache is stale (or absent) AND the last attempt is outside the TTL
/// window. Fresh cache -> never; a recent failed attempt -> wait out the
/// same TTL (no backoff ladder, ADR-0152).
fn refresh_decision(loaded_fetched_at: Option<u64>, last_attempt: Option<u64>, now: u64) -> bool {
    let fresh = loaded_fetched_at.is_some_and(|t| now.saturating_sub(t) < CATALOG_TTL_SECS);
    if fresh {
        return false;
    }
    !last_attempt.is_some_and(|t| now.saturating_sub(t) < CATALOG_TTL_SECS)
}

/// The lazy consumption trigger (ADR-0152), called from the built-in
/// turn's live factory -- the one call site that implies a provider
/// profile exists. Answers immediately from the current data (the turn
/// never blocks); a detached worker does the fetching. Unit-test builds
/// compile this to a no-op (hermetic suite -- no egress to the real
/// endpoint); integration-test builds keep the real arm, which is inert
/// there because nothing anchors the cache path outside the app's setup.
/// The decision+arming critical section the lazy trigger rides: one lock
/// guard spans the disk load, the staleness decision, and the attempt-
/// ledger write, so two concurrent turn starts cannot both pass the
/// decision and each spawn a fetch (ADR-0152's one-fetch-per-window
/// contract). Extracted over an explicit state and path -- the unit
/// suite drives it directly, since the compiled-out live trigger below
/// cannot pin the section as a whole.
fn arm_refresh(state: &Mutex<CacheState>, path: &Path, now: u64) -> bool {
    let mut state = state.lock().expect("model catalog state lock poisoned");
    load_cache_locked(&mut state, path);
    let loaded_fetched_at = state.loaded.as_ref().map(|catalog| catalog.fetched_at);
    if !refresh_decision(loaded_fetched_at, state.last_attempt, now) {
        return false;
    }
    state.last_attempt = Some(now);
    true
}

#[cfg(not(test))]
pub(crate) fn ensure_fresh() {
    let Some(path) = CACHE_PATH.get().cloned() else {
        return;
    };
    if !arm_refresh(&CACHE_STATE, &path, now_secs()) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("model-catalog-refresh".into())
        .spawn(move || {
            if !refresh_into(UPSTREAM_URL, &path) {
                return;
            }
            if let Ok(bytes) = std::fs::read(&path) {
                if let Some(catalog) = decode_catalog(&bytes) {
                    cache_state().loaded = Some(Arc::new(catalog));
                }
            }
        });
}

/// Hermetic unit suite: the live trigger is compiled out (see the real
/// arm's doc comment above for what that guarantees). The stub COUNTS
/// its calls -- the read-path hermeticity pin asserts that chain lookups
/// never route into the trigger, which a bare no-op stub could not
/// detect.
#[cfg(test)]
pub(crate) fn ensure_fresh() {
    TEST_TRIGGER_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// The test stub's call ledger (see above).
#[cfg(test)]
static TEST_TRIGGER_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One silent fetch->trim->encode->write cycle. Every failure is `false`
/// with no side effects on an existing cache file (the write is
/// staged-then-renamed, so a half-written cache can never exist) --
/// including a valid-JSON upstream that trims to zero entries: a healthy
/// upstream carries five-digit entry counts, so an empty trim is a shape
/// drift (an error page, a rename), not a catalog. Public because the
/// release-flow generator bin rides the exact same pipeline (and inherits
/// the gate: empty fails the release leg loudly).
pub fn refresh_into(url: &str, path: &Path) -> bool {
    let Ok(body) = fetch_upstream(url) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    let catalog = trim_upstream(&value, now_secs());
    if catalog.models.is_empty() {
        return false;
    }
    let Ok(bytes) = encode_catalog(&catalog) else {
        return false;
    };
    write_atomic(path, &bytes)
}

/// Fetch the upstream document over the shared blocking egress client
/// (redirects pinned off, the same posture every outbound call rides) --
/// one public unauthenticated GET, no credentials involved.
fn fetch_upstream(url: &str) -> Result<String, reqwest::Error> {
    let client = crate::egress::blocking_client()?;
    client
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .send()?
        .error_for_status()?
        .text()
}

/// Stage-then-rename write: a failed or interrupted write leaves the
/// previous file (or nothing) in place -- a corrupt cache file is never
/// observable.
fn write_atomic(path: &Path, bytes: &[u8]) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    let staged = path.with_extension("tmp");
    if std::fs::write(&staged, bytes).is_err() {
        return false;
    }
    std::fs::rename(&staged, path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::output_cap::OUTPUT_TOKEN_CAP;

    /// A recorded-shape upstream fixture: duplicate ids across providers
    /// (a digit-prefixed reseller ahead of the canonical lab, a non-
    /// canonical late writer, a casing variant), effort / toggle+budget /
    /// no reasoning rows, a no-limit row with a name, a payload-free row,
    /// and a non-object provider entry -- every shape the trim must
    /// survive.
    fn upstream_fixture() -> serde_json::Value {
        serde_json::json!({
            "302-reseller": { "models": { "shared-model": {
                "name": "Shared (reseller)",
                "limit": { "context": 128_000, "output": 4_096 }
            }}},
            "alpha-labs": { "models": { "Shared-Model": {
                "name": "Alpha Shared",
                "limit": { "context": 222_000, "output": 5_000 },
                "canonical_model_id": "alpha-labs/Shared-Model"
            }}},
            "budget-only": { "models": { "thinker": {
                "name": "Thinker",
                "limit": { "context": 9_000, "output": 1_000 },
                "reasoning_options": [
                    { "type": "toggle" },
                    { "type": "budget_tokens", "min": 1024 }
                ]
            }}},
            "no-limit": { "models": {
                "bare": { "name": "Bare" },
                "empty": {}
            }},
            "not-an-object": 42,
            "zeta-labs": { "models": { "shared-model": {
                "name": "Zeta Shared",
                "limit": { "context": 111_000, "output": 4_000 },
                "reasoning_options": [ { "type": "effort", "values": ["low", "high"] } ]
            }}}
        })
    }

    /// The trim keeps the compact shape: name / limits / effort tiers from
    /// the upstream rows, ids lowercased.
    #[test]
    fn trim_projects_the_compact_shape() {
        let catalog = trim_upstream(&upstream_fixture(), 1_000);
        let thinker = catalog.models.get("thinker").expect("thinker trimmed");
        assert_eq!(thinker.display_name.as_deref(), Some("Thinker"));
        assert_eq!(thinker.context_window, Some(9_000));
        assert_eq!(thinker.output_cap, Some(1_000));
        // toggle + budget_tokens carry no discrete tier list
        assert_eq!(thinker.effort_tiers, None);
        // a name-only row survives (the posture menu's display name)
        let bare = catalog.models.get("bare").expect("bare trimmed");
        assert_eq!(bare.display_name.as_deref(), Some("Bare"));
        assert_eq!(bare.context_window, None);
        // a payload-free row and a non-object provider entry answer nothing
        assert!(!catalog.models.contains_key("empty"));
        assert_eq!(catalog.models.len(), 3);
        assert_eq!(catalog.fetched_at, 1_000);
    }

    /// Upstream writes unknown limits as 0 (the image/embedding class --
    /// a five-percent slice of the live document); a 0 that survived the
    /// projection would stamp a max_tokens of 0 (a guaranteed per-turn
    /// rejection, the one failure mode the clamp formula documents as
    /// impossible), so 0 reads as absent on both fields.
    #[test]
    fn trim_treats_zero_limits_as_absent() {
        let api = serde_json::json!({
            "provider": {
                "models": {
                    "zero-model": {
                        "name": "Zero Model",
                        "limit": { "context": 0, "output": 0 }
                    }
                }
            }
        });
        let catalog = trim_upstream(&api, 1_000);
        let entry = catalog
            .models
            .get("zero-model")
            .expect("zero-model trimmed");
        assert_eq!(entry.context_window, None);
        assert_eq!(entry.output_cap, None);
    }

    /// Duplicate ids resolve by canonical precedence: the lab's own row
    /// (`canonical_model_id` naming its provider) outranks a digit-prefixed
    /// reseller that sorts first -- a stale reseller limit must never
    /// under-cap a current model (the #1001 truncation shape). Casing is
    /// normalized on both sides.
    #[test]
    fn trim_prefers_the_canonical_row_over_earlier_resellers() {
        let catalog = trim_upstream(&upstream_fixture(), 0);
        let shared = catalog.models.get("shared-model").expect("id lowercased");
        assert_eq!(shared.display_name.as_deref(), Some("Alpha Shared"));
        assert_eq!(
            shared.context_window,
            Some(222_000),
            "not the reseller's 128K"
        );
        assert_eq!(
            shared.effort_tiers, None,
            "the winner's own row is kept whole"
        );
    }

    /// Among NON-canonical rows the first sorted provider wins (the plain
    /// deterministic fallback when no lab row exists for an id).
    #[test]
    fn trim_falls_back_to_first_sorted_among_non_canonical_rows() {
        let api = serde_json::json!({
            "aaa-reseller": { "models": { "dupe": {
                "name": "A Dupe", "limit": { "context": 111_000, "output": 4_000 }
            }}},
            "bbb-reseller": { "models": { "dupe": {
                "name": "B Dupe", "limit": { "context": 222_000, "output": 5_000 }
            }}}
        });
        let catalog = trim_upstream(&api, 0);
        assert_eq!(
            catalog.models.get("dupe").unwrap().display_name.as_deref(),
            Some("A Dupe")
        );
    }

    /// gzip+JSON roundtrip; empty bytes are the empty catalog; garbage
    /// bytes are `None` (the silent skip), never a panic.
    #[test]
    fn encode_decode_roundtrip_and_corrupt_input() {
        let catalog = trim_upstream(&upstream_fixture(), 42);
        let bytes = encode_catalog(&catalog).expect("encode");
        let decoded = decode_catalog(&bytes).expect("roundtrip decodes");
        assert_eq!(decoded, catalog);
        assert_eq!(
            decode_catalog(&[]).expect("empty placeholder"),
            CompactCatalog::default()
        );
        assert_eq!(decode_catalog(b"not-gzip-at-all"), None);
        // a valid gzip of non-JSON is still a silent skip
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        use std::io::Write as _;
        encoder.write_all(b"{not json").unwrap();
        let garbage = encoder.finish().unwrap();
        assert_eq!(decode_catalog(&garbage), None);
    }

    fn fixture_tiers() -> (CompactCatalog, CompactCatalog) {
        let with = |ctx: u64, out: u32, effort: Option<Vec<&str>>| CompactCatalog {
            fetched_at: 0,
            models: HashMap::from([(
                "zz-model".to_string(),
                CompactEntry {
                    display_name: None,
                    context_window: Some(ctx),
                    output_cap: Some(out),
                    effort_tiers: effort
                        .map(|values| values.into_iter().map(str::to_string).collect::<Vec<_>>()),
                },
            )]),
        };
        // cache knows zz-model at the cache values + effort; the snapshot
        // knows a DIFFERENT zz-model and its own ss-model
        let mut snapshot = with(3_000, 6_000, None);
        snapshot.models.insert(
            "ss-model".to_string(),
            CompactEntry {
                display_name: None,
                context_window: Some(3_500),
                ..CompactEntry::default()
            },
        );
        (with(1_000, 4_000, Some(vec!["low", "high"])), snapshot)
    }

    /// The chain order: cache exact id -> snapshot exact id -> prefix
    /// table -> hollow ring, casing normalized.
    #[test]
    fn chain_cache_outranks_snapshot_outranks_the_prefix_table() {
        let (cache, snapshot) = fixture_tiers();
        let tiers = (Some(&cache), Some(&snapshot));
        // cache wins over a conflicting snapshot entry
        assert_eq!(
            tiered_context_window(tiers.0, tiers.1, "ZZ-Model"),
            Some(1_000)
        );
        // snapshot tier for an id the cache misses
        assert_eq!(
            tiered_context_window(tiers.0, tiers.1, "ss-model"),
            Some(3_500)
        );
        // prefix tier for an id both miss (glm-4 family window)
        assert_eq!(
            tiered_context_window(tiers.0, tiers.1, "glm-4-air"),
            Some(128_000)
        );
        // a total miss stays hollow
        assert_eq!(
            tiered_context_window(tiers.0, tiers.1, "doubao-1.5-pro"),
            None
        );
    }

    /// The output chain keeps the cap formula: exact hit under the cap,
    /// exact hit over the cap clamps, a field-less hit and a total miss
    /// fall to the low-cap prefix table, then the global cap.
    #[test]
    fn output_chain_keeps_the_clamp_formula() {
        let (cache, snapshot) = fixture_tiers();
        assert_eq!(
            tiered_output_cap(Some(&cache), Some(&snapshot), "zz-model"),
            4_000
        );
        // an over-cap exact entry clamps to the global cap
        let mut over = cache.clone();
        over.models.get_mut("zz-model").unwrap().output_cap = Some(OUTPUT_TOKEN_CAP * 4);
        assert_eq!(
            tiered_output_cap(Some(&over), None, "zz-model"),
            OUTPUT_TOKEN_CAP
        );
        // prefix tier (glm-4's low cap), then the fallback for a total miss
        assert_eq!(tiered_output_cap(None, None, "glm-4-air"), 4_096);
        assert_eq!(tiered_output_cap(None, None, "gpt-4.1"), OUTPUT_TOKEN_CAP);
    }

    /// Effort tiers resolve from the exact-id tiers only; no prefix
    /// fallback exists (the tables carry no reasoning data).
    #[test]
    fn effort_tiers_resolve_from_exact_ids_only() {
        let (cache, snapshot) = fixture_tiers();
        assert_eq!(
            tiered_effort_tiers(Some(&cache), Some(&snapshot), "zz-model"),
            Some(vec!["low".to_string(), "high".to_string()])
        );
        assert_eq!(tiered_effort_tiers(None, Some(&snapshot), "ss-model"), None);
    }

    /// The cadence decision table: fresh cache never fetches; a stale (or
    /// absent) cache fetches once per TTL window regardless of outcome.
    #[test]
    fn refresh_decision_table() {
        let now = 10 * CATALOG_TTL_SECS;
        // fresh cache -> no fetch (the zero-egress-when-fresh pin)
        assert!(!refresh_decision(Some(now - 100), None, now));
        // stale cache, no attempt yet -> fetch (the lazy trigger)
        assert!(refresh_decision(
            Some(now - CATALOG_TTL_SECS - 1),
            None,
            now
        ));
        // no cache at all (first run) -> fetch
        assert!(refresh_decision(None, None, now));
        // a recent attempt silences the window (failed fetch included)
        assert!(!refresh_decision(
            Some(now - CATALOG_TTL_SECS - 1),
            Some(now - 100),
            now
        ));
        assert!(!refresh_decision(None, Some(now - 100), now));
        // ...and re-arms one TTL later (the long-running self-heal)
        assert!(refresh_decision(
            Some(now - CATALOG_TTL_SECS - 1),
            Some(now - CATALOG_TTL_SECS - 1),
            now
        ));
    }

    /// Arming loads the disk cache BEFORE deciding: a cache a
    /// just-finished refresh wrote to disk must read as fresh, not arm a
    /// redundant fetch over it. (A decide-then-load order would read the
    /// empty in-memory tier, re-fetch, and stomp the fresh disk cache.)
    #[test]
    fn arming_loads_the_disk_cache_before_deciding() {
        const NOW: u64 = 10 * CATALOG_TTL_SECS;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        let fresh = CompactCatalog {
            fetched_at: NOW - 100,
            models: HashMap::new(),
        };
        std::fs::write(&path, encode_catalog(&fresh).expect("encode")).expect("seed");
        let state = Mutex::new(CacheState::default());
        assert!(
            !arm_refresh(&state, &path, NOW),
            "a fresh disk cache must not arm a refresh"
        );
        let guard = state.lock().expect("state lock");
        assert!(
            guard
                .loaded
                .as_ref()
                .is_some_and(|catalog| catalog.fetched_at == NOW - 100),
            "the disk tier was loaded into memory first"
        );
        assert!(
            guard.last_attempt.is_none(),
            "no ledger write on a fresh cache"
        );
    }

    /// The attempt ledger inside the critical section: one arm silences
    /// the rest of the TTL window regardless of outcome, then re-arms
    /// one TTL later (the long-running self-heal).
    #[test]
    fn arming_silences_the_window_then_rearms_next_ttl() {
        const NOW: u64 = 10 * CATALOG_TTL_SECS;
        let dir = tempfile::tempdir().expect("tempdir");
        // absent file: no cache tier, so only the ledger can say no
        let path = dir.path().join("model-catalog.json.gz");
        let state = Mutex::new(CacheState::default());
        assert!(arm_refresh(&state, &path, NOW), "no cache at all -> arm");
        assert_eq!(
            state.lock().expect("state lock").last_attempt,
            Some(NOW),
            "arming stamps the ledger inside the guard"
        );
        assert!(
            !arm_refresh(&state, &path, NOW + 100),
            "a recent attempt silences the window"
        );
        assert!(
            arm_refresh(&state, &path, NOW + CATALOG_TTL_SECS),
            "the next TTL window re-arms"
        );
    }

    /// Two concurrent turn starts arm exactly ONE refresh: the decision
    /// and the ledger write share one lock guard, so whichever thread
    /// enters the critical section second sees the first's stamp and
    /// stands down. Correct code is deterministic here (the guard lock
    /// serializes the sections); a ledger write moved OUTSIDE the guard
    /// lets both pass the decision and both arm.
    #[test]
    fn two_concurrent_turn_starts_arm_exactly_one_refresh() {
        const NOW: u64 = 10 * CATALOG_TTL_SECS;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        let state = Arc::new(Mutex::new(CacheState::default()));
        // Hold the guard so neither worker can enter the critical
        // section until both are running and about to take the lock.
        let guard = state.lock().expect("state lock");
        let entered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let state = Arc::clone(&state);
                let entered = Arc::clone(&entered);
                let path = path.clone();
                std::thread::spawn(move || {
                    entered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    arm_refresh(&state, &path, NOW)
                })
            })
            .collect();
        while entered.load(std::sync::atomic::Ordering::SeqCst) < 2 {
            std::hint::spin_loop();
        }
        drop(guard);
        let armed: usize = handles
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("worker")))
            .sum();
        assert_eq!(armed, 1, "exactly one turn may arm the refresh");
        assert_eq!(state.lock().expect("state lock").last_attempt, Some(NOW));
    }

    /// A successful refresh writes a decodable cache file: same trim as
    /// the in-process path, fetched_at stamped, cache-dir created.
    #[test]
    fn refresh_into_writes_a_decodable_cache() {
        let mut server = mockito::Server::new();
        let mock = server
            .mock("GET", "/api.json")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(upstream_fixture().to_string())
            .create();
        let dir = tempfile::tempdir().expect("tempdir");
        // a nested cache dir that does not exist yet
        let path = dir.path().join("nested").join("model-catalog.json.gz");
        assert!(refresh_into(&format!("{}/api.json", server.url()), &path));
        let catalog =
            decode_catalog(&std::fs::read(&path).expect("cache written")).expect("decodable");
        assert_eq!(
            catalog.models.get("shared-model").unwrap().context_window,
            Some(222_000)
        );
        assert!(catalog.fetched_at > 0);
        mock.assert();
    }

    /// A valid-JSON upstream that trims to zero entries is failure, not a
    /// (vacuously successful) empty catalog: nothing is written, an
    /// EXISTING cache survives byte-for-byte -- the same contract as
    /// fetch/parse failures -- and the release generator fails loudly on
    /// the same gate (ADR-0152's loud-over-empty ruling).
    #[test]
    fn an_empty_trim_is_failure_not_an_empty_catalog() {
        let mut server = mockito::Server::new();
        let empty = server
            .mock("GET", "/api.json")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("{}")
            .expect(2)
            .create();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        assert!(!refresh_into(&format!("{}/api.json", server.url()), &path));
        assert!(!path.exists(), "an empty trim writes no file");
        // seed a cache, then let the same empty trim hit it: it must not
        // destroy what a real catalog already wrote
        let seeded = encode_catalog(&trim_upstream(&upstream_fixture(), 7)).expect("encode");
        std::fs::write(&path, &seeded).expect("seed");
        assert!(!refresh_into(&format!("{}/api.json", server.url()), &path));
        assert_eq!(
            std::fs::read(&path).expect("cache survives"),
            seeded,
            "an empty trim never rewrites the existing cache"
        );
        // both fetches DID happen: the false comes from the gate, not the network
        empty.assert();
    }

    /// Failures leave the disk untouched: an HTTP error and an
    /// unparseable body write nothing, and an EXISTING cache survives a
    /// failed refresh byte-for-byte.
    #[test]
    fn refresh_failures_never_touch_the_existing_cache() {
        let mut server = mockito::Server::new();
        let error = server.mock("GET", "/api.json").with_status(500).create();
        let garbage = server
            .mock("GET", "/api.json")
            .with_status(200)
            .with_body("{not json")
            .create();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        let url = format!("{}/api.json", server.url());
        assert!(!refresh_into(&url, &path));
        assert!(!path.exists(), "an HTTP error writes no file");
        error.assert();
        // seed a good cache, then fail against it
        let seeded = trim_upstream(&upstream_fixture(), 7);
        let seeded_bytes = encode_catalog(&seeded).expect("encode");
        std::fs::write(&path, &seeded_bytes).expect("seed");
        assert!(!refresh_into(&url, &path));
        assert_eq!(
            std::fs::read(&path).expect("cache survives"),
            seeded_bytes,
            "a failed refresh never rewrites the existing cache"
        );
        garbage.assert();
    }

    /// The staged-then-renamed write, driven directly: success leaves no
    /// `.tmp` residue, a failed staged write never touches the existing
    /// file, and a failed rename sinks the whole write -- a partial or
    /// half-written cache can never be observed. A plain-write regression
    /// (write straight to the target) flips the staged-failure leg green,
    /// which is exactly what this pin detects.
    #[test]
    fn atomic_write_leaves_no_residue_and_never_breaks_the_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        // success: the payload lands and the staged file is gone
        let path = dir.path().join("one.json.gz");
        assert!(write_atomic(&path, b"payload"));
        assert_eq!(std::fs::read(&path).expect("written"), b"payload");
        assert!(
            !path.with_extension("tmp").exists(),
            "no staged file lingers after success"
        );
        // staged-write failure: a directory squatting on the staged name
        // sinks the stage step; the existing file must survive untouched
        let path = dir.path().join("two.json.gz");
        std::fs::write(&path, b"previous").expect("seed");
        std::fs::create_dir(path.with_extension("tmp")).expect("block the staged name");
        assert!(!write_atomic(&path, b"next"));
        assert_eq!(
            std::fs::read(&path).expect("survives"),
            b"previous",
            "a failed staged write never rewrites the target"
        );
        // rename failure: a non-empty directory on the target name sinks
        // the rename (both platforms refuse file-over-directory)
        let path = dir.path().join("three.json.gz");
        std::fs::create_dir(&path).expect("dir target");
        std::fs::write(path.join("occupant"), b"x").expect("non-empty");
        assert!(!write_atomic(&path, b"next"));
    }

    /// Chain lookups are pure reads: however many fire (the CLI channel
    /// stamps are exactly this shape), no refresh is ever attempted --
    /// the read-path half of the CLI-only zero-egress guarantee. The
    /// stub's call ledger gives the pin teeth: routing `ensure_fresh`
    /// into any read path shows up as a counted call, not a silent
    /// no-op.
    #[test]
    fn lookups_never_attempt_a_refresh() {
        let before = TEST_TRIGGER_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        assert!(crate::provider::context_window::context_window("glm-4.6").is_some());
        let _ = crate::provider::output_cap::output_token_cap("gpt-4o");
        let _ = context_window("claude-3-5-sonnet");
        let _ = output_cap("deepseek-chat");
        let _ = effort_tiers("zz-nothing");
        assert_eq!(
            TEST_TRIGGER_CALLS.load(std::sync::atomic::Ordering::SeqCst),
            before,
            "chain lookups must never route into the lazy trigger"
        );
        assert!(
            cache_state().last_attempt.is_none(),
            "lookups must never arm the attempt ledger"
        );
    }

    /// A corrupt cache file on disk is skipped silently: loading never
    /// panics, never deletes or rewrites the file, never arms the
    /// ledger -- and the chain still answers through the snapshot and
    /// prefix tiers. Driven through the explicit state+path seam: the
    /// process-global `CACHE_PATH` anchors once per process (the
    /// healthy-file scenario below claims it), so this second disk
    /// scenario cannot ride the real entry points.
    #[test]
    fn a_corrupt_cache_falls_through_the_chain() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        std::fs::write(&path, b"not a gzip stream").expect("corrupt seed");
        let state = Mutex::new(CacheState::default());
        assert!(
            cache_catalog_at(&state, &path).is_none(),
            "a corrupt file loads nothing (no panic)"
        );
        // a second load is equally silent: the bad file is never
        // rewritten from the snapshot tier or deleted
        assert!(cache_catalog_at(&state, &path).is_none());
        assert!(path.exists(), "a corrupt cache is skipped, never deleted");
        assert_eq!(
            std::fs::read(&path).expect("byte-for-byte"),
            b"not a gzip stream".to_vec()
        );
        assert!(
            state.lock().expect("state lock").last_attempt.is_none(),
            "serving the chain never arms the ledger"
        );
        // the rest of the chain still answers: snapshot tier first...
        let (_, snapshot) = fixture_tiers();
        assert_eq!(
            tiered_context_window(None, Some(&snapshot), "ss-model"),
            Some(3_500)
        );
        // ...then the prefix table
        assert_eq!(
            tiered_context_window(None, None, "glm-4-air"),
            Some(128_000)
        );
    }

    /// The process-global wiring: a seeded disk cache (unique fixture ids,
    /// so sibling tests are unaffected) serves the chain through the
    /// public entry points -- cache tier over the empty-in-test snapshot
    /// and the prefix tables, exact-id only.
    #[test]
    fn global_chain_reads_the_disk_cache() {
        let catalog = CompactCatalog {
            fetched_at: now_secs(),
            models: HashMap::from([(
                "zz-fixture-model".to_string(),
                CompactEntry {
                    display_name: Some("ZZ Fixture".into()),
                    context_window: Some(123_456),
                    output_cap: Some(4_321),
                    effort_tiers: Some(vec!["low".into(), "high".into()]),
                },
            )]),
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-catalog.json.gz");
        std::fs::write(&path, encode_catalog(&catalog).expect("encode")).expect("seed");
        let _ = CACHE_PATH.set(path);
        // the chain resolves through cache > (empty snapshot) > prefix
        assert_eq!(context_window("ZZ-Fixture-Model"), Some(123_456));
        assert_eq!(output_cap("zz-fixture-model"), 4_321);
        assert_eq!(
            effort_tiers("zz-fixture-model"),
            Some(vec!["low".to_string(), "high".to_string()])
        );
        // the occupancy stamp rides the same chain
        let mut snapshot = crate::model::OccupancySnapshot {
            tokens: 1,
            limit: None,
        };
        crate::provider::context_window::stamp(&mut snapshot, Some("zz-fixture-model"));
        assert_eq!(snapshot.limit, Some(123_456));
        // a sibling id of the fixture entry stays on the prefix/hollow path
        // (exact-id only, no family spill)
        assert_eq!(context_window("zz-fixture-model-air"), None);
    }
}
