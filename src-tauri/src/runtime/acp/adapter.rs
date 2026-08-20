//! Per-CLI adapter data definitions (ADR-0081, issue #299).
//!
//! ADR-0081 Decision: every external CLI is a **pure data definition** -- the
//! engine ([`crate::runtime::acp::engine`]) has zero per-CLI code branches.
//! Adding a CLI = adding one [`AdapterSpec`] constructor here. The v1 engine
//! drives every external CLI (gemini-cli, codex, qwen-code, opencode)
//! through the SAME engine -- per-format dispatch ([`StreamFormat`],
//! ADR-0094), never per-CLI -- so the AC "the adapter engine has zero per-CLI
//! code branches" is structural: the engine takes a `&AdapterSpec` and never
//! names a CLI.
//!
//! An [`AdapterSpec`] carries:
//! - identification: a stable [`AdapterId`] + display name (the composer
//!   runtime picker, ADR-0083, and the per-turn provenance, ADR-0101, read
//!   these);
//! - detection: the candidate binary names a PATH scan resolves (the composer
//!   grays out an absent CLI, ADR-0083);
//! - launch: the argv prefix that puts the CLI into its ACP stdio mode (the
//!   engine appends nothing -- the prefix IS the full argv the CLI needs to
//!   speak ACP on stdio; per-CLI session addressing rides the MCP bridge
//!   descriptor, not the CLI argv).
//!
//! The argv prefix is the ONE CLI-specific fact the ACP-over-stdio engine
//! consumes; it is data (a `&'static [&'static str]`), not a code path.

use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Stream format (ADR-0094)
// ---------------------------------------------------------------------------

/// The wire protocol an adapter's CLI speaks over stdio (ADR-0094). The engine
/// dispatches on this field -- per-format, NOT per-CLI: multiple CLIs share a
/// format, adding a CLI never touches the engine, and adding a format adds one
/// parser path (ADR-0081 zero per-CLI code invariant preserved). Each variant
/// is exactly one parser's dispatch unit, named after its owning CLI's
/// vocabulary (ADR-0097 Decision 2): a neutral shared name would misassociate
/// a second CLI with the wrong parser (claude's official output format is ALSO
/// called stream-json).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StreamFormat {
    /// ACP v1 JSON-RPC over stdio (initialize + session/new + session/prompt).
    /// The serde/default form -- an older payload omitting the field degrades
    /// to the ACP surface.
    #[default]
    Acp,
    /// The codex native JSONL event stream over stdio (codex `exec --json`,
    /// ADR-0094). Renamed from `JsonEventStream` when the format set grew to
    /// three (ADR-0097 Decision 2): the value's single owner is codex, and the
    /// wire-tag change drops pre-rename catalog-cache entries through the
    /// existing corrupt-entry degrade (the cache is a discardable snapshot).
    CodexEventStream,
    /// The claude-code native headless stream (ADR-0097): NDJSON `system` /
    /// `assistant` / `stream_event` / `result` frames over stdout, driven via
    /// `--print --output-format stream-json` with the prompt on stdin. The
    /// catalog channel is the stream-json control plane (a probe-time
    /// `control_request{initialize}`), never the turn path.
    ClaudeStreamJson,
}

// ---------------------------------------------------------------------------
// Adapter spec
// ---------------------------------------------------------------------------

/// The ONE surface an adapter's reasoning-effort selection rides (ADR-0095,
/// ADR-0097 Decision 6). An enum, not two independent Option fields, so
/// "at most one effort surface per adapter" is a type invariant: a
/// dual-surface spec (which flag would win?) is unrepresentable, and the
/// injection dispatch in [`crate::runtime::acp::turn_io::build_model_flags`]
/// is a single exhaustive match with no silent precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortSurface {
    /// The `-c` runtime-config override: the engine appends
    /// `["-c", "{key}={value}"]` to argv when a thought level is selected
    /// (codex's `model_reasoning_effort`).
    ConfigKey(&'static str),
    /// The argv flag at spawn: the engine appends `[flag, value]` parallel
    /// to [`AdapterSpec::model_arg`] (claude-code's `--effort`).
    ArgvFlag(&'static str),
}

/// A stable identifier for a CLI adapter: the composer picker's key
/// (ADR-0083) and the id persisted on an external turn's provenance +
/// mirrored across IPC (ADR-0101). Distinct from the binary name and from
/// the display name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AdapterId(&'static str);

impl AdapterId {
    /// Build a new adapter id. `pub` so the slice-9c integration test can mint a
    /// fake-CLI adapter; production code still uses the constructors below
    /// ([`gemini_cli`], etc.), so a stray id fails review rather than the
    /// type system.
    pub const fn new(name: &'static str) -> Self {
        Self(name)
    }

    /// The id as a static string (provenance + IPC carry it verbatim).
    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl std::fmt::Display for AdapterId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

/// A pure-data CLI adapter definition (ADR-0081 / ADR-0094). The engine
/// consumes this and nothing else per CLI; all per-CLI variation lives in
/// fields here. The [`StreamFormat`] field selects the engine's per-format
/// dispatch path (ADR-0094: per-format, not per-CLI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterSpec {
    /// Stable id (provenance + IPC key).
    pub id: AdapterId,
    /// Human-readable name for the composer runtime picker (ADR-0083).
    pub display_name: &'static str,
    /// Candidate binary names for the PATH scan, in priority order. The first
    /// that resolves wins. Multiple names cover installer variation (an npm
    /// wrapper vs a native installer shipping different binary names); every
    /// current spec is single-name, so the shape is a forward reservation.
    pub binary_names: &'static [&'static str],
    /// The argv prefix that puts the CLI into its stdio protocol mode. The
    /// engine spawns `<resolved-binary> <argv-prefix...>` and speaks the
    /// protocol selected by [`StreamFormat`] over stdio. The prefix is the
    /// full CLI-specific invocation into protocol mode; the engine appends
    /// only generic per-turn args derived from the other spec fields and the
    /// turn input (non-ACP model/effort flags, bridge config overrides) --
    /// never CLI-specific arguments.
    pub argv: &'static [&'static str],
    /// The argv prefix the diagnostic probe uses to spawn this CLI (ADR-0096).
    /// `None` on ACP adapters -- the probe reuses [`Self::argv`] (the same
    /// protocol mode the turn drives). Every non-ACP adapter carries a
    /// dedicated probe argv (the probe surface differs from the turn's
    /// protocol mode): codex probes via the `app-server` subcommand, a
    /// different surface from the turn's `exec --json` mode; claude-code
    /// probes via the turn argv extended with `--input-format stream-json`
    /// (the stream-json control plane, ADR-0097 Decision 5). Like
    /// [`Self::argv`], pure CLI-specific data: the probe kernel reads it and
    /// names no CLI.
    pub probe_argv: Option<&'static [&'static str]>,
    /// The wire protocol the CLI speaks over stdio (ADR-0094). Selects the
    /// engine's per-format dispatch path.
    pub stream_format: StreamFormat,
    /// The argv flag that carries the model id at spawn (ADR-0095). Consumed
    /// ONLY by the non-ACP paths (the engine appends `[flag, value]` after
    /// the argv prefix). `None` on ACP adapters -- the ACP path injects the
    /// model via a `session/set_config_option` request after the handshake
    /// instead (schema 0.13.8's `NewSessionRequest` carries no model field).
    pub model_arg: Option<&'static str>,
    /// The ONE surface the reasoning-effort selection rides (ADR-0095 /
    /// ADR-0097 Decision 6): a `-c` config override key (codex) or an argv
    /// flag (claude-code's `--effort`). `None` on ACP adapters -- the ACP
    /// path sends one `session/set_config_option` request after the
    /// handshake instead. The enum makes "at most one surface per adapter"
    /// a type invariant: a dual-surface spec cannot be constructed, so the
    /// injection needs no precedence rule.
    pub effort: Option<EffortSurface>,
}

