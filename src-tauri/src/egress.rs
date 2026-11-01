//! The process-shared egress client seam (ADR-0139): every outbound HTTP
//! face in the app draws its reqwest client from the singletons here instead
//! of building its own -- the live provider turns and the MCP remote
//! transports (async face), the preflight probes (blocking face). A new
//! egress face MUST route through this module, not grow a third singleton:
//! the construction recipe carries two posture decisions every face shares.
//!
//! - Redirects are pinned off (`Policy::none`): a 3xx surfaces as an honest
//!   raw status each face refuses in its own vocabulary, structurally
//!   incapable of following a `Location` with a credential on board (the
//!   #244 egress-agent lesson; the MCP transports' #901 guardrail).
//! - Proxy resolution rides reqwest's `system-proxy` (env vars first, OS
//!   configuration fallback), the one converged posture across every face
//!   (the retired ureq face's implicit env-only split is what ADR-0139
//!   closed). TLS rides the crate's rustls-only feature graph (see the
//!   Cargo.toml reqwest declaration).
//!
//! Sharing freezes the proxy snapshot at the first successful build: a
//! mid-session proxy or VPN change is not picked up until process exit --
//! documented, accepted posture (issue #926 for the live face).

/// Test-only construction counter for the async face: proves a completed
/// build is not duplicated by subsequent calls. The claim stops short of
/// one-build-per-process on purpose: a failed build legitimately retries
/// (only successful builds are cached), and the init race may double-build.
/// Read by the build-once tests in this module; compiled out of release
/// builds.
#[cfg(test)]
static ASYNC_BUILDS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Test-only construction counter for the blocking face -- see
/// [`ASYNC_BUILDS`].
#[cfg(test)]
static BLOCKING_BUILDS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The process-shared async egress client: injected into every live rig
/// provider (issue #926) and cloned by every MCP remote transport connect
/// (#1455). Carries no per-profile state (keys and base URLs ride each
/// caller's own requests), so sharing costs no freshness while restoring
/// keep-alive and TLS-session reuse across turns, probes, and connects.
/// Only a successful build is cached: a construction failure is surfaced
/// (not unwrapped) and stays uncached, so the next call retries the build.
static ASYNC_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

/// The process-shared blocking egress client for the preflight probes: the
/// probe runs on a `spawn_blocking` thread where the blocking flavor fits
/// without an async runtime, on the same stack and wire posture the async
/// faces ride. Only a successful build is cached (see [`ASYNC_CLIENT`]).
static BLOCKING_CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();

/// Hand out the shared async egress client: a clone per call, one build per
/// process -- see [`ASYNC_CLIENT`]. A build failure is surfaced (not
/// unwrapped) so the caller classifies it in its own vocabulary.
pub(crate) fn async_client() -> Result<reqwest::Client, reqwest::Error> {
    if let Some(client) = ASYNC_CLIENT.get() {
        return Ok(client.clone());
    }
    #[cfg(test)]
    ASYNC_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    // First-wins under a race (two first calls racing the init): both built,
    // one pool wins; the loser keeps its own client for its one call -- only
    // its set() clone drops unused. Once, harmless.
    let _ = ASYNC_CLIENT.set(client.clone());
    Ok(client)
}

/// Hand out the shared blocking egress client: a clone per call, one build
/// per process -- see [`BLOCKING_CLIENT`]. A build failure is surfaced (not
/// unwrapped) so the caller classifies it in the probe's own vocabulary.
pub(crate) fn blocking_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    if let Some(client) = BLOCKING_CLIENT.get() {
        return Ok(client.clone());
    }
    #[cfg(test)]
    BLOCKING_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    // First-wins under a race -- mirrors the async face above.
    let _ = BLOCKING_CLIENT.set(client.clone());
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The async client is process-shared: every caller after the first
    /// draws from one client, so the connection pool and TLS sessions
    /// survive across turns and connects. The frozen-counter leg is the
    /// deterministic core (the preflight face's pin shape, issue #1452's
    /// review): the 2nd+ calls never rebuild, regardless of whether another
    /// test already initialized the client (tests run in parallel, so the
    /// `before` baseline may already be non-zero). No first-window bound is
    /// asserted -- racing first builds between the snapshots are legitimate
    /// and not derivable from this test's own callers (the ubuntu CI
    /// observation on the preflight face's original pin).
    #[test]
    fn async_client_builds_only_once_across_calls() {
        let _first = async_client().expect("the shared async client builds");
        let after_first = ASYNC_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        let _second = async_client().expect("the shared async client builds");
        let _third = async_client().expect("the shared async client builds");
        let after_third = ASYNC_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            after_third, after_first,
            "subsequent calls never rebuild the client"
        );
    }

    /// The blocking face carries the same sharing contract as the async
    /// face above (frozen-counter leg only).
    #[test]
    fn blocking_client_builds_only_once_across_calls() {
        let _first = blocking_client().expect("the shared blocking client builds");
        let after_first = BLOCKING_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        let _second = blocking_client().expect("the shared blocking client builds");
        let after_third = BLOCKING_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            after_third, after_first,
            "subsequent calls never rebuild the client"
        );
    }
}
