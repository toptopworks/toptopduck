import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port; the config comes from vitest/config so the
// `test` field is typed. Tests import { describe, it, expect } from "vitest"
// explicitly (globals disabled) to keep the production tsc build free of test types.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