impl AdapterSpec {
    /// The composer picker + provenance key for this adapter.
    pub fn adapter_id(&self) -> AdapterId {
        self.id
    }
}

// ---------------------------------------------------------------------------
// The v1 adapters (gemini-cli, codex, qwen-code, opencode, claude-code)
// ---------------------------------------------------------------------------

/// The gemini-cli adapter (ADR-0081 v1 validation set, issue #300). The npm
/// package `@google/gemini-cli` ships a single `gemini` binary; the argv prefix
/// `["--experimental-acp"]` puts it into ACP stdio mode. gemini-cli names its
/// flag `--experimental-acp` (ACP support is still experimental upstream).
///
/// NOTE: the `--experimental-acp` spelling is pinned by gemini-cli's own CLI
/// (its `config.js` option table; no alias). Live E2E verifies it against a
/// real install. If gemini-cli renames or graduates the flag, ONLY this
/// constant changes -- the engine is untouched (ADR-0081 zero per-CLI code).
pub const fn gemini_cli() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("gemini-cli"),
        display_name: "gemini-cli",
        binary_names: &["gemini"],
        argv: &["--experimental-acp"],
        stream_format: StreamFormat::Acp,
        probe_argv: None,
        model_arg: None,
        effort: None,
    }
}

/// The codex adapter (ADR-0081 v1 validation set, issue #300). ADR-0094:
/// codex uses native `exec --json` direct-connect (not the retired `codex-acp`
/// bridge package). The detection binary is the official `codex` CLI; the argv
/// puts it into structured-NDJSON mode with a read-only sandbox (native shell /
/// file-write tools blocked platform-uniformly). The prompt is written to stdin
/// as flattened text; MCP tool calls route through the gateway bridge injected
/// via `-c` config override (ADR-0085/0094). The stream format is
/// `CodexEventStream`, so the engine dispatches to the codex event stream
/// path, not the ACP JSON-RPC path.
///
/// NOTE: the argv shape is pinned by the codex CLI's `exec` subcommand; live
/// E2E verifies it against a real install. If codex changes the flags, ONLY
/// this constant changes -- the engine is untouched (ADR-0081 zero per-CLI
/// code).
pub const fn codex() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("codex"),
        display_name: "codex",
        binary_names: &["codex"],
        argv: &[
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
        ],
        stream_format: StreamFormat::CodexEventStream,
        // The probe surface is the `app-server` subcommand, NOT the turn's
        // `exec --json` (ADR-0096 D2) -- a different communication channel
        // whose `model/list` RPC returns the per-model catalog.
        probe_argv: Some(&["app-server"]),
        // ADR-0095: codex's native `exec` takes the model as `--model <id>`
        // and the reasoning effort via the config override
        // `-c model_reasoning_effort=<value>` (same `-c` mechanism the bridge
        // injection uses, ADR-0094). No argv-shaped effort flag (ADR-0097
        // Decision 6 leaves codex on the `-c` surface).
        model_arg: Some("--model"),
        effort: Some(EffortSurface::ConfigKey("model_reasoning_effort")),
    }
}

/// The qwen-code adapter (issue #343). The npm package ships a single `qwen`
/// binary; the argv prefix `["--acp"]` puts it into ACP stdio mode. Unlike
/// gemini-cli's still-experimental `--experimental-acp`, qwen-code has graduated
/// to the stable `--acp` spelling, so the prefix differs even though the launch
/// shape is the same `<binary> <flag>` form.
///
/// NOTE: the `--acp` spelling is pinned by qwen-code's own CLI; live E2E
/// verifies it against a real install. If qwen-code renames the flag, ONLY this
/// constant changes -- the engine is untouched (ADR-0081 zero per-CLI code).
pub const fn qwen_code() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("qwen-code"),
        display_name: "qwen-code",
        binary_names: &["qwen"],
        argv: &["--acp"],
        stream_format: StreamFormat::Acp,
        probe_argv: None,
        model_arg: None,
        effort: None,
    }
}

