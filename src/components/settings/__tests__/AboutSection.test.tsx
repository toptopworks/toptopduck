import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { AboutSection } from "../AboutSection";
import {
  checkForUpdates,
  installUpdate,
  listLiveSessions,
  onUpdateDownloadProgress,
} from "../../../api";
import { updateKeys } from "../../../session/queryKeys";
import { renderSettings } from "./helpers";

// The About pane's update block (ADR-0143, issue #1509): the button state
// machine (check -> up-to-date / update-to-X), the active-turn confirm gate,
// and the manual check's mirror-write into the shared cache slice the sidebar
// indicator subscribes to. Assertions anchor on the en-US catalog wording
// (the shared seam's real-catalog posture, issue #1100).

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    listLiveSessions: vi.fn(),
    onUpdateDownloadProgress: vi.fn(async () => vi.fn()),
  };
});

vi.mock("@tauri-apps/api/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/app")>();
  return {
    ...actual,
    getVersion: vi.fn(async () => "0.4.0"),
  };
});

const mockedCheck = vi.mocked(checkForUpdates);
const mockedInstall = vi.mocked(installUpdate);
const mockedLive = vi.mocked(listLiveSessions);
const mockedProgress = vi.mocked(onUpdateDownloadProgress);

function renderPane() {
  return renderSettings(<AboutSection />);
}

describe("AboutSection update block", () => {
  beforeEach(() => {
    mockedCheck.mockReset();
    mockedInstall.mockReset();
    mockedLive.mockReset();
    mockedLive.mockResolvedValue([]);
  });

  it("offers a manual check and shows the identity row's version pill by default", async () => {
    renderPane();

    expect(
      screen.getByRole("button", { name: /check for updates/i }),
    ).toBeInTheDocument();
    // The identity row (issue #1577): the sidebar.brand copy + bare-semver
    // pill together; the old "Current version: …" description is retired.
    expect(await screen.findByText("TOPTOPDuck")).toBeInTheDocument();
    expect(screen.getByText("0.4.0")).toBeInTheDocument();
    expect(screen.queryByText(/current version/i)).toBeNull();
  });

  it("lands the manual check's null result as up-to-date and into the shared cache", async () => {
    mockedCheck.mockResolvedValue(null);
    const { queryClient } = renderPane();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    // The version interpolation is retired; the pill owns the current version.
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
    expect(queryClient.getQueryData(updateKeys.check())).toBeNull();
  });

  it("surfaces a failed manual check as an inline error with the raw detail folded", async () => {
    mockedCheck.mockRejectedValue(new Error("endpoint unreachable"));
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    // The friendly catalog line is primary; the raw reject rides the
    // technical-details fold.
    expect(await screen.findByText(/couldn't check for updates/i)).toBeInTheDocument();
    expect(screen.getByText(/endpoint unreachable/i)).toBeInTheDocument();
  });

  it("lands an install failure as an inline error with the raw detail folded", async () => {
    mockedInstall.mockRejectedValue(new Error("signature invalid"));
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });

    fireEvent.click(await screen.findByRole("button", { name: /update to 0\.5\.0/i }));

    expect(await screen.findByText(/^update failed$/i)).toBeInTheDocument();
    expect(screen.getByText(/signature invalid/i)).toBeInTheDocument();
  });

  it("shows the install button and notes once an update is known", async () => {
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: "Faster imports.",
      currentVersion: "0.4.0",
    });

    expect(
      await screen.findByRole("button", { name: /update to 0\.5\.0/i }),
    ).toBeInTheDocument();
    // Non-canonical text rides the plain-lines fallback.
    expect(screen.getByText("Faster imports.")).toBeInTheDocument();
  });

  it("renders canonical notes as sections with PR tails stripped", async () => {
    const notes = [
      "### 新功能",
      "",
      "- 新增工作区记忆系统，回合结束自动提取沉淀要点 (PR [#1536](https://example.com/pull/1536))",
      "",
      "### 修复",
      "",
      "- 大型 Excel 工作簿引导导入全程只解析一次 (PR [#1555](https://example.com/pull/1555))",
      "",
      "---",
      "",
      "> Install tips belong to the release page.",
    ].join("\n");
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes,
      currentVersion: "0.4.0",
    });

    await screen.findByRole("button", { name: /update to 0\.5\.0/i });

    // Section titles and cleaned items render as text nodes; provenance
    // tails and the footer never surface.
    expect(screen.getByText("新功能")).toBeInTheDocument();
    expect(
      screen.getByText("新增工作区记忆系统，回合结束自动提取沉淀要点"),
    ).toBeInTheDocument();
    expect(screen.getByText("修复")).toBeInTheDocument();
    expect(screen.queryByText(/install tips/i)).toBeNull();
    expect(screen.queryByText(/PR \[/u)).toBeNull();
  });

  it("installs directly when no turn is in flight", async () => {
    mockedInstall.mockReturnValue(new Promise(() => {}));
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });

    fireEvent.click(await screen.findByRole("button", { name: /update to 0\.5\.0/i }));

    await waitFor(() => expect(mockedInstall).toHaveBeenCalledTimes(1));
    // No confirm dialog on the quiet path.
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("gates the install behind a confirm dialog while a turn is in flight", async () => {
    mockedLive.mockResolvedValue([
      {
        session_id: "s1",
        recipe_path: null,
        session_name: null,
        in_flight: true,
      },
    ]);
    mockedInstall.mockReturnValue(new Promise(() => {}));
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });

    fireEvent.click(await screen.findByRole("button", { name: /update to 0\.5\.0/i }));

    // The dialog opens; the install has NOT started.
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockedInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /update and restart/i }));

    await waitFor(() => expect(mockedInstall).toHaveBeenCalledTimes(1));
  });

  it("drives the install percent from the download progress events", async () => {
    // The producer face: the Rust download events flow through the
    // subscription into the shared install slice and onto the button's
    // percent wording -- the floor, the clamp, and the null-total guard all
    // live on this path (the suites previously mocked the subscription as a
    // no-op, leaving the whole producer unexecuted).
    let progress:
      | ((p: { downloaded: number; contentLength: number | null }) => void)
      | null = null;
    mockedProgress.mockImplementationOnce(async (cb) => {
      progress = cb;
      return () => {};
    });
    mockedInstall.mockReturnValue(new Promise(() => {}));
    const { queryClient } = renderPane();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /update to 0\.5\.0/i }),
    );
    await waitFor(() => expect(progress).not.toBeNull());
    expect(screen.getByRole("button", { name: "Updating…" })).toBeInTheDocument();

    act(() => progress?.({ downloaded: 150, contentLength: 200 }));
    expect(
      await screen.findByRole("button", { name: "Updating… 75%" }),
    ).toBeInTheDocument();

    // Unknown total collapses back to the unquantified posture (no NaN).
    act(() => progress?.({ downloaded: 10, contentLength: null }));
    expect(
      await screen.findByRole("button", { name: "Updating…" }),
    ).toBeInTheDocument();
  });
});
