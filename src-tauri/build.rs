fn main() {
    track_assets(std::path::Path::new("src/skills/assets/builtin"));
    embed_catalog_snapshot();
    tauri_build::build()
}

/// Stage the model-catalog snapshot for `include_bytes!` (ADR-0152): the
/// release flow's generator step (build.yml) writes
/// `snapshots/model-catalog.gz` (the gitignored staging dir); the build
/// script copies whatever sits there into `OUT_DIR` -- an absent file (dev
/// builds, the CI test job) stages an EMPTY placeholder so the embedded tier
/// is simply empty and every lookup falls to the prefix tables. The repo
/// never carries a hand-maintained data file; the watcher directive turns a
/// regenerated snapshot into a rebuild trigger.
fn embed_catalog_snapshot() {
    const SNAPSHOT_SRC: &str = "snapshots/model-catalog.gz";
    println!("cargo:rerun-if-changed={SNAPSHOT_SRC}");
    let bytes = std::fs::read(SNAPSHOT_SRC).unwrap_or_default();
    let out_dir =
        std::env::var_os("OUT_DIR").expect("cargo always provides OUT_DIR to build scripts");
    let staged = std::path::Path::new(&out_dir).join("model-catalog.gz");
    std::fs::write(&staged, bytes)
        .unwrap_or_else(|e| panic!("failed to stage the catalog snapshot: {e}"));
}

/// Recursively declare rerun-if-changed for the embedded builtin-skill asset
/// tree (ADR-0121 Decision 1). Cargo only watches paths named explicitly, and
/// a NEW file inside a watched directory does not change the directory's own
/// mtime on every platform -- so every file AND subdirectory gets its own
/// directive, keeping an edited or added asset a rebuild trigger (the codex
/// build-script pattern).
fn track_assets(dir: &std::path::Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            track_assets(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
