//! MCP server import from external tool configs (issue #390, ADR-0076).
//!
//! Each external source (Claude Desktop, Codex) has its own parser that
//! discovers the config file (platform-specific path) and maps the external
//! format into [`DiscoveredServer`] entries. The parsers are independent and
//! extensible -- a new source adds a parser function + a match arm in
//! [`discover`], with no changes to existing parsers.
//!
//! ## Secrets handling
//!
//! External configs (especially Claude Desktop) often carry secret env values
//! inline (e.g. `API_KEY`). The app-config read-time scan refuses any key
//! matching a secret name (see [`crate::app_config::io::is_secret_name`]).
//! During import, env keys that match the scan are routed to
//! [`DiscoveredServer::keychain_env_keys`] (name only -- the value is dropped;
//! the user re-enters it after import). Non-secret env values stay in the env
//! map and ride the normal config write.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::app_config::io::is_secret_name;
use crate::mcp::config::McpTransport;

/// The external source to import MCP servers from (issue #390). Serialized as
/// a plain string over IPC (`"claude_desktop"` / `"codex"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportSource {
    #[serde(rename = "claude_desktop")]
    ClaudeDesktop,
    #[serde(rename = "codex")]
    Codex,
}

/// One server discovered in an external config (issue #390). A subset of
/// [`crate::mcp::config::McpServerConfig`] without the `id` (empty -- Rust
/// mints a uuid v4 on upsert) or `timeout_ms` (defaults to `None` -- the
/// gateway default applies). The frontend renders these in a checklist, then
/// batch-upserts the selected entries via `upsert_mcp_server`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredServer {
    /// The server name from the external config (used as the display label).
    pub display_name: String,
    /// How the gateway connects to the server.
    pub transport: McpTransport,
    /// NON-SECRET env values from the external config.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Env key names whose VALUES matched the secret scan and were routed to
    /// the keychain (values dropped during import -- the user re-enters them).
    #[serde(default)]
    pub keychain_env_keys: Vec<String>,
}

/// Discover MCP servers from an external config (issue #390). Returns the
/// parsed server list, or an empty vec if the config file is not found (the
/// frontend shows a "not found" message -- this is NOT an error).
///
/// Parse errors (malformed JSON / TOML) return an error string so the frontend
/// can tell the user the file exists but could not be read.
pub fn discover(source: ImportSource) -> Result<Vec<DiscoveredServer>, String> {
    match source {
        ImportSource::ClaudeDesktop => discover_claude_desktop(),
        ImportSource::Codex => discover_codex(),
    }
}

// ---------------------------------------------------------------------------
// Claude Desktop
// ---------------------------------------------------------------------------

/// Locate the Claude Desktop config file on this platform.
///
/// - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
/// - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
/// - Linux: `~/.config/Claude/claude_desktop_config.json`
fn claude_desktop_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // %APPDATA% is the Roaming app-data dir on Windows; Claude Desktop
        // stores its config there.
        let appdata = std::env::var("APPDATA").ok()?;
        Some(
            PathBuf::from(appdata)
                .join("Claude")
                .join("claude_desktop_config.json"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        )
    }
    #[cfg(target_os = "linux")]
    {
        // XDG_CONFIG_HOME or ~/.config
        let config_dir = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).ok();
        let base = match config_dir {
            Some(dir) => dir,
            None => {
                let home = std::env::var("HOME").ok()?;
                PathBuf::from(home).join(".config")
            }
        };
        Some(base.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Claude Desktop config JSON shape (only the `mcpServers` object is read).
#[derive(Deserialize)]
struct ClaudeDesktopConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, ClaudeDesktopServer>,
}

/// One Claude Desktop MCP server entry.
#[derive(Deserialize)]
struct ClaudeDesktopServer {
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn discover_claude_desktop() -> Result<Vec<DiscoveredServer>, String> {
    let path = match claude_desktop_config_path() {
        Some(p) => p,
        None => return Ok(Vec::new()), // Unsupported platform = "not found"
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    parse_claude_desktop_config(&content)
        .map_err(|e| format!("failed to parse {}: {e}", path.display()))
}

/// Pure parse of a Claude Desktop config JSON string (testable without touching
/// the filesystem). Extracted from [`discover_claude_desktop`] so unit tests can
/// exercise the parse + mapping logic + malformed-input rejection.
fn parse_claude_desktop_config(content: &str) -> Result<Vec<DiscoveredServer>, String> {
    let config: ClaudeDesktopConfig = serde_json::from_str(content).map_err(|e| e.to_string())?;
    Ok(config
        .mcp_servers
        .into_iter()
        .map(|(name, server)| parse_external_server(&name, server.command, server.args, server.env))
        .collect())
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// Locate the Codex CLI config file. Codex stores its config at
/// `~/.codex/config.toml`.
fn codex_config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".codex").join("config.toml"))
}

