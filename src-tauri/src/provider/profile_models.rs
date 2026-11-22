//! The built-in runtime's first-hand model list (#1639, ADR-0153): the
//! active profile's own endpoint is the model id set's most accurate
//! source, probed once per cache-miss posture-menu open and served from
//! an in-process cache afterwards. The probe is silent by contract: any
//! failure degrades the menu to the profile-model-only fallback shape,
//! never an error surface.
//!
//! Wire posture mirrors the preflight probe (ADR-0070): the shared
//! no-redirect blocking egress client, per-protocol auth headers -- only
//! what the protocol itself requires, nothing that impersonates an SDK.
//! The request carries the profile's key and goes to the profile's own
//! base_url, nothing else. Only the LIST url normalizes a trailing
//! `/v1` onto the base; turn requests keep the configured base verbatim.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::model::Protocol;
use crate::provider::keychain::ProviderConfigSource;

/// The models-list request timeout: one round-trip against the user's own
/// endpoint, the same envelope as the preflight probe's (30s).
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// The anthropic list wire's page cap: one `?limit=1000` request, no
/// pagination follow (ADR-0153 -- a directory that outgrows one page
/// degrades to its first thousand, which is still the most accurate set
/// the app can offer without a traversal loop).
const ANTHROPIC_PAGE_LIMIT: u32 = 1000;

/// One menu row: the endpoint's model id plus the catalog metadata the
/// menu renders (the model catalog fills the name and effort tiers; an
/// uncataloged id renders verbatim with no strength row). The probe-cache
/// `CatalogModel` shape minus the CLI-current fields -- the built-in
/// surface has no CLI reporting a current; the payload-level
/// `profile_model` is the one carrier of the effective default (a row
/// flag would state the same fact twice with no consumer).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BuiltinCatalogModel {
    pub id: String,
    pub display_name: String,
    pub supported_reasoning_efforts: Vec<String>,
}

/// The built-in posture menu's catalog payload: the merged first-hand id
/// set + catalog metadata, plus the effective current model (`None` when
/// the active profile's model field is blank -- no honest current to
/// show). An empty `models` renders the fallback menu (the held profile
/// model's synthetic row + the clearing row) -- the honest shape both
/// before the probe answers and after it fails.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct BuiltinPostureCatalog {
    pub models: Vec<BuiltinCatalogModel>,
    pub profile_model: Option<String>,
}

/// The cache key: the protocol + the normalized list base. An endpoint
/// edit or protocol switch mints a new key (a fresh probe); a key change
/// alone reuses the same endpoint's list. The stored key never includes
/// the API key -- it names the endpoint, not the credential.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ListKey {
    protocol: Protocol,
    base: String,
}

/// The in-process list cache (session-memory scope, ADR-0153): only
/// successful probes land here, so a failed open retries on the next
/// menu-open instead of caching the failure.
static LIST_CACHE: Mutex<Option<HashMap<ListKey, Arc<Vec<String>>>>> = Mutex::new(None);

/// Serve the id set for `key`: the cache first, else run `probe` and cache
/// a successful answer (empty included -- an endpoint that lists zero
/// models answered honestly). A failed probe returns `None` uncached.
fn cached_or_probe(
    key: ListKey,
    probe: impl FnOnce() -> Option<Vec<String>>,
) -> Option<Arc<Vec<String>>> {
    let mut guard = LIST_CACHE
        .lock()
        .expect("profile model list cache lock poisoned");
    cached_or_probe_at(guard.get_or_insert_with(HashMap::new), key, probe)
}

/// The cache decision over an explicit map -- the seam the unit tests
/// drive (the process-global static cannot be reset between cases).
fn cached_or_probe_at(
    cache: &mut HashMap<ListKey, Arc<Vec<String>>>,
    key: ListKey,
    probe: impl FnOnce() -> Option<Vec<String>>,
) -> Option<Arc<Vec<String>>> {
    if let Some(hit) = cache.get(&key) {
        return Some(Arc::clone(hit));
    }
    probe().map(|ids| {
        let ids = Arc::new(ids);
        cache.insert(key, Arc::clone(&ids));
        ids
    })
}

