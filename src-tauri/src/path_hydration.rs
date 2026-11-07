//! Startup PATH hydration for non-Windows desktop launches (issue #1467).
//!
//! A desktop-launched bundle (macOS via Finder/Dock, Linux via a session
//! .desktop entry) inherits the login session's trimmed PATH (typically
//! `/usr/bin:/bin:/usr/sbin:/sbin`), which carries no user-level install
//! locations. Externally installed runtimes -- npm globals living in a
//! version manager's per-version bin, a custom npm prefix, or a Homebrew
//! prefix -- are then invisible to every PATH-reading surface: adapter
//! detection, the builtin startup scan, and call-time bare-name resolution
//! alike, and a turn ends with `external runtime 'X' not found on PATH`.
//! Terminal launches inherit the shell PATH and Windows launches inherit
//! the registry user+system PATH, so neither is affected.
//!
//! The fix is static enumeration, never a login-shell subprocess: an
//! interactive shell is slow, non-deterministic, and still misses what it
//! does not source (version managers initialized in `.zshrc` need their
//! install roots enumerated regardless of what a login shell resolves).
//! [`hydrate_process_path`] merges the well-known user toolchain
//! directories into the process PATH once, at the top of `run()`, BEFORE
//! any detection or scan. Writing the process PATH (rather than widening
//! one search call site) keeps detection, scanning, and spawning
//! symmetric: a spawned runtime's shebang interpreter
//! (`#!/usr/bin/env node`) must resolve through the same PATH, or a
//! runtime that detected fine would still fail to launch.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The startup hook: merge the user-level toolchain directories into the
/// process PATH (issue #1467). Must run before the first detection, scan,
/// or spawn -- everything downstream reads the process PATH. A missing
/// `HOME` (a service context) or a missing `PATH` leaves the environment
/// untouched -- honest degradation, not a synthetic PATH.
pub(crate) fn hydrate_process_path() {
    // Windows keeps the registry user+system PATH wholesale on a desktop
    // launch -- nothing is trimmed, nothing to hydrate. `cfg!` (not a
    // `#[cfg]` arm split) so the whole body still compiles -- and clippy
    // covers it -- on Windows too.
    if cfg!(windows) {
        return;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let Some(existing) = std::env::var_os("PATH") else {
        return;
    };
    let npm_prefix = npm_config_prefix().map(PathBuf::from);
    let candidates = user_toolchain_dirs(Path::new(&home), npm_prefix.as_deref());
    let merged = merged_path(&existing, &candidates, |dir| dir.is_dir());
    std::env::set_var("PATH", merged);
}

/// The explicit npm prefix from the environment, either spelling
/// (`NPM_CONFIG_PREFIX` or the lowercase form npm also honors).
fn npm_config_prefix() -> Option<OsString> {
    resolve_npm_prefix(
        std::env::var_os("NPM_CONFIG_PREFIX"),
        std::env::var_os("npm_config_prefix"),
    )
}

/// First-set-wins across the two spellings, with an empty value reading
/// as unset (an empty prefix would join into the CWD-relative `bin`,
/// injecting an entry that drifts with the launch directory).
fn resolve_npm_prefix(upper: Option<OsString>, lower: Option<OsString>) -> Option<OsString> {
    upper.or(lower).filter(|value| !value.is_empty())
}

/// Assemble the ordered user-level toolchain directory candidates for a
/// home directory. Pure over its inputs apart from listing the
/// version-manager install roots under the passed `home`, so tests pin
/// the full order with a tempdir home. The order is priority order:
///
/// 1. the explicit npm prefix's `bin` (an env-set prefix outranks every
///    default location);
/// 2. the well-known single user-level bin directories;
/// 3. version-manager per-version bins, newest version first within each
///    manager (nvm, then fnm's roots, then mise's);
/// 4. the system prefixes, Homebrew's arm64 location ahead of the
///    intel-origin `/usr/local/bin`.
///
/// Candidates are NOT existence-filtered here: an absent directory simply
/// contributes nothing once [`merged_path`] applies its existence
/// predicate, and keeping `is_dir` out of the assembly keeps the list
/// deterministic across machines for tests.
fn user_toolchain_dirs(home: &Path, npm_config_prefix: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(prefix) = npm_config_prefix {
        dirs.push(prefix.join("bin"));
    }
    // The well-known single user-level bins. ~/.volta/bin and ~/.asdf/shims
    // are shim directories (they hold proxies to the real installs) and
    // still ride PATH like any bin. pnpm's standalone installer defaults
    // differ per OS (Library/pnpm on macOS, .local/share/pnpm on Linux), so
    // both spellings ride the table like fnm's cross-platform roots.
    for rel in [
        ".local/bin",
        ".cargo/bin",
        ".bun/bin",
        ".volta/bin",
        ".asdf/shims",
        "Library/pnpm",
        ".local/share/pnpm",
        ".npm-global/bin",
        ".npm-packages/bin",
    ] {
        dirs.push(home.join(rel));
    }
    // Version managers, newest version first within each root. fnm carries
    // three roots (legacy, XDG, and the macOS default), mise two (XDG and
    // legacy); a missing root contributes nothing, so each extra root
    // costs one failed read_dir.
    for (root, tail) in [
        (".nvm/versions/node", "bin"),
        (".fnm/node-versions", "installation/bin"),
        (".local/share/fnm/node-versions", "installation/bin"),
        (
            "Library/Application Support/fnm/node-versions",
            "installation/bin",
        ),
        (".local/share/mise/installs/node", "bin"),
        (".mise/installs/node", "bin"),
    ] {
        dirs.extend(version_bins(home, root, tail));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// The per-version bin directories under one version-manager install root
/// (`<root>/<version>/<tail>`), newest version first. A missing or
/// unreadable root contributes nothing.
fn version_bins(home: &Path, root: &str, tail: &str) -> Vec<PathBuf> {
    let root = home.join(root);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut versions: Vec<OsString> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name())
        .collect();
    versions.sort_by(|a, b| version_desc(a, b));
    versions
        .into_iter()
        .map(|version| root.join(version).join(tail))
        .collect()
}

/// Newest-first ordering of version-manager directory names (`v20.11.0`,
/// `20.9.1`, ...): the `v` prefix is stripped, segments compare
/// numerically, non-numeric segments fall back to string order below any
/// numeric one, and shorter prefixes order lower (`20` < `20.0.0`). The
/// comparison is version-aware on purpose -- lexicographic order would
/// rank `v1.10.0` below `v1.9.0` and pin the OLDEST runtime instead of
/// the newest. Pre-release names (`v22.6.0-rc.1`) sort below their own
/// stable but above older stables, with pre-release segments compared as
/// strings -- an approximation, not semver (it misorders multi-digit
/// pre-release numerics such as `1.0.0-2` vs `1.0.0-10`), kept at this
/// weight deliberately for a leaf module.
fn version_desc(a: &OsStr, b: &OsStr) -> std::cmp::Ordering {
    let segments = |name: &OsStr| {
        name.to_string_lossy()
            .trim_start_matches('v')
            .split('.')
            .map(|segment| (segment.parse::<u64>().ok(), segment.to_string()))
            .collect::<Vec<(Option<u64>, String)>>()
    };
    segments(b).cmp(&segments(a))
}

/// Merge candidate directories into an existing PATH value: existing
/// entries keep their order and priority, a candidate already present is
/// not duplicated (neither re-ordered nor repeated), candidates duplicate
/// within themselves only once, and `exists` filters them -- an absent
/// directory contributes nothing (a PATH entry pointing nowhere is
/// harmless, but it is noise).
fn merged_path(
    existing: &OsStr,
    candidates: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> OsString {
    let mut entries: Vec<PathBuf> = std::env::split_paths(existing).collect();
    for candidate in candidates {
        if exists(candidate) && !entries.contains(candidate) {
            entries.push(candidate.clone());
        }
    }
    // A candidate whose name carries the list separator (legal on Unix,
    // reachable through a crafted NPM_CONFIG_PREFIX) cannot join back into
    // one PATH value: leave PATH untouched rather than panic at startup --
    // hydration is best-effort by contract.
    std::env::join_paths(entries).unwrap_or_else(|_| existing.to_os_string())
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture home carrying the named version directories under one
    /// manager root, each with its bin directory materialized.
    fn home_with_versions(root: &str, tail: &str, versions: &[&str]) -> tempfile::TempDir {
        let home = tempfile::tempdir().expect("tempdir");
        for version in versions {
            std::fs::create_dir_all(home.path().join(root).join(version).join(tail))
                .expect("mkdir version bin");
        }
        home
    }

    #[test]
    fn explicit_npm_prefix_outranks_every_default_location() {
        let home = tempfile::tempdir().expect("tempdir");
        let dirs = user_toolchain_dirs(home.path(), Some(Path::new("/custom/npm-prefix")));
        assert_eq!(
            dirs.first(),
            Some(&PathBuf::from("/custom/npm-prefix/bin")),
            "the env-set npm prefix bin leads the list"
        );
        assert_eq!(
            dirs.len(),
            1 + 9 + 2,
            "the prefix ride does not drop the defaults: 9 well-known + 2 system"
        );
    }

    #[test]
    fn npm_prefix_resolves_both_spellings_and_filters_empty() {
        // The env-reader's two behaviors, pinned on the pure core: the
        // lowercase spelling is a fallback, and an empty value reads as
        // unset (it would join into the CWD-relative `bin`).
        assert_eq!(resolve_npm_prefix(None, None), None);
        assert_eq!(
            resolve_npm_prefix(Some(OsString::from("/upper/prefix")), None),
            Some(OsString::from("/upper/prefix"))
        );
        assert_eq!(
            resolve_npm_prefix(None, Some(OsString::from("/lower/prefix"))),
            Some(OsString::from("/lower/prefix"))
        );
        assert_eq!(
            resolve_npm_prefix(Some(OsString::new()), None),
            None,
            "an empty set value reads as unset"
        );
    }

    #[test]
    fn well_known_user_dirs_ride_in_home_order_before_managers_and_system() {
        let home = tempfile::tempdir().expect("tempdir");
        let dirs = user_toolchain_dirs(home.path(), None);
        let expected: Vec<PathBuf> = [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".volta/bin",
            ".asdf/shims",
            "Library/pnpm",
            ".local/share/pnpm",
            ".npm-global/bin",
            ".npm-packages/bin",
        ]
        .iter()
        .map(|rel| home.path().join(rel))
        .collect();
        let actual: Vec<PathBuf> = dirs.iter().take(expected.len()).cloned().collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn well_known_bins_outrank_version_manager_bins() {
        // The block-level priority the doc ranks: the well-known user
        // bins ride ahead of any version-manager per-version bin. A home
        // carrying both makes the blocks observable together, so a swap
        // of the two blocks cannot pass green.
        let home = home_with_versions(".nvm/versions/node", "bin", &["v20.0.0"]);
        std::fs::create_dir_all(home.path().join(".local/bin")).expect("mkdir well-known");
        let dirs = user_toolchain_dirs(home.path(), None);
        let well_known = dirs
            .iter()
            .position(|d| d == &home.path().join(".local/bin"))
            .expect("well-known bin present");
        let nvm = dirs
            .iter()
            .position(|d| d == &home.path().join(".nvm/versions/node/v20.0.0/bin"))
            .expect("nvm bin present");
        assert!(
            well_known < nvm,
            "the well-known bins must precede the version-manager bins"
        );
    }

    #[test]
    fn version_manager_bins_sort_newest_first_within_a_root() {
        // nvm spelling (`v`-prefixed): newest first, and the ordering must
        // come from the version, not the directory listing order.
        let home = home_with_versions(
            ".nvm/versions/node",
            "bin",
            &["v18.0.0", "v20.9.0", "v20.11.0"],
        );
        let dirs = user_toolchain_dirs(home.path(), None);
        let nvm: Vec<PathBuf> = dirs
            .iter()
            .filter(|d| d.starts_with(home.path().join(".nvm")))
            .cloned()
            .collect();
        assert_eq!(
            nvm,
            vec![
                home.path().join(".nvm/versions/node/v20.11.0/bin"),
                home.path().join(".nvm/versions/node/v20.9.0/bin"),
                home.path().join(".nvm/versions/node/v18.0.0/bin"),
            ]
        );
    }

    #[test]
    fn version_ordering_beats_lexicographic_on_double_digit_segments() {
        // The load-bearing anti-lexicographic pin: 1.10.0 > 1.9.0. Run
        // through the same read_dir path as production (version_bins via
        // user_toolchain_dirs) so the ordering under test is the shipped
        // one.
        let home = home_with_versions(".mise/installs/node", "bin", &["1.9.0", "1.10.0"]);
        let dirs = user_toolchain_dirs(home.path(), None);
        let mise: Vec<PathBuf> = dirs
            .iter()
            .filter(|d| d.starts_with(home.path().join(".mise")))
            .cloned()
            .collect();
        assert_eq!(
            mise.first(),
            Some(&home.path().join(".mise/installs/node/1.10.0/bin")),
            "1.10.0 must outrank 1.9.0"
        );
    }

    #[test]
    fn pre_release_names_sort_below_their_stable_but_above_older_stables() {
        // Ordering::Less means the first argument ranks first (newest).
        let older_stable = OsStr::new("v22.5.0");
        let stable = OsStr::new("v22.6.0");
        let pre_release = OsStr::new("v22.6.0-rc.1");
        assert_eq!(
            version_desc(pre_release, older_stable),
            std::cmp::Ordering::Less,
            "the pre-release outranks the older stable"
        );
        assert_eq!(
            version_desc(pre_release, stable),
            std::cmp::Ordering::Greater,
            "the stable outranks its own pre-release"
        );
    }

    #[test]
    fn fnm_and_mise_roots_contribute_theirs_with_the_manager_tail() {
        // The managers' inner layout differs: fnm nests an
        // `installation/bin`, mise a bare `bin`. One representative each.
        let home = home_with_versions(".fnm/node-versions", "installation/bin", &["20.0.0"]);
        std::fs::create_dir_all(
            home.path()
                .join(".local/share/mise/installs/node/22.0.0/bin"),
        )
        .expect("mkdir mise");
        let dirs = user_toolchain_dirs(home.path(), None);
        assert!(dirs.contains(
            &home
                .path()
                .join(".fnm/node-versions/20.0.0/installation/bin")
        ));
        assert!(
            dirs.contains(
                &home
                    .path()
                    .join(".local/share/mise/installs/node/22.0.0/bin")
            ),
            "the XDG-style mise root contributes too"
        );
    }

    #[test]
    fn missing_roots_contribute_nothing() {
        // An empty home: no version-manager entries at all -- only the
        // well-known joins plus the two system prefixes.
        let home = tempfile::tempdir().expect("tempdir");
        let dirs = user_toolchain_dirs(home.path(), None);
        assert_eq!(dirs.len(), 9 + 2, "9 well-known dirs + 2 system prefixes");
        assert!(
            !dirs.iter().any(|d| d
                .components()
                .any(|c| c == std::path::Component::Normal("versions".as_ref()))),
            "no version-manager entry appears"
        );
    }

    #[test]
    fn system_prefixes_close_the_list() {
        let home = tempfile::tempdir().expect("tempdir");
        let dirs = user_toolchain_dirs(home.path(), None);
        assert_eq!(
            dirs.last(),
            Some(&PathBuf::from("/usr/local/bin")),
            "/usr/local/bin closes the list"
        );
        assert_eq!(
            dirs[dirs.len() - 2],
            PathBuf::from("/opt/homebrew/bin"),
            "/opt/homebrew/bin sits right before it"
        );
    }

    #[cfg(windows)]
    #[test]
    fn hydrate_leaves_the_windows_process_path_untouched() {
        // CI gate note: the CI test step is Linux-only, so this Windows-only
        // pin executes in local `cargo test` runs, not CI.
        let before = std::env::var_os("PATH");
        hydrate_process_path();
        assert_eq!(std::env::var_os("PATH"), before);
    }

    #[cfg(not(windows))]
    #[test]
    fn merged_path_degrades_to_the_existing_value_on_an_unjoinable_candidate() {
        // A candidate carrying the list separator (a crafted
        // NPM_CONFIG_PREFIX) cannot join into one PATH: the existing value
        // survives verbatim instead of a startup panic.
        let existing = std::env::join_paths(["/usr/bin"]).expect("join existing");
        let candidates = vec![PathBuf::from("/new:dir")];
        let merged = merged_path(&existing, &candidates, |_| true);
        assert_eq!(merged, existing);
    }

    #[test]
    fn merged_path_keeps_existing_order_and_dedups() {
        // The AC pin: existing entries keep their order and priority; a
        // candidate already present is not duplicated; an absent candidate
        // (exists -> false) contributes nothing; in-list duplicates enter
        // once.
        let existing =
            std::env::join_paths(["/usr/bin", "/bin", "/shared/bin"]).expect("join existing");
        let candidates = vec![
            PathBuf::from("/shared/bin"), // already present: no dup, no reorder
            PathBuf::from("/absent/dir"), // exists -> false: dropped
            PathBuf::from("/nvm/newest/bin"),
            PathBuf::from("/nvm/newest/bin"), // in-list duplicate: once
        ];
        let merged = merged_path(&existing, &candidates, |dir| {
            dir != Path::new("/absent/dir")
        });
        let parts: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            parts,
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/shared/bin"),
                PathBuf::from("/nvm/newest/bin"),
            ]
        );
    }
}
