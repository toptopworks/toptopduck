import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { AboutSection } from "../AboutSection";
import {
  checkForUpdates,
  installUpdate,
  listLiveSessions,
} from "../../../api";
import { updateKeys } from "../../../session/queryKeys";
import { renderSettings } from "./helpers";

// The About pane's update block (ADR-0143, issue #1509): the button state
// machine (check -> up-to-date / update-to-X), the active-turn confirm gate,
// and the manual check's mirror-write into the shared cache slice the topbar
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

  it("offers a manual check and shows the running version by default", async () => {
    renderPane();

    expect(
      screen.getByRole("button", { name: /check for updates/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/current version: 0\.4\.0/i)).toBeInTheDocument();
  });

  it("lands the manual check's null result as up-to-date and into the shared cache", async () => {
    mockedCheck.mockResolvedValue(null);
    const { queryClient } = renderPane();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText(/you're up to date \(0\.4\.0\)/i)).toBeInTheDocument();
    expect(queryClient.getQueryData(updateKeys.check())).toBeNull();
  });

  it("surfaces a failed manual check as an inline error", async () => {
    mockedCheck.mockRejectedValue(new Error("endpoint unreachable"));
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() =>
      expect(screen.getByText(/endpoint unreachable/i)).toBeInTheDocument(),
    );
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
    expect(screen.getByText(/faster imports/i)).toBeInTheDocument();
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
});
