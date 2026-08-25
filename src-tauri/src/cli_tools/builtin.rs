//! Builtin CLI registration entries (issue #675, ADR-0109 Decisions 1/3/4).
//!
//! The shipped definition set is a compile-time constant: three curated
//! entries ride the app version and the definition body is NEVER persisted
//! (a version asset, not user state). Detection is PATH existence
//! resolution only -- resolving a candidate name never spawns the
//! executable (a spawn could trigger the tool's own side effects, e.g. an
//! update check), and the scan covers exactly the shipped set, never the
//! whole PATH. A hit auto-registers silently with `source = Builtin`,
//! `baseline = Following`, enabled; a miss leaves the definition dormant
//! (NO config entry -- the settings page renders dormancy from this set
//! plus the scan snapshot, not from the registry). The authoritative
//! fallback stays call-time resolution (ADR-0108 probe semantics): a tool
//! uninstalled mid-run surfaces as a structured tool error, the entry
//! stays, and it re-arms on reinstall without a rescan.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use serde::Serialize;

use crate::app_config::AppConfig;
use crate::cli_tools::config::{
    CliBaselineState, CliParamDelivery, CliToolConfig, CliToolParam, CliToolRegistry, CliToolSource,
};

// ---------------------------------------------------------------------------
// The shipped definition set (ADR-0109 Decision 4: three entries, curated)

/// One parameter of a shipped definition (the static mirror of
/// [`CliToolParam`]; the strings become owned values in [`BuiltinCliDefinition::to_config`]).
struct BuiltinCliParam {
    name: &'static str,
    description: &'static str,
    delivery: CliParamDelivery,
    varargs: bool,
}

/// One shipped builtin CLI registration definition. Everything except
/// `executables` is the registration body; `executables` is the candidate
/// list the detector resolves in order (cross-platform name differences
/// live here, e.g. `python` / `python3`).
pub(crate) struct BuiltinCliDefinition {
    pub name: &'static str,
    pub description: &'static str,
    executables: &'static [&'static str],
    argv_template: &'static [&'static str],
    params: &'static [BuiltinCliParam],
}

impl BuiltinCliDefinition {
    /// Materialize the registration entry for a resolved executable
    /// (issue #675: the hit candidate is written into `executable`, so the
    /// registered copy records what this machine actually resolves).
    /// `source = Builtin`, `baseline = Following` (ADR-0109 Decisions 1/2),
    /// enabled by default (ADR-0106 fourth write-entry class).
    fn to_config(&self, executable: &str) -> CliToolConfig {
        CliToolConfig {
            name: self.name.to_string(),
            description: self.description.to_string(),
            executable: executable.to_string(),
            argv_template: self.argv_template.iter().map(|s| s.to_string()).collect(),
            params: self
                .params
                .iter()
                .map(|p| CliToolParam {
                    name: p.name.to_string(),
                    description: p.description.to_string(),
                    delivery: p.delivery,
                    varargs: p.varargs,
                })
                .collect(),
            env: Default::default(),
            enabled: true,
            source: CliToolSource::Builtin,
            baseline: Some(CliBaselineState::Following),
        }
    }
}

