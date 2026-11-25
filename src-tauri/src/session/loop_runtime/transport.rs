//! The transport-liveness client wrapper (#1653, the ADR-0115 calibration
//! seam): a per-turn `HttpClientExt` that feeds streaming body chunks into
//! the turn's no-progress clock. SSE parsing lives inside rig -- comment
//! lines are swallowed before dispatch and unrecognized delta fields
//! produce no event items at all -- so the response body is the one low-
//! level surface where an upstream queue/processing heartbeat (transport
//! alive, application layer silent) is still observable. The wrapper is the
//! only injection site's inner face: it delegates every request to the
//! wrapped client (the shared egress singleton in production, so
//! connection-pool sharing is unchanged) and touches nothing else.

use std::future::Future;
use std::sync::Arc;

use bytes::Bytes;
use futures::StreamExt;
use rig_core::http_client::sse::BoxedStream;
use rig_core::http_client::{
    HttpClientExt, LazyBody, MultipartForm, Request, Response, Result, StreamingResponse,
};
use rig_core::wasm_compat::WasmCompatSend;

use crate::cancel::CancelToken;
use crate::session::progress::ProgressClock;

/// An SSE comment line opens with `:` -- the heartbeat shape the first-byte
/// discrimination keys on.
const COMMENT_FIRST_BYTE: u8 = b':';

/// The per-turn transport-liveness client (#1653): delegates to `inner`
/// while each streaming body chunk re-arms the turn's no-progress clock
/// through [`ProgressClock::note_transport_chunk`]. The clock is resolved
/// via [`CancelToken::progress_clock`] once per request -- the loop arms
/// and publishes it before the driver's first upstream request, so the
/// lookup succeeds on the live face -- and with no token or no published
/// clock the wrapper is a pure pass-through. The non-streaming faces
/// delegate unconditionally (bytes counted only where they can mean
/// queue-liveness: a streaming generation body).
#[derive(Clone)]
pub(crate) struct LivenessClient<C> {
    inner: C,
    token: Option<Arc<CancelToken>>,
}

impl<C> LivenessClient<C> {
    pub(crate) fn new(inner: C, token: Option<Arc<CancelToken>>) -> Self {
        Self { inner, token }
    }
}

/// The `Default` rig's completion-model blanket impl demands of every
/// injected client: the inert shape -- the wrapped client's own default,
/// no token, a pure pass-through. Production always constructs through
/// [`Self::new`].
impl<C> Default for LivenessClient<C>
where
    C: Default,
{
    fn default() -> Self {
        Self {
            inner: C::default(),
            token: None,
        }
    }
}

/// The `Debug` the openai completion path demands of its client (the
/// anthropic path asks only for `Default`): structural, credential-free --
/// the token is never rendered.
impl<C> std::fmt::Debug for LivenessClient<C> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LivenessClient")
            .field("token", &self.token.is_some())
            .finish_non_exhaustive()
    }
}

impl<C> HttpClientExt for LivenessClient<C>
where
    C: HttpClientExt,
{
    fn send<T, U>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes> + WasmCompatSend,
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        self.inner.send(req)
    }

    fn send_multipart<U>(
        &self,
        req: Request<MultipartForm>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        self.inner.send_multipart(req)
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = Result<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        // One clock resolution per request: a retry resolves again on its
        // own request, and no chunk takes a lock.
        let clock = self.token.as_ref().and_then(|token| token.progress_clock());
        let inner = self.inner.send_streaming(req);
        async move {
            let response = inner.await?;
            match clock {
                Some(clock) => Ok(response.map(|body| note_chunks(body, clock))),
                None => Ok(response),
            }
        }
    }
}

/// Per-chunk observation over one streaming body: count the chunk,
/// discriminate its first byte (`:` = the SSE comment-line heartbeat form),
/// and re-arm the clock. The chunk itself passes through untouched and no
/// content is retained.
fn note_chunks(body: BoxedStream, clock: Arc<ProgressClock>) -> BoxedStream {
    Box::pin(body.map(move |chunk| {
        if let Ok(bytes) = &chunk {
            clock.note_transport_chunk(bytes.len(), bytes.first() == Some(&COMMENT_FIRST_BYTE));
        }
        chunk
    }))
}

/// A scripted `HttpClientExt` double (the rig `SequencedStreamingClient`
/// pattern, #1653): every `send_streaming` answers with a fresh body stream
/// from the factory, framed as an SSE response. The non-streaming faces
/// refuse -- the loop's model calls are streaming-only, so reaching them
/// here means the test has already left the shape it pinned.
#[cfg(test)]
#[derive(Clone)]
pub(super) struct ScriptedBodyClient {
    make_body: Arc<dyn Fn() -> BoxedStream + Send + Sync>,
}

