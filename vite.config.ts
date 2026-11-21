import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed dev port; the config comes from vitest/config so the
// `test` field is typed. Tests import { describe, it, expect } from "vitest"
// explicitly (globals disabled) so the test API can't slip into non-test code
// via implicit globals.
// Tailwind v4 ships a first-party Vite plugin (ADR-0049): CSS-first config in
// src/app.css, no tailwind.config.js, no PostCSS pipeline.
// The `@/*` alias mirrors tsconfig paths for future shadcn copy-in imports
// (`@/lib/utils`); no consumers yet.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // vega-embed is only imported from the lazy chart chunk (LazyVegaChart),
  // so without this pin the optimizer discovers it mid-session on the first
  // chart render and re-runs pre-bundling -- stale-batch dep URLs then 504
  // ("Outdated Optimize Dep"), the dynamic import chain rejects, and every
  // chart on the page degrades. Pinning it into the initial batch removes
  // the mid-session re-optimize entirely.
  optimizeDeps: { include: ["vega-embed"] },
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    // Local dev only: worker_threads outrun process forks for this
    // jsdom-only suite on Windows, and 8 workers sit safely below the
    // contention zone where runs fake-red with timeouts (forks had to be
    // capped at 2 locally for the same reason). CI keeps its runner
    // defaults (4-core ubuntu).
    pool: process.env.CI ? undefined : "threads",
    maxWorkers: process.env.CI ? undefined : 8,
    // Interactive tests ride real timers; under machine load their waits
    // can spill past the 5s default and fake-red (all observed failures in
    // the concurrency experiments were 5s timeouts). 10s is a cap, not a
    // wait -- green runs are unaffected.
    testTimeout: 10_000,
  },
});