/// The v1 curated set (ADR-0109 Decision 4, narrowed 2026-08-25 to three):
/// pandoc (universal document conversion), the Python interpreter (data
/// cleaning; script text rides the `file` channel, no runtime is bundled),
/// and OfficeCLI (agent-oriented Office document processing; registered as
/// a whole-binary varargs wrapper -- one entry covers every subcommand).
/// Additive evolution: new entries pass the same curation screen, not a
/// reopen of the ADR.
pub(crate) static BUILTIN_DEFINITIONS: &[BuiltinCliDefinition] = &[
    BuiltinCliDefinition {
        name: "pandoc",
        description: "Convert documents between formats (Markdown, HTML, \
                      DOCX, PPTX, EPUB, LaTeX, PDF, ...): reads the source \
                      document and writes the converted one.",
        executables: &["pandoc"],
        argv_template: &["{input}", "-o", "{output}"],
        params: &[
            BuiltinCliParam {
                name: "input",
                description: "Path to the source document.",
                delivery: CliParamDelivery::Argv,
                varargs: false,
            },
            BuiltinCliParam {
                name: "output",
                description: "Path to write the converted document to.",
                delivery: CliParamDelivery::Argv,
                varargs: false,
            },
        ],
    },
    BuiltinCliDefinition {
        name: "python",
        description: "Run a Python script for data cleaning and \
                      transformation. The script text arrives as a temp \
                      file path argument and runs against the interpreter \
                      installed on this machine (no library ecosystem is \
                      bundled; libraries are the machine's own).",
        executables: &["python", "python3"],
        argv_template: &["{script}"],
        params: &[BuiltinCliParam {
            name: "script",
            description: "The Python script source to run.",
            delivery: CliParamDelivery::File,
            varargs: false,
        }],
    },
    BuiltinCliDefinition {
        name: "office-cli",
        description: "OfficeCLI: process and generate Office documents \
                      (agent-oriented single binary). Pass its subcommand \
                      and arguments.",
        executables: &["office-cli", "OfficeCLI", "officecli"],
        argv_template: &[],
        params: &[BuiltinCliParam {
            name: "args",
            description: "The OfficeCLI subcommand and its arguments.",
            delivery: CliParamDelivery::Argv,
            varargs: true,
        }],
    },
];

/// The reserved-name class every user registration must dodge (ADR-0109
/// Decision 7): static full-set membership, independent of what this
/// machine happens to have installed.
pub(crate) fn is_builtin_name(name: &str) -> bool {
    BUILTIN_DEFINITIONS.iter().any(|d| d.name == name)
}

// ---------------------------------------------------------------------------
// Detection (PATH existence resolution, never a spawn)

/// Resolve one executable name against an explicit PATH value. Pure over
/// its argument so tests pin the resolution rules without touching the
/// process environment. On Windows a name with no extension is matched
/// against the standard executable suffixes (`.exe` first; `.bat` / `.cmd`
/// cover npm shims); POSIX needs no suffix. `is_file` guards against PATH
/// entries pointing at a non-file, and on Windows the zero-length
/// app-execution-alias stub shape is skipped (see [`is_empty_stub`]);
/// executability is enforced by the spawn itself at call time, not by this
/// scan.
pub(crate) fn which_in(name: &str, path_env: &OsStr) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) && PathBuf::from(name).extension().is_none() {
        [".exe", ".bat", ".cmd"]
            .iter()
            .map(|ext| format!("{name}{ext}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(path_env) {
        for candidate in &candidates {
            let resolved = dir.join(candidate);
            if resolved.is_file() && !is_empty_stub(&resolved) {
                return Some(resolved);
            }
        }
    }
    None
}

/// Reject the Windows app-execution-alias stub shape: stock Windows 11
/// ships `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` (and `python3`)
/// as a ZERO-LENGTH reparse file that `is_file()` reports as true even with
/// no interpreter installed. Counting it as a hit would auto-register
/// `python` on machines where every call lands on the Store redirector
/// (and where `WindowsApps` precedes a user-Path install, the stub shadows
/// the real interpreter). The stub is always empty; a real executable
/// never is. Unreadable metadata counts as a miss (conservative).
#[cfg(windows)]
fn is_empty_stub(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() == 0)
        .unwrap_or(true)
}

/// POSIX has no such alias class; every regular file counts.
#[cfg(not(windows))]
fn is_empty_stub(_path: &std::path::Path) -> bool {
    false
}

/// Resolve against the process PATH (the production wrapper over
/// [`which_in`]; the adapter scan shares the same core).
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    which_in(name, &std::env::var_os("PATH")?)
}

// ---------------------------------------------------------------------------
// Scan snapshot + registration plan

/// One shipped definition's detection outcome. A computed snapshot, never
/// persisted (ADR-0109 Decision 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinDetectionState {
    /// A candidate resolved on PATH (newly registered now, or already in
    /// the registry).
    Detected,
    /// No candidate resolved; the definition stays out of the registry
    /// (dormant -- no config entry, no tool-surface slot).
    Dormant,
    /// A user registration already owns the name: the builtin entry
    /// defers (no registration, no mutation of the user entry); once the
    /// user renames or removes theirs, the next scan registers.
    Conflict,
}

