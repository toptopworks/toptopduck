//! App-config atomic IO (ADR-0038): the second at-rest artifact, alongside the
//! user-owned `.duck`. The on-disk file is small JSON in the OS app-data
//! directory; this module owns its write + read semantics.
//!
//! **Write** mirrors [`crate::persistence::io::save_atomic`]: serialize to JSON,
//! write `<target>.tmp` in the same directory, `fsync`, then rename over the
//! target. The rename is intra-volume atomic; a crash mid-write leaves either
//! the prior complete config or the next complete one -- never a half-file.
//!
//! **Read** uses a DIFFERENT policy from `.duck`: app-config honest-DEGRADES to
//! built-in defaults on ANY failure (missing file, corrupt JSON, version
//! mismatch, detected secret field). A `.duck` honest-REFUSES (the user's
//! analysis is at stake); app-config is just prefs, so "no crash, reset to
//! defaults" is the right call (ADR-0038 / issue #53 AC: "损坏/缺失 -> 默认值,
//! 不崩"). [`read_at`] therefore returns `AppConfig`, not `Result` -- every
//! failure path yields [`AppConfig::defaults`].
//!
//! **Secrets-never enforcement (ADR-0029/0036/0038)**: the model has no key
//! field, so the write path cannot persist one. The read path additionally
//! scans the raw JSON for any secret-named key (recursively) and rejects the
//! file to defaults if one is present -- so a hand-edited config that smuggles
//! in `api_key` cannot keep a plaintext key on disk behind the type system.
//! Combined with the structural absence of a key field, this makes
//! secrets-never enforceable and testable across both directions.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::Value;

use crate::app_config::model::{AppConfig, APP_CONFIG_FORMAT_VERSION};

/// Suffix appended to the target file name for the temp file. Same directory as
/// the target so the `rename` is intra-volume (atomic on NTFS / POSIX). Mirrors
/// [`crate::persistence::io::TMP_SUFFIX`].
const TMP_SUFFIX: &str = ".tmp";

/// Key names that must NEVER appear in an app-config file. A hand-edited file
/// carrying any of these (at any object depth) is rejected to defaults: the file
/// may hold a plaintext secret smuggled past the type system, and the honest
/// answer is to refuse it rather than silently load the surrounding prefs. The
/// list targets the realistic BYOK leak vector (the Anthropic API key) without
/// false-positiving on a future benign field -- a bare `key`/`token` is avoided.
const SECRET_KEY_NAMES: &[&str] = &[
    "api_key",
    "apikey",
    "anthropic_api_key",
    "anthropic-key",
    "secret",
    "password",
    "credential",
    "access_token",
    "refresh_token",
];

/// Additional secret-name substrings checked ONLY against header names
/// (issue #901): request headers carry credentials far more often than
/// config fields do (`Authorization`, bearer/JWT tokens, `Cookie` session
/// values), and the header face is hand-reachable (web-format JSON pasted
/// into the form), so a secret-named header's literal value must be
/// structurally refused at read time -- the name belongs in
/// `keychain_header_keys`, with the value in the OS keychain. The effective
/// set matches the frontend's single `isSecretEnvKey` scan (one scan applied
/// to both faces there -- there is no separate frontend header routing);
/// relative to the Rust import path's `IMPORT_SECRET_SUBSTRINGS` it adds
/// `authorization` / `cookie` / `session`, which the two Rust env scans
/// deliberately omit.
const HEADER_SECRET_SUBSTRINGS: &[&str] = &[
    "token",
    "bearer",
    "jwt",
    "privatekey",
    "authorization",
    "cookie",
    "session",
];

/// Collapse a key name for substring matching: lowercase, non-alphanumerics
/// dropped (so `apiKey` / `API_KEY` / `api-key` collapse to `apikey`).
fn collapse_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// True if `name` matches a secret key name, ignoring case and non-alphanumeric
/// separators, using SUBSTRING matching so prefixed variants also trip:
/// `my_api_key`, `openai_api_key`, `claude_api_key`, `anthropic_key` all contain
/// a known secret token after collapse. `apiKey`, `API_KEY`, `api-key`, and
/// `apikey` collapse to the same `apikey` token. The app-config field set
/// (`base_url`, `model`, `theme`, `window`, `engine`, ...) collapses to tokens
/// that contain NO secret name, so substring matching stays false-positive-free
/// across the real schema. The primary secrets-never defense is the model having
/// no key field; this scan is the read-time backstop for hand-edited files.
pub(crate) fn is_secret_name(name: &str) -> bool {
    let collapsed = collapse_name(name);
    SECRET_KEY_NAMES
        .iter()
        .any(|secret| collapsed.contains(&collapse_name(secret)))
}

