fn main() {
    track_assets(std::path::Path::new("src/skills/assets/builtin"));
    tauri_build::build()
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