/// One row of the scan snapshot returned by the rescan IPC (and rendered
/// by the settings page).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuiltinScanEntry {
    pub name: String,
    pub description: String,
    pub state: BuiltinDetectionState,
    /// The resolved candidate (the bare name, not the full path -- it is
    /// what gets written into the registration). Present only when
    /// detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
}

/// The rescan command's return: the updated full config (ADR-0109
/// Decision 9 frontend-sync contract) plus the detection snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BuiltinScanResult {
    pub config: AppConfig,
    pub scan: Vec<BuiltinScanEntry>,
}

/// Classify every shipped definition against the registry and plan the
/// auto-registrations (ADR-0109 Decisions 1/3/4). Registration happens
/// ONLY for a definition whose name has no registry entry at all AND whose
/// candidates resolve: an existing entry is never touched, whatever its
/// source -- a user entry owning the name is the Conflict deference, and
/// an already-registered builtin entry (possibly disabled or edited by the
/// user) keeps its state instead of being re-armed on every scan.
pub(crate) fn scan(
    defs: &'static [BuiltinCliDefinition],
    registry: &CliToolRegistry,
    resolve: impl Fn(&str) -> Option<PathBuf>,
) -> (Vec<BuiltinScanEntry>, Vec<CliToolConfig>) {
    let mut entries = Vec::with_capacity(defs.len());
    let mut to_register = Vec::new();
    for def in defs {
        let resolved = def
            .executables
            .iter()
            .find_map(|name| resolve(name).map(|_| *name));
        let state = if registry.get(def.name).map(|t| t.source) == Some(CliToolSource::User) {
            BuiltinDetectionState::Conflict
        } else {
            match resolved {
                Some(_) => BuiltinDetectionState::Detected,
                None => BuiltinDetectionState::Dormant,
            }
        };
        if registry.get(def.name).is_none() {
            if let Some(exe) = resolved {
                to_register.push(def.to_config(exe));
            }
        }
        entries.push(BuiltinScanEntry {
            name: def.name.to_string(),
            description: def.description.to_string(),
            state,
            executable: match state {
                BuiltinDetectionState::Detected => resolved.map(str::to_string),
                _ => None,
            },
        });
    }
    (entries, to_register)
}

// ---------------------------------------------------------------------------
// Startup window (ADR-0109 Decision 9)

