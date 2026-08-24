//! The app-config model for a user-configured MCP server (ADR-0076, issue #301
//! AC#1).
//!
//! Three types form the contract:
//! - [`McpServerId`]: stable opaque identity (minted once, never mutated),
//!   the keychain-account suffix anchor.
//! - [`McpTransport`]: the connection shape (stdio subprocess / sse / http).
//! - [`McpServerConfig`]: one server's descriptor + NON-SECRET env values.
//!
//! ## Secrets-never (ADR-0029/0036/0038)
//!
//! The model has NO field that semantically holds a secret. [`McpServerConfig::env`]
//! carries non-secret env values only (e.g. `LOG_LEVEL=info`); a secret value
//! (API token, password) lives in the OS keychain, NEVER in this config. Two
//! defenses make that enforceable rather than aspirational:
//!
//! 1. **Structural**: there is no `api_key` / `token` / `secret` field on any
//!    type here, so the write path cannot persist one through the type system.
//! 2. **Read-time scan** ([`crate::app_config::io`]): the existing recursive
//!    secret-name scan refuses the WHOLE config file if any key under any depth
//!    matches a secret name -- including a smuggled `env` entry like
//!    `{"API_KEY": "sk-..."}`. So a hand-edited file cannot keep a plaintext
//!    secret behind the type system; the honest-degrade target loads instead.
//!
//! The keychain account scheme for an MCP secret is `mcp-<server_id>-<env_key>`
//! (one OS entry per server + env name, so two servers both needing `API_KEY`
//! never collide). The store methods that read/write those entries land in a
//! later slice; this module pins the addressing anchor (the id) the scheme
//! composes onto.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// Stable identity for a user-configured MCP server (issue #301, ADR-0076).
///
/// Minted once at server creation and never mutated thereafter (mirrors
/// [`crate::model::ProfileId`]'s ADR-0037 reference/display split: the id is
/// the stable reference half, [`McpServerConfig::display_name`] is the
/// renamable display half). Opaque -- carried verbatim across IPC and used as
/// the keychain-account suffix anchor (`mcp-<id>-<env_key>`). Callers must not
/// assume any structure; a uuid v4 simple form is the intended spelling.
///
/// Sans secret -- the id itself is a non-secret pointer (the same property
/// [`crate::model::ProfileId`] relies on for `key-<id>`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct McpServerId(pub String);

impl McpServerId {
    /// The id as a string slice (for keychain-account formatting, lookups, etc.).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for McpServerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for McpServerId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The MCP transport for a configured server (issue #301, ADR-0076).
///
/// Internally tagged (`type` field) + snake_case variant names, matching the
/// ACP wire [`crate::runtime::acp::wire::McpServer`] convention so the
/// hand-edited config form reads identically to the ACP-injected descriptor:
/// `{"type":"stdio","command":"...","args":[...]}`. The http / sse variants
/// carry a single `url`; the MCP client (later slice) differentiates the
/// transport at connect time.
///
/// `command` / `args` on [`McpTransport::Stdio`] default empty so a partial
/// hand-edit (a server under construction) deserializes rather than rejecting
/// the whole config; the gateway surfaces a connection fault for an empty
/// command at spawn time rather than the config layer guessing validity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    /// A stdio MCP server: the app spawns `command` with `args`, speaks
    /// newline-delimited JSON-RPC over the child's stdin/stdout (the MCP stdio
    /// transport contract). The user's configured external MCP servers are
    /// overwhelmingly stdio (the MCP SDK's default).
    Stdio {
        /// Absolute path (or PATH-resolved name) of the server executable.
        #[serde(default)]
        command: String,
        /// Argv passed to the executable. Empty is valid (a server may take none).
        #[serde(default)]
        args: Vec<String>,
    },
    /// A Server-Sent-Events MCP transport: the client opens `url` for a
    /// bidirectional SSE channel. v1 advertises the shape; the MCP client
    /// wiring lands in a later slice.
    Sse { url: String },
    /// A streamable-HTTP MCP transport (MCP spec rev): the client POSTs JSON-RPC
    /// to `url`. v1 advertises the shape; the MCP client wiring lands in a
    /// later slice.
    Http { url: String },
}

