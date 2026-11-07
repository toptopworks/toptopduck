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
// The mac release face builds universal (ADR-0143): the bundler resolves
// externalBin per target slice, so BOTH darwin triples must be compiled
// and staged, explicitly via --target (independent of the host arch).
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
  for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    execFileSync(
      "cargo",
      ["build", "-p", "acp-bridge", "--release", "--target", triple],
      { stdio: "inherit" },
    );
    stage(triple, join(root, "target", triple, "release"));
  }
} else {
  const rustcOutput = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const triple = rustcOutput.match(/^host: (\S+)$/m)?.[1];
  if (!triple) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  stage(triple, join(root, "target", profile));
}
