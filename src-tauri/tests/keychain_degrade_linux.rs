//! Honest-degrade pin for the Linux Secret Service backend (issue #730).
//!
//! The `sync-secret-service` feature made Linux's keyring default a real
//! Secret Service client. This suite deliberately does NOT pin the in-memory
//! mock (unlike the blackbox suites): it exercises the real backend against
//! an environment with NO Secret Service daemon -- the CI ubuntu runners ship
//! no gnome-keyring / org.freedesktop.secrets service. The contract under
//! test: an absent daemon surfaces as `Err` through the keychain fault
//! channel (ADR-0029 trust root, issue #243), never as a fake success and
//! never misdiagnosed as `NoEntry` ("nothing stored"). The write side is the
//! sharper half: mock-fallback builds "succeeded" on write and dropped the
//! value -- exactly the write-and-forget bug #730 fixed, so a write here must
//! refuse loudly, not claim success.
//!
//! If this suite ever fails with an `Ok`, the runner environment grew a
//! Secret Service daemon -- revisit the pinning strategy then, don't paper
//! over it locally.

#![cfg(target_os = "linux")]

use toptopduck_lib::provider::keychain::KeychainStore;

/// A read with no daemon must return `Err` (the `keychain_fault` detail), not
/// `Ok(None)` -- `Ok(None)` is the legitimate "no key stored" state and would
/// misdiagnose an unavailable keychain as an empty one (issue #243).
#[test]
fn absent_daemon_read_surfaces_err_not_no_entry() {
    let store = KeychainStore::new();
    match store.get_secret("toptopduck-degrade-pin") {
        Err(detail) => assert!(
            detail.starts_with("keychain access failed:"),
            "fault detail should ride the keychain_err channel, got: {detail}"
        ),
        Ok(_) => panic!(
            "read returned Ok with no Secret Service daemon -- the fault must \
             surface as Err, not read as stored/empty"
        ),
    }
}

/// A write with no daemon must return `Err`, never `Ok(())` -- the pre-#730
/// mock fallback "succeeded" on write while the value never persisted (the
/// Set-key-never-sticks bug). A silent-success write here would resurrect it.
#[test]
fn absent_daemon_write_surfaces_err_not_fake_success() {
    let store = KeychainStore::new();
    match store.set_secret("toptopduck-degrade-pin", "sentinel") {
        Err(detail) => assert!(
            detail.starts_with("keychain access failed:"),
            "fault detail should ride the keychain_err channel, got: {detail}"
        ),
        Ok(()) => panic!(
            "write returned Ok with no Secret Service daemon -- the value \
             cannot have persisted, this is the write-and-forget bug"
        ),
    }
}