/// True if `name` matches the EXPANDED header-secret list (issue #901):
/// [`is_secret_name`] plus the [`HEADER_SECRET_SUBSTRINGS`] -- applied only to
/// header names inside a `headers` object (see [`find_scan_hit`]), never to
/// env names (the env list is deliberately narrower; [`is_secret_name`] is
/// the read-time env scan, and `mcp::import::is_secret_env_key` the separate
/// import-time variant).
pub(crate) fn is_secret_header_name(name: &str) -> bool {
    if is_secret_name(name) {
        return true;
    }
    let collapsed = collapse_name(name);
    HEADER_SECRET_SUBSTRINGS
        .iter()
        .any(|s| collapsed.contains(&collapse_name(s)))
}

/// Why a typed parse failed. Internal: [`read_at`] maps every variant to
/// [`AppConfig::defaults`] + a `log::warn!` for the READ consumers, while the
/// crate's read-modify-write read source (issue #602) matches `Missing` (the
/// defaults branch) and lifts every other variant as a `WriteError::Read` --
/// so this crosses module boundaries inside the crate, never an IPC boundary.
/// Exposed at crate visibility so `provider` and the unit tests can pin each
/// failure mode.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AppConfigReadError {
    /// File not found (first launch, or deleted). Not really an error -- the
    /// honest-degrade target IS the right value here.
    Missing,
    /// IO error reading the file (permission denied, etc.).
    Io(String),
    /// File content is not valid JSON.
    Parse(String),
    /// `format_version` is missing or not a number.
    VersionMissing,
    /// `format_version` is above the app's current -- a newer app made the file.
    /// Degrade to defaults rather than mis-parsing (app-config policy, ADR-0038).
    HigherVersion { found: u32, supported: u32 },
    /// `format_version` is below current. v2 (issue #150, ADR-0064) marks the
    /// provider schema shape change to multi-profile; a leftover v1 file lands
    /// here and degrades to the default profile skeleton (ADR-0064 declines a
    /// v1->v2 migrator -- the app is unreleased, so a stale v1 file resets to
    /// defaults rather than being converted). Any older shape lands here as
    /// future versions ship.
    LowerVersion { found: u32, supported: u32 },
    /// A secret-named key was detected in the raw JSON. Refuse the file.
    SecretField(String),
    /// A malformed header name or value (bad token charset or a control
    /// character) was detected inside a `headers` object. Refuse the file
    /// (issue #901: the hand-edit backstop for the write boundary's checks).
    InvalidHeader(String),
}

impl std::fmt::Display for AppConfigReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Missing => write!(f, "file not found"),
            Self::Io(d) => write!(f, "io error: {d}"),
            Self::Parse(d) => write!(f, "parse error: {d}"),
            Self::VersionMissing => write!(f, "format_version missing or non-numeric"),
            Self::HigherVersion { found, supported } => write!(
                f,
                "format_version {found} > supported {supported} (newer app made this file)"
            ),
            Self::LowerVersion { found, supported } => write!(
                f,
                "format_version {found} < supported {supported} (stale shape, reset to defaults)"
            ),
            Self::SecretField(name) => {
                write!(f, "secret-named field `{name}` refused (secrets-never)")
            }
            Self::InvalidHeader(name) => {
                write!(
                    f,
                    "malformed header `{name}` refused (bad token or control character)"
                )
            }
        }
    }
}

/// The temp-file path for a target (same directory, name + TMP_SUFFIX). Public
/// so a test can locate a stale temp after a simulated mid-write crash.
pub fn temp_path_for(target: &Path) -> Option<std::path::PathBuf> {
    let file_name = target.file_name()?.to_str()?;
    Some(target.with_file_name(format!("{file_name}{TMP_SUFFIX}")))
}

/// Write a config atomically: serialize to pretty JSON (human-readable + git-
/// friendly diffs), write to `<target>.tmp` in the same directory, `fsync`, then
/// rename over the target. The rename is atomic on the same volume; a crash
/// before rename leaves the prior target intact and a stale temp behind
/// (overwritten on the next write). Mirrors the `.duck` atomic write.
pub fn write_at(target: &Path, cfg: &AppConfig) -> Result<(), WriteError> {
    let json =
        serde_json::to_string_pretty(cfg).map_err(|e| WriteError::Serialize(e.to_string()))?;
    let tmp = temp_path_for(target)
        .ok_or_else(|| WriteError::Io("could not derive temp file path".into()))?;

    {
        let mut file = fs::File::create(&tmp).map_err(|e| WriteError::Io(e.to_string()))?;
        file.write_all(json.as_bytes())
            .map_err(|e| WriteError::Io(e.to_string()))?;
        // fsync before the rename so a crash right after rename never leaves a
        // 0-byte / partially-flushed target.
        file.sync_all().map_err(|e| WriteError::Io(e.to_string()))?;
    }

    if let Err(e) = fs::rename(&tmp, target) {
        // Clean up the temp so it doesn't pile up; the target is untouched.
        let _ = fs::remove_file(&tmp);
        return Err(WriteError::Rename(e.to_string()));
    }
    Ok(())
}

