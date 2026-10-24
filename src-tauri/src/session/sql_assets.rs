//! The per-session `assets/` directory (ADR-0089): a legacy read-gate
//! surface. The settle-time materialization face -- dead-file copies of
//! temp-dir `read_*` references plus the SQL rewrite onto them -- is
//! retired by ADR-0137 Decision 6 (issue #1383): the lazily minted
//! workspace leaves the session temp dir permanently without working
//! files, and every `read_*` reference now persists through the copy-in
//! snapshot pipeline (ADR-0137 Decision 4, issue #1382), so the face's
//! domain is empty. What remains is the directory naming + derivation
//! consumed by the read gate (a legacy recipe's replay) and the bind-time
//! derived-source migration.

use std::path::{Path, PathBuf};

/// The per-session directory's `assets/` subdirectory name (ADR-0089: the
/// per-session tree holds `recipe.json` + `assets/`).
pub(super) const ASSETS_DIR_NAME: &str = "assets";

/// The session's `assets/` dir derived from the bound `recipe.json` path. `None`
/// when unbound (nothing to gate for -- there is no resume) or the duck
/// path has no parent directory.
pub(super) fn assets_dir(recipe_path: Option<&Path>) -> Option<PathBuf> {
    recipe_path
        .and_then(Path::parent)
        .map(|dir| dir.join(ASSETS_DIR_NAME))
}
