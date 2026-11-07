//! Egress env-proxy routing pin (issue #1458, ADR-0139).
//!
//! An integration-test file is its own process, so the env mutations below
//! cannot reach other test files' suites -- but they are process-global
//! within this one: parallel test threads share the environment, and the
//! OnceLock egress singletons freeze the first build's env snapshot, so a
//! second test would draw whatever client the first one built. This file
//! must therefore stay a single test -- one env setup covering both egress
//! faces, never per-test env variants.
//!
//! The probe host lives under the reserved `.invalid` TLD (RFC 6761): if
//! the shared recipe ever stops honoring the env proxy, the request goes
//! direct, DNS fails fast, and the pin turns red -- no reachable origin
//! exists in any state.

use std::io::{Read, Write};
use std::net::TcpListener;

use toptopduck_lib::egress::{async_client, blocking_client};
use toptopduck_lib::mcp::client::block_on;

/// Minimal capturing proxy: accepts `count` connections, answers each with
/// a tiny 200, and returns the collected request lines. An HTTP proxy sees
/// an http target as an absolute-form request line -- that shape is itself
/// the assertion material (a direct request would carry only the path).
fn capturing_proxy(count: usize) -> (u16, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind the fake proxy");
    let port = listener.local_addr().expect("read the proxy port").port();
    let handle = std::thread::spawn(move || {
        let mut request_lines = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().expect("the egress face connects");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            // Read to the end of the request head; a GET carries no body,
            // so the head terminator is the end of the request.
            loop {
                let n = stream.read(&mut chunk).expect("read the proxied request");
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf).into_owned();
            request_lines.push(
                head.lines()
                    .next()
                    .unwrap_or("(no request line captured)")
                    .to_string(),
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .expect("answer the proxied request");
        }
        request_lines
    });
    (port, handle)
}

/// Point the egress faces' env at the fake proxy. The uppercase name is the
/// one the env leg resolves (hyper-util reads each proxy variable
/// upper-then-lower, first set wins), so one write suffices. The `NO_PROXY`
/// pair is removed in both letter cases: a no-list entry matches the
/// request's destination host, and the probe's `.invalid` host matches
/// neither loopback entry -- what the removal actually clears is an
/// inherited wildcard bypass (`NO_PROXY=*`), which would otherwise exempt
/// the probe and send it direct.
fn point_env_at_proxy(port: u16) {
    let proxy = format!("http://127.0.0.1:{port}");
    std::env::set_var("HTTP_PROXY", &proxy);
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
}

/// The shared egress construction recipe routes every outbound face through
/// the env proxy -- env vars first is the reqwest `system-proxy` posture
/// ADR-0139 converged all faces on (the retired ureq face's implicit
/// env-only split is what the ADR closed). A regression that pins
/// `.no_proxy()` onto the shared builder sends the probe direct, the
/// reserved `.invalid` host fails DNS, and the send below fails. Both faces
/// (blocking for the preflight probes, async for the live turns and the MCP
/// remote transports) draw from one construction seam, so each is proven
/// once through its own client.
#[test]
fn egress_recipe_routes_both_faces_through_the_env_proxy() {
    const PROBE: &str = "http://egress-proxy-pin.invalid/probe";
    // The face array drives the accept count and the assertions, so a new
    // face cannot extend the one without the other: a drift either way
    // fails the length assert or hangs the join (bounded red by the CI job
    // timeout), never a silently truncated zip.
    let faces = ["blocking", "async"];
    let (port, proxy) = capturing_proxy(faces.len());
    point_env_at_proxy(port);

    // Blocking face first: `reqwest::blocking` panics when the calling
    // thread sits inside a runtime context. tokio's `block_on` exits that
    // context before returning, so the order is not load-bearing -- it
    // keeps the blocking face free of the subtlety either way.
    let blocking = blocking_client().expect("the blocking face builds");
    let response = blocking
        .get(PROBE)
        .send()
        .expect("the blocking face reaches the proxy");
    assert_eq!(
        response.status(),
        200,
        "the fake proxy answers the blocking face"
    );

    let async_face = async_client().expect("the async face builds");
    let response =
        block_on(async_face.get(PROBE).send()).expect("the async face reaches the proxy");
    assert_eq!(
        response.status(),
        200,
        "the fake proxy answers the async face"
    );

    let request_lines = proxy.join().expect("the fake proxy observed both faces");
    assert_eq!(
        request_lines.len(),
        faces.len(),
        "each egress face dials the proxy exactly once"
    );
    for (face, line) in faces.iter().zip(&request_lines) {
        assert_eq!(
            line,
            &format!("GET {PROBE} HTTP/1.1"),
            "the {face} face hands the absolute-form request to the proxy"
        );
    }
}