/// Why a write failed. Every failure leaves the target config file (if any)
/// untouched: a read failure happens before any write is attempted; a
/// serialize error happens before any IO; an IO failure leaves the temp file
/// behind but the target unchanged; a rename failure leaves the target
/// unchanged (temp best-effort removed).
#[derive(Debug)]
pub enum WriteError {
    /// The read half of a read-modify-write failed (corrupt file, version
    /// mismatch, transient IO). Surfaced instead of degrading to defaults so
    /// a rewrite can never persist "defaults + this one write" (issue #602).
    /// A missing file deliberately does NOT surface here -- it is the correct
    /// starting value and goes through the defaults branch.
    Read(String),
    Serialize(String),
    Io(String),
    Rename(String),
    /// The write was refused before touching the file: the payload failed a
    /// domain validation (issue #901 -- e.g. an MCP server's header face).
    /// Carries the user-correctable message.
    Validation(String),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Read(d) => write!(f, "read app-config for rewrite failed: {d}"),
            Self::Serialize(d) => write!(f, "serialize app-config failed: {d}"),
            Self::Io(d) => write!(f, "write app-config temp file failed: {d}"),
            Self::Rename(d) => write!(f, "replace app-config failed: {d}"),
            Self::Validation(d) => write!(f, "invalid MCP server config: {d}"),
        }
    }
}
impl std::error::Error for WriteError {}

/// Read the config, honest-degrading to [`AppConfig::defaults`] on ANY failure
/// (ADR-0038 / issue #53 AC). Never returns an error and never panics: a missing
/// / corrupt / version-mismatched / secret-carrying file all yield the built-in
/// defaults with a `log::warn!` naming the reason. The caller therefore always
/// has a usable config and the app always boots.
pub fn read_at(path: &Path) -> AppConfig {
    match parse_at(path) {
        Ok(cfg) => cfg,
        Err(AppConfigReadError::Missing) => {
            // First launch or deleted file -- defaults are the right value, not a
            // degraded state, so no warning.
            AppConfig::defaults()
        }
        Err(reason) => {
            log::warn!(
                "app-config read degraded to defaults ({reason}): {}",
                path.display()
            );
            AppConfig::defaults()
        }
    }
}

/// Parse the config file, routing on `format_version` and scanning for secret
/// fields. The honest-degrade decision for READ consumers lives in
/// [`read_at`]; this surfaced `Result` lets the tests pin each failure mode
/// precisely and feeds the app-config read-modify-write entries, where a
/// degraded read must never become the source of a rewrite (issue #602).
pub(crate) fn parse_at(path: &Path) -> Result<AppConfig, AppConfigReadError> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppConfigReadError::Missing)
        }
        Err(e) => return Err(AppConfigReadError::Io(e.to_string())),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|e| AppConfigReadError::Parse(e.to_string()))?;

    // Secrets-never: scan the raw JSON for any secret-named key BEFORE
    // deserializing. serde would otherwise silently drop an unknown `api_key`
    // field on the floor -- the value would never reach Rust, but the plaintext
    // key would sit on disk. Refusing here makes the invariant enforceable.
    if let Some(found) = find_scan_hit(&value) {
        return Err(match found {
            ScanHit::Secret(name) => AppConfigReadError::SecretField(name),
            ScanHit::MalformedHeader(name) => AppConfigReadError::InvalidHeader(name),
        });
    }

    let raw = value
        .get("format_version")
        .and_then(|v| v.as_u64())
        .ok_or(AppConfigReadError::VersionMissing)?;
    let version = u32::try_from(raw).map_err(|_| AppConfigReadError::VersionMissing)?;
    if version > APP_CONFIG_FORMAT_VERSION {
        return Err(AppConfigReadError::HigherVersion {
            found: version,
            supported: APP_CONFIG_FORMAT_VERSION,
        });
    }
    if version < APP_CONFIG_FORMAT_VERSION {
        return Err(AppConfigReadError::LowerVersion {
            found: version,
            supported: APP_CONFIG_FORMAT_VERSION,
        });
    }

    let mut cfg: AppConfig =
        serde_json::from_value(value).map_err(|e| AppConfigReadError::Parse(e.to_string()))?;
    // Read-path domain repair (issue #741): `normalize` only runs on writes,
    // but the engine fields are live-consumed now, so a hand-edited
    // out-of-domain value must never reach a session snapshot.
    cfg.engine.sanitize();
    Ok(cfg)
}

