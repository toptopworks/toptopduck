import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatasetDescriptor } from "../types";

// FileDropzone touches Tauri APIs that don't exist under jsdom; stub them first.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

// Mutable working set the api mock reflects after a guided load (the dialog
// flow's end state). vi.hoisted keeps it alive across the hoisted vi.mock.
const state = vi.hoisted(() => ({ workingSet: [] as DatasetDescriptor[] }));
vi.mock("../api", () => ({
  ingestFile: vi.fn(),
  ingestFileGuided: vi.fn(),
  listWorkingSet: vi.fn(),
  activeDataset: vi.fn(async () => null),
}));

import { open } from "@tauri-apps/plugin-dialog";
import App from "../App";
import { ingestFile, ingestFileGuided, listWorkingSet } from "../api";

const guidedDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/m.xlsx",
  row_count: 1,
  fingerprint: "ff".repeat(32),
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [["1", "Alice"]],
  rectify: { kind: "User", data: { header_row: 2, skip_rows: [] } },
};

describe("App guided-load flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(open).mockResolvedValue("/x/m.xlsx");
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "NeedsGuidance",
      data: {
        source_path: "/x/m.xlsx",
        workbook_name: "m",
        sheets: [
          {
            name: "people",
            preview: [
              ["meta", "info"],
              ["id", "name"],
              ["1", "Alice"],
            ],
          },
        ],
      },
      // A NeedsGuidance outcome is the only shape this flow exercises; the cast
      // keeps the mock terse without weakening the rest of the LoadOutcome union.
    } as never);
    vi.mocked(ingestFileGuided).mockImplementation(async () => {
      state.workingSet = [guidedDataset];
      return { kind: "Loaded", data: guidedDataset } as never;
    });
  });

  it("opens the guided dialog on NeedsGuidance, then closes it after a guided load", async () => {
    render(<App />);

    // Mount-time refresh (empty working set) settles before the flow starts.
    await waitFor(() => expect(listWorkingSet).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Pick a file -> ingestFile returns NeedsGuidance -> dialog opens (AC2 seam).
    fireEvent.click(screen.getByRole("button", { name: /选择数据文件/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText(/引导加载：m/)).toBeInTheDocument();

    // Choose the real header (row 2) and submit -> guided ingest (AC3/AC7 seam).
    fireEvent.change(screen.getByLabelText(/表头所在行/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /按选择加载/ }));

    await waitFor(() =>
      expect(ingestFileGuided).toHaveBeenCalledWith("/x/m.xlsx", [
        { name: "people", rectify: { header_row: 2, skip_rows: [] } },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
