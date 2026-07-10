import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed dev port; the config comes from vitest/config so the
// `test` field is typed. Tests import { describe, it, expect } from "vitest"
// explicitly (globals disabled) to keep the production tsc build free of test types.
// Tailwind v4 ships a first-party Vite plugin (ADR-0049): CSS-first config in
// src/app.css, no tailwind.config.js, no PostCSS pipeline.
// The `@/*` alias mirrors tsconfig paths so shadcn copy-in imports
// (`@/lib/utils`) resolve under both tsc and Vite/vitest.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
