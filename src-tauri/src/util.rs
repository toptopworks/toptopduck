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
