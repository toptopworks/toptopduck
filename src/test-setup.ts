import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Clear the rendered DOM between tests so queries never see stale components
// from a prior test (e.g. two tests rendering a dialog with the same button).
afterEach(() => {
  cleanup();
});
