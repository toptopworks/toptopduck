import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkingSetEmptyState } from "../WorkingSetEmptyState";
import { renderI18n } from "../../common/__tests__/helpers";

// The empty card's add entry opens the Tauri file dialog; stub the bridge so
// the tests drive the picker (the WorkingSetList replace-test pattern).
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";

describe("WorkingSetEmptyState", () => {
  // Spies must not leak between tests.
  afterEach(() => vi.restoreAllMocks());

  it("renders the drop-or-pick hint with the inline add entry (issue #792)", () => {
    renderI18n(<WorkingSetEmptyState onAddFiles={() => {}} />);
    // The drop hint stays (the window dropzone still works), and the pick it
    // always pointed at is finally ON this screen.
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加数据文件" })).toBeInTheDocument();
  });

  it("opens the multi-select data-file picker and forwards the picked paths (issue #792)", async () => {
    const onAddFiles = vi.fn();
    vi.mocked(open).mockResolvedValue(["/x/a.csv", "/x/b.parquet"]);
    renderI18n(<WorkingSetEmptyState onAddFiles={onAddFiles} />);
    fireEvent.click(screen.getByRole("button", { name: "添加数据文件" }));
    // The add contract matches the composer's + entry: multi-select over
    // every ingestible extension (xlsx included -- multi-sheet workbooks park
    // on the guided-load dock inside the shared pipeline).
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          multiple: true,
          filters: [
            expect.objectContaining({
              extensions: ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"],
            }),
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(onAddFiles).toHaveBeenCalledWith(["/x/a.csv", "/x/b.parquet"]),
    );
  });

  it("normalizes a single picked path to a one-element array", async () => {
    const onAddFiles = vi.fn();
    vi.mocked(open).mockResolvedValue("/x/a.csv");
    renderI18n(<WorkingSetEmptyState onAddFiles={onAddFiles} />);
    fireEvent.click(screen.getByRole("button", { name: "添加数据文件" }));
    await waitFor(() => expect(onAddFiles).toHaveBeenCalledWith(["/x/a.csv"]));
  });

  it("ignores a cancelled picker", async () => {
    const onAddFiles = vi.fn();
    vi.mocked(open).mockResolvedValue(null); // cancelled
    renderI18n(<WorkingSetEmptyState onAddFiles={onAddFiles} />);
    fireEvent.click(screen.getByRole("button", { name: "添加数据文件" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it("disables the add button while loading (execution-window gate, ADR-0040)", () => {
    renderI18n(<WorkingSetEmptyState onAddFiles={() => {}} loading={true} />);
    expect(screen.getByRole("button", { name: "添加数据文件" })).toBeDisabled();
  });
});