/// The models-list URL: the base normalized to end with exactly one
/// `/v1` segment, then `/models` (anthropic adds the page cap). This is
/// the ONLY `/v1` normalization in the request path -- turn requests use
/// the configured base verbatim (the adapters join their own paths).
pub(crate) fn list_url(protocol: Protocol, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let base = if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1")
    };
    match protocol {
        Protocol::Anthropic => format!("{base}/models?limit={ANTHROPIC_PAGE_LIMIT}"),
        Protocol::Openai => format!("{base}/models"),
    }
}

/// Parse a models-list response body into the id set. Both protocols
/// answer the documented `data` array of `{id}` entries (anthropic adds
/// page cursors -- `has_more` ignored, single-page cap); openai-protocol
/// endpoints may instead answer a rich object keyed by model id, and the
/// array shape outranks it when present (the documented contract).
/// `None` on any other shape -- the caller degrades silently.
pub(crate) fn parse_model_ids(protocol: Protocol, body: &serde_json::Value) -> Option<Vec<String>> {
    let data = body.get("data")?;
    match data {
        serde_json::Value::Array(entries) => Some(
            entries
                .iter()
                .filter_map(|entry| entry.get("id")?.as_str().map(str::to_string))
                .collect(),
        ),
        // The openai-only rich-object fallback (compatible gateways key
        // the map by model id); the anthropic wire is the array contract
        // alone.
        serde_json::Value::Object(map) if matches!(protocol, Protocol::Openai) => {
            Some(map.keys().cloned().collect())
        }
        _ => None,
    }
}

/// Probe the endpoint's model list once. Any failure -- non-http base,
/// client construction fault, transport error, non-2xx, unparseable body
/// -- is `None` (the silent degrade); only a 2xx parseable body answers.
pub(crate) fn fetch_model_ids(
    protocol: Protocol,
    base_url: &str,
    key: &str,
) -> Option<Vec<String>> {
    if let Err(e) = crate::provider::http::validate_http_base_url(base_url) {
        log::debug!("profile model list skipped: invalid base url: {e}");
        return None;
    }
    let client = match crate::egress::blocking_client() {
        Ok(client) => client,
        Err(err) => {
            log::warn!("profile model list egress client construction failed: {err}");
            return None;
        }
    };
    let url = list_url(protocol, base_url);
    let request = match protocol {
        Protocol::Anthropic => client
            .get(&url)
            .timeout(LIST_TIMEOUT)
            .header("x-api-key", key)
            .header(
                "anthropic-version",
                crate::provider::preflight::ANTHROPIC_VERSION,
            ),
        Protocol::Openai => client
            .get(&url)
            .timeout(LIST_TIMEOUT)
            .header("Authorization", format!("Bearer {key}")),
    };
    let response = match request.send() {
        Ok(response) => response,
        Err(err) => {
            log::debug!("profile model list probe failed ({url}): {err}");
            return None;
        }
    };
    if !response.status().is_success() {
        log::debug!(
            "profile model list probe answered HTTP {} ({url})",
            response.status()
        );
        return None;
    }
    let body = response.json::<serde_json::Value>().ok()?;
    parse_model_ids(protocol, &body)
}

/// Merge the first-hand ids with the model catalog's metadata: the
/// display name and effort tiers fill from the catalog (`metadata`), an
/// uncataloged id renders verbatim with no tiers, and `is_default` flags
/// the profile's configured model (the menu's effective default).
fn merge_builtin_catalog(
    ids: &[String],
    metadata: impl Fn(&str) -> crate::provider::model_catalog::CatalogMetadata,
) -> Vec<BuiltinCatalogModel> {
    ids.iter()
        .map(|id| {
            let meta = metadata(id);
            BuiltinCatalogModel {
                id: id.clone(),
                display_name: meta.display_name.unwrap_or_else(|| id.clone()),
                supported_reasoning_efforts: meta.effort_tiers.unwrap_or_default(),
            }
        })
        .collect()
}