/// The opencode adapter (issue #343). The npm package ships a single `opencode`
/// binary; the argv prefix `["acp"]` puts it into ACP stdio mode. Unlike the
/// other v1 adapters, opencode uses a SUBCOMMAND (`opencode acp`), not a
/// `--flag` -- the first v1 adapter whose argv prefix is not a flag. The launch
/// shape is still `<binary> <argv-prefix...>`, so the engine spawns it the same
/// way; the subcommand-vs-flag distinction lives entirely in this constant
/// (ADR-0081 zero per-CLI code).
///
/// NOTE: the `acp` subcommand is pinned by opencode's own CLI; live E2E
/// verifies it against a real install. If opencode renames the subcommand or
/// adds a `--flag` alias, ONLY this constant changes -- the engine is untouched.
pub const fn opencode() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("opencode"),
        display_name: "opencode",
        binary_names: &["opencode"],
        argv: &["acp"],
        stream_format: StreamFormat::Acp,
        probe_argv: None,
        model_arg: None,
        effort: None,
    }
}

/// The claude-code adapter (ADR-0097, issue #561). claude-code has no native
/// ACP mode (measured on 2.1.222: no `--acp` option; the spawn errors), so the
/// only structured interface is its headless mode: `--print --output-format
/// stream-json` emits NDJSON frames (`system` / `assistant` / `stream_event` /
/// `result`) on stdout while the prompt rides stdin as flattened text -- the
/// SAME stateless per-turn spawn shape the codex path drives (new spawn every
/// turn, no `--resume` / `--session-id`; `--no-session-persistence` keeps
/// upstream from writing a session file). The stream format is
/// `ClaudeStreamJson`, so the engine dispatches to the claude stream-json
/// path, never the codex parser.
///
/// Native tools are blocked wholesale (ADR-0097 Decision 3): the
/// `--disallowedTools` deny list below names claude-code's native tool
/// surface (the implementation-period measured set -- an open set upstream,
/// with headless auto-refusal of any permission request as the backstop), and
/// `--permission-prompt-tool` is deliberately NOT wired (no approval surface
/// for tools with no legitimate use). The ONLY tool plane is the gateway
/// bridge injected via `--mcp-config` + `--strict-mcp-config` (the turn
/// driver builds those from the turn input, ADR-0097 Decision 4).
///
/// NOTE: the argv spellings are pinned by the claude-code CLI; live E2E
/// verifies them against a real install (ADR-0097 unresolved item). If
/// claude-code renames a flag, ONLY this constant changes -- the engine is
/// untouched (ADR-0081 zero per-CLI code).
pub const fn claude_code() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("claude-code"),
        display_name: "claude-code",
        // The npm package `@anthropic-ai/claude-code` ships the `claude`
        // binary (native installers ship the same name).
        binary_names: &["claude"],
        // ADR-0097 Decision 7: the minimal flag set, no version gating. The
        // deny list is one comma-joined argv element (claude-code's
        // `--disallowedTools` spelling).
        argv: &[
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--disallowedTools",
            "Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,\
             TodoWrite,BashOutput,KillShell,SlashCommand",
        ],
        stream_format: StreamFormat::ClaudeStreamJson,
        // The probe surface is the stream-json CONTROL PLANE (ADR-0097
        // Decision 5): the turn argv extended with `--input-format
        // stream-json` so the probe can send a `control_request{initialize}`
        // frame and read the per-model catalog back -- the same spawn ->
        // query -> kill lifecycle the codex `app-server` probe drives, a
        // different wire surface. The turn argv prefix is repeated verbatim
        // (const fn cannot concatenate slices); the
        // `claude_probe_argv_is_turn_argv_plus_stream_json_input` test pins
        // the pairing so a drift fails instead of probing the wrong surface.
        probe_argv: Some(&[
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--disallowedTools",
            "Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,\
             TodoWrite,BashOutput,KillShell,SlashCommand",
            "--input-format",
            "stream-json",
        ]),
        // ADR-0095/0097: claude-code's headless mode takes the model as
        // `--model <id>` and the reasoning effort as `--effort <level>` --
        // both argv-shaped (no `-c` config surface on this CLI).
        model_arg: Some("--model"),
        effort: Some(EffortSurface::ArgvFlag("--effort")),
    }
}

/// All v1 adapters, in the composer picker's display order (ADR-0083). Adding
/// a CLI = adding one entry here + one constructor above.
pub fn v1_adapters() -> &'static [AdapterSpec] {
    // A pure-data static backing slice: const-constructible data in a plain
    // `static` is simpler than LazyLock and avoids the indirection.
    &V1_ADAPTERS
}

// The per-adapter constructors are `const fn`, so V1_ADAPTERS invokes them
// directly -- no field duplication, no drift between a constructor and its
// array entry. Adding a CLI = adding one `const fn` constructor + one call
// here; `v1_adapters()` stays the picker source.
static V1_ADAPTERS: [AdapterSpec; 5] = [
    gemini_cli(),
    codex(),
    qwen_code(),
    opencode(),
    claude_code(),
];

// ---------------------------------------------------------------------------
// Detection (PATH scan)
// ---------------------------------------------------------------------------

