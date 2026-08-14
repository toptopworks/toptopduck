//! Per-CLI adapter data definitions (ADR-0081, issue #299).
//!
//! ADR-0081 Decision: every external CLI is a **pure data definition** -- the
//! engine ([`crate::runtime::acp::engine`]) has zero per-CLI code branches.
//! Adding a CLI = adding one [`AdapterSpec`] constructor here. The v1 engine
//! drives every ACP CLI (claude-code, gemini-cli, codex, qwen-code, opencode)
//! against the SAME code path, so the AC "the adapter engine has zero per-CLI
//! code branches" is structural: the engine takes a `&AdapterSpec` and never
//! names a CLI.
//!
//! An [`AdapterSpec`] carries:
//! - identification: a stable [`AdapterId`] + display name (the composer runtime
//!   picker + the per-turn provenance, ADR-0078, read these);
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
/// parser path (ADR-0081 zero per-CLI code invariant preserved).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFormat {
    /// ACP v1 JSON-RPC over stdio (initialize + session/new + session/prompt).
    Acp,
    /// A native JSONL event stream over stdio (codex `exec --json`, ADR-0094).
    JsonEventStream,
}

// ---------------------------------------------------------------------------
// Adapter spec
// ---------------------------------------------------------------------------

/// A stable identifier for a CLI adapter (per-turn provenance + the composer
/// picker's key). Distinct from the binary name (claude-code ships as both
/// `claude` and `claude-code` across installers) and from the display name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AdapterId(&'static str);

impl AdapterId {
    /// Build a new adapter id. `pub` so the slice-9c integration test can mint a
    /// fake-CLI adapter; production code still uses the constructors below
    /// ([`claude_code`], etc.), so a stray id fails review rather than the
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
    /// that resolves wins. Multiple names cover installer variation (npm vs the
    /// native installer ship different binary names).
    pub binary_names: &'static [&'static str],
    /// The argv prefix that puts the CLI into its stdio protocol mode. The
    /// engine spawns `<resolved-binary> <argv-prefix...>` and speaks the
    /// protocol selected by [`StreamFormat`] over stdio. The prefix is the full
    /// invocation; the engine appends nothing.
    pub argv: &'static [&'static str],
    /// The wire protocol the CLI speaks over stdio (ADR-0094). Selects the
    /// engine's per-format dispatch path.
    pub stream_format: StreamFormat,
}

impl AdapterSpec {
    /// The composer picker + provenance key for this adapter.
    pub fn adapter_id(&self) -> AdapterId {
        self.id
    }
}

// ---------------------------------------------------------------------------
// The v1 adapters (claude-code, gemini-cli, codex, qwen-code, opencode)
// ---------------------------------------------------------------------------

/// The claude-code adapter (ADR-0081 v1 validation set). claude-code is
/// installed as `claude` (native installer) or `claude-code` (npm wrapper); the
/// PATH scan tries both. The argv prefix `["--acp"]` puts the CLI into its ACP
/// stdio mode (the engine then drives session/new + session/prompt).
///
/// NOTE: the `--acp` flag spelling is pinned by claude-code's own CLI; live E2E
/// verifies it against a real install. If claude-code renames the flag, ONLY
/// this constant changes -- the engine is untouched (ADR-0081 zero per-CLI
/// code).
pub const fn claude_code() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("claude-code"),
        display_name: "claude-code",
        binary_names: &["claude", "claude-code"],
        argv: &["--acp"],
        stream_format: StreamFormat::Acp,
    }
}

/// The gemini-cli adapter (ADR-0081 v1 validation set, issue #300). The npm
/// package `@google/gemini-cli` ships a single `gemini` binary; the argv prefix
/// `["--experimental-acp"]` puts it into ACP stdio mode. Unlike claude-code's
/// `--acp`, gemini-cli names its flag `--experimental-acp` (ACP support is
/// still experimental upstream), so the prefix differs even though the launch
/// shape is the same `<binary> <flag>` form.
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
    }
}

/// The codex adapter (ADR-0081 v1 validation set, issue #300). Unlike
/// claude-code + gemini-cli, codex has NO native `--acp` flag: ACP support is
/// the dedicated `codex-acp` binary (npm `@agentclientprotocol/codex-acp`,
/// installed as `codex-acp`), which starts in ACP stdio mode by default and
/// wraps the Codex App Server internally. So the launch shape differs from the
/// other two -- empty argv, a dedicated server binary -- yet it is STILL pure
/// data: the engine spawns `<binary> <argv...>` and the difference lives here,
/// not in a code branch (ADR-0081 zero per-CLI code).
///
/// The id / display name stay `codex` (the user-facing concept the composer
/// picker + per-turn provenance carry); only the detection binary name is
/// `codex-acp`.
///
/// NOTE: the binary name + the "dedicated server, no flag" shape are pinned by
/// the `codex-acp` package; live E2E verifies them against a real install. If
/// codex later gains a native `--acp` flag, ONLY this constant changes -- the
/// engine is untouched.
pub const fn codex() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("codex"),
        display_name: "codex",
        binary_names: &["codex-acp"],
        argv: &[],
        stream_format: StreamFormat::Acp,
    }
}