impl McpTransport {
    /// Construct a stdio transport (the common case -- most user-configured
    /// servers are stdio subprocesses). Keeps call sites terse without a struct
    /// literal that names every field.
    pub fn stdio(command: impl Into<String>, args: Vec<String>) -> Self {
        Self::Stdio {
            command: command.into(),
            args,
        }
    }
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

/// One user-configured MCP server (issue #301, ADR-0076).
///
/// The connection descriptor ([`Self::transport`]) plus NON-SECRET env values
/// ([`Self::env`]). Secret env values (API tokens, passwords) live in the OS
/// keychain under `mcp-<id>-<env_key>` (ADR-0029/0036), NEVER here -- see the
/// module-level secrets-never note. [`Self::display_name`] is the renamable UI
/// label; [`Self::id`] is the stable identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Stable identity (minted once; see [`McpServerId`]). Also the keychain
    /// account suffix anchor.
    pub id: McpServerId,
    /// Renamable display label (ADR-0037 display half). Sans secret, sans
    /// transport semantics -- purely what the UI shows. `#[serde(default)]`
    /// so a partial hand-edit fills empty rather than rejecting the file; the
    /// registry upsert fills it from the id when empty
    /// (see [`McpServerRegistry::upsert`]).
    #[serde(default)]
    pub display_name: String,
    /// How the gateway connects to the server.
    pub transport: McpTransport,
    /// NON-SECRET env values the gateway passes to the server at spawn/connect
    /// (e.g. `LOG_LEVEL=info`). A key matching the secret-name scan
    /// (`api_key` / `token` / `secret` / ...) is refused at config read time
    /// (see [`crate::app_config::io`]); such a value MUST live in the
    /// keychain. `BTreeMap` (not `HashMap`) so serialization is deterministic
    /// -- stable diffs across writes + stable round-trip in tests.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The env_key names whose VALUES live in the OS keychain (issue #301,
    /// ADR-0029). The gateway reads each via `get_mcp_secret(id, env_key)`
    /// at spawn time and injects it into the child env alongside
    /// [`Self::env`]; the values NEVER cross this config (structural +
    /// read-time scan, ADR-0029/0036/0038). A separate list (not mixed into
    /// `env`) keeps the config all-non-secret and the gateway injection
    /// contract explicit. `#[serde(default)]` so a config written before
    /// this field existed deserializes to empty (no secret env injected --
    /// the server still runs with its non-secret env).
    #[serde(default)]
    pub keychain_env_keys: Vec<String>,
    /// Per-server call timeout in milliseconds (issue #301). `None` = the
    /// gateway's default timeout applies (the gateway client lands in a later
    /// slice); `Some(ms)` overrides per server. `#[serde(default)]` so a config
    /// written before this field existed deserializes to `None` (forward-compat,
    /// mirroring `AppConfig.last_dir`). The gateway enforces the value at
    /// connect / call time -- this layer does NOT validate it (0 / huge values
    /// surface as a gateway fault, not a config-layer reject).
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    /// Machine-level persistent enablement (ADR-0106). Enabled = the server
    /// enters every session's effective tool surface (connected + catalogued
    /// at turn assembly); disabled = dormant -- no connect, no child spawn,
    /// no keychain secret read, no catalog entry. Disabled is absolute: no
    /// skill declaration or other path re-arms it. `#[serde(default = ...)]`
    /// true so a config written before this field existed (legacy migration),
    /// a new entry, or a partial hand-edit all default to enabled.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// Serde default for [`McpServerConfig::enabled`]: `true` (ADR-0106 Decision 4
/// -- every existing entry migrates enabled; the three write entries -- form
/// save, import, legacy config -- all carry explicit user intent).
fn default_enabled() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// The user-configured MCP server registry (issue #301): the named wrapper
/// [`crate::app_config::AppConfig`] carries as its `mcp_servers` field. Parallels
/// [`crate::model::ProviderConfig`] as a cohesive sub-structure with its own
/// invariant + upsert helper. Default is empty -- the app ships
/// with no preconfigured external servers; the user adds them from settings.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct McpServerRegistry {
    /// The configured servers, in the order the user added them (the settings
    /// UI renders this order; upsert preserves it).
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

impl McpServerRegistry {
    /// Enforce the registry invariant: unique ids. A hand-edited file with
    /// duplicate ids keeps the FIRST occurrence of each and drops the rest
    /// (ADR-0038 honest-degrade style -- the config does not brick; the
    /// keychain-account suffix `mcp-<id>-...` stays unambiguous). Called by
    /// [`crate::app_config::AppConfig::normalize`] on every write.
    pub fn normalize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.servers.retain(|s| seen.insert(s.id.clone()));
    }

