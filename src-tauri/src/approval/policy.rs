//! Pure approval policy (ADR-0080): the decision cascade's home.
//!
//! Stateless and IO-free -- given a tool key, the session posture, and the
//! trust set, [`classify`] returns the verdict. Two production adapters
//! consume it: [`super::ApprovalState::gate`] (per-call enforcement for the
//! builtin runtime, which suspends the turn on `NeedsApproval`) and the ACP
//! permission handshake (`runtime/acp/engine.rs`, which answers each
//! `session/request_permission` request with a single-key check against an
//! `auth_mode()` + `trust_list()` snapshot). The vocabulary types
//! ([`super::ToolKey`] / [`super::AuthMode`]) stay in the parent module --
//! they serve the whole gateway, not the policy alone.

use std::collections::HashSet;

use super::{AuthMode, ToolKey};

/// The gateway's classification of a tool call (ADR-0080). The
/// [`super::ApprovalState`] gate maps this to a concrete action (pass /
/// suspend).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Pass through: built-in (Decision 1), OR trusted via "always allow"
    /// (Decision 3), OR the session is in [`AuthMode::NoConfirmation`]
    /// (Decision 4).
    Allow,
    /// External tool under [`AuthMode::PerCall`] that is not in the trust
    /// set: suspend this turn's call and surface the in-flow approval card
    /// (ADR-0083).
    NeedsApproval,
}

/// Pure policy check (ADR-0080). Given the tool, the session posture, and the
/// trust set, return the classification. Stateful side effects (suspending
/// the turn, emitting the card) live in [`super::ApprovalState::gate`]; this
/// fn is the testable, side-effect-free core.
pub fn classify(key: &ToolKey, mode: AuthMode, trust: &HashSet<ToolKey>) -> Classification {
    // (1) Built-in read-only + materialize: zero approval (ADR-0080 Decision
    // 1) -- except the gated builtin meta-tools (ADR-0122 Decision 3): a
    // `create_skill` mint persists across sessions and its body is a future
    // prompt-injection source, so it rides the per-call card + session trust
    // like an external write, never Decision 1's zero-approval pass.
    if key.is_builtin() && !is_gated_builtin(key) {
        return Classification::Allow;
    }
    // (4) No-confirmation posture: every external call auto-passes (Decision 4).
    if mode == AuthMode::NoConfirmation {
        return Classification::Allow;
    }
    // (3) "Always allow" (per-tool session trust) overrides per-call (Decision 3).
    if trust.contains(key) {
        return Classification::Allow;
    }
    // (3) Default: external tool under PerCall, not trusted -> suspend + ask.
    Classification::NeedsApproval
}

/// The built-in tools that gate anyway (ADR-0122 Decision 3): their writes
/// outlive the session, so they never ride ADR-0080 Decision 1's
/// zero-approval builtin pass. An explicit enumerated family, not a naming
/// convention.
fn is_gated_builtin(key: &ToolKey) -> bool {
    key == &ToolKey::builtin(crate::skills::create::CREATE_SKILL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tools_always_pass() {
        let mode = AuthMode::PerCall;
        let trust = HashSet::new();
        for name in ["explore", "materialize", "describe", "sample"] {
            let key = ToolKey::builtin(name);
            assert_eq!(
                classify(&key, mode, &trust),
                Classification::Allow,
                "built-in {name} must pass with zero approval (ADR-0080 Decision 1)"
            );
        }
    }

    #[test]
    fn external_per_call_untrusted_needs_approval() {
        let key = ToolKey::external("acme", "fetch");
        assert_eq!(
            classify(&key, AuthMode::PerCall, &HashSet::new()),
            Classification::NeedsApproval
        );
    }

    #[test]
    fn external_per_call_trusted_passes() {
        let key = ToolKey::external("acme", "fetch");
        let mut trust = HashSet::new();
        trust.insert(key.clone());
        assert_eq!(
            classify(&key, AuthMode::PerCall, &trust),
            Classification::Allow,
            "always-allow trust overrides per-call (ADR-0080 Decision 3)"
        );
    }

    #[test]
    fn no_confirmation_mode_passes_all_external() {
        let key = ToolKey::external("acme", "fetch");
        assert_eq!(
            classify(&key, AuthMode::NoConfirmation, &HashSet::new()),
            Classification::Allow,
            "no-confirmation posture auto-passes every external call (ADR-0080 Decision 4)"
        );
    }

    #[test]
    fn trust_is_scoped_to_server_tool() {
        // Same tool name, different server -> different trust (ADR-0076/0080).
        let trusted = ToolKey::external("acme", "fetch");
        let mut trust = HashSet::new();
        trust.insert(trusted);
        let other = ToolKey::external("other", "fetch");
        assert_eq!(
            classify(&other, AuthMode::PerCall, &trust),
            Classification::NeedsApproval,
            "trust is per server::tool, not per tool name"
        );
    }

    #[test]
    fn classify_gates_the_create_skill_builtin_despite_the_builtin_pass() {
        // ADR-0122 Decision 3: the creation mint persists across sessions
        // and its body is a future prompt-injection source -- the builtin
        // zero-approval pass (ADR-0080 Decision 1) does not cover it.
        let key = ToolKey::builtin(crate::skills::create::CREATE_SKILL);
        assert_eq!(
            classify(&key, AuthMode::PerCall, &HashSet::new()),
            Classification::NeedsApproval,
            "an untrusted create gates"
        );
        // Session trust ("always allow") restores the pass.
        let trust = HashSet::from([key.clone()]);
        assert_eq!(
            classify(&key, AuthMode::PerCall, &trust),
            Classification::Allow,
            "an always-allowed create passes"
        );
        // The no-confirmation posture keeps its universal auto-pass.
        assert_eq!(
            classify(&key, AuthMode::NoConfirmation, &HashSet::new()),
            Classification::Allow
        );
        // Ordinary built-ins keep the zero-approval pass.
        assert_eq!(
            classify(
                &ToolKey::builtin("explore"),
                AuthMode::PerCall,
                &HashSet::new()
            ),
            Classification::Allow
        );
    }
}
