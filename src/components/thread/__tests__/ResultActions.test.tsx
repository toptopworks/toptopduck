// ResultActions (issue #769): the result header's export-CSV / copy-all pair.
// The tests script the full-pull IPC surfaces and the save dialog, and stub
// the clipboard the way the thread's copy tests do (test-setup un-stubs after
// each test). Assertions ride the zh-CN catalog (renderI18n), pinning the
// quiet-cancel, honest-failure, ack-flip, and shared-busy contracts.

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";
import { TooltipProvider } from "../../ui/tooltip";
import { ResultActions } from "../ResultActions";
import { exportRowsCsv, readRowsTsv } from "../../../api";

// ResultActions' two api surfaces are stubbed so each test scripts the
// full-pull outcome; the rest of the api module passes through unchanged.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    readRowsTsv: vi.fn(),
    exportRowsCsv: vi.fn(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

// Radix tooltips need the app-wide TooltipProvider ancestor (mounted in
// App.tsx); tests provide it the RoundProse way.
function renderActions(onError: Mock = vi.fn()) {
  renderI18n(
    <TooltipProvider>
      <ResultActions sessionId="sess-1" referenceName="result_1" onError={onError} />
    </TooltipProvider>,
  );
  return { onError };
}

function exportButton() {
  return screen.getByRole("button", { name: "导出 CSV" });
}

function copyButton() {
  return screen.getByRole("button", { name: "复制全部" });
}

describe("ResultActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports through the native save dialog to the chosen path", async () => {
    // AC: the export action opens the native save dialog, then hands the
    // chosen path to the full-path IPC -- the UI never stitches pages.
    vi.mocked(saveDialog).mockResolvedValue("C:/out/result_1.csv");
    vi.mocked(exportRowsCsv).mockResolvedValue(undefined);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(exportRowsCsv).toHaveBeenCalledWith(
        "sess-1",
        "result_1",
        "C:/out/result_1.csv",
      ),
    );
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: "result_1.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a cancelled save dialog as a quiet no-op", async () => {
    // AC: dialog cancel triggers no export and surfaces no error.
    vi.mocked(saveDialog).mockResolvedValue(null);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exportButton()).toBeEnabled());
    expect(exportRowsCsv).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("routes an export failure to the error lane, never silently", async () => {
    // The wire shape is the typed SessionError::Export reject (ExportRowsError
    // adjacently-tagged); the lane receives it verbatim for toAppError.
    const reject = {
      kind: "Export",
      data: { kind: "Io", data: { step: "Write", path: "C:/out/x.csv", detail: "denied" } },
    };
    vi.mocked(saveDialog).mockResolvedValue("C:/out/x.csv");
    vi.mocked(exportRowsCsv).mockRejectedValue(reject);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toEqual(reject);
  });

  it("writes the full TSV to the clipboard and acknowledges in place", async () => {
    // AC: copy writes the core-built TSV (header row included) and flips the
    // shared Copied ack -- the CopyButton idiom.
    const writeText = stubClipboard();
    vi.mocked(readRowsTsv).mockResolvedValue("甲\t乙\na b\tx y\n");
    const { onError } = renderActions();
    fireEvent.click(copyButton());
    await waitFor(() => expect(readRowsTsv).toHaveBeenCalledWith("sess-1", "result_1"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("甲\t乙\na b\tx y\n"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument(),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("flips no ack and reports when the clipboard rejects", async () => {
    // AC: a clipboard rejection is an honest failure -- no fake ack, the error
    // lane carries it.
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.mocked(readRowsTsv).mockResolvedValue("a\tb\n");
    const { onError } = renderActions();
    fireEvent.click(copyButton());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "复制全部" })).toBeInTheDocument();
  });

  it("disables both actions while a pull is in flight and cannot re-trigger", async () => {
    // AC: in-flight disables the actions and blocks a repeat trigger -- one
    // busy flag covers the pair, so no concurrent full pulls either.
    const writeText = stubClipboard();
    let resolveTsv: (v: string) => void = () => {};
    vi.mocked(readRowsTsv).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTsv = resolve;
        }),
    );
    renderActions();
    fireEvent.click(copyButton());
    await waitFor(() => expect(readRowsTsv).toHaveBeenCalledTimes(1));
    expect(copyButton()).toBeDisabled();
    expect(exportButton()).toBeDisabled();
    fireEvent.click(copyButton()); // lands on a disabled control
    expect(readRowsTsv).toHaveBeenCalledTimes(1);
    resolveTsv("a\tb\n");
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Settled: re-enabled with the ack holding (the accessible name stays on
    // the shared Copied label for the hold window).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "已复制" })).toBeEnabled(),
    );
  });

  it("disables both actions while an export is in flight", async () => {
    // AC: the shared busy flag is direction-agnostic -- an export in flight
    // disables the pair exactly like a copy (no re-trigger either).
    vi.mocked(saveDialog).mockResolvedValue("C:/out/x.csv");
    let resolveExport: (v: void) => void = () => {};
    vi.mocked(exportRowsCsv).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );
    renderActions();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exportRowsCsv).toHaveBeenCalledTimes(1));
    expect(exportButton()).toBeDisabled();
    expect(copyButton()).toBeDisabled();
    fireEvent.click(exportButton()); // lands on a disabled control
    expect(exportRowsCsv).toHaveBeenCalledTimes(1);
    resolveExport(undefined);
    await waitFor(() => expect(exportButton()).toBeEnabled());
  });

  it("drops a late copy failure and ack when the result switched under it", async () => {
    // The header instance is reused across result switches; settle-time
    // effects (the error lane, the ack) land only on the result that started
    // the pull -- a late resolution under a new reference is dropped, while
    // the busy flag still clears.
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    let rejectTsv: (e: Error) => void = () => {};
    vi.mocked(readRowsTsv).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectTsv = reject;
        }),
    );
    const onError = vi.fn();
    const { rerender } = renderI18n(
      <TooltipProvider>
        <ResultActions sessionId="sess-1" referenceName="result_1" onError={onError} />
      </TooltipProvider>,
    );
    fireEvent.click(copyButton());
    await waitFor(() => expect(readRowsTsv).toHaveBeenCalledTimes(1));
    // The user switches to another result under the same header instance.
    rerender(
      withIntl(
        <TooltipProvider>
          <ResultActions sessionId="sess-1" referenceName="result_2" onError={onError} />
        </TooltipProvider>,
      ),
    );
    rejectTsv(new Error("late"));
    // Busy clears (the pair re-enables) but the late failure never lands on
    // the new result's lane, and no ack flips.
    await waitFor(() => expect(copyButton()).toBeEnabled());
    expect(onError).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
