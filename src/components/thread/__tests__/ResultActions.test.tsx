// ResultActions (issue #769): the result header's export-CSV / copy-all pair.
// The tests script the full-pull IPC surfaces and the save dialog, and stub
// the clipboard the way the thread's copy tests do (test-setup un-stubs after
// each test). Assertions ride the zh-CN catalog (renderI18n), pinning the
// quiet-cancel, honest-failure, ack-flip, and shared-busy contracts.
//
// The full-pull guardrails (issue #779) add their own contracts: a TooLarge
// refusal parks the confirm dialog (Continue re-sends with confirmed,
// reusing the chosen export destination; Cancel abandons quietly), a
// Cancelled reject is a quiet no-op, and a busy pull flips both buttons to
// stop entries firing the session's cancel token.

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";
import { TooltipProvider } from "../../ui/tooltip";
import { ResultActions } from "../ResultActions";
import { cancelQuery, exportRowsCsv, readRowsTsv } from "../../../api";

// ResultActions' full-pull + cancel IPC surfaces are stubbed so each test
// scripts the outcome; the rest of the api module passes through unchanged.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    readRowsTsv: vi.fn(),
    exportRowsCsv: vi.fn(),
    cancelQuery: vi.fn(),
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

// The confirm gate's typed refusal as it crosses IPC: the CSV export rides
// SessionError::Export's RowRead half, the TSV copy rides SessionError::RowRead
// whose serde wire kind is "Turn" (renamed in Rust, issue #121) -- pinning the
// literal wire shape is what guards the classifier against a hand-matched
// kind string (issue #779 review).
const tooLargeExportReject = {
  kind: "Export",
  data: {
    kind: "RowRead",
    data: { kind: "TooLarge", data: { row_count: 1_200_000, limit: 1_000_000 } },
  },
};

const tooLargeCopyReject = {
  kind: "Turn",
  data: { kind: "TooLarge", data: { row_count: 1_200_000, limit: 1_000_000 } },
};

const cancelledCopyReject = {
  kind: "Turn",
  data: { kind: "Cancelled" },
};

