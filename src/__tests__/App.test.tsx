import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  renameDataset: vi.fn(),
  replaceSource: vi.fn(),
  setDatasetPrivacy: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";
import App from "../App";
import { ingestFile, ingestFileGuided, listWorkingSet, renameDataset } from "../api";

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
  privacy: { send_samples: true, type_only_columns: [] },
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

describe("App rename flow", () => {
  // prompt spies must not leak between tests (jsdom default returns null).
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });

  it("keeps selection on the renamed dataset (ADR-0037 display/reference decoupling)", async () => {
    // One dataset loaded; selection keys off the stable reference name, so a
    // display rename must not drop the current selection.
    state.workingSet = [guidedDataset];
    render(<App />);

    // Mount refresh settles, then select the dataset to show its detail.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));
    // The dataset's column type is shown (now in both the schema table and the
    // privacy-cols table, so BIGINT appears twice -- assert presence, not uniqueness).
    expect(screen.getAllByText("BIGINT").length).toBeGreaterThan(0);

    // Rename via prompt; on refresh the working set carries the new label.
    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    vi.mocked(renameDataset).mockImplementation(async (ref, display) => {
      state.workingSet = state.workingSet.map((d) =>
        d.reference_name === ref ? { ...d, display_name: display } : d,
      );
      return { ...guidedDataset, display_name: display };
    });
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));

    // The rename carries the stable reference name + the new display label.
    await waitFor(() => expect(renameDataset).toHaveBeenCalledWith("people", "员工表"));

    // Selection survived (keyed by reference_name): the list now shows the new
    // label, yet the same dataset's columns are still in the detail pane.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^员工表/ })).toBeInTheDocument(),
    );
    expect(screen.getAllByText("BIGINT").length).toBeGreaterThan(0);
  });

  it("labels a rename failure distinctly from a load failure (M2)", async () => {
    // A rejected rename surfaces the backend's message, but NOT under the
    // load-failure prefix -- the error context follows the operation that
    // produced it, so a rename rejection is never misread as a load failure.
    state.workingSet = [guidedDataset];
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );

    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    vi.mocked(renameDataset).mockRejectedValueOnce(
      "显示名「员工表」已被其他数据集使用",
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));

    await waitFor(() =>
      expect(screen.getByText(/显示名「员工表」已被其他数据集使用/)).toBeInTheDocument(),
    );
    // The rename rejection must not inherit the ingest flow's "加载失败" prefix.
    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();
  });
});