/// The posture-menu catalog entry (#1639): the active profile's id list
/// (cache-or-probe) merged with catalog metadata. Keyless or zero-profile
/// state answers the empty catalog without any egress -- the menu renders
/// its fallback shape and nothing leaves the process.
pub(crate) fn builtin_posture_catalog(
    live: &crate::provider::live_config::LiveProviderConfig,
) -> BuiltinPostureCatalog {
    let Some(api_key) = live.api_key() else {
        return BuiltinPostureCatalog::default();
    };
    let protocol = live.protocol();
    let base = live.base_url();
    let cache_key = ListKey {
        protocol,
        base: list_url(protocol, &base),
    };
    let ids = cached_or_probe(cache_key, || fetch_model_ids(protocol, &base, &api_key));
    let profile_model = live.model();
    // The effective current: the profile's model field verbatim; a blank
    // field has no honest current (the backend default never masquerades
    // as the user's configured choice here).
    let current = profile_model.trim();
    let current = (!current.is_empty()).then(|| current.to_string());
    let models = match ids.as_deref() {
        Some(ids) => merge_builtin_catalog(ids, crate::provider::model_catalog::catalog_metadata),
        // A failed probe: the empty list IS the fallback shape (the menu
        // renders the held profile model's synthetic row + the clear row).
        None => Vec::new(),
    };
    BuiltinPostureCatalog {
        models,
        profile_model: current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse: the fixtures pin the two protocols' real response shapes.

    #[test]
    fn openai_parses_the_data_array_shape() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                {"id": "gpt-4o", "created": 1715367049, "owned_by": "system"},
                {"id": "gpt-4o-mini"}
            ]
        });
        assert_eq!(
            parse_model_ids(Protocol::Openai, &body),
            Some(vec!["gpt-4o".into(), "gpt-4o-mini".into()])
        );
    }

    #[test]
    fn openai_parses_the_rich_object_shape() {
        // Compatible gateways key the map by model id with rich values the
        // app does not read.
        let body = serde_json::json!({
            "data": {
                "deepseek-chat": {"owned_by": "deepseek", "max_tokens": 8192},
                "deepseek-reasoner": {}
            }
        });
        let mut ids = parse_model_ids(Protocol::Openai, &body).expect("ids");
        ids.sort();
        assert_eq!(
            ids,
            vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()]
        );
    }

    #[test]
    fn openai_array_shape_outranks_the_object_fallthrough() {
        // "Array first" is structural: a body whose `data` is an array
        // never reaches the object arm, and a `data` of neither shape (or
        // an absent `data`) parses as no list at all.
        assert_eq!(
            parse_model_ids(Protocol::Openai, &serde_json::json!({"data": "nope"})),
            None
        );
        assert_eq!(
            parse_model_ids(Protocol::Openai, &serde_json::json!({})),
            None
        );
    }

    #[test]
    fn anthropic_parses_the_single_page_data_array() {
        // The real /v1/models shape: a data array plus page cursors; the
        // cursors (has_more included) are ignored -- one page, capped.
        let body = serde_json::json!({
            "data": [
                {"id": "claude-sonnet-4-5", "display_name": "Claude Sonnet 4.5",
                 "created_at": "2025-09-29T00:00:00Z"},
                {"id": "claude-opus-4-5", "display_name": "Claude Opus 4.5"}
            ],
            "first_id": "claude-sonnet-4-5",
            "last_id": "claude-opus-4-5",
            "has_more": true
        });
        assert_eq!(
            parse_model_ids(Protocol::Anthropic, &body),
            Some(vec!["claude-sonnet-4-5".into(), "claude-opus-4-5".into()])
        );
    }

    #[test]
    fn anthropic_rejects_the_object_shape() {
        // The anthropic wire is the array contract alone; an object `data`
        // (an openai-shape answer on a misconfigured protocol) is no list.
        assert_eq!(
            parse_model_ids(
                Protocol::Anthropic,
                &serde_json::json!({"data": {"claude-x": {}}})
            ),
            None
        );
    }

    // --- the list url: only this path normalizes the trailing /v1.

    #[test]
    fn list_url_appends_v1_when_the_base_lacks_it() {
        assert_eq!(
            list_url(Protocol::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
        assert_eq!(
            list_url(Protocol::Openai, "https://gateway.example.com"),
            "https://gateway.example.com/v1/models"
        );
    }

    #[test]
    fn list_url_never_doubles_a_trailing_v1() {
        assert_eq!(
            list_url(Protocol::Openai, "https://gateway.example.com/v1/"),
            "https://gateway.example.com/v1/models"
        );
        assert_eq!(
            list_url(Protocol::Anthropic, "https://proxy.example.com/v1/"),
            "https://proxy.example.com/v1/models?limit=1000"
        );
    }

    // --- the cache: hits never re-probe, failures never land.

    #[test]
    fn cache_hit_answers_without_running_the_probe() {
        let mut cache = HashMap::new();
        let key = ListKey {
            protocol: Protocol::Openai,
            base: "https://a.example.com/v1".into(),
        };
        cache.insert(key.clone(), Arc::new(vec!["m1".into()]));
        let mut probes = 0;
        let hit = cached_or_probe_at(&mut cache, key, || {
            probes += 1;
            None
        });
        assert_eq!(
            hit.as_ref().map(|ids| ids.as_ref()),
            Some(&vec!["m1".to_string()])
        );
        assert_eq!(probes, 0, "the hit must not probe");
    }

    #[test]
    fn failed_probes_are_not_cached_but_successes_are() {
        let mut cache = HashMap::new();
        let key = ListKey {
            protocol: Protocol::Openai,
            base: "https://b.example.com/v1".into(),
        };
        let mut probes = 0;
        // A failed probe answers None and leaves the cache empty.
        assert!(cached_or_probe_at(&mut cache, key.clone(), || {
            probes += 1;
            None
        })
        .is_none());
        assert!(cache.is_empty(), "the failure must not land in the cache");
        // The next call probes again (the retry-on-next-open contract) and
        // this time succeeds: the answer is cached.
        assert_eq!(
            cached_or_probe_at(&mut cache, key.clone(), || {
                probes += 1;
                Some(vec![])
            })
            .as_deref()
            .map(|v| v.to_vec()),
            Some(vec![])
        );
        // An empty successful answer is still an answer: the third call is
        // a hit and never probes.
        assert!(cached_or_probe_at(&mut cache, key, || {
            probes += 1;
            panic!("a cached empty list must answer without probing")
        })
        .is_some());
        assert_eq!(probes, 2);
    }

    // --- the merge: catalog metadata fills, uncataloged ids stay verbatim.

    #[test]
    fn merge_fills_metadata_and_keeps_uncataloged_ids_verbatim() {
        let ids = vec![
            "claude-sonnet-4-5".to_string(),
            "custom-deploy-7".to_string(),
        ];
        let merged = merge_builtin_catalog(&ids, |id| {
            if id == "claude-sonnet-4-5" {
                crate::provider::model_catalog::CatalogMetadata {
                    display_name: Some("Claude Sonnet 4.5".into()),
                    effort_tiers: Some(vec!["low".into(), "high".into()]),
                }
            } else {
                crate::provider::model_catalog::CatalogMetadata {
                    display_name: None,
                    effort_tiers: None,
                }
            }
        });
        assert_eq!(
            merged[0],
            BuiltinCatalogModel {
                id: "claude-sonnet-4-5".into(),
                display_name: "Claude Sonnet 4.5".into(),
                supported_reasoning_efforts: vec!["low".into(), "high".into()],
            }
        );
        assert_eq!(
            merged[1],
            BuiltinCatalogModel {
                id: "custom-deploy-7".into(),
                display_name: "custom-deploy-7".into(),
                // An uncataloged id carries no tiers: the menu renders no
                // strength row for it.
                supported_reasoning_efforts: vec![],
            }
        );
    }

    // --- the probe's silent degrade over real HTTP classification.

    #[test]
    fn fetch_answers_none_on_a_non_2xx_endpoint() {
        let mut server = mockito::Server::new();
        let mock = server.mock("GET", "/v1/models").with_status(500).create();
        assert_eq!(
            fetch_model_ids(Protocol::Openai, &server.url(), "sk-test"),
            None
        );
        mock.assert();
    }

    #[test]
    fn fetch_answers_none_on_an_invalid_base() {
        // A non-http base never egresses at all (mirrors the preflight's
        // boundary check).
        assert_eq!(fetch_model_ids(Protocol::Openai, "file:///etc", "k"), None);
    }
}
