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
//!   closed). The OS-fallback leg honors the user's proxy-bypass list only
//!   lossily: on Windows hyper-util folds WinINET `ProxyOverride` into its
//!   internal no-list with the wildcard shapes stripped (loopback IPs,
//!   `<local>`, and trailing `prefix.*` die in the fold; a bare `localhost`
//!   entry survives), on macOS `ExceptionsList` is never read, and neither
//!   leg exempts a loopback IP literal -- so every face overlays its own
//!   exemption judgment on top (issue #1521): the [`proxy_with_bypass_overlay`]
//!   matcher checks the parsed bypass rules first and otherwise delegates
//!   the proxy choice to the crate's own frozen system resolution. TLS
//!   rides the crate's rustls-only feature graph (see the Cargo.toml
//!   reqwest declaration).
//!
//! Sharing freezes the proxy snapshot at the first successful build: a
//! mid-session proxy or VPN change is not picked up until process exit --
//! documented, accepted posture (issue #926 for the live face). The bypass
//! overlay freezes with it: the delegated system matcher and the parsed
//! bypass list are both captured at that same first build.

/// The parsed OS proxy-bypass list feeding the exemption judgment of the
/// [`proxy_with_bypass_overlay`] matcher (issue #1521). Loopback is exempt
/// regardless of the list; entries carry WinINET/macOS semantics:
/// `<local>` (dotless hostnames), `*` (everything), `*.domain` / plain
/// `domain` (the domain and its subdomains), and a trailing `prefix.*`
/// (the Windows default list's address prefixes). CIDR entries are not
/// matched -- neither OS default list carries one the hosts here can hit
/// (macOS's link-local `169.254/16`); add ipnet-backed matching if a real
/// configuration ever needs it.
struct BypassRules {
    entries: Vec<String>,
}

impl BypassRules {
    /// Parse a raw bypass list. Windows `ProxyOverride` is `;`-separated,
    /// macOS `ExceptionsList` is `,`-separated; both dialects are accepted
    /// in one string (entries are trimmed, bracketed IPv6 literals
    /// unbracketed, lowercased, empties dropped).
    fn parse(raw: &str) -> Self {
        Self {
            entries: raw
                .split([';', ','])
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(|entry| entry.trim_matches(['[', ']']))
                .map(str::to_ascii_lowercase)
                .collect(),
        }
    }

    /// Read the OS bypass list at build time: Windows reads the WinINET
    /// `ProxyOverride` string, macOS the `ExceptionsList` array, other
    /// targets have no OS proxy leg and parse an empty list (loopback-only
    /// exemption). Reading regardless of whether a proxy is enabled: with
    /// none configured everything already dials direct, so gating on the
    /// enabled flag would buy nothing.
    fn from_os() -> Self {
        Self::parse(os_bypass_list().as_deref().unwrap_or(""))
    }

    /// The exemption judgment: `true` means the egress faces must dial
    /// `host` directly, proxy or no proxy. The input is a `Url::host_str`
    /// shape -- no port, and IPv6 literals carry their brackets; the
    /// normalization below strips them (a bracketed `"[::1]"` would fail
    /// both the loopback parse and every entry comparison) alongside a
    /// defensive lowercase.
    fn exempts(&self, host: &str) -> bool {
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        // Loopback is exempt unconditionally -- the OS-fallback leg of the
        // crate's resolution never exempts it (issue #1521's core report).
        if host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        {
            return true;
        }
        self.entries.iter().any(|entry| entry_matches(entry, &host))
    }
}

/// One bypass-list entry against one lowercased, unbracketed host. All
/// comparisons are dot-boundary aware: `cache.corp` must not match
/// `xcache.corp`.
fn entry_matches(entry: &str, host: &str) -> bool {
    match entry {
        "*" => return true,
        "<local>" => return !host.contains('.'),
        _ => {}
    }
    if let Some(prefix) = entry.strip_suffix(".*") {
        return host
            .strip_prefix(prefix)
            .is_some_and(|r| r.is_empty() || r.starts_with('.'));
    }
    // `*.domain` and a bare `domain` share the suffix judgment; the strip
    // order above keeps double wildcards (`*.*`) false rather than
    // recursing -- a host never contains `*`.
    let domain = entry.strip_prefix("*.").unwrap_or(entry);
    host == domain || host.strip_suffix(domain).is_some_and(|r| r.ends_with('.'))
}

