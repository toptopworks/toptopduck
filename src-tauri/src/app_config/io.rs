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
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Read(d) => write!(f, "read app-config for rewrite failed: {d}"),
            Self::Serialize(d) => write!(f, "serialize app-config failed: {d}"),
            Self::Io(d) => write!(f, "write app-config temp file failed: {d}"),
            Self::Rename(d) => write!(f, "replace app-config failed: {d}"),
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
    if let Some(found) = find_secret_field(&value) {
        return Err(AppConfigReadError::SecretField(found));
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

    serde_json::from_value(value).map_err(|e| AppConfigReadError::Parse(e.to_string()))
}

/// Recursively scan a JSON value for any object key matching a secret name
/// (case-insensitive, non-alphanumeric-stripped comparison so `apiKey` /
/// `API_KEY` / `api-key` all trip). Returns the offending key on the first hit.
fn find_secret_field(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if is_secret_name(k) {
                    return Some(k.clone());
                }
                if let Some(found) = find_secret_field(v) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_secret_field),
        _ => None,
    }
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
    let collapsed: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    SECRET_KEY_NAMES.iter().any(|secret| {
        let s: String = secret
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        collapsed.contains(&s)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::model::{EngineDefaults, Theme};
    use std::path::PathBuf;

    /// A config with at least one non-default field, so a successful round-trip
    /// is distinguishable from a defaults-degrade.
    fn sample_config() -> AppConfig {
        let mut cfg = AppConfig::defaults();
        cfg.theme = Theme::Dark;
        cfg.engine = EngineDefaults {
            memory_limit: "1024MB".into(),
            threads: 8,
            row_cap: 500_000,
            statement_timeout_ms: 10_000,
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
        assert!(!is_secret_name("statement_timeout_ms"));
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