describe("ResultActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cancelQuery).mockResolvedValue(undefined);
  });

  it("exports through the native save dialog to the chosen path", async () => {
    // AC: the export action opens the native save dialog, then hands the
    // chosen path to the full-path IPC -- the UI never stitches pages. The
    // first attempt passes confirmed=false (the confirm gate's default).
    vi.mocked(saveDialog).mockResolvedValue("C:/out/result_1.csv");
    vi.mocked(exportRowsCsv).mockResolvedValue(undefined);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(exportRowsCsv).toHaveBeenCalledWith(
        "sess-1",
        "result_1",
        "C:/out/result_1.csv",
        false,
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
    // shared Copied ack -- the CopyButton idiom. The first attempt passes
    // confirmed=false (the confirm gate's default).
    const writeText = stubClipboard();
    vi.mocked(readRowsTsv).mockResolvedValue("甲\t乙\na b\tx y\n");
    const { onError } = renderActions();
    fireEvent.click(copyButton());
    await waitFor(() => expect(readRowsTsv).toHaveBeenCalledWith("sess-1", "result_1", false));
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

  it("parks a TooLarge export refusal on the confirm dialog and re-sends confirmed", async () => {
    // Issue #779 AC1: the gate's refusal never reaches the error lane -- it
    // parks the confirm dialog quoting the row count; Continue re-sends with
    // confirmed=true, reusing the destination the user already chose (no
    // second save dialog), and only then can the export settle.
    vi.mocked(saveDialog).mockResolvedValue("C:/out/result_1.csv");
    vi.mocked(exportRowsCsv)
      .mockRejectedValueOnce(tooLargeExportReject)
      .mockResolvedValue(undefined);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    const dialog = await screen.findByRole("alertdialog");
    expect(screen.getByText(/1,200,000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(exportRowsCsv).toHaveBeenLastCalledWith(
        "sess-1",
        "result_1",
        "C:/out/result_1.csv",
        true,
      ),
    );
    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(dialog).not.toBeInTheDocument();
  });

  it("abandons a TooLarge export when the confirm dialog is cancelled", async () => {
    // Cancel is a quiet no-op: no confirmed re-send, no error lane -- nothing
    // ran, exactly like a cancelled save dialog. The second refusal re-parks
    // the dialog: Cancel's state clear is what lets the next refusal mount a
    // fresh defaultOpen dialog (issue #766's stranded-state failure class).
    vi.mocked(saveDialog).mockResolvedValue("C:/out/result_1.csv");
    vi.mocked(exportRowsCsv)
      .mockRejectedValueOnce(tooLargeExportReject)
      .mockRejectedValueOnce(tooLargeExportReject);
    const { onError } = renderActions();
    fireEvent.click(exportButton());
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导出 CSV" })).toBeEnabled(),
    );
    expect(exportRowsCsv).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // A later oversized pull parks the confirm dialog again.
    fireEvent.click(exportButton());
    await screen.findByRole("alertdialog");
    expect(exportRowsCsv).toHaveBeenCalledTimes(2);
  });

  it("parks a TooLarge copy refusal and acknowledges after the confirmed re-send", async () => {
    // The copy twin rides SessionError::RowRead directly; the confirmed
    // re-send writes the clipboard and flips the shared ack.
    const writeText = stubClipboard();
    vi.mocked(readRowsTsv)
      .mockRejectedValueOnce(tooLargeCopyReject)
      .mockResolvedValue("甲\t乙\n");
    const { onError } = renderActions();
    fireEvent.click(copyButton());
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(readRowsTsv).toHaveBeenLastCalledWith("sess-1", "result_1", true));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("甲\t乙\n"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument(),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a cancelled pull as a quiet no-op", async () => {
    // Issue #779: the stop landed (the token fired), so the pull ended with
    // Cancelled -- the user asked for it, so neither the error lane nor an
    // ack nor a confirm dialog fires, and nothing reached the clipboard.
    const writeText = stubClipboard();
    vi.mocked(readRowsTsv).mockRejectedValueOnce(cancelledCopyReject);
    const { onError } = renderActions();
    fireEvent.click(copyButton());
    await waitFor(() => expect(copyButton()).toBeEnabled());
    expect(writeText).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("turns both buttons into stop entries while a pull is in flight", async () => {
    // Issue #779 AC2: busy no longer disables the pair -- each button becomes
    // a stop entry firing the session's cancel token (the token fires without
    // the session lock, so the stop lands mid-pull), and neither re-triggers
    // the pull itself.
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
    const stops = screen.getAllByRole("button", { name: "停止" });
    expect(stops).toHaveLength(2);
    fireEvent.click(stops[0]);
    expect(cancelQuery).toHaveBeenCalledWith("sess-1");
    expect(readRowsTsv).toHaveBeenCalledTimes(1); // no re-trigger
    resolveTsv("a\tb\n");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a\tb\n"));
    // Settled: re-enabled with the ack holding (the accessible name stays on
    // the shared Copied label for the hold window).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "已复制" })).toBeEnabled(),
    );
  });

  it("turns both buttons into stop entries while an export is in flight", async () => {
    // The busy flip is direction-agnostic: an export in flight presents the
    // same stop pair, and its stop fires the shared token without
    // re-triggering the export.
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
    const stops = screen.getAllByRole("button", { name: "停止" });
    expect(stops).toHaveLength(2);
    fireEvent.click(stops[1]);
    expect(cancelQuery).toHaveBeenCalledWith("sess-1");
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

  it("drops a TooLarge refusal when the result switched under it", async () => {
    // The stale guard covers the guardrail lane too: a confirm-gate refusal
    // arriving after the result switched parks no dialog (a prompt quoting
    // the departed result's row count over the new one's header would
    // misdirect the user) and feeds no error lane -- the pull is simply not
    // happening on this result anymore.
    let rejectTsv: (e: unknown) => void = () => {};
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
    rerender(
      withIntl(
        <TooltipProvider>
          <ResultActions sessionId="sess-1" referenceName="result_2" onError={onError} />
        </TooltipProvider>,
      ),
    );
    rejectTsv(tooLargeCopyReject);
    await waitFor(() => expect(copyButton()).toBeEnabled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });
});