/// Codex config TOML shape (only the `[mcp_servers.*]` tables are read).
///
/// Each `[mcp_servers.NAME]` table has `command`, `args`, and optionally an
/// `[mcp_servers.NAME.env]` subtable:
///
/// ```toml
/// [mcp_servers.my-server]
/// command = "npx"
/// args = ["-y", "@modelcontextprotocol/server-filesystem"]
///
/// [mcp_servers.my-server.env]
/// LOG_LEVEL = "debug"
/// ```
#[derive(Deserialize)]
struct CodexConfig {
    #[serde(default, rename = "mcp_servers")]
    mcp_servers: BTreeMap<String, CodexMcpServer>,
}

#[derive(Deserialize)]
struct CodexMcpServer {
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn discover_codex() -> Result<Vec<DiscoveredServer>, String> {
    let path = match codex_config_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    parse_codex_config(&content).map_err(|e| format!("failed to parse {}: {e}", path.display()))
}

/// Pure parse of a Codex config TOML string (testable without touching the
/// filesystem). Extracted from [`discover_codex`] so unit tests can exercise
/// the parse + mapping logic + malformed-input rejection.
fn parse_codex_config(content: &str) -> Result<Vec<DiscoveredServer>, String> {
    let config: CodexConfig = toml::from_str(content).map_err(|e| e.to_string())?;
    Ok(config
        .mcp_servers
        .into_iter()
        .map(|(name, server)| parse_external_server(&name, server.command, server.args, server.env))
        .collect())
}

// ---------------------------------------------------------------------------
// Shared mapping
// ---------------------------------------------------------------------------

/// Map one external server entry (common stdio shape across both sources) into
/// a [`DiscoveredServer`], splitting env values into non-secret vs keychain.
///
/// Env keys matching the secret scan ([`is_secret_name`]) are routed to
/// `keychain_env_keys` (name only -- the value is dropped; the user re-enters
/// it after import). Non-secret values stay in the env map.
fn parse_external_server(
    name: &str,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
) -> DiscoveredServer {
    let mut safe_env = BTreeMap::new();
    let mut keychain_env_keys = Vec::new();
    for (key, value) in env {
        if is_secret_name(&key) {
            keychain_env_keys.push(key);
        } else {
            safe_env.insert(key, value);
        }
    }
    DiscoveredServer {
        display_name: name.to_string(),
        transport: McpTransport::Stdio { command, args },
        env: safe_env,
        keychain_env_keys,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::config::McpTransport;

    #[test]
    fn claude_desktop_parses_stdio_servers() {
        let json = r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                    "env": { "LOG_LEVEL": "debug" }
                },
                "github": {
                    "command": "node",
                    "args": ["github-server.js"]
                }
            }
        }"#;
        let config: ClaudeDesktopConfig = serde_json::from_str(json).unwrap();
        let servers: Vec<DiscoveredServer> = config
            .mcp_servers
            .into_iter()
            .map(|(name, s)| parse_external_server(&name, s.command, s.args, s.env))
            .collect();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].display_name, "filesystem");
        assert!(matches!(
            &servers[0].transport,
            McpTransport::Stdio { command, args } if command == "npx" && args.len() == 3
        ));
        assert_eq!(servers[0].env.get("LOG_LEVEL").unwrap(), "debug");
        assert!(servers[0].keychain_env_keys.is_empty());

        assert_eq!(servers[1].display_name, "github");
        assert!(servers[1].env.is_empty());
    }

    #[test]
    fn claude_desktop_empty_mcp_servers_is_empty_vec() {
        let json = r#"{"mcpServers": {}}"#;
        let config: ClaudeDesktopConfig = serde_json::from_str(json).unwrap();
        assert!(config.mcp_servers.is_empty());
    }

    #[test]
    fn claude_desktop_missing_mcp_servers_defaults_empty() {
        let json = r#"{"otherKey": 42}"#;
        let config: ClaudeDesktopConfig = serde_json::from_str(json).unwrap();
        assert!(config.mcp_servers.is_empty());
    }

    #[test]
    fn codex_parses_stdio_servers() {
        let toml = r#"
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.filesystem.env]
LOG_LEVEL = "debug"
"#;
        let config: CodexConfig = toml::from_str(toml).unwrap();
        let servers: Vec<DiscoveredServer> = config
            .mcp_servers
            .into_iter()
            .map(|(name, s)| parse_external_server(&name, s.command, s.args, s.env))
            .collect();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].display_name, "filesystem");
        assert!(matches!(
            &servers[0].transport,
            McpTransport::Stdio { command, args } if command == "npx" && args.len() == 3
        ));
        assert_eq!(servers[0].env.get("LOG_LEVEL").unwrap(), "debug");
    }

    #[test]
    fn codex_empty_mcp_servers_is_empty_vec() {
        let toml = r#"model = "o4-mini""#;
        let config: CodexConfig = toml::from_str(toml).unwrap();
        assert!(config.mcp_servers.is_empty());
    }

    #[test]
    fn secret_env_keys_routed_to_keychain() {
        let mut env = BTreeMap::new();
        env.insert("LOG_LEVEL".to_string(), "debug".to_string());
        env.insert("API_KEY".to_string(), "sk-xxx".to_string());
        env.insert("DATABASE_PASSWORD".to_string(), "hunter2".to_string());

        let server = parse_external_server("test", "cmd".into(), Vec::new(), env);

        assert_eq!(server.env.len(), 1);
        assert_eq!(server.env.get("LOG_LEVEL").unwrap(), "debug");
        assert_eq!(server.keychain_env_keys.len(), 2);
        assert!(server.keychain_env_keys.contains(&"API_KEY".to_string()));
        assert!(server
            .keychain_env_keys
            .contains(&"DATABASE_PASSWORD".to_string()));
    }

    #[test]
    fn parse_claude_desktop_malformed_json_returns_err() {
        let result = parse_claude_desktop_config("{ not valid json");
        assert!(result.is_err(), "malformed JSON must return Err");
    }

    #[test]
    fn parse_codex_malformed_toml_returns_err() {
        let result = parse_codex_config("not = valid = toml = =");
        assert!(result.is_err(), "malformed TOML must return Err");
    }

    #[test]
    fn parse_claude_desktop_extracts_servers_via_pure_function() {
        // Directly test the pure parse function (no filesystem dependency).
        let json = r#"{
            "mcpServers": {
                "fetch": {
                    "command": "uvx",
                    "args": ["mcp-server-fetch"],
                    "env": { "LOG_LEVEL": "info" }
                }
            }
        }"#;
        let servers = parse_claude_desktop_config(json).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].display_name, "fetch");
        assert!(matches!(
            &servers[0].transport,
            McpTransport::Stdio { command, .. } if command == "uvx"
        ));
    }

    #[test]
    fn parse_codex_extracts_servers_via_pure_function() {
        let toml = r#"
[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
"#;
        let servers = parse_codex_config(toml).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].display_name, "fetch");
        assert!(matches!(
            &servers[0].transport,
            McpTransport::Stdio { command, .. } if command == "uvx"
        ));
    }

    #[test]
    fn import_source_serializes_as_snake_case_string() {
        let json = serde_json::to_string(&ImportSource::ClaudeDesktop).unwrap();
        assert_eq!(json, r#""claude_desktop""#);
        let json = serde_json::to_string(&ImportSource::Codex).unwrap();
        assert_eq!(json, r#""codex""#);

        let back: ImportSource = serde_json::from_str(r#""claude_desktop""#).unwrap();
        assert_eq!(back, ImportSource::ClaudeDesktop);
        let back: ImportSource = serde_json::from_str(r#""codex""#).unwrap();
        assert_eq!(back, ImportSource::Codex);
    }

    #[test]
    fn discovered_server_serializes_with_transport_tag() {
        let server = DiscoveredServer {
            display_name: "test".into(),
            transport: McpTransport::stdio("npx", vec!["-y".into(), "server".into()]),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
        };
        let json = serde_json::to_value(&server).unwrap();
        assert_eq!(json["display_name"], "test");
        assert_eq!(json["transport"]["type"], "stdio");
        assert_eq!(json["transport"]["command"], "npx");
    }
}
