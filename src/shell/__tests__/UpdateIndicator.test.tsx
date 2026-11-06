import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "../../components/ui/tooltip";
import { toast } from "../../components/ui/use-toast";
import { UpdateIndicator } from "../UpdateIndicator";
import { updateKeys } from "../../session/queryKeys";
import {
  installUpdate,
  listLiveSessions,
} from "../../api";

// The sidebar-footer update indicator (ADR-0143, issue #1509): absent while
// no update is known, present with a version-naming accessible label the
// moment the shared cache slice carries one; the click installs DIRECTLY
// (gated by the active-turn confirm when tasks are in flight). Empty-catalog
// English IntlProvider resolves labels to the defaultMessage literals
// (ADR-0052).

vi.mock("../../api", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../api")>()),
    installUpdate: vi.fn(),
    listLiveSessions: vi.fn(),
    onUpdateDownloadProgress: vi.fn(async () => vi.fn()),
  };
});
vi.mock("../../components/ui/use-toast", () => ({ toast: vi.fn() }));

const mockedInstall = vi.mocked(installUpdate);
const mockedLive = vi.mocked(listLiveSessions);
const mockedToast = vi.mocked(toast);

function renderIndicator() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(updateKeys.check(), UPDATE);
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <UpdateIndicator />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

const UPDATE = {
  version: "0.5.0",
  notes: null,
  currentVersion: "0.4.0",
};

describe("UpdateIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLive.mockResolvedValue([]);
    // A never-resolving install stands in for the real atomic chain (success
    // replaces the process; the promise never settles).
    mockedInstall.mockReturnValue(new Promise(() => {}));
  });

  it("renders nothing while no update is known (self-hidden)", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <TooltipProvider>
            <UpdateIndicator />
          </TooltipProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows an independent icon naming the version once an update lands", () => {
    renderIndicator();
    expect(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    ).toBeInTheDocument();
  });

  it("installs directly on click when no task is in flight", async () => {
    renderIndicator();
    fireEvent.click(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    );
    await waitFor(() => expect(mockedInstall).toHaveBeenCalledTimes(1));
  });

  it("gates with the active-turn confirm when a task is in flight", async () => {
    mockedLive.mockResolvedValue([{ sid: "s", in_flight: true } as never]);
    renderIndicator();
    fireEvent.click(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    );
    expect(mockedInstall).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Update and restart" }),
    );
    await waitFor(() => expect(mockedInstall).toHaveBeenCalledTimes(1));
  });

  it("cannot start a second install while one is already in flight", async () => {
    // The shared in-flight gate (the slice is process-wide): a confirm leg
    // opened on this face must go dark when another face (the About pane)
    // already started the chain -- exactly one Rust install may run.
    mockedLive.mockResolvedValue([{ sid: "s", in_flight: true } as never]);
    const queryClient = renderIndicator();
    fireEvent.click(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    );
    const confirm = await screen.findByRole("button", {
      name: "Update and restart",
    });
    // The other face's startInstall already wrote the slice.
    queryClient.setQueryData(updateKeys.install(), { percent: null });
    fireEvent.click(confirm);
    expect(mockedInstall).not.toHaveBeenCalled();
  });

  it("toasts a destructive failure and returns to the idle posture", async () => {
    mockedInstall.mockRejectedValueOnce(new Error("network down"));
    renderIndicator();
    fireEvent.click(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    );
    await waitFor(() => expect(mockedToast).toHaveBeenCalledTimes(1));
    expect(mockedToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
    // Back to idle: the version-label affordance is live again.
    expect(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    ).toBeInTheDocument();
  });
});