/// Resolve an adapter's binary to an absolute [`PathBuf`] by scanning `PATH`.
///
/// Returns the first of [`AdapterSpec::binary_names`] that resolves on `PATH`
/// (priority order), or `None` when no candidate is on `PATH`. The composer
/// runtime picker grays out an absent CLI from this result (ADR-0083 "已检测到
/// 的可选，未检测到的呈禁选项"); the engine (slice 9c) refuses to run a turn
/// against an absent CLI with a typed `NotWired`-equivalent failure.
///
/// Detection is `which`-style: each candidate is checked as an existing file
/// on each `PATH` entry, with the platform's executable suffix appended on
/// Windows (executability is enforced by the spawn itself, not the scan). No
/// caching -- detection is cheap and the picker re-scans on demand (the user
/// may install a CLI between scans).
pub fn detect_adapter(spec: &AdapterSpec) -> Option<PathBuf> {
    for name in spec.binary_names {
        if let Some(path) = which(name) {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Runtime discovery (ADR-0095)
// ---------------------------------------------------------------------------

/// The model + thought-level catalog extracted from an ACP handshake's
/// `config_options` (ADR-0095 Discovery Decision). Produced by the engine at
/// the handshake boundary (per format: ACP extracts, CodexEventStream has
/// none, ClaudeStreamJson reports the `system{init}` current model),
/// returned to the frontend via `LoopOutcome.discovered_runtime`, and cached
/// on the session for resume cold-start rendering.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DiscoveredRuntime {
    /// The model ids the CLI offered (empty when the CLI reports none).
    pub models: Vec<String>,
    /// The model the CLI reported as current / default, if any.
    pub current_model: Option<String>,
    /// The thought-level ids the CLI offered (empty when none).
    pub thought_levels: Vec<String>,
    /// The thought level the CLI reported as current / default, if any.
    pub current_thought_level: Option<String>,
    /// The config id of the catalog entry the CLI used for the model setting,
    /// when a model entry was seen (ADR-0095 D4). The ACP schema makes the
    /// option `id` agent-chosen -- only `category` is the semi-standardized
    /// tag -- so the engine keys injection on this id, falling back to the
    /// category constant when the entry carried no usable id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_config_id: Option<String>,
    /// Same as [`Self::model_config_id`] for the thought-level entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_level_config_id: Option<String>,
    /// The adapter that produced this catalog (issue #529): stamped by the
    /// engine after the handshake extract, NOT read from the CLI wire (the
    /// config_options shape carries no adapter identity). The frontend
    /// compares it against the active runtime to detect a catalog cached
    /// under a different adapter (stale across a runtime switch). Absent on
    /// recipes persisted before the field existed (old-recipe compatibility).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
}

impl DiscoveredRuntime {
    /// Nothing discovered (the honest empty shape for a config_options value
    /// that carried no model / thought_level entries).
    pub fn empty() -> Self {
        Self {
            models: Vec::new(),
            current_model: None,
            thought_levels: Vec::new(),
            current_thought_level: None,
            model_config_id: None,
            thought_level_config_id: None,
            adapter_id: None,
        }
    }

    /// True when no selector-facing field carries data (issue #531): the
    /// picker can render nothing from this catalog. The injection-facing
    /// `*_config_id`s and the engine-stamped `adapter_id` are deliberately
    /// excluded -- an id alone can only re-key an already-persisted
    /// selection, it offers the selector nothing.
    fn selector_fields_empty(&self) -> bool {
        self.models.is_empty()
            && self.current_model.is_none()
            && self.thought_levels.is_empty()
            && self.current_thought_level.is_none()
    }
}

/// The semantic categories the discovery path keys on (ADR-0095 Decision 3):
/// the ACP `SessionConfigOption.category` enum's model + thought_level
/// variants, snake_case-tagged exactly this way in schema 0.13.8's
/// `SessionConfigOptionCategory`; any other tag -- including a renamed one
/// -- lands in that enum's `Other(String)` fallback and contributes nothing
/// (the zero-extraction warn in [`extract_discovered_runtime`] is what makes
/// that drift visible). A CLI with no categorized options contributes
/// nothing to [`DiscoveredRuntime`] -- discovery degrades to the empty
/// shape, it never fails the turn.
pub(crate) const MODEL_CATEGORY: &str = "model";
pub(crate) const THOUGHT_LEVEL_CATEGORY: &str = "thought_level";

/// Extract the [`DiscoveredRuntime`] from a raw `config_options` value
/// (ADR-0095). The ACP wire shape is schema 0.13.8's `SessionConfigOption`
/// (camelCase: `id` / `name` / optional `description` / optional `category`,
/// plus a flattened Select kind carrying `currentValue` + `options`;
/// `name` / `description` / `_meta` are display-side and never read here)
/// -- one entry per option:
/// `{ "id", "name", "category", "currentValue", "options": [...] }` where
/// `options` is either a flat list of `{ "value", "name" }` or a grouped
/// list of `{ "group", "name", "options": [...] }` (serde untagged -- the
/// two shapes share the `options` key, an array of groups instead of
/// values). Discovery keys on `category` (model / thought_level) and reads
/// `currentValue` + every option's `value`, flattening groups. Pure +
/// total: any malformed shape (missing fields, wrong types, a non-array
/// catalog) contributes nothing -- the result degrades to empty lists /
/// `None` currents, never an error (a turn must not fail because a CLI's
/// config shape drifted); when the result carries no selector-facing data,
/// [`degrade_diagnosis`] turns that silence into one warn (issue #531).
pub fn extract_discovered_runtime(config_options: Option<&serde_json::Value>) -> DiscoveredRuntime {
    let mut out = DiscoveredRuntime::empty();
    let Some(catalog) = config_options else {
        return out;
    };
    // A non-array catalog contributes nothing, but it still flows to the
    // diagnosis below: `null` is the legitimate no-options encoding, any
    // other non-array shape is envelope drift (issue #531).
    if let Some(entries) = catalog.as_array() {
        for entry in entries {
            let category = entry.get("category").and_then(|v| v.as_str());
            // One dispatch over the category binds every slot this entry owns, so
            // adding a category is one arm (no second match to keep in sync).
            match category {
                Some(c) if c == MODEL_CATEGORY => {
                    out.current_model = entry
                        .get("currentValue")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    out.model_config_id = entry_config_id(entry);
                    out.models = flatten_option_values(entry.get("options"));
                }
                Some(c) if c == THOUGHT_LEVEL_CATEGORY => {
                    out.current_thought_level = entry
                        .get("currentValue")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    out.thought_level_config_id = entry_config_id(entry);
                    out.thought_levels = flatten_option_values(entry.get("options"));
                }
                _ => {}
            }
        }
    }
    // Issue #531: the silent degrade gets one diagnostic line -- config
    // shape drift reads as a warn instead of a permanently-empty selector.
    if let Some((count, categories)) = degrade_diagnosis(catalog, &out) {
        log::warn!(
            target: "toptopduck::discovery",
            "config_options: {count} entries yielded no model/thought_level data (categories seen: {categories}); selector degrades to empty -- possible CLI config-shape drift"
        );
    }
    out
}

/// Diagnose the silent degrade (issue #531): a non-empty catalog that still
/// produced no selector-facing data yields `Some((entry count, distinct
/// category strings))` for the boundary warn -- the category set tells
/// category drift (renamed tags visible verbatim) apart from field drift
/// (known tags, nothing extracted). Selector-facing means the fields the
/// picker renders; the injection-facing `*_config_id`s are excluded -- an
/// id alone can only re-key an already-persisted selection, it offers the
/// selector nothing. A present, non-null, non-array catalog never reached
/// extraction and diagnoses as `<not an array>`. Every other path stays
/// `None`: a missing / null / empty catalog is a normal degrade, and any
/// partial selector-facing recognition means the catalog was understood
/// well enough to use.
fn degrade_diagnosis(
    catalog: &serde_json::Value,
    out: &DiscoveredRuntime,
) -> Option<(usize, String)> {
    let entries = match catalog.as_array() {
        Some(entries) => entries,
        // `null` is the legitimate no-options encoding; anything else
        // non-array is envelope drift.
        None if catalog.is_null() => return None,
        None => return Some((0, "<not an array>".to_string())),
    };
    if entries.is_empty() || !out.selector_fields_empty() {
        return None;
    }
    let mut categories: Vec<&str> = entries
        .iter()
        .filter_map(|e| e.get("category").and_then(|v| v.as_str()))
        .collect();
    categories.sort_unstable();
    categories.dedup();
    let seen = if categories.is_empty() {
        "<none>".to_string()
    } else {
        categories.join(", ")
    };
    Some((entries.len(), seen))
}

/// The entry's `id`, when it is a non-empty string. The ACP schema makes the
/// option id agent-chosen (ADR-0095 D4): the engine keys injection on it and
/// falls back to the category constant when absent, so an empty / non-string
/// id is treated as missing.
fn entry_config_id(entry: &serde_json::Value) -> Option<String> {
    entry
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Flatten an ACP select `options` payload into its value ids: a flat array
/// of `{ value }` entries passes through; a grouped array's inner `options`
/// are flattened in order. Anything else yields nothing.
fn flatten_option_values(options: Option<&serde_json::Value>) -> Vec<String> {
    let Some(entries) = options.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        if let Some(value) = entry.get("value").and_then(|v| v.as_str()) {
            out.push(value.to_string());
        } else if let Some(inner) = entry.get("options").and_then(|v| v.as_array()) {
            for option in inner {
                if let Some(value) = option.get("value").and_then(|v| v.as_str()) {
                    out.push(value.to_string());
                }
            }
        }
    }
    out
}

/// `which`-style PATH lookup for a single binary name. Returns the first
/// `PATH` entry that holds the binary as an executable. Windows appends the
/// standard executable suffixes (`.exe` first; `.bat` / `.cmd` cover npm
/// shims) when the bare name has no extension. Pure std -- no `which` crate
/// dependency, consistent with the codebase's minimal-deps stance.
fn which(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    // On Windows, a name with no extension is matched against the standard
    // executable suffixes; POSIX needs no suffix.
    let candidates: Vec<String> = if cfg!(windows) && PathBuf::from(name).extension().is_none() {
        [".exe", ".bat", ".cmd"]
            .iter()
            .map(|ext| format!("{name}{ext}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path_env) {
        for candidate in &candidates {
            let resolved = dir.join(candidate);
            // is_file guards against PATH entries pointing at a non-file (a
            // stale dir, a dangling symlink). Executability is enforced by the
            // spawn itself (Command surfaces a clear error if the bit is
            // missing); the scan only needs "the file exists on PATH".
            if resolved.is_file() {
                return Some(resolved);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- extract_discovered_runtime (ADR-0095) ------------------------------

    /// The full happy path against the real SessionConfigOption wire shape
    /// (id / category / currentValue / options[], camelCase -- schema crate
    /// 0.13.8): one model entry + one thought_level entry, each carrying a
    /// current value and a flat offered-choices list. A non-categorized
    /// entry (e.g. mode) is ignored.
    #[test]
    fn extract_finds_model_and_thought_level_entries() {
        let catalog = json!([
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": "claude-sonnet-4",
                "options": [
                    { "value": "claude-sonnet-4", "name": "Sonnet" },
                    { "value": "claude-opus-4", "name": "Opus" },
                ],
            },
            {
                "id": "thought",
                "name": "Thinking",
                "category": "thought_level",
                "currentValue": "medium",
                "options": [
                    { "value": "low" }, { "value": "medium" }, { "value": "high" },
                ],
            },
            {
                "id": "mode",
                "name": "Mode",
                "category": "mode",
                "currentValue": "default",
                "options": [{ "value": "default" }],
            },
        ]);
        let d = extract_discovered_runtime(Some(&catalog));
        assert_eq!(
            d.models,
            vec!["claude-sonnet-4".to_string(), "claude-opus-4".to_string()]
        );
        assert_eq!(d.current_model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(
            d.thought_levels,
            vec!["low".to_string(), "medium".to_string(), "high".to_string()]
        );
        assert_eq!(d.current_thought_level.as_deref(), Some("medium"));
        // ADR-0095 D4: the agent-chosen ids are extracted for the injection
        // path (the thought entry names its id `thought`, NOT the category
        // constant -- a hardcoded injection would miss it).
        assert_eq!(d.model_config_id.as_deref(), Some("model"));
        assert_eq!(d.thought_level_config_id.as_deref(), Some("thought"));
        // The engine stamps the producing adapter AFTER the extract (issue
        // #529) -- the raw wire shape carries no adapter identity, so the
        // extract itself leaves the slot None (empty() sets it None too).
        assert_eq!(d.adapter_id, None);
    }

    /// The grouped-options shape (SessionConfigSelectOptions::Grouped, serde
    /// untagged): the values flatten in group order.
    #[test]
    fn extract_flattens_grouped_options() {
        let catalog = json!([
            {
                "id": "model",
                "category": "model",
                "currentValue": "m2",
                "options": [
                    { "group": "fast", "name": "Fast", "options": [
                        { "value": "m1" }, { "value": "m2" },
                    ]},
                    { "group": "deep", "name": "Deep", "options": [
                        { "value": "m3" },
                    ]},
                ],
            },
        ]);
        let d = extract_discovered_runtime(Some(&catalog));
        assert_eq!(
            d.models,
            vec!["m1".to_string(), "m2".to_string(), "m3".to_string()]
        );
        assert_eq!(d.current_model.as_deref(), Some("m2"));
    }

    /// None config_options / an empty array / only-uncategorized entries all
    /// degrade to the empty shape (discovery is optional data, never a
    /// failure).
    #[test]
    fn extract_missing_or_empty_catalog_degrades_to_empty() {
        assert_eq!(extract_discovered_runtime(None), DiscoveredRuntime::empty());
        assert_eq!(
            extract_discovered_runtime(Some(&json!([]))),
            DiscoveredRuntime::empty()
        );
        assert_eq!(
            extract_discovered_runtime(Some(&json!([
                { "id": "mode", "category": "mode", "currentValue": "default" }
            ]))),
            DiscoveredRuntime::empty()
        );
    }

    /// Malformed shapes (a non-array catalog, a non-string currentValue, a
    /// missing options list) contribute what they can -- never an error.
    #[test]
    fn extract_malformed_shapes_contribute_nothing() {
        // A non-array catalog is not a catalog.
        assert_eq!(
            extract_discovered_runtime(Some(&json!({"category": "model"}))),
            DiscoveredRuntime::empty()
        );
        // A model entry whose currentValue is not a string: no current, but
        // the offered list still extracts.
        let d = extract_discovered_runtime(Some(&json!([
            {
                "id": "model",
                "category": "model",
                "currentValue": 42,
                "options": [{ "value": "m1" }],
            }
        ])));
        assert_eq!(d.models, vec!["m1".to_string()]);
        assert_eq!(d.current_model, None);
        // A thought_level entry with no options list: the current value still
        // extracts (an offered list is optional information).
        let d = extract_discovered_runtime(Some(&json!([
            { "id": "t", "category": "thought_level", "currentValue": "high" }
        ])));
        assert!(d.thought_levels.is_empty());
        assert_eq!(d.current_thought_level.as_deref(), Some("high"));
    }

    /// Issue #531: a non-empty catalog that still yields no selector-facing
    /// data is diagnosed -- entry count + the distinct sorted category
    /// strings the CLI actually sent, so a renamed category surfaces
    /// verbatim in the set (duplicates collapse, order is lexicographic).
    #[test]
    fn nonempty_catalog_with_zero_extraction_is_diagnosed() {
        let catalog = json!([
            { "id": "z1", "category": "zed" },
            { "id": "a", "name": "Alpha", "category": "alpha" },
            { "id": "z2", "category": "zed" },
        ]);
        let out = extract_discovered_runtime(Some(&catalog));
        assert_eq!(out, DiscoveredRuntime::empty());
        assert_eq!(
            degrade_diagnosis(&catalog, &out),
            Some((3, "alpha, zed".to_string()))
        );
    }

    /// The diagnosis collapses absent / non-string categories into one
    /// marker: the set stays honest about what arrived without failing on
    /// shape (issue #531).
    #[test]
    fn zero_extraction_without_category_strings_uses_none_marker() {
        let catalog = json!([
            { "id": "m", "currentValue": "m1", "options": [{ "value": "m1" }] },
            { "id": "x", "category": 42 },
        ]);
        let out = extract_discovered_runtime(Some(&catalog));
        assert_eq!(out, DiscoveredRuntime::empty());
        assert_eq!(
            degrade_diagnosis(&catalog, &out),
            Some((2, "<none>".to_string()))
        );
    }

    /// Recognition that yields only injection keys still counts as zero
    /// extraction: an id can re-key an already-persisted selection but
    /// offers the selector nothing, so the warn must fire (issue #531).
    #[test]
    fn id_only_recognition_is_still_diagnosed() {
        let catalog = json!([
            { "id": "m", "category": "model" },
            { "id": "t", "category": "thought_level" },
        ]);
        let out = extract_discovered_runtime(Some(&catalog));
        assert!(out.model_config_id.is_some());
        assert!(out.thought_level_config_id.is_some());
        assert_eq!(
            degrade_diagnosis(&catalog, &out),
            Some((2, "model, thought_level".to_string()))
        );
    }

    /// Entries with and without a usable category string coexist: the set
    /// lists what arrived, the `<none>` marker is reserved for a catalog
    /// that carried no category strings at all (issue #531).
    #[test]
    fn mixed_category_availability_lists_only_the_strings() {
        let catalog = json!([
            { "id": "x", "category": "x" },
            { "id": "y" },
        ]);
        let out = extract_discovered_runtime(Some(&catalog));
        assert_eq!(out, DiscoveredRuntime::empty());
        assert_eq!(
            degrade_diagnosis(&catalog, &out),
            Some((2, "x".to_string()))
        );
    }

    /// Only the all-empty outcome is diagnosed: a missing / null / empty
    /// catalog is a normal degrade, and partial recognition (a current
    /// value with no offered list) means the catalog was understood well
    /// enough to use -- the warn is reserved for the selector going fully
    /// empty (issue #531).
    #[test]
    fn non_catalogs_and_partial_recognition_are_not_diagnosed() {
        assert_eq!(
            degrade_diagnosis(&json!(null), &DiscoveredRuntime::empty()),
            None
        );
        let empty_catalog = json!([]);
        assert_eq!(
            degrade_diagnosis(&empty_catalog, &DiscoveredRuntime::empty()),
            None
        );
        let catalog = json!([
            { "id": "t", "category": "thought_level", "currentValue": "high" }
        ]);
        let out = extract_discovered_runtime(Some(&catalog));
        assert_ne!(out, DiscoveredRuntime::empty());
        assert_eq!(degrade_diagnosis(&catalog, &out), None);
    }

    /// A present, non-null, non-array catalog is envelope drift, not the
    /// legitimate `null` no-options encoding -- it diagnoses as such
    /// (issue #531).
    #[test]
    fn non_null_non_array_catalog_is_diagnosed() {
        let object = json!({ "model": "misplaced" });
        assert_eq!(
            degrade_diagnosis(&object, &DiscoveredRuntime::empty()),
            Some((0, "<not an array>".to_string()))
        );
        let string = json!("catalog");
        assert_eq!(
            degrade_diagnosis(&string, &DiscoveredRuntime::empty()),
            Some((0, "<not an array>".to_string()))
        );
    }

    /// ADR-0095 injection fields: ACP adapters carry `None` (protocol
    /// injection), the CodexEventStream adapter (codex) carries `--model` +
    /// the reasoning-effort config key, the ClaudeStreamJson adapter carries
    /// `--model` + the argv-shaped `--effort` (ADR-0097 Decision 6). The
    /// single-enum field makes the at-most-one-surface invariant structural;
    /// this test pins WHICH surface each adapter picked.
    #[test]
    fn adapters_declare_per_format_injection_fields() {
        for spec in [gemini_cli(), qwen_code(), opencode()] {
            assert_eq!(spec.stream_format, StreamFormat::Acp);
            assert!(spec.model_arg.is_none(), "{}", spec.id);
            assert!(spec.effort.is_none(), "{}", spec.id);
        }
        let codex = codex();
        assert_eq!(codex.model_arg, Some("--model"));
        assert_eq!(
            codex.effort,
            Some(EffortSurface::ConfigKey("model_reasoning_effort")),
            "codex effort rides `-c`"
        );
        let claude = claude_code();
        assert_eq!(claude.model_arg, Some("--model"));
        assert_eq!(
            claude.effort,
            Some(EffortSurface::ArgvFlag("--effort")),
            "claude-code has no `-c` config surface"
        );
    }

    /// ADR-0096 D2: the probe argv is `None` on ACP adapters (the probe reuses
    /// the turn argv); every non-ACP adapter carries a dedicated probe
    /// surface -- the `app-server` subcommand on codex, the turn argv +
    /// `--input-format stream-json` on claude-code (ADR-0097 Decision 5).
    /// The spawn kernel enforces this pairing via a debug_assert.
    #[test]
    fn adapters_declare_probe_argv_per_format() {
        for spec in [gemini_cli(), qwen_code(), opencode()] {
            assert!(spec.probe_argv.is_none(), "{}", spec.id);
        }
        assert_eq!(codex().probe_argv, Some(&["app-server"][..]));
        assert!(claude_code().probe_argv.is_some());
    }

    /// The claude-code probe argv is the turn argv extended with
    /// `--input-format stream-json` (ADR-0097 Decision 5: the probe spawns
    /// the SAME stateless surface and speaks the control plane over stdin,
    /// probing without an upstream session file just like the turn). const
    /// fn cannot concatenate slices, so the two literals repeat the prefix --
    /// this test is the drift guard.
    #[test]
    fn claude_probe_argv_is_turn_argv_plus_stream_json_input() {
        let spec = claude_code();
        let probe = spec
            .probe_argv
            .expect("claude-code probes via its own argv");
        assert!(
            probe.len() == spec.argv.len() + 2,
            "probe argv = turn argv + [--input-format, stream-json]"
        );
        assert_eq!(&probe[..spec.argv.len()], spec.argv);
        assert_eq!(
            &probe[spec.argv.len()..],
            &["--input-format", "stream-json"]
        );
    }

    /// v1_adapters is internally consistent: non-empty, unique ids, every
    /// entry has a non-empty display name + binary names. Count-agnostic --
    /// adding a CLI (one `const fn` constructor + one V1_ADAPTERS entry) never
    /// touches this test.
    #[test]
    fn v1_adapters_is_internally_consistent() {
        let adapters = v1_adapters();
        assert!(!adapters.is_empty(), "v1 ships at least one adapter");
        let unique: std::collections::HashSet<AdapterId> = adapters.iter().map(|a| a.id).collect();
        assert_eq!(
            adapters.len(),
            unique.len(),
            "duplicate adapter id in v1_adapters"
        );
        for a in adapters {
            assert!(!a.display_name.is_empty(), "{:?}: empty display_name", a.id);
            assert!(!a.binary_names.is_empty(), "{:?}: empty binary_names", a.id);
            assert!(
                !a.binary_names.iter().any(|n| n.is_empty()),
                "{:?}: empty binary name in binary_names",
                a.id
            );
            // Each adapter's stream_format is a valid known variant (Acp,
            // CodexEventStream, or ClaudeStreamJson). The specific
            // per-adapter assignment is pinned in the per-adapter tests
            // above, not here.
            // Every non-ACP adapter carries a dedicated probe argv; ACP
            // adapters reuse the turn argv (the spawn kernel's invariant).
            assert_eq!(
                a.stream_format != StreamFormat::Acp,
                a.probe_argv.is_some(),
                "{}: probe argv pairing",
                a.id
            );
        }
    }

    /// gemini-cli uses the `gemini` binary plus the `["--experimental-acp"]`
    /// argv prefix (gemini-cli's experimental ACP flag). The engine reads this
    /// as data.
    #[test]
    fn gemini_cli_spec_carries_gemini_binary_and_experimental_acp_flag() {
        let spec = gemini_cli();
        assert_eq!(spec.id.as_str(), "gemini-cli");
        assert_eq!(spec.display_name, "gemini-cli");
        assert_eq!(spec.binary_names, &["gemini"]);
        assert_eq!(spec.argv, &["--experimental-acp"]);
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// ADR-0094: codex uses the native `codex` binary (not the retired
    /// `codex-acp` bridge package) with the `exec --json` argv that puts it
    /// into structured-NDJSON mode + a read-only sandbox. The stream format is
    /// `CodexEventStream`, not `Acp`. This is the structural proof that
    /// per-CLI variation lives in data, not code.
    #[test]
    fn codex_spec_targets_native_exec_json() {
        let spec = codex();
        assert_eq!(spec.id.as_str(), "codex");
        assert_eq!(spec.display_name, "codex");
        assert_eq!(spec.binary_names, &["codex"]);
        assert_eq!(
            spec.argv,
            &[
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ephemeral",
                "--sandbox",
                "read-only",
            ]
        );
        assert_eq!(spec.stream_format, StreamFormat::CodexEventStream);
    }

    /// ADR-0097: claude-code targets its native headless surface -- the
    /// `claude` binary, `--print --output-format stream-json` argv with
    /// `--no-session-persistence` (stateless per-turn spawn, no upstream
    /// session file), and the `--disallowedTools` deny list blocking the
    /// native tool plane. The stream format is `ClaudeStreamJson`, not
    /// `Acp` (claude-code has no ACP mode) and not the codex parser.
    #[test]
    fn claude_code_spec_targets_native_headless_stream_json() {
        let spec = claude_code();
        assert_eq!(spec.id.as_str(), "claude-code");
        assert_eq!(spec.display_name, "claude-code");
        assert_eq!(spec.binary_names, &["claude"]);
        assert_eq!(spec.stream_format, StreamFormat::ClaudeStreamJson);
        // Turn argv pins: the headless flags + session-persistence opt-out +
        // the native-tool deny list (ADR-0097 Decision 1/3/7).
        assert!(spec
            .argv
            .starts_with(&["--print", "--output-format", "stream-json"]));
        assert!(spec.argv.contains(&"--verbose"));
        assert!(spec.argv.contains(&"--no-session-persistence"));
        let deny = spec
            .argv
            .iter()
            .position(|a| *a == "--disallowedTools")
            .expect("the deny list rides the turn argv");
        let deny_value = spec.argv[deny + 1];
        for tool in [
            "Task",
            "Bash",
            "Glob",
            "Grep",
            "Read",
            "Edit",
            "Write",
            "NotebookEdit",
            "WebFetch",
            "WebSearch",
            "TodoWrite",
            "BashOutput",
            "KillShell",
            "SlashCommand",
        ] {
            assert!(
                deny_value.split(',').any(|t| t == tool),
                "the deny list covers claude-code's native tool `{tool}`: {deny_value}"
            );
        }
        // No session addressing: neither flag may ride the turn argv
        // (ADR-0097 Decision 1 -- resume / session state is app-side).
        assert!(!spec.argv.contains(&"--resume"));
        assert!(!spec.argv.contains(&"--session-id"));
    }

    /// qwen-code uses the `qwen` binary plus the stable `["--acp"]` flag
    /// (graduated from gemini-cli's experimental `--experimental-acp`). The
    /// launch shape is the same `<binary> <flag>` form.
    #[test]
    fn qwen_code_spec_carries_qwen_binary_and_stable_acp_flag() {
        let spec = qwen_code();
        assert_eq!(spec.id.as_str(), "qwen-code");
        assert_eq!(spec.display_name, "qwen-code");
        assert_eq!(spec.binary_names, &["qwen"]);
        assert_eq!(spec.argv, &["--acp"]);
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// opencode uses the `opencode` binary plus an `["acp"]` SUBCOMMAND, not a
    /// `--flag` -- the first v1 adapter whose argv prefix is not a flag. The
    /// engine's `<binary> <argv...>` spawn drives it verbatim; the
    /// subcommand-vs-flag distinction lives in this data, not a code branch.
    #[test]
    fn opencode_spec_uses_acp_subcommand_not_a_flag() {
        let spec = opencode();
        assert_eq!(spec.id.as_str(), "opencode");
        assert_eq!(spec.display_name, "opencode");
        assert_eq!(spec.binary_names, &["opencode"]);
        assert_eq!(spec.argv, &["acp"]);
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// detect_adapter returns Option regardless of install state -- the
    /// structural guarantee the engine + the composer picker rely on (no
    /// panic on an absent CLI).
    #[test]
    fn detect_adapter_returns_option_regardless_of_install() {
        let spec = gemini_cli();
        // `gemini` is not on the CI runner's PATH. A dev box with gemini-cli
        // installed may resolve to Some; the assertion pins the Option shape,
        // not the absence, so the test is portable.
        let _ = detect_adapter(&spec);
    }

    /// which finds a binary that IS on PATH (the test runner's own tooling).
    /// Uses `cargo` (always present in a cargo test run) to exercise the
    /// resolution path positively, not just the absent path.
    #[test]
    fn which_resolves_a_present_binary() {
        // `cargo` is on PATH in any `cargo test` invocation. The bare name on
        // Windows resolves via the `.exe` suffix branch; on POSIX directly.
        let found = which("cargo");
        assert!(
            found.is_some(),
            "cargo must resolve on PATH in a cargo test"
        );
        assert!(
            found.unwrap().is_file(),
            "the resolved path must be an existing file"
        );
    }

    /// which returns None for a binary that is definitely not on PATH.
    #[test]
    fn which_returns_none_for_definitely_absent_binary() {
        let found = which("definitely-not-a-real-binary-xyz-12345");
        assert!(found.is_none(), "an absent binary resolves to None");
    }

    /// AdapterId round-trips through Display + as_str (provenance + IPC).
    #[test]
    fn adapter_id_displays_as_its_str() {
        let id = AdapterId::new("gemini-cli");
        assert_eq!(id.as_str(), "gemini-cli");
        assert_eq!(id.to_string(), "gemini-cli");
    }
}
