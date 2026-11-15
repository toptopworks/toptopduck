//! Process-global app-data path anchors that deep execution layers need but
//! Tauri state cannot reach (ADR-0150, issue #1583).
//!
//! [`set_extensions_dir`] is called once from the Tauri setup hook; every
//! sandbox the session layer opens reads [`extensions_dir`] so DuckDB
//! extension binaries land under the app-data dir instead of `~/.duckdb`
//! (ADR-0150 Decision: install directory redirected, uninstall-clean). The
//! setter/getter pair is a `RwLock<Option<..>>` (not `OnceLock`) purely so
//! unit tests can point the anchor at a temp dir and reset it afterwards --
//! production writes it exactly once before the first session exists.

use std::path::PathBuf;
use std::sync::RwLock;

static EXTENSIONS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Anchor the extension install directory (setup hook; idempotent no-op when
/// already set -- the first anchor wins, same semantics as a `OnceLock`).
pub(crate) fn set_extensions_dir(dir: PathBuf) {
    let Ok(mut guard) = EXTENSIONS_DIR.write() else {
        return; // poisoned: keep the prior anchor, never panic at startup
    };
    if guard.is_none() {
        *guard = Some(dir);
    }
}

/// The anchored extension install directory, or `None` before the setup hook
/// ran (unit tests that never boot Tauri). `None` leaves DuckDB's own default
/// (`~/.duckdb`) -- acceptable only pre-startup; the tests that pin the
/// redirect set the anchor explicitly.
pub(crate) fn extensions_dir() -> Option<PathBuf> {
    EXTENSIONS_DIR.read().ok().and_then(|g| g.clone())
}

/// Test-only reset so a pinned redirect test does not leak its temp dir into
/// later tests in the same binary.
#[cfg(test)]
pub(crate) fn reset_extensions_dir_for_tests() {
    if let Ok(mut guard) = EXTENSIONS_DIR.write() {
        *guard = None;
    }
}

/// The canonical subdirectory name under the OS app-data dir.
pub(crate) const EXTENSIONS_DIR_NAME: &str = "extensions";
