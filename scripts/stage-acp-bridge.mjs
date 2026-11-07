// Stages the ACP bridge binary under the target-triple file name Tauri's
// externalBin bundler expects (ADR-0132). Two callers, two profiles:
// beforeBuildCommand stages the release binary right after
// `cargo build -p acp-bridge --release`, so every `tauri build` bundles the
// sidecar the app resolves beside its own executable (same sibling rule as
// the dev target/debug layout). beforeDevCommand and the cargo quality-gate
// entrypoints stage with --debug, because tauri-build validates externalBin
// entries on EVERY cargo compile of src-tauri -- the file must merely
// exist there; content is only consumed at bundle time, where the release
// staging has already overwritten it. Assumes the default cargo target
// dir, like the sibling resolution it mirrors.
//
// The mac release face builds universal (ADR-0143): tauri-build validates
// externalBin against every compiled target slice, and the universal
// bundler consumes one lipo-merged sidecar named after the universal
// target -- so both darwin triples are built via --target, staged
// per-slice, and merged with lipo as the third staged file.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binName = "toptopduck-acp-bridge";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const profile = process.argv.includes("--debug") ? "debug" : "release";

const stage = (triple, sourceDir) => {
  const source = join(sourceDir, `${binName}${exeSuffix}`);
  const stagedDir = join(root, "src-tauri", "binaries");
  const staged = join(stagedDir, `${binName}-${triple}${exeSuffix}`);
  mkdirSync(stagedDir, { recursive: true });
  copyFileSync(source, staged);
  console.log(`staged ${staged}`);
};

if (process.platform === "darwin" && profile === "release") {
  const triples = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  for (const triple of triples) {
    execFileSync(
      "cargo",
      ["build", "-p", "acp-bridge", "--release", "--target", triple],
      { stdio: "inherit" },
    );
    // Per-slice copies: tauri-build validates externalBin against each
    // compiled target triple.
    stage(triple, join(root, "target", triple, "release"));
  }
  // The universal bundle consumes ONE lipo-merged sidecar named after the
  // universal target itself.
  const universalStaged = join(
    root, "src-tauri", "binaries", `${binName}-universal-apple-darwin`,
  );
  execFileSync("lipo", [
    "-create",
    ...triples.map((t) => join(root, "target", t, "release", binName)),
    "-output", universalStaged,
  ]);
  console.log(`staged ${universalStaged}`);
} else {
  const rustcOutput = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const triple = rustcOutput.match(/^host: (\S+)$/m)?.[1];
  if (!triple) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  stage(triple, join(root, "target", profile));
}
