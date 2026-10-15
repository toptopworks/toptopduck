//! The external-runtime adapter engine family (ADR-0081), rooted in the ACP
//! (Agent Client Protocol) v1 subset it started from.
//!
//! One submodule per ADR-0081 concern:
//! - [`wire`]: the JSON-RPC 2.0 + ACP method/notification shapes (serde). The
//!   ONLY place the on-the-wire field names live.
//! - [`adapter`]: the per-CLI pure-data definition ([`AdapterSpec`]) +
//!   [`detect_adapter`] PATH scan. Adding a CLI = adding one [`AdapterSpec`].
//! - [`app_server`]: the codex `app-server` diagnostic query (ADR-0096 D2/D3)
//!   -- the CodexEventStream half of the probe's `model/list` catalog read.
//! - [`claude_control`]: the claude-code stream-json control-plane diagnostic
//!   query (ADR-0097 Decision 5) -- the ClaudeStreamJson half of the probe's
//!   `control_request{initialize}` catalog read.
//! - [`engine`]: the generic driver. Spawns the CLI, speaks the [`wire`] subset,
//!   maps `session/update` to the execution trace (ADR-0078), enforces the
//!   execution-level caps (ADR-0081 step + wall-clock), and cancels via
//!   `session/cancel` + SIGTERM fallback. Dispatches on
//!   [`adapter::StreamFormat`]: [`codex_event_stream`] for `CodexEventStream`,
//!   [`claude_stream_json`] for `ClaudeStreamJson`.
//! - [`codex_event_stream`]: the codex native `exec --json` driving path
//!   (ADR-0094). Pure event parser + config-override builder + the turn
//!   driver.
//! - [`claude_stream_json`]: the claude-code native headless driving path
//!   (ADR-0097). Pure frame parser + `--mcp-config` builder + the turn
//!   driver.
//! - [`turn_io`]: the turn-input construction the stream-format drivers
//!   share (ADR-0094 Decision 3 prompt flattening + ADR-0095/0097
//!   selection argv injection).
//! - [`probe`]: the session-agnostic diagnostic probe kernel (ADR-0096) --
//!   one-shot spawn + handshake + catalog extract + kill, decoupled from the
//!   turn path.
//! - [`catalog_store`]: the probe-catalog cache sidecar (ADR-0096 D5) --
//!   `adapter-catalogs.json` under app-data, one overwrite entry per
//!   adapter, honest-degrade on a corrupt file.

pub mod adapter;
pub mod app_server;
pub mod catalog_store;
pub mod claude_control;
pub mod claude_stream_json;
pub mod codex_event_stream;
pub mod engine;
mod ndjson;
pub mod probe;
mod process;
mod turn_io;
pub mod wire;