/// The raw OS bypass list, unconverted -- the OS dialect split and the
/// WinINET wildcard shapes are the overlay's own judgment to make.
#[cfg(windows)]
fn os_bypass_list() -> Option<String> {
    windows_registry::CURRENT_USER
        .open("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?
        .get_string("ProxyOverride")
        .ok()
}

/// macOS's bypass list lives as the `ExceptionsList` string array in the
/// same dynamic-store proxies map hyper-util's own macOS leg reads; it is
/// joined back into one `,`-separated string for [`BypassRules::parse`].
#[cfg(target_os = "macos")]
fn os_bypass_list() -> Option<String> {
    use system_configuration::core_foundation::array::CFArray;
    // `wrap_under_create_rule` and `as_concrete_TypeRef` are TCFType trait
    // methods -- the trait must be in scope for the typed-view wrap below.
    use system_configuration::core_foundation::base::TCFType;
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;

    let store = SCDynamicStoreBuilder::new("toptopduck-egress").build()?;
    let proxies = store.get_proxies()?;
    let exceptions = proxies
        .find(CFString::new("ExceptionsList"))?
        .downcast::<CFArray>()?;
    // A borrowed `CFString`-typed view over the untyped array, for
    // iteration only. SAFETY: the type parameter is a compile-time fiction
    // over the same CFArrayRef, and `ManuallyDrop` keeps the view from
    // releasing storage the `exceptions` owner still holds; the iterator
    // yields borrowed items (never released individually). The element
    // cast's one trust root is the macOS proxy schema: `ExceptionsList` is
    // defined there as an array of strings.
    let typed = std::mem::ManuallyDrop::new(unsafe {
        CFArray::<CFString>::wrap_under_create_rule(exceptions.as_concrete_TypeRef())
    });
    Some(
        typed
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// No OS proxy leg exists on this target (ADR-0139), so no OS bypass list
/// either -- loopback-only exemption.
#[cfg(not(any(windows, target_os = "macos")))]
fn os_bypass_list() -> Option<String> {
    None
}

/// The shared recipe's proxy posture (issue #1521): ONE custom matcher that
/// is the only entry in the client's matcher chain (setting any proxy
/// disables reqwest's implicit system matcher), so its `None` is a direct
/// connection. Exempt destinations (loopback always; OS bypass list entries
/// under the WinINET/macOS semantics the crate's own resolution misses)
/// return `None`; everything else delegates the proxy choice to a frozen
/// `hyper_util` system matcher -- the same env-vars-first,
/// OS-configuration-fallback resolution reqwest itself rides, snapshot
/// included. The intercept's resolved credentials round-trip through the
/// returned URL's userinfo: reqwest re-parses the returned URL through the
/// same builder, and that userinfo is the custom-matcher contract's only
/// auth channel (issue #1521's review).
fn proxy_with_bypass_overlay() -> reqwest::Proxy {
    let system = hyper_util::client::proxy::matcher::Matcher::from_system();
    let rules = BypassRules::from_os();
    reqwest::Proxy::custom(move |url| {
        if rules.exempts(url.host_str().unwrap_or_default()) {
            return None;
        }
        let uri = http::Uri::try_from(url.as_str()).ok()?;
        let intercepted = system.intercept(&uri)?;
        let mut proxy = reqwest::Url::parse(&intercepted.uri().to_string()).ok()?;
        // hyper-util's env parsing splits the proxy URI's credentials into
        // the intercept's auth field and leaves `uri()` a bare authority;
        // re-embed them or they evaporate at reqwest's re-parse and an
        // authenticated proxy answers 407. A decode failure keeps the
        // credential-less proxy URL -- proxied without auth, never a
        // silent direct dial.
        if let Some((user, pass)) = proxy_credentials(&intercepted) {
            let _ = proxy.set_username(&user);
            let _ = proxy.set_password(Some(&pass));
        }
        Some(proxy)
    })
}

/// The credentials an [`hyper_util`] intercept resolved, as the (user,
/// password) pair the returned proxy URL's userinfo carries: the raw pair
/// for socks handshakes, the Basic header decoded back for the http/https
/// legs (hyper-util encoded it from the userinfo verbatim, so the UTF-8
/// decode cannot fail for values it produced).
fn proxy_credentials(
    intercepted: &hyper_util::client::proxy::matcher::Intercept,
) -> Option<(String, String)> {
    if let Some((user, pass)) = intercepted.raw_auth() {
        return Some((user.to_owned(), pass.to_owned()));
    }
    use base64::Engine as _;
    let header = intercepted.basic_auth()?;
    let encoded = header.to_str().ok()?.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let mut parts = decoded.splitn(2, |byte| *byte == b':');
    let user = std::str::from_utf8(parts.next()?).ok()?;
    let pass = std::str::from_utf8(parts.next().unwrap_or_default()).unwrap_or("");
    Some((user.to_owned(), pass.to_owned()))
}

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
/// unwrapped) so the caller classifies it in its own vocabulary. `pub` for
/// the integration seam: the env-proxy pin (issue #1458) drives both faces
/// from a dedicated test binary for process-global env isolation.
pub fn async_client() -> Result<reqwest::Client, reqwest::Error> {
    if let Some(client) = ASYNC_CLIENT.get() {
        return Ok(client.clone());
    }
    #[cfg(test)]
    ASYNC_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .proxy(proxy_with_bypass_overlay())
        .build()?;
    // First-wins under a race (two first calls racing the init): both built,
    // one pool wins; the loser keeps its own client for its one call -- only
    // its set() clone drops unused. Once, harmless.
    let _ = ASYNC_CLIENT.set(client.clone());
    Ok(client)
}

/// Hand out the shared blocking egress client: a clone per call, one build
/// per process -- see [`BLOCKING_CLIENT`]. A build failure is surfaced (not
/// unwrapped) so the caller classifies it in the probe's own vocabulary. `pub`
/// for the integration seam (see [`async_client`]).
pub fn blocking_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    if let Some(client) = BLOCKING_CLIENT.get() {
        return Ok(client.clone());
    }
    #[cfg(test)]
    BLOCKING_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .proxy(proxy_with_bypass_overlay())
        .build()?;
    // First-wins under a race -- mirrors the async face above.
    let _ = BLOCKING_CLIENT.set(client.clone());
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bypass_rules_exempt_loopback_unconditionally() {
        // The whole 127/8 range rides `is_loopback`, not a literal
        // `127.0.0.1`: every address in it is loopback. The bracketed
        // `"[::1]"` is the shape the production caller feeds (`host_str`
        // serializes IPv6 literals with brackets); a bracketed list entry
        // matches the same host through the parse-side unbracketing.
        let rules = BypassRules::parse("[::1]");
        for host in [
            "localhost",
            "LOCALHOST",
            "127.0.0.1",
            "::1",
            "[::1]",
            "127.203.1.9",
        ] {
            assert!(rules.exempts(host), "loopback host {host} is always exempt");
        }
    }

    #[test]
    fn bypass_rules_exempt_the_url_host_str_shapes() {
        // Ride the real boundary: `host_str` on a parsed URL is the exact
        // input the matcher closure hands `exempts` -- IPv6 bracketed, per
        // the url crate's serialization.
        for url in [
            "http://[::1]:1/",
            "http://localhost:1/",
            "http://127.0.0.1:1/",
        ] {
            let parsed = reqwest::Url::parse(url).expect("the probe URL parses");
            let host = parsed.host_str().expect("each probe URL carries a host");
            assert!(
                BypassRules::parse("").exempts(host),
                "the host_str shape of {url} is exempt"
            );
        }
    }

    #[test]
    fn bypass_rules_do_not_match_cidr_entries() {
        // ADR-0144 Decision 2: CIDR entries are documented as not matched
        // (neither OS default list carries a hittable one); the ceiling is
        // deliberate, and this pins it as such.
        let rules = BypassRules::parse("10.0.0.0/8");
        assert!(
            !rules.exempts("10.4.5.6"),
            "a CIDR entry is not an address matcher"
        );
    }

    #[test]
    fn bypass_rules_exempt_nothing_else_without_entries() {
        let rules = BypassRules::parse("");
        for host in ["example.com", "10.0.0.1", "172.16.0.5", "intranet"] {
            assert!(
                !rules.exempts(host),
                "{host} carries no exemption without a list entry"
            );
        }
    }

    #[test]
    fn bypass_rules_honor_local_token_for_dotless_hosts() {
        let rules = BypassRules::parse("foo.com;<local>");
        assert!(
            rules.exempts("intranet"),
            "a dotless host is exempt under `<local>`"
        );
        assert!(
            !rules.exempts("intranet.corp"),
            "a dotted host is not `<local>`"
        );
    }

    #[test]
    fn bypass_rules_match_domain_and_subdomains() {
        let rules = BypassRules::parse("cache.corp");
        assert!(rules.exempts("cache.corp"), "the entry itself matches");
        assert!(rules.exempts("sub.cache.corp"), "a subdomain matches");
        assert!(
            !rules.exempts("xcache.corp"),
            "a suffix without a dot boundary is not a subdomain"
        );
    }

    #[test]
    fn bypass_rules_match_leading_and_trailing_wildcards() {
        // `*.corp.com` (WinINET/macOS leading wildcard), `192.168.*` and
        // `10.*` (Windows default-list trailing prefixes).
        let rules = BypassRules::parse("*.corp.com;192.168.*;10.*");
        assert!(rules.exempts("a.corp.com"));
        assert!(
            rules.exempts("corp.com"),
            "the wildcard base itself matches"
        );
        assert!(!rules.exempts("acorp.com"));
        assert!(rules.exempts("192.168.1.5"));
        assert!(!rules.exempts("192.169.1.5"));
        assert!(rules.exempts("10.24.0.1"));
        assert!(
            !rules.exempts("100.24.0.1"),
            "the prefix wildcard requires a dot boundary"
        );
        let double = BypassRules::parse("*.*");
        assert!(
            !double.exempts("a.b"),
            "a double wildcard is not an everything pass"
        );
    }

    #[test]
    fn bypass_rules_split_both_separator_dialects() {
        // Windows `ProxyOverride` is `;`-separated, macOS `ExceptionsList`
        // is `,`-separated; the parse accepts both in one string.
        let rules = BypassRules::parse("a.com; b.com, c.com");
        for host in ["a.com", "b.com", "c.com"] {
            assert!(rules.exempts(host), "{host} parsed out of the mixed list");
        }
    }

    #[test]
    fn bypass_rules_compare_case_insensitively() {
        let rules = BypassRules::parse("Cache.Corp");
        assert!(rules.exempts("CACHE.corp"));
    }

    #[test]
    fn bypass_rules_wildcard_entry_exempts_everything() {
        let rules = BypassRules::parse("*");
        assert!(rules.exempts("anything.example"));
    }

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
