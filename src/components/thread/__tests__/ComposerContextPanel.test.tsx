import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";

import { ComposerContextPanel } from "../ComposerContextPanel";

// ComposerContextPanel is now the Files-only button (Skills and MCP moved to
// dedicated trigger chips above the QuestionBar). The button opens the file
// dialog directly -- no popover shell. Mocked dialog plugin so the view never
// hits Tauri (ADR-0029).
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";

function renderButton(
  props: Partial<{
    onIngestFiles: (paths: string[]) => void;
    loading: boolean;
    pendingFiles: string[];
    onClearPendingFiles: () => void;
  }> = {},
) {
  const onIngestFiles = props.onIngestFiles ?? vi.fn();
  const view: ReactElement = (
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <ComposerContextPanel
        onIngestFiles={onIngestFiles}
        loading={props.loading ?? false}
        pendingFiles={props.pendingFiles}
        onClearPendingFiles={props.onClearPendingFiles}
      />
    </IntlProvider>
  );
  return { ...render(view), onIngestFiles };
}

describe("ComposerContextPanel (Files button)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the multi-select dialog on click", async () => {
    vi.mocked(open).mockResolvedValue(["/a.csv", "/b.csv"]);
    const { onIngestFiles } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Add files" }));

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true }),
    );
    await waitFor(() =>
      expect(onIngestFiles).toHaveBeenCalledWith(["/a.csv", "/b.csv"]),
    );
  });

  it("normalizes a single-string dialog result into a one-path batch", async () => {
    vi.mocked(open).mockResolvedValue("/a.csv");
    const { onIngestFiles } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Add files" }));

    await waitFor(() => expect(onIngestFiles).toHaveBeenCalledWith(["/a.csv"]));
  });

  it("does not ingest when the dialog is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    const { onIngestFiles } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Add files" }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(onIngestFiles).not.toHaveBeenCalled();
  });

  it("is disabled while the session is loading", () => {
    renderButton({ loading: true });
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
  });

  // --- Cold-start draft mode (#500): the pending file queue chip ------------

  it("renders a queued-count chip with the file names in the tooltip when pendingFiles is non-empty", () => {
    renderButton({ pendingFiles: ["/x/a.csv", "/deep/dir/b.parquet"] });
    const chip = screen.getByRole("generic", {
      name: "2 files queued for the next session",
    });
    expect(chip).toBeInTheDocument();
    // The tooltip carries every queued file's NAME (not the full path).
    expect(chip).toHaveAttribute("title", "a.csv, b.parquet");
    expect(chip).toHaveTextContent("2");
  });

  it("clears the whole queue via the chip's X button", () => {
    const onClearPendingFiles = vi.fn();
    renderButton({
      pendingFiles: ["/x/a.csv"],
      onClearPendingFiles,
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear queued files" }));
    expect(onClearPendingFiles).toHaveBeenCalledTimes(1);
  });

  it("renders no chip when pendingFiles is absent (session-active bar)", () => {
    renderButton({});
    expect(
      screen.queryByRole("generic", { name: /files queued/ }),
    ).not.toBeInTheDocument();
  });

  it("renders no chip for an empty pending list", () => {
    renderButton({ pendingFiles: [] });
    expect(
      screen.queryByRole("generic", { name: /files queued/ }),
    ).not.toBeInTheDocument();
  });
});
