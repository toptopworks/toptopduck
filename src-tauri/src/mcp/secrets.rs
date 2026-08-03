//! MCP server secret storage in the OS keychain (ADR-0029/0076, issue #301).
//!
//! A configured MCP server's NON-SECRET env values ride in
//! [`crate::mcp::config::McpServerConfig::env`]; a SECRET env value (API token,
//! password) lives in the OS keychain under `mcp-<server_id>-<env_key>` -- one
//! OS entry per server + env name, so two servers both needing `API_KEY` never
//! collide. The account-format helper pins the scheme; the set/get/clear thin
//! wrappers over [`KeychainStore`]'s generic accessors keep the keychain
//! mechanics in one place (DRY) and this module purely MCP-flavored.
//!
//! The set/clear pair is wired to IPC (issue #301 slice B); `get_mcp_secret` is
//! Rust-internal -- the gateway (later slice) reads it per spawn to inject the
//! secret into the server's env, and the value never crosses IPC back out
//! (ADR-0029 invariant 3, same one-shot contract as the provider API key).

use crate::mcp::config::McpServerId;
use crate::provider::keychain::KeychainStore;

/// The keychain account prefix for an MCP server secret (issue #301). Pairs with
/// the per-profile `key-` prefix in [`crate::provider::keychain`]: both live
/// under the same SERVICE, distinguished by prefix so a server id that happens
/// to look like a profile id never collides with a provider key slot.
const MCP_ACCOUNT_PREFIX: &str = "mcp-";

/// The keychain account for one MCP server secret: `mcp-<server_id>-<env_key>`
/// (issue #301, ADR-0076). The id is opaque ([`McpServerId`]); the env_key is
/// the env variable name the gateway injects at spawn (e.g. `API_KEY`). The
/// account is a lookup key, never parsed back, so dashes in the id or env_key
/// are harmless.
pub fn mcp_account(id: &McpServerId, env_key: &str) -> String {
    format!("{MCP_ACCOUNT_PREFIX}{id}-{env_key}")
}

/// Store one MCP server secret (ADR-0029 frontend-to-Rust one-shot). Thereafter
/// the value never crosses IPC back out; the gateway (later slice) reads it per
/// spawn via [`get_mcp_secret`].
pub fn set_mcp_secret(
    store: &KeychainStore,
    id: &McpServerId,
    env_key: &str,
    value: &str,
) -> Result<(), String> {
    store.set_secret(&mcp_account(id, env_key), value)
}

/// Read one MCP server secret: `Ok(None)` when nothing is stored, `Err` when the
/// OS keychain read failed (ADR-0029 trust root). Rust-internal -- the gateway
/// calls this at spawn; the value never crosses IPC.
pub fn get_mcp_secret(
    store: &KeychainStore,
    id: &McpServerId,
    env_key: &str,
) -> Result<Option<String>, String> {
    store.get_secret(&mcp_account(id, env_key))
}

/// Remove one MCP server secret (idempotent: a missing entry is success). The
/// trust-root rule applies (ADR-0029): a real keychain error surfaces rather
/// than reading as "removed" while the value still sits in the keyring.
pub fn clear_mcp_secret(
    store: &KeychainStore,
    id: &McpServerId,
    env_key: &str,
) -> Result<(), String> {
    store.clear_secret(&mcp_account(id, env_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_account_format_is_prefix_id_env_key() {
        // The account is `mcp-<id>-<env_key>`: prefix + server id + env name,
        // dash-separated. The id is opaque (a uuid v4 simple form at mint time,
        // but the format does not assume it); the env_key is the env var name.
        let id = McpServerId("abc123".into());
        assert_eq!(mcp_account(&id, "API_KEY"), "mcp-abc123-API_KEY");
    }

    #[test]
    fn mcp_account_distinguishes_servers_and_env_keys() {
        // Two servers both needing API_KEY get distinct accounts; one server
        // needing two secrets gets distinct accounts. The prefix keeps an MCP
        // secret out of the provider key slot (`key-<id>`).
        let s1 = McpServerId("server-one".into());
        let s2 = McpServerId("server-two".into());
        assert_ne!(
            mcp_account(&s1, "API_KEY"),
            mcp_account(&s2, "API_KEY"),
            "distinct servers -> distinct accounts"
        );
        assert_ne!(
            mcp_account(&s1, "API_KEY"),
            mcp_account(&s1, "OTHER_KEY"),
            "distinct env keys -> distinct accounts"
        );
        assert!(
            !mcp_account(&s1, "API_KEY").starts_with("key-"),
            "MCP accounts do not collide with provider key slots"
        );
    }
}