    /// Look up a server by id.
    pub fn get(&self, id: &McpServerId) -> Option<&McpServerConfig> {
        self.servers.iter().find(|s| &s.id == id)
    }

    /// Upsert one server: mint a uuid v4 (simple form) id when the incoming id
    /// is empty / whitespace-only (a new server from the frontend), fill
    /// `display_name` from the id when empty, then replace an existing entry
    /// with the same id or append. Returns the finalized config (with the
    /// stable id) so the IPC layer hands the id back to the frontend for
    /// subsequent secret calls.
    pub fn upsert(&mut self, mut server: McpServerConfig) -> McpServerConfig {
        if server.id.as_str().trim().is_empty() {
            server.id = McpServerId(uuid::Uuid::new_v4().simple().to_string());
        }
        if server.display_name.is_empty() {
            server.display_name = server.id.as_str().to_string();
        }
        match self.servers.iter_mut().find(|s| s.id == server.id) {
            Some(slot) => *slot = server.clone(),
            None => self.servers.push(server.clone()),
        }
        server
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- McpServerId -------------------------------------------------------

    #[test]
    fn mcp_server_id_is_transparent_string() {
        // serde(transparent): the id serializes as a bare JSON string, not an
        // object -- so the config file reads `"id": "github-mcp"`, not
        // `"id": {"0": "github-mcp"}`. Matches ProfileId's wire form.
        let id = McpServerId("github-mcp".into());
        assert_eq!(serde_json::to_string(&id).unwrap(), r#""github-mcp""#);
        let back: McpServerId = serde_json::from_str(r#""github-mcp""#).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn mcp_server_id_as_str_display_as_ref_agree() {
        let id = McpServerId("abc-123".into());
        assert_eq!(id.as_str(), "abc-123");
        assert_eq!(id.to_string(), "abc-123");
        assert_eq!(AsRef::<str>::as_ref(&id), "abc-123");
    }

    // --- McpTransport ------------------------------------------------------

    #[test]
    fn stdio_transport_serializes_with_type_tag_and_snake_case() {
        // The hand-edited config form: internally tagged `type` + snake_case
        // variant, matching the ACP McpServer convention (wire.rs). Pinning the
        // shape so a future rename_all / tag rework cannot drift the on-disk
        // form past a hand-edited file.
        let t = McpTransport::stdio(
            "/usr/local/bin/github-mcp",
            vec!["--port".into(), "8080".into()],
        );
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["type"], "stdio");
        assert_eq!(json["command"], "/usr/local/bin/github-mcp");
        assert_eq!(json["args"][0], "--port");
        assert_eq!(json["args"][1], "8080");
    }

    #[test]
    fn sse_transport_serializes_url_only() {
        let t = McpTransport::Sse {
            url: "https://example.test/sse".into(),
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["type"], "sse");
        assert_eq!(json["url"], "https://example.test/sse");
    }

    #[test]
    fn http_transport_serializes_url_only() {
        let t = McpTransport::Http {
            url: "https://example.test/mcp".into(),
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["type"], "http");
        assert_eq!(json["url"], "https://example.test/mcp");
    }

    #[test]
    fn stdio_transport_with_empty_args_round_trips() {
        // `args` defaults empty; a server that takes no args round-trips.
        let t = McpTransport::stdio("/bin/server", Vec::new());
        let json = serde_json::to_string(&t).unwrap();
        let back: McpTransport = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn stdio_transport_partial_deserialize_fills_default_args() {
        // A hand-edit in progress (command only, no args) deserializes rather
        // than rejecting the whole config -- args fills empty via serde(default).
        let json = r#"{"type":"stdio","command":"/bin/srv"}"#;
        let t: McpTransport = serde_json::from_str(json).unwrap();
        match t {
            McpTransport::Stdio { command, args } => {
                assert_eq!(command, "/bin/srv");
                assert!(args.is_empty(), "missing args -> empty default");
            }
            _ => panic!("expected Stdio"),
        }
    }

    #[test]
    fn unknown_transport_variant_is_rejected() {
        // No #[serde(other)] fallback: a typo'd or forward-incompatible
        // transport (`websockets`) rejects the whole config (honest-degrade to
        // defaults at read time), rather than silently dropping a server.
        // Pinning so adding #[serde(other)] later is deliberate, not drift.
        let json = r#"{"type":"websockets","url":"wss://x"}"#;
        let result: Result<McpTransport, _> = serde_json::from_str(json);
        assert!(result.is_err(), "unknown transport must reject");
    }

    // --- McpServerConfig round-trip ---------------------------------------

    #[test]
    fn server_config_round_trips_with_stdio_and_env() {
        let mut env = BTreeMap::new();
        env.insert("LOG_LEVEL".into(), "debug".into());
        env.insert("CACHE_DIR".into(), "/tmp/mcp".into());
        let cfg = McpServerConfig {
            id: McpServerId("github-mcp".into()),
            display_name: "GitHub".into(),
            transport: McpTransport::stdio("/usr/local/bin/github-mcp", vec!["--stdio".into()]),
            env,
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: false,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: McpServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        // BTreeMap iteration is deterministic -> the serialized env keys are
        // sorted, so two writes of the same config produce byte-identical files
        // (stable diffs + stable round-trip).
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let env_keys: Vec<&str> = value["env"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            env_keys,
            vec!["CACHE_DIR", "LOG_LEVEL"],
            "BTreeMap sorts keys"
        );
    }

    #[test]
    fn server_config_partial_deserialize_fills_defaults() {
        // Forward-compat: a config written before display_name/env existed
        // (or a hand-edit with only id + transport) fills the missing fields
        // from default rather than rejecting.
        let json = r#"{
            "id": "raw-server",
            "transport": {"type": "stdio", "command": "/bin/srv"}
        }"#;
        let cfg: McpServerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.id, McpServerId("raw-server".into()));
        assert_eq!(
            cfg.display_name, "",
            "missing display_name -> empty default"
        );
        assert!(cfg.env.is_empty(), "missing env -> empty default");
        assert!(
            cfg.keychain_env_keys.is_empty(),
            "missing keychain_env_keys -> empty default"
        );
        assert!(
            cfg.timeout_ms.is_none(),
            "missing timeout_ms -> None default"
        );
        assert!(
            cfg.enabled,
            "missing enabled -> true default (ADR-0106: legacy migration stays enabled)"
        );
    }

    // --- McpServerRegistry -------------------------------------------------

    #[test]
    fn empty_registry_round_trips_and_defaults() {
        let reg = McpServerRegistry::default();
        assert!(reg.servers.is_empty());
        let json = serde_json::to_string(&reg).unwrap();
        let back: McpServerRegistry = serde_json::from_str(&json).unwrap();
        assert_eq!(back, reg);
    }

    #[test]
    fn registry_get_finds_by_id() {
        let mut reg = McpServerRegistry::default();
        reg.servers.push(McpServerConfig {
            id: McpServerId("alpha".into()),
            display_name: "Alpha".into(),
            transport: McpTransport::stdio("/bin/a", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        });
        assert!(reg.get(&McpServerId("alpha".into())).is_some());
        assert!(reg.get(&McpServerId("missing".into())).is_none());
    }

    #[test]
    fn registry_normalize_dedupes_by_id_keeping_first() {
        // A hand-edited file with duplicate ids keeps the first occurrence of
        // each and drops the rest, so the keychain-account suffix stays
        // unambiguous (mcp-<id>-<env_key> points at one server).
        let mut reg = McpServerRegistry {
            servers: vec![
                McpServerConfig {
                    id: McpServerId("dup".into()),
                    display_name: "First".into(),
                    transport: McpTransport::stdio("/bin/first", Vec::new()),
                    env: BTreeMap::new(),
                    keychain_env_keys: Vec::new(),
                    timeout_ms: None,
                    enabled: true,
                },
                McpServerConfig {
                    id: McpServerId("dup".into()),
                    display_name: "Second".into(),
                    transport: McpTransport::stdio("/bin/second", Vec::new()),
                    env: BTreeMap::new(),
                    keychain_env_keys: Vec::new(),
                    timeout_ms: None,
                    enabled: true,
                },
                McpServerConfig {
                    id: McpServerId("unique".into()),
                    display_name: "Unique".into(),
                    transport: McpTransport::stdio("/bin/u", Vec::new()),
                    env: BTreeMap::new(),
                    keychain_env_keys: Vec::new(),
                    timeout_ms: None,
                    enabled: true,
                },
            ],
        };
        reg.normalize();
        assert_eq!(reg.servers.len(), 2, "duplicate dropped");
        assert_eq!(
            reg.servers[0].display_name, "First",
            "first occurrence kept"
        );
        assert_eq!(reg.servers[1].id, McpServerId("unique".into()));
    }

    #[test]
    fn registry_normalize_is_idempotent() {
        // A clean registry is unaffected; a second normalize on a deduped one
        // changes nothing.
        let mut reg = McpServerRegistry {
            servers: vec![McpServerConfig {
                id: McpServerId("solo".into()),
                display_name: "Solo".into(),
                transport: McpTransport::stdio("/bin/s", Vec::new()),
                env: BTreeMap::new(),
                keychain_env_keys: Vec::new(),
                timeout_ms: None,
                enabled: true,
            }],
        };
        let before = reg.clone();
        reg.normalize();
        assert_eq!(reg, before, "no dupes -> no change");
    }

    // --- upsert / remove (slice B) -----------------------------------------

    #[test]
    fn registry_upsert_mints_uuid_v4_when_id_empty() {
        // A new server from the frontend carries an empty id; upsert mints a
        // uuid v4 simple form (32 hex chars, no dashes) so the keychain account
        // suffix + the IPC reference stay unique and parse-free.
        let mut reg = McpServerRegistry::default();
        let incoming = McpServerConfig {
            id: McpServerId(String::new()),
            display_name: String::new(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(incoming);
        assert_ne!(stored.id.as_str(), "");
        assert_eq!(
            stored.id.as_str().len(),
            32,
            "uuid v4 simple = 32 hex chars"
        );
        assert!(stored.id.as_str().chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(reg.servers.len(), 1);
        assert_eq!(reg.servers[0].id, stored.id);
    }

    #[test]
    fn registry_upsert_mints_uuid_v4_when_id_whitespace_only() {
        // A whitespace-only id is treated as "no id" -- upsert mints a uuid v4
        // rather than keeping a blank keychain-account suffix anchor the frontend
        // cannot reference and the gateway cannot inject.
        let mut reg = McpServerRegistry::default();
        let incoming = McpServerConfig {
            id: McpServerId("   \t".into()),
            display_name: String::new(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(incoming);
        assert_ne!(stored.id.as_str(), "   \t");
        assert_eq!(stored.id.as_str().len(), 32, "minted uuid v4 simple");
        assert_eq!(reg.servers.len(), 1);
        assert_eq!(reg.servers[0].id, stored.id);
    }

    #[test]
    fn registry_upsert_fills_display_name_from_id_when_empty() {
        let mut reg = McpServerRegistry::default();
        let incoming = McpServerConfig {
            id: McpServerId("github-mcp".into()),
            display_name: String::new(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(incoming);
        assert_eq!(stored.display_name, "github-mcp");
        assert_eq!(reg.servers[0].display_name, "github-mcp");
    }

    #[test]
    fn registry_upsert_keeps_display_name_when_provided() {
        let mut reg = McpServerRegistry::default();
        let incoming = McpServerConfig {
            id: McpServerId("github-mcp".into()),
            display_name: "My GitHub".into(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(incoming);
        assert_eq!(stored.display_name, "My GitHub");
    }

    #[test]
    fn registry_upsert_replaces_existing_by_id() {
        let mut reg = McpServerRegistry {
            servers: vec![McpServerConfig {
                id: McpServerId("github-mcp".into()),
                display_name: "Old".into(),
                transport: McpTransport::stdio("/bin/old", Vec::new()),
                env: BTreeMap::new(),
                keychain_env_keys: Vec::new(),
                timeout_ms: None,
                enabled: true,
            }],
        };
        let updated = McpServerConfig {
            id: McpServerId("github-mcp".into()),
            display_name: "New".into(),
            transport: McpTransport::stdio("/bin/new", vec!["--flag".into()]),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(updated);
        assert_eq!(reg.servers.len(), 1, "replace not append");
        assert_eq!(reg.servers[0].display_name, "New");
        assert_eq!(stored.display_name, "New");
        match &reg.servers[0].transport {
            McpTransport::Stdio { command, args } => {
                assert_eq!(command, "/bin/new");
                assert_eq!(args.len(), 1);
            }
            _ => panic!("expected Stdio"),
        }
    }

    #[test]
    fn registry_upsert_appends_when_id_new() {
        let mut reg = McpServerRegistry {
            servers: vec![McpServerConfig {
                id: McpServerId("alpha".into()),
                display_name: "Alpha".into(),
                transport: McpTransport::stdio("/bin/a", Vec::new()),
                env: BTreeMap::new(),
                keychain_env_keys: Vec::new(),
                timeout_ms: None,
                enabled: true,
            }],
        };
        let beta = McpServerConfig {
            id: McpServerId("beta".into()),
            display_name: "Beta".into(),
            transport: McpTransport::stdio("/bin/b", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(beta);
        assert_eq!(reg.servers.len(), 2);
        assert_eq!(reg.servers[1].id, McpServerId("beta".into()));
        assert_eq!(stored.id, McpServerId("beta".into()));
    }

    // --- timeout_ms (T1) ----------------------------------------------------

    #[test]
    fn server_config_timeout_ms_round_trips_some_and_null() {
        // Some -> JSON number; None -> JSON null. Mirrors the project's Option
        // + bare serde(default) convention (AppConfig.last_dir): no
        // skip_serializing_if, so the on-disk shape stays stable. Both
        // round-trip.
        let with_timeout = McpServerConfig {
            id: McpServerId("slow-server".into()),
            display_name: "Slow".into(),
            transport: McpTransport::stdio("/bin/slow", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: Some(45_000),
            enabled: true,
        };
        let json = serde_json::to_value(&with_timeout).unwrap();
        assert_eq!(json["timeout_ms"], 45_000);

        let null_timeout = McpServerConfig {
            id: McpServerId("default-server".into()),
            display_name: "Default".into(),
            transport: McpTransport::stdio("/bin/default", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let json = serde_json::to_value(&null_timeout).unwrap();
        assert!(json["timeout_ms"].is_null());

        let back: McpServerConfig =
            serde_json::from_str(&serde_json::to_string(&with_timeout).unwrap()).unwrap();
        assert_eq!(back.timeout_ms, Some(45_000));
        let back: McpServerConfig =
            serde_json::from_str(&serde_json::to_string(&null_timeout).unwrap()).unwrap();
        assert_eq!(back.timeout_ms, None);
    }

    #[test]
    fn registry_upsert_preserves_timeout_ms() {
        // upsert is a passthrough for timeout_ms -- it does not mint or fill the
        // field (unlike id / display_name). Whatever the frontend sent (Some or
        // None) lands verbatim, and a replace keeps the NEW value (does not
        // carry the old forward).
        let mut reg = McpServerRegistry::default();
        let with_timeout = McpServerConfig {
            id: McpServerId("slow".into()),
            display_name: "Slow".into(),
            transport: McpTransport::stdio("/bin/slow", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: Some(45_000),
            enabled: true,
        };
        let stored = reg.upsert(with_timeout);
        assert_eq!(stored.timeout_ms, Some(45_000));
        assert_eq!(reg.servers[0].timeout_ms, Some(45_000));

        // Replace with None -- the new value wins, the old Some does not carry.
        let without_timeout = McpServerConfig {
            id: McpServerId("slow".into()),
            display_name: "Slow".into(),
            transport: McpTransport::stdio("/bin/slow", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = reg.upsert(without_timeout);
        assert_eq!(stored.timeout_ms, None);
        assert_eq!(reg.servers[0].timeout_ms, None);
    }

    // --- keychain_env_keys (C0) ---------------------------------------------

    #[test]
    fn server_config_keychain_env_keys_round_trips() {
        // The list of keychain-backed env_key names serializes as a JSON
        // array of strings. The values themselves never touch this config
        // (ADR-0029 -- they live in the keychain under mcp-<id>-<env_key>);
        // only the key NAMES ride here so the gateway knows which entries
        // to read at spawn time. Empty serializes as [].
        let cfg = McpServerConfig {
            id: McpServerId("github-mcp".into()),
            display_name: "GitHub".into(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: vec!["API_KEY".into(), "WEBHOOK_SECRET".into()],
            timeout_ms: None,
            enabled: true,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(
            json["keychain_env_keys"],
            serde_json::json!(["API_KEY", "WEBHOOK_SECRET"])
        );
        let back: McpServerConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back.keychain_env_keys, cfg.keychain_env_keys);

        // Empty list round-trips as [].
        let empty = McpServerConfig {
            id: McpServerId("bare".into()),
            display_name: "Bare".into(),
            transport: McpTransport::stdio("/bin/bare", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let json = serde_json::to_value(&empty).unwrap();
        assert!(json["keychain_env_keys"].is_array());
        assert!(json["keychain_env_keys"].as_array().unwrap().is_empty());
    }
}
