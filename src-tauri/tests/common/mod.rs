//! Shared helpers for the integration-test binaries. A file under tests/ is
//! its own test binary; a subdirectory file like this one is NOT, so it is
//! only compiled where a suite declares `mod common;`.

use toptopduck_lib::provider::keychain::KeychainStore;

/// Keychain factory for the blackbox suites (issue #730). On Linux, pins the
/// keyring default to the in-memory mock before the first construction: CI's
/// ubuntu runners have no Secret Service daemon, and the suites were written
/// against the pre-#730 mock baseline. Windows/macOS keep the real OS
/// keychain (their CI baseline). Every test that builds a keychain goes
/// through here, so the pin lands before that test's first OS entry access
/// (one deliberate exception: keychain_degrade_linux.rs bypasses the factory
/// to keep the real backend).
#[cfg(target_os = "linux")]
pub fn keychain() -> KeychainStore {
    toptopduck_lib::provider::keychain::pin_mock_keyring();
    KeychainStore::new()
}

/// Non-Linux twin: no pin, the real platform keychain stays the baseline.
#[cfg(not(target_os = "linux"))]
pub fn keychain() -> KeychainStore {
    KeychainStore::new()
}
