//! The release-flow model-catalog snapshot generator (ADR-0152): fetches
//! `https://models.dev/api.json`, trims it to the compact schema, gzips
//! it, and writes the staged file the build script embeds
//! (`snapshots/model-catalog.gz` -- the staging dir is gitignored, never
//! committed). Invoked by the Build workflow's generator step
//! before `tauri build`; a failure fails the release build loudly (this
//! is the one place catalog fetching is NOT silent). Rides the library's
//! own fetch->trim->encode pipeline so the snapshot and the runtime
//! refresh trim identically.
//!
//! Usage: `model-catalog-snapshot <output-path>`

use std::path::Path;

fn main() {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| usage("missing <output-path> argument"));
    if toptopduck_lib::provider::model_catalog::refresh_into(
        toptopduck_lib::provider::model_catalog::UPSTREAM_URL,
        Path::new(&out),
    ) {
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        println!("model catalog snapshot written: {out} ({size} bytes gzipped)");
    } else {
        eprintln!("model catalog snapshot generation failed (fetch/parse/write)");
        std::process::exit(1);
    }
}

fn usage(problem: &str) -> ! {
    eprintln!("{problem}; usage: model-catalog-snapshot <output-path>");
    std::process::exit(2);
}