/// Why the read-time scan refused a file (issue #901).
enum ScanHit {
    /// A secret-named key on any face: a smuggled plaintext credential.
    Secret(String),
    /// A header name or value that cannot legally reach the wire (bad token
    /// charset or a control character) -- the hand-edit backstop mirroring
    /// the write boundary's charset checks.
    MalformedHeader(String),
}

/// Recursively scan a JSON value for refuse-worthy content: any object key
/// matching a secret name (case-insensitive, non-alphanumeric-stripped
/// comparison so `apiKey` / `API_KEY` / `api-key` all trip), and -- inside a
/// `headers` object's DIRECT keys -- a secret-named header (the expanded
/// [`is_secret_header_name`] list) or a malformed header name/value
/// (issue #901): a secret-named header's literal value must refuse the file
/// exactly like a smuggled `env` entry, and a hand-edited malformed header
/// fails here rather than as a generic connect-time error. `headers` is
/// unambiguous here -- the mcp transport header face is the only such key
/// in the schema.
///
/// Deliberately NOT scanned: a `keychain_env_keys` entry starting with
/// `header-` (the account collision the write boundary refuses, issue #904).
/// Tripping it needs one server to carry BOTH a `header-X` env key and an
/// `X` header secret -- a hand-edit racing the form's own write boundary,
/// self-inflicted and last-writer-wins; refusing the whole app-config over
/// it would nuke every unrelated preference for an asymmetrically small
/// harm. The write boundary (upsert) is the sole guard.
fn find_scan_hit(value: &Value) -> Option<ScanHit> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "headers" {
                    if let Value::Object(headers) = v {
                        for (name, sub) in headers {
                            if is_secret_header_name(name) {
                                return Some(ScanHit::Secret(name.clone()));
                            }
                            if !crate::mcp::config::is_valid_header_name(name)
                                || sub
                                    .as_str()
                                    .is_some_and(|value| value.chars().any(char::is_control))
                            {
                                return Some(ScanHit::MalformedHeader(name.clone()));
                            }
                            if let Some(found) = find_scan_hit(sub) {
                                return Some(found);
                            }
                        }
                        continue;
                    }
                }
                if is_secret_name(k) {
                    return Some(ScanHit::Secret(k.clone()));
                }
                if let Some(found) = find_scan_hit(v) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_scan_hit),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::model::{EngineDefaults, Theme};
    use std::path::PathBuf;

    /// Extract the string entries of one `const NAME = [ ... ];` array
    /// literal from the frontend source (the drift pin parses the TS file
    /// directly -- a snapshot constant would test nothing the TS compiler
    /// does not already check).
    fn ts_string_array(ts_source: &str, const_name: &str) -> Vec<String> {
        let start = ts_source
            .find(&format!("const {const_name} = ["))
            .unwrap_or_else(|| panic!("{const_name} not found in the TS source"));
        let rest = &ts_source[start..];
        let end = rest.find("];").expect("array close");
        rest[..end]
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let line = line.strip_suffix(',').unwrap_or(line);
                line.strip_prefix('"')?
                    .strip_suffix('"')
                    .map(str::to_string)
            })
            .collect()
    }

    /// The secret-vocabulary drift pin (issue #904): three hand-maintained
    /// copies must stay in lockstep --
    /// - Rust read-time: [`SECRET_KEY_NAMES`] + [`HEADER_SECRET_SUBSTRINGS`]
    ///   (their union, as [`is_secret_header_name`], must equal the
    ///   frontend's single two-face scan);
    /// - Frontend: the two arrays in `src/lib/mcp-json-parse.ts`;
    /// - Rust import path: [`crate::mcp::import::IMPORT_SECRET_SUBSTRINGS`],
    ///   a deliberate SUBSET of the header additions (the stdio-only import
    ///   path never sees `authorization` / `cookie` / `session`).
    ///
    /// The `cookie` / `session` fix in #901 was applied in all three places
    /// BY HAND; this pin exists so the next vocabulary change cannot land
    /// halfway (either side alone goes red until the copies are synced).
    #[test]
    fn secret_name_lists_match_the_frontend_and_import_copies() {
        let ts = include_str!("../../../src/lib/mcp-json-parse.ts");
        let to_strings = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(
            ts_string_array(ts, "SECRET_NAME_SUBSTRINGS"),
            to_strings(SECRET_KEY_NAMES),
            "the frontend base list must equal SECRET_KEY_NAMES entry for entry"
        );
        assert_eq!(
            ts_string_array(ts, "IMPORT_SECRET_SUBSTRINGS"),
            to_strings(HEADER_SECRET_SUBSTRINGS),
            "the frontend additions must equal HEADER_SECRET_SUBSTRINGS entry for entry"
        );
        for extra in crate::mcp::import::IMPORT_SECRET_SUBSTRINGS {
            assert!(
                HEADER_SECRET_SUBSTRINGS.contains(extra),
                "the import-path list must stay a subset of the header additions ({extra})"
            );
        }
    }

    /// A config with at least one non-default field, so a successful round-trip
    /// is distinguishable from a defaults-degrade.
    fn sample_config() -> AppConfig {
        let mut cfg = AppConfig::defaults();
        cfg.theme = Theme::Dark;
        cfg.engine = EngineDefaults {
            memory_limit: "1024MB".into(),
            threads: 8,
            row_cap: 500_000,
        };
        // Seed the ACTIVE profile's endpoint (the ADR-0098 defaults ship zero
        // profiles) so a successful round-trip is distinguishable from a
        // defaults-degrade.
        {
            let profile = crate::model::ProviderProfile::default_anthropic();
            cfg.provider.active_profile = Some(profile.id.clone());
            cfg.provider.profiles.push(profile);
            let active = cfg
                .provider
                .active_mut()
                .expect("seeded config has an active profile");
            active.base_url = "https://gateway.example.test".into();
            active.model = "claude-opus-4-8".into();
        }
        // Issue #84 / #251: non-default shell prefs exercise every shell field's
        // full io round-trip (a default-equal shell would pass == trivially).
        cfg.shell.sidebar_collapsed = true;
        cfg.shell.sidebar_grouping = crate::app_config::model::SidebarGrouping::Time;
        cfg
    }

    fn temp(target_name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(target_name);
        (dir, path)
    }

    #[test]
    fn write_then_read_round_trips_every_field() {
        // ADR-0038: a written config reads back identically -- the artifact is a
        // faithful record of the user's preferences.
        let (_dir, path) = temp("config.json");
        let cfg = sample_config();
        write_at(&path, &cfg).expect("write");
        let back = read_at(&path);
        assert_eq!(back, cfg);
    }

    #[test]
    fn retired_statement_timeout_key_is_ignored_and_dropped() {
        // A pre-#741 file carries `engine.statement_timeout_ms`. The field was
        // retired WITH the timeout mechanism (the `retry_budget` precedent):
        // parse must ignore the stale key (the rest of the engine block still
        // loads) and a rewrite must not carry it -- one load/save cycle and the
        // file converges to the current shape.
        let (_dir, path) = temp("legacy.json");
        let legacy = format!(
            "{{\"format_version\":{v},\"engine\":{{\"memory_limit\":\"1024MB\",\
             \"threads\":8,\"row_cap\":500,\"statement_timeout_ms\":7777}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &legacy).expect("write");
        let cfg = read_at(&path);
        assert_eq!(
            cfg.engine,
            EngineDefaults {
                memory_limit: "1024MB".into(),
                threads: 8,
                row_cap: 500,
            }
        );
        write_at(&path, &cfg).expect("rewrite");
        let on_disk = fs::read_to_string(&path).expect("read back");
        assert!(
            !on_disk.contains("statement_timeout_ms"),
            "rewritten file drops the retired key (got {on_disk})"
        );
    }

    #[test]
    fn hand_edited_engine_fields_are_sanitized_on_read() {
        // A hand-edited file can carry values the UI would never write: a
        // `memory_limit` DuckDB would parse as unlimited (`none`) or execute
        // as extra statements (embedded quote), and 0 counts that would
        // brick every non-empty materialization. The read path repairs all
        // three to their domain instead of threading them live.
        let (_dir, path) = temp("hand-edited.json");
        let hand_edited = format!(
            "{{\"format_version\":{v},\"engine\":{{\"memory_limit\":\
             \"none'; ATTACH 'x' AS leak; --\",\"threads\":0,\"row_cap\":0}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &hand_edited).expect("write");
        let cfg = read_at(&path);
        assert_eq!(
            cfg.engine,
            EngineDefaults {
                memory_limit: crate::guardrail::MEMORY_LIMIT.to_string(),
                threads: 1,
                row_cap: 1,
            }
        );
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        // Atomic write: a successful write renames the temp over the target, so
        // no `.tmp` litters the directory.
        let (_dir, path) = temp("config.json");
        write_at(&path, &AppConfig::defaults()).expect("write");
        let tmp = temp_path_for(&path).expect("temp path");
        assert!(!tmp.exists(), "temp file must not linger");
        assert!(path.exists(), "target exists");
    }

    #[test]
    fn write_overwrites_an_existing_file_atomically() {
        // Each save rewrites the whole file; a second write replaces the first.
        let (_dir, path) = temp("config.json");
        let mut first = AppConfig::defaults();
        first.theme = Theme::Light;
        write_at(&path, &first).expect("write 1");
        let second = sample_config();
        write_at(&path, &second).expect("write 2");
        let back = read_at(&path);
        assert_eq!(back, second);
    }

    #[test]
    fn read_a_missing_file_returns_defaults_silently() {
        // First launch / deleted file: defaults are the right value, no warning.
        let (_dir, path) = temp("absent.json");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_a_corrupt_file_degrades_to_defaults() {
        // Issue #53 AC: 损坏 -> 默认值, 不崩. Malformed JSON surfaces as
        // defaults, not a panic or an error.
        let (_dir, path) = temp("config.json");
        fs::write(&path, b"not json {").expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_a_higher_version_degrades_to_defaults() {
        // A newer app's config must not be silently mis-parsed (mirror of the
        // .duck honest-refuse, but app-config degrades because it is non-essential).
        let (_dir, path) = temp("config.json");
        let future = format!(
            "{{\"format_version\":{future},\"theme\":\"dark\"}}",
            future = APP_CONFIG_FORMAT_VERSION + 1
        );
        fs::write(&path, &future).expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_a_lower_version_degrades_to_defaults() {
        // Issue #150 / ADR-0064: a leftover v1 app-config file (the old single-
        // endpoint shape) honest-degrades to the v2 default profile skeleton,
        // not a crash or a mis-parse. ADR-0064 declines a v1->v2 migrator (the
        // app is unreleased, so a stale v1 file resets to defaults).
        let (_dir, path) = temp("config.json");
        fs::write(&path, b"{\"format_version\":1,\"theme\":\"dark\"}").expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_a_missing_format_version_degrades_to_defaults() {
        // format_version is mandatory; a hand-edited file without it is corrupt.
        let (_dir, path) = temp("config.json");
        fs::write(&path, b"{\"theme\":\"dark\"}").expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_degrades_when_a_secret_field_is_present_at_top_level() {
        // ADR-0029/0038 secrets-never: a hand-edited file smuggling in an
        // api_key is refused -- defaults load, and the plaintext key does not
        // silently sit on disk behind the type system.
        let (_dir, path) = temp("config.json");
        let smuggled = format!(
            "{{\"format_version\":{v},\"api_key\":\"sk-leak\"}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &smuggled).expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_degrades_when_a_secret_field_is_nested() {
        // The scan is recursive: a key nested under any object is also caught.
        let (_dir, path) = temp("config.json");
        let smuggled = format!(
            "{{\"format_version\":{v},\"provider\":{{\"base_url\":\"https://x\",\"model\":\"m\",\"secret\":\"sk-leak\"}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &smuggled).expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_degrades_when_an_mcp_server_env_smuggles_a_secret() {
        // Issue #301 AC#1 (secrets-never): a hand-edited config smuggling a
        // secret-named value into an MCP server's `env` (e.g. `API_KEY`) is
        // refused -- the recursive secret-name scan reaches into
        // mcp_servers.servers[].env, catches the key, and honest-degrades to
        // defaults. The structural defense (no secret field on McpServerConfig)
        // + this read-time backstop together make secrets-never enforceable:
        // the plaintext never sits on disk behind the type system. Secret env
        // values must live in the OS keychain (`mcp-<id>-<env_key>`), never here.
        let (_dir, path) = temp("config.json");
        let smuggled = format!(
            "{{\"format_version\":{v},\"mcp_servers\":{{\"servers\":[{{\"id\":\"github-mcp\",\"display_name\":\"GitHub\",\"transport\":{{\"type\":\"stdio\",\"command\":\"/bin/srv\"}},\"env\":{{\"API_KEY\":\"sk-leak\"}}}}]}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &smuggled).expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_refuses_a_cli_tool_env_with_a_secret_named_key() {
        // The CLI registry's env is non-secret by the same rule (issue #671,
        // ADR-0108): the recursive raw-JSON scan catches a smuggled
        // secret-named key under cli_tools.tools[].env and honest-degrades
        // to defaults, exactly as it does for mcp_servers.servers[].env.
        let (_dir, path) = temp("config.json");
        let smuggled = format!(
            "{{\"format_version\":{v},\"cli_tools\":{{\"tools\":[{{\"name\":\"pandoc\",\"description\":\"d\",\"executable\":\"pandoc\",\"env\":{{\"API_KEY\":\"sk-leak\"}}}}]}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &smuggled).expect("write");
        assert_eq!(read_at(&path), AppConfig::defaults());
    }

    #[test]
    fn read_refuses_a_secret_named_header_on_a_remote_transport() {
        // Issue #901: a hand-edited `transport.headers` entry whose NAME
        // matches the EXPANDED header-secret list (authorization / token /
        // bearer / jwt / privatekey, on top of the base secret names) is a
        // smuggled plaintext credential -- the read refuses the whole file
        // (honest degrade), exactly as it does for a smuggled env entry. The
        // name belongs in keychain_header_keys; the value in the OS keychain.
        for header_name in [
            "Authorization",
            "X-Api-Token",
            "X-Bearer-Id",
            "X-Jwt",
            "API_KEY",
            "Cookie",
            "X-Session-Id",
        ] {
            let (_dir, path) = temp("config.json");
            let smuggled = format!(
                "{{\"format_version\":{v},\"mcp_servers\":{{\"servers\":[{{\"id\":\"s\",\"display_name\":\"S\",\"transport\":{{\"type\":\"http\",\"url\":\"https://e.test\",\"headers\":{{\"{header_name}\":\"sk-leak\"}}}}}}]}}}}",
                v = APP_CONFIG_FORMAT_VERSION,
            );
            fs::write(&path, &smuggled).expect("write");
            assert_eq!(
                read_at(&path),
                AppConfig::defaults(),
                "{header_name} must refuse the file"
            );
        }
    }

    #[test]
    fn read_refuses_a_malformed_header_on_a_remote_transport() {
        // Issue #901: a hand-edited `transport.headers` entry whose NAME is
        // not an RFC 7230 token, or whose VALUE carries a control character
        // (the JSON `\r` escape parses to a real CR), is malformed -- the
        // read-time backstop mirrors the write boundary's charset checks so
        // the failure is a named refusal here, not a generic connect-time
        // `BadHeader`.
        for (name, value) in [("X Bad", "v"), ("X-Ok", "a\\rb"), ("X-Ok", "a\\nb")] {
            let (_dir, path) = temp("config.json");
            let smuggled = format!(
                "{{\"format_version\":{v},\"mcp_servers\":{{\"servers\":[{{\"id\":\"s\",\"display_name\":\"S\",\"transport\":{{\"type\":\"http\",\"url\":\"https://e.test\",\"headers\":{{\"{name}\":\"{value}\"}}}}}}]}}}}",
                v = APP_CONFIG_FORMAT_VERSION,
            );
            fs::write(&path, &smuggled).expect("write");
            assert_eq!(
                parse_at(&path),
                Err(AppConfigReadError::InvalidHeader(name.into())),
                "{name:?}={value:?} must refuse the file as malformed"
            );
            assert_eq!(read_at(&path), AppConfig::defaults());
        }
    }

    #[test]
    fn read_keeps_a_remote_transport_with_non_secret_headers() {
        // The complement: ordinary header names (`X-Api-Version`,
        // `Accept-Language`) are NOT on the expanded list -- a remote server
        // with non-secret headers reads back faithfully (the header face is
        // usable, not hostage to the scan).
        let (_dir, path) = temp("config.json");
        let legitimate = format!(
            "{{\"format_version\":{v},\"mcp_servers\":{{\"servers\":[{{\"id\":\"s\",\"display_name\":\"S\",\"transport\":{{\"type\":\"http\",\"url\":\"https://e.test\",\"headers\":{{\"X-Api-Version\":\"2024-11-05\",\"Accept-Language\":\"en\"}}}}}}]}}}}",
            v = APP_CONFIG_FORMAT_VERSION,
        );
        fs::write(&path, &legitimate).expect("write");
        let cfg = read_at(&path);
        assert_ne!(cfg, AppConfig::defaults(), "the file reads back");
        assert_eq!(cfg.mcp_servers.servers.len(), 1);
    }

    #[test]
    fn the_expanded_header_list_does_not_apply_to_env_names() {
        // The env-face list stays narrower (issue #901: the env-name scan is
        // unchanged): `authorization` as an ENV key does not trip the
        // read-time scan (it is neither on the base list nor scanned with
        // the header additions) while the same name as a HEADER does. The
        // import path applies its own wider list at import time -- that is a
        // separate seam, not this scan.
        assert!(!is_secret_name("authorization"));
        assert!(is_secret_header_name("authorization"));
        assert!(is_secret_header_name("cookie"));
        assert!(is_secret_header_name("X-Session-Id"));
        assert!(!is_secret_header_name("X-Api-Version"));
        assert!(
            is_secret_header_name("x-api-key"),
            "base list still applies"
        );
    }

    #[test]
    fn read_keeps_an_mcp_server_with_non_secret_env() {
        // The complement of the smuggle test: an MCP server carrying a
        // NON-secret env value (`LOG_LEVEL=info` -- no secret-name match) reads
        // back faithfully. The secret scan is false-positive-free across the
        // legitimate MCP env surface; only secret-named keys trip it.
        let (_dir, path) = temp("config.json");
        let json = format!(
            "{{\"format_version\":{v},\"mcp_servers\":{{\"servers\":[{{\"id\":\"srv\",\"display_name\":\"Srv\",\"transport\":{{\"type\":\"stdio\",\"command\":\"/bin/srv\"}},\"env\":{{\"LOG_LEVEL\":\"info\"}}}}]}}}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &json).expect("write");
        let cfg = read_at(&path);
        assert_eq!(
            cfg.mcp_servers.servers.len(),
            1,
            "non-secret env reads back"
        );
        let srv = &cfg.mcp_servers.servers[0];
        assert_eq!(srv.id.as_str(), "srv");
        assert_eq!(srv.env.get("LOG_LEVEL").map(String::as_str), Some("info"));
    }

    #[test]
    fn secret_scan_catches_casing_and_separator_variants() {
        // apiKey / API_KEY / api-key all collapse to the same token as api_key.
        assert!(is_secret_name("api_key"));
        assert!(is_secret_name("apiKey"));
        assert!(is_secret_name("API_KEY"));
        assert!(is_secret_name("api-key"));
        assert!(is_secret_name("anthropic_api_key"));
        assert!(!is_secret_name("base_url"));
        assert!(!is_secret_name("model"));
        assert!(!is_secret_name("theme"));
        assert!(!is_secret_name("locale"));
    }

    #[test]
    fn secret_scan_catches_prefixed_variants() {
        // Substring (not exact) matching: a smuggled key under a prefixed name
        // (my_api_key, openai_api_key, claude_api_key, anthropic_key) must also
        // trip the scan. The prior exact-match missed these, weakening the
        // secrets-never defense-in-depth (the primary defense is the model having
        // no key field; this scan is the read-time backstop for hand-edited files).
        assert!(is_secret_name("my_api_key"));
        assert!(is_secret_name("openai_api_key"));
        assert!(is_secret_name("claude_api_key"));
        assert!(is_secret_name("anthropic_key"));
        // The legit app-config field set must still NOT trip -- no secret name
        // is a substring of any collapsed field token.
        assert!(!is_secret_name("base_url"));
        assert!(!is_secret_name("memory_limit"));
        assert!(!is_secret_name("format_version"));
        assert!(!is_secret_name("default_format"));
        assert!(!is_secret_name("window_turns"));
    }

    #[test]
    fn partial_file_fills_missing_fields_from_defaults() {
        // Forward-compat within v1: a file missing a subsection still loads,
        // filling the gap from defaults rather than degrading wholesale. This
        // keeps a partial hand-edit (or a future same-version field) usable.
        let (_dir, path) = temp("config.json");
        let partial = format!(
            "{{\"format_version\":{v},\"theme\":\"dark\"}}",
            v = APP_CONFIG_FORMAT_VERSION
        );
        fs::write(&path, &partial).expect("write");
        let cfg = read_at(&path);
        assert_eq!(cfg.theme, Theme::Dark); // the one field that was present
        assert_eq!(cfg.engine, EngineDefaults::default()); // gap filled
        assert_eq!(cfg.provider, crate::model::ProviderConfig::default());
    }

    #[test]
    fn parse_at_pins_each_failure_mode() {
        // The typed error lets tests distinguish the failure modes that read_at
        // collapses into defaults. Missing + HigherVersion + SecretField are the
        // three load-bearing branches for the AC.
        let (_dir, path) = temp("config.json");

        // Missing.
        assert_eq!(parse_at(&path), Err(AppConfigReadError::Missing));

        // Higher version.
        fs::write(
            &path,
            format!("{{\"format_version\":{}}}", APP_CONFIG_FORMAT_VERSION + 1),
        )
        .expect("write");
        assert_eq!(
            parse_at(&path),
            Err(AppConfigReadError::HigherVersion {
                found: APP_CONFIG_FORMAT_VERSION + 1,
                supported: APP_CONFIG_FORMAT_VERSION
            })
        );

        // Secret field.
        fs::write(
            &path,
            format!(
                "{{\"format_version\":{v},\"api_key\":\"sk\"}}",
                v = APP_CONFIG_FORMAT_VERSION
            ),
        )
        .expect("write");
        assert_eq!(
            parse_at(&path),
            Err(AppConfigReadError::SecretField("api_key".into()))
        );

        // Lower version (stale v1 shape, issue #150 / ADR-0064).
        fs::write(&path, b"{\"format_version\":1}").expect("write");
        assert_eq!(
            parse_at(&path),
            Err(AppConfigReadError::LowerVersion {
                found: 1,
                supported: APP_CONFIG_FORMAT_VERSION
            })
        );
    }
}