/// The qwen-code adapter (issue #343). The npm package ships a single `qwen`
/// binary; the argv prefix `["--acp"]` puts it into ACP stdio mode. Unlike
/// gemini-cli's still-experimental `--experimental-acp`, qwen-code has graduated
/// to the stable `--acp` spelling, so the prefix differs even though the launch
/// shape is the same `<binary> <flag>` form as claude-code.
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
    claude_code(),
    gemini_cli(),
    codex(),
    qwen_code(),
    opencode(),
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
/// Detection is `which`-style: each candidate is checked as an executable on
/// each `PATH` entry, with the platform's executable suffix appended on
/// Windows. No caching -- detection is cheap and the picker re-scans on demand
/// (the user may install a CLI between scans).
pub fn detect_adapter(spec: &AdapterSpec) -> Option<PathBuf> {
    for name in spec.binary_names {
        if let Some(path) = which(name) {
            return Some(path);
        }
    }
    None
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

    /// The claude-code adapter carries both installer binary names + the ACP
    /// argv prefix. The engine reads these as data, never naming the CLI.
    #[test]
    fn claude_code_spec_carries_both_binary_names_and_acp_flag() {
        let spec = claude_code();
        assert_eq!(spec.id.as_str(), "claude-code");
        assert_eq!(spec.display_name, "claude-code");
        assert_eq!(spec.binary_names, &["claude", "claude-code"]);
        assert_eq!(spec.argv, &["--acp"]);
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// v1_adapters is internally consistent: non-empty, unique ids, every entry
    /// has a non-empty display name + binary names, and every entry is `Acp`
    /// (the prefactor pins all existing adapters to ACP; ADR-0094's codex native
    /// exec migration changes the codex entry in a later slice). Count-agnostic
    /// -- adding a CLI (one `const fn` constructor + one V1_ADAPTERS entry)
    /// never touches this test.
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
            assert_eq!(
                a.stream_format,
                StreamFormat::Acp,
                "{:?}: all v1 adapters are ACP in this prefactor slice",
                a.id
            );
        }
    }

    /// gemini-cli uses the `gemini` binary plus the `["--experimental-acp"]`
    /// argv prefix (gemini-cli's experimental ACP flag, distinct from
    /// claude-code's `--acp`). The engine reads this as data.
    #[test]
    fn gemini_cli_spec_carries_gemini_binary_and_experimental_acp_flag() {
        let spec = gemini_cli();
        assert_eq!(spec.id.as_str(), "gemini-cli");
        assert_eq!(spec.display_name, "gemini-cli");
        assert_eq!(spec.binary_names, &["gemini"]);
        assert_eq!(spec.argv, &["--experimental-acp"]);
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// codex is the dedicated-ACP-server shape: the `codex-acp` binary with an
    /// empty argv (no native `--acp` flag). The id/display stay `codex` (the
    /// user-facing concept); only the detection binary name is `codex-acp`.
    /// This is the structural proof that per-CLI variation lives in data, not
    /// code: the engine spawns `<binary> <argv...>` and this differs from the
    /// other two without a per-CLI branch.
    #[test]
    fn codex_spec_targets_dedicated_acp_server_with_empty_argv() {
        let spec = codex();
        assert_eq!(spec.id.as_str(), "codex");
        assert_eq!(spec.display_name, "codex");
        assert_eq!(spec.binary_names, &["codex-acp"]);
        assert!(spec.argv.is_empty(), "codex-acp needs no ACP flag");
        assert_eq!(spec.stream_format, StreamFormat::Acp);
    }

    /// qwen-code uses the `qwen` binary plus the stable `["--acp"]` flag
    /// (graduated from gemini-cli's experimental `--experimental-acp`). The
    /// launch shape matches claude-code's `<binary> <flag>` form.
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
        let spec = claude_code();
        // `claude` / `claude-code` are not on the CI runner's PATH. A dev box
        // with claude-code installed may resolve to Some; the assertion pins
        // the Option shape, not the absence, so the test is portable.
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
        let id = AdapterId::new("claude-code");
        assert_eq!(id.as_str(), "claude-code");
        assert_eq!(id.to_string(), "claude-code");
    }
}