/// The startup-window scan: detect + auto-register in one read-modify-write
/// BEFORE the frontend loads its first config snapshot (the structural
/// timing guarantee -- `setup` completes before any webview IPC). `path_env`
/// mirrors [`crate::provider::live_config::LiveProviderConfig::scan_and_register`]:
/// `None` reads the process environment, `Some` is the tests' controlled
/// PATH. Failures are the caller's to log-and-degrade; the settings-page
/// rescan retries.
pub fn startup_register(
    live: &crate::provider::live_config::LiveProviderConfig,
    path_env: Option<OsString>,
) -> Result<(), crate::provider::live_config::CliToolWriteError> {
    let result = live.scan_and_register(path_env)?;
    for entry in &result.scan {
        if entry.state == BuiltinDetectionState::Conflict {
            log::warn!(
                "builtin CLI entry `{}` deferred: a user registration owns the \
                 name; it registers once the user renames or removes it",
                entry.name
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_tools::config::CliToolRegistry;

    /// A registry builder for the plan scenarios.
    fn registry_with(tools: Vec<CliToolConfig>) -> CliToolRegistry {
        CliToolRegistry { tools }
    }

    /// The pandoc definition (the single-candidate representative).
    fn pandoc() -> &'static BuiltinCliDefinition {
        &BUILTIN_DEFINITIONS[0]
    }

    /// A PATH value naming existing temp dirs the tests create, so the
    /// pure `which_in` runs against real files without touching the
    /// process environment.
    fn path_env_of(dir: &std::path::Path) -> std::ffi::OsString {
        std::env::join_paths([dir]).expect("join_paths")
    }

    // --- which_in ----------------------------------------------------------

    #[test]
    fn which_in_resolves_a_file_in_the_passed_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) {
            "present.exe"
        } else {
            "present"
        };
        std::fs::write(dir.path().join(name), b"bin").expect("write");
        let found = which_in("present", path_env_of(dir.path()).as_os_str());
        assert_eq!(found, Some(dir.path().join(name)));
    }

    #[test]
    fn which_in_returns_none_for_an_absent_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            which_in("absent", path_env_of(dir.path()).as_os_str()),
            None
        );
    }

    #[test]
    fn which_in_skips_a_directory_masquerading_as_a_candidate() {
        // is_file guards: a DIRECTORY named exactly like the candidate must
        // not count as a hit (a stale PATH entry pointing at a dir).
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) { "decoy.exe" } else { "decoy" };
        std::fs::create_dir(dir.path().join(name)).expect("mkdir");
        assert_eq!(which_in("decoy", path_env_of(dir.path()).as_os_str()), None);
    }

    #[cfg(windows)]
    #[test]
    fn which_in_matches_the_windows_suffixes_for_a_bare_name() {
        // A bare name resolves through the .exe/.bat/.cmd suffix list on
        // Windows (`.exe` first).
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("tool.bat"), b"@echo off").expect("write bat");
        assert_eq!(
            which_in("tool", path_env_of(dir.path()).as_os_str()),
            Some(dir.path().join("tool.bat"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn which_in_skips_the_windows_app_execution_alias_stub() {
        // The Store alias shape: a zero-length reparse file that `is_file()`
        // reports as true (stock Win11 ships python.exe this way with no
        // interpreter installed). It must not count as a hit, and the scan
        // keeps looking: the real `.bat` in the same directory resolves.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("tool.exe"), b"").expect("write stub");
        std::fs::write(dir.path().join("tool.bat"), b"@echo off").expect("write bat");
        assert_eq!(
            which_in("tool", path_env_of(dir.path()).as_os_str()),
            Some(dir.path().join("tool.bat"))
        );
        // A stub alone means dormant, not detected.
        let stub_only = tempfile::tempdir().expect("tempdir");
        std::fs::write(stub_only.path().join("tool.exe"), b"").expect("write stub");
        assert_eq!(
            which_in("tool", path_env_of(stub_only.path()).as_os_str()),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn which_in_matches_the_bare_name_on_posix() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("tool"), b"bin").expect("write");
        assert_eq!(
            which_in("tool", path_env_of(dir.path()).as_os_str()),
            Some(dir.path().join("tool"))
        );
    }

    // --- to_config ---------------------------------------------------------

    #[test]
    fn every_shipped_definition_materializes_into_a_valid_registration() {
        // The compile-time set must clear every registration invariant:
        // reserved-name conditioning lets source=Builtin carry a builtin
        // name, and the template/param-table shapes must be consistent.
        for def in BUILTIN_DEFINITIONS {
            let cfg = def.to_config("resolved-exe");
            assert_eq!(cfg.name, def.name);
            assert_eq!(cfg.executable, "resolved-exe");
            assert_eq!(cfg.source, CliToolSource::Builtin);
            assert_eq!(cfg.baseline, Some(CliBaselineState::Following));
            assert!(cfg.enabled, "auto-registration is enabled by default");
            assert!(cfg.validate().is_ok(), "{} must validate", def.name);
        }
    }

    // --- scan / registration plan ------------------------------------------

    /// A resolver under the tests' full control: some names resolve, the
    /// rest never do.
    fn resolver_for(
        present: &'static [&'static str],
    ) -> impl Fn(&str) -> Option<PathBuf> + 'static {
        move |name| {
            present
                .contains(&name)
                .then(|| PathBuf::from("/resolved").join(name))
        }
    }

    #[test]
    fn scan_registers_a_detected_definition_with_no_existing_entry() {
        let registry = registry_with(vec![]);
        let (entries, to_register) =
            scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&["pandoc"]));
        let pandoc_entry = entries.iter().find(|e| e.name == "pandoc").expect("row");
        assert_eq!(pandoc_entry.state, BuiltinDetectionState::Detected);
        assert_eq!(pandoc_entry.executable.as_deref(), Some("pandoc"));
        assert_eq!(to_register.len(), 1);
        assert_eq!(to_register[0].name, "pandoc");
        assert_eq!(to_register[0].source, CliToolSource::Builtin);
    }

    #[test]
    fn scan_marks_a_missing_definition_dormant_with_no_registration() {
        // Dormant = NOT registered: the plan produces no entry for it, and
        // the snapshot state says dormant (the settings page renders
        // dormancy from the definition set + snapshot, not the registry).
        let registry = registry_with(vec![]);
        let (entries, to_register) = scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&[]));
        assert!(to_register.is_empty());
        assert!(entries
            .iter()
            .all(|e| e.state == BuiltinDetectionState::Dormant));
    }

    #[test]
    fn scan_defers_when_a_user_registration_owns_the_name() {
        // The builtin entry retreats: no registration, the user entry is
        // untouched, the snapshot reports the conflict for the settings
        // page -- even though the executable resolves.
        let user_pandoc = crate::cli_tools::config::CliToolConfig {
            source: CliToolSource::User,
            ..pandoc().to_config("users-own-pandoc")
        };
        let registry = registry_with(vec![user_pandoc]);
        let (entries, to_register) =
            scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&["pandoc"]));
        assert!(to_register.is_empty());
        let pandoc_entry = entries.iter().find(|e| e.name == "pandoc").expect("row");
        assert_eq!(pandoc_entry.state, BuiltinDetectionState::Conflict);
        assert!(pandoc_entry.executable.is_none());
    }

    #[test]
    fn scan_never_touches_an_existing_builtin_entry_even_disabled() {
        // An already-registered builtin entry keeps its state on every
        // scan: a user-disabled builtin entry must not be re-armed, and an
        // edited one must not be overwritten (the pre-#676 stand-in for
        // baseline tracking).
        let mut disabled_builtin = pandoc().to_config("pandoc");
        disabled_builtin.enabled = false;
        let registry = registry_with(vec![disabled_builtin]);
        let (entries, to_register) =
            scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&["pandoc"]));
        assert!(to_register.is_empty(), "no re-registration");
        let pandoc_entry = entries.iter().find(|e| e.name == "pandoc").expect("row");
        assert_eq!(pandoc_entry.state, BuiltinDetectionState::Detected);
    }

    #[test]
    fn scan_reports_dormant_for_an_uninstalled_already_registered_builtin() {
        // Honest detection: the registry copy stays (dangling entries are
        // kept, ADR-0108 probe semantics) but the snapshot says dormant.
        let registered = pandoc().to_config("pandoc");
        let registry = registry_with(vec![registered]);
        let (entries, to_register) = scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&[]));
        assert!(to_register.is_empty());
        let pandoc_entry = entries.iter().find(|e| e.name == "pandoc").expect("row");
        assert_eq!(pandoc_entry.state, BuiltinDetectionState::Dormant);
    }

    #[test]
    fn scan_resolves_candidates_in_priority_order() {
        // `python` before `python3`: the first hit wins and its NAME (not
        // the full path) is what lands in the registration.
        let registry = registry_with(vec![]);
        let (entries, to_register) =
            scan(BUILTIN_DEFINITIONS, &registry, resolver_for(&["python3"]));
        let python_entry = entries.iter().find(|e| e.name == "python").expect("row");
        assert_eq!(python_entry.state, BuiltinDetectionState::Detected);
        assert_eq!(python_entry.executable.as_deref(), Some("python3"));
        assert_eq!(to_register[0].executable, "python3");
    }

    #[test]
    fn is_builtin_name_covers_the_shipped_set() {
        assert!(is_builtin_name("pandoc"));
        assert!(is_builtin_name("python"));
        assert!(is_builtin_name("office-cli"));
        assert!(!is_builtin_name("my-own-tool"));
    }
}
