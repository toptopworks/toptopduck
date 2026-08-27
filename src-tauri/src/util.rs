//! Crate-wide shared utilities (one-off helpers used by multiple modules).
//!
//! Started as the home for [`sha256_hex`] so the skills module and the session
//! module share a single content-hash implementation (issue #364, ADR-0086).

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes` as a lowercase hex string.
///
/// Shared by the skill-provenance content hash (ADR-0086: SHA-256 of a skill's
/// whole `SKILL.md` bytes) and the session's file-change baseline. Hex-encoded
/// so the digest is a comparable string.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Truncate a string to `max` chars, appending an ellipsis when cut. The ONE
/// char-level implementation shared by the trace surfaces -- the persisted
/// summary (`persistence::recipe::truncate_trace_summary`) and the live
/// excerpt (`session::loop_contract::truncate_trace_excerpt`) -- so a cut
/// renders identically everywhere. (The byte-level UTF-8-boundary truncator
/// in `provider::http` serves a different contract -- panic-free slicing on
/// untrusted bodies at a byte cap -- and stays separate.)
pub(crate) fn truncate_chars_with_ellipsis(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{head}…")
    }
}