#[cfg(test)]
impl ScriptedBodyClient {
    pub(super) fn new(make_body: impl Fn() -> BoxedStream + Send + Sync + 'static) -> Self {
        Self {
            make_body: Arc::new(make_body),
        }
    }
}

/// The `Default` rig's completion-model blanket impl demands (see
/// [`LivenessClient`]'s): an immediately-empty body, the closest inert
/// script -- the loop-level suites never construct the double this way.
#[cfg(test)]
impl Default for ScriptedBodyClient {
    fn default() -> Self {
        Self::new(|| Box::pin(futures::stream::empty()))
    }
}

/// The `Debug` the openai completion path demands: structural only (the
/// body factory is a closure).
#[cfg(test)]
impl std::fmt::Debug for ScriptedBodyClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ScriptedBodyClient").finish()
    }
}

#[cfg(test)]
use rig_core::http_client::Error as HttpError;

#[cfg(test)]
// The trait declares RPITIT (`impl Future`) signatures, so the impl cannot
// adopt `async fn` syntax even where the body is a bare async block.
#[allow(clippy::manual_async_fn)]
impl HttpClientExt for ScriptedBodyClient {
    fn send<T, U>(
        &self,
        _req: Request<T>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes> + WasmCompatSend,
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        async { Err(HttpError::StreamEnded) }
    }

    fn send_multipart<U>(
        &self,
        _req: Request<MultipartForm>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        async { Err(HttpError::StreamEnded) }
    }

    fn send_streaming<T>(
        &self,
        _req: Request<T>,
    ) -> impl Future<Output = Result<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let body = (self.make_body)();
        async move {
            // The SSE content type is mandatory: rig's event source rejects
            // a response without `text/event-stream`.
            http::Response::builder()
                .status(200)
                .header("content-type", "text/event-stream")
                .body(body)
                .map_err(HttpError::Protocol)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    fn scripted_request() -> Request<Bytes> {
        http::Request::builder()
            .method(http::Method::POST)
            .uri("http://scripted.test/v1/messages")
            .body(Bytes::new())
            .expect("request builds")
    }

    fn drain(client: &LivenessClient<ScriptedBodyClient>) -> Vec<Bytes> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let response = client
                .send_streaming(scripted_request())
                .await
                .expect("scripted response");
            let mut body = response.into_body();
            let mut seen = Vec::new();
            while let Some(chunk) = body.next().await {
                seen.push(chunk.expect("scripted chunk"));
            }
            seen
        })
    }

    fn two_chunk_body() -> BoxedStream {
        Box::pin(futures::stream::iter([
            Ok(Bytes::from_static(": beat\n\n".as_bytes())),
            Ok(Bytes::from_static("data: {}\n\n".as_bytes())),
        ]))
    }

    /// #1653: each streaming chunk re-arms the resolved clock and folds
    /// into the qualitative counters (first-byte discrimination), while the
    /// bytes pass through untouched.
    #[test]
    fn streaming_chunks_feed_the_clock_and_pass_through() {
        let token = Arc::new(CancelToken::new());
        let guard = token.begin_turn();
        let clock =
            ProgressClock::arm_and_publish(guard.generation(), &token, Duration::from_secs(3600));

        let client = LivenessClient::new(
            ScriptedBodyClient::new(two_chunk_body),
            Some(Arc::clone(&token)),
        );
        let seen = drain(&client);

        assert_eq!(
            seen,
            vec![
                Bytes::from_static(": beat\n\n".as_bytes()),
                Bytes::from_static("data: {}\n\n".as_bytes()),
            ],
            "the wrapper must not alter any chunk"
        );
        let snapshot = clock.transport_snapshot();
        assert_eq!(snapshot.chunks, 2);
        assert_eq!(
            snapshot.bytes,
            ": beat\n\n".len() as u64 + "data: {}\n\n".len() as u64
        );
        assert_eq!(snapshot.comment_chunks, 1);
        assert_eq!(snapshot.chunks - snapshot.comment_chunks, 1);
    }

    /// #1653: with no token to resolve a clock from, the wrapper is a pure
    /// pass-through (the extraction one-shot's posture) -- every chunk
    /// arrives and nothing observes anything.
    #[test]
    fn no_token_is_a_pure_pass_through() {
        let client = LivenessClient::new(ScriptedBodyClient::new(two_chunk_body), None);
        assert_eq!(drain(&client).len(), 2);
    }
}
