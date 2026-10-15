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

/// The order-preserving linear-dedupe push shared by the skill-set folds
/// (ADR-0119, issue #983): first-insertion order everywhere a set
/// accumulates -- the discovery snapshot, the invoked-set fold, and
/// the migration's mount fold. One helper so a
/// hand-rolled `contains` at any consumer cannot drift (the discipline the
/// retired `is_activated` used to carry).
pub(crate) fn push_unique<T: PartialEq + Clone>(items: &mut Vec<T>, item: &T) {
    if !items.contains(item) {
        items.push(item.clone());
    }
}

/// The accumulation byte cap for a runtime track (issue #629): 8MB of prose
/// or thinking before the runaway guard engages -- defense in depth against
/// a runaway stream, not a normal-truncation budget. One constant for every
/// accumulation seam (the external paths' `RoundTracker` and the rig fold,
/// ADR-0126's rig-fold calibration) so the paths cannot drift apart.
pub(crate) const ACCUM_MAX_BYTES: usize = 8 * 1024 * 1024;

/// The visible truncation marker appended when an accumulation track hits
/// [`ACCUM_MAX_BYTES`] -- the `TRACE_EXCERPT_MAX` truncation-visible
/// philosophy (never silently drop).
pub(crate) const TRUNCATION_MARKER: &str = "\n[truncated]";

/// Append `text` to `buf` under the accumulation byte cap (issue #629): the
/// first crossing latches the visible truncation marker; appends afterwards
/// are dropped. The whole chunk lands before the check, so a chunk straddling
/// the cap overshoots it by the chunk's remainder -- bounded by the chunk's
/// own length. Returns whether THIS call latched the marker.
pub(crate) fn push_capped(buf: &mut String, text: &str) -> bool {
    if is_latched(buf) {
        return false;
    }
    buf.push_str(text);
    if is_latched(buf) {
        buf.push_str(TRUNCATION_MARKER);
        true
    } else {
        false
    }
}

/// Whether an accumulation track has latched its truncation marker
/// (issue #1171): the byte length, not a marker-suffix check -- provider
/// text may legitimately end in the marker, while a latched buffer
/// always exceeds the cap by the marker's length and an unlatched one
/// never reaches it. One predicate for every consumer (the gates here,
/// the fold's terminal discrimination) so the spellings cannot drift.
pub(crate) fn is_latched(buf: &str) -> bool {
    buf.len() >= ACCUM_MAX_BYTES
}

/// The capped prose emission every runtime path shares (ADR-0126's cap
/// boundary): the chunk's delta emits unless the track already latched, and
/// the crossing chunk's delta is followed by one final marker delta -- the
/// live round text stays byte-identical to the settle record. One helper so
/// a hand-rolled gate at any consumer cannot drift (the `push_unique`
/// discipline).
pub(crate) fn push_capped_emit(buf: &mut String, text: &str, emit: &mut impl FnMut(&str)) {
    let capped = is_latched(buf);
    if !text.is_empty() && !capped {
        emit(text);
    }
    if push_capped(buf, text) {
        emit(TRUNCATION_MARKER);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The empty-input arm (issue #1171): an empty fragment emits no
    /// delta and leaves the buffer untouched -- the ADR-0126 lineage
    /// contract every runtime path's prose gate shares.
    #[test]
    fn an_empty_fragment_emits_nothing_and_leaves_the_buffer() {
        let mut buf = String::from("seed");
        let mut emitted: Vec<String> = Vec::new();
        push_capped_emit(&mut buf, "", &mut |delta| emitted.push(delta.to_string()));
        assert!(emitted.is_empty(), "an empty fragment emits no delta");
        assert_eq!(buf, "seed", "the buffer is untouched");
    }
}
