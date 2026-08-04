import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerAuthModeChip } from "../ComposerAuthModeChip";
import { getAuthorizationMode, setAuthorizationMode } from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";

// ComposerAuthModeChip is the composer authorization-posture toggle (ADR-0080
// Decision 4, issue #352): a two-position chip (confirm-each-call <->
// no-confirmation) that reads / writes the session's auth mode through the
// get/set authorization-mode IPC (#294). The no-confirmation position rides
// the --warning token. Routes its chrome through react-intl (ADR-0052);
// rendered inside an empty-catalog English IntlProvider so assertions anchor
// on the canonical defaultMessage strings. The IPC pair is mocked so the view
// never hits Tauri.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    getAuthorizationMode: vi.fn(),
    setAuthorizationMode: vi.fn(async () => {}),
  };
});

function renderChip(sessionId: string = "sess-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>
          <ComposerAuthModeChip sessionId={sessionId} />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  return render(view);
}

const PER_CALL_NAME = "Authorization mode: Confirm each call";
const NO_CONFIRM_NAME = "Authorization mode: No confirmation";

describe("ComposerAuthModeChip (ADR-0080 Decision 4, issue #352)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthorizationMode).mockResolvedValue("per_call");
    vi.mocked(setAuthorizationMode).mockResolvedValue(undefined);
  });

  it("renders the per-call chip from the session read", async () => {
    renderChip();
    const chip = await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(getAuthorizationMode).toHaveBeenCalledWith("sess-1");
    // Default posture is not pressed (no-confirmation is the toggled state).
    expect(chip).not.toHaveAttribute("aria-pressed", "true");
    // The neutral face rides the composer chrome tokens, not the warning hue.
    expect(chip.className).toContain("bg-card");
    expect(chip.className).not.toContain("bg-warning");
  });

  it("renders the warning-styled chip when the session is no_confirmation", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const chip = await screen.findByRole("button", { name: NO_CONFIRM_NAME });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    // ADR-0080: the no-confirmation posture is marked with the --warning
    // token (border / fill / text all consume it).
    expect(chip.className).toContain("border-warning/40");
    expect(chip.className).toContain("bg-warning/10");
    expect(chip.className).toContain("text-warning");
  });

  it("toggles per_call -> no_confirmation through the set IPC", async () => {
    renderChip();
    const chip = await screen.findByRole("button", { name: PER_CALL_NAME });

    fireEvent.click(chip);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation");
    // The chip flips once the write lands: warning face + pressed state.
    const flipped = await screen.findByRole("button", { name: NO_CONFIRM_NAME });
    expect(flipped).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles back no_confirmation -> per_call", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const chip = await screen.findByRole("button", { name: NO_CONFIRM_NAME });

    fireEvent.click(chip);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "per_call");
    const flipped = await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(flipped).not.toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the server posture on a rejected write and resyncs", async () => {
    vi.mocked(setAuthorizationMode).mockRejectedValue(new Error("session gone"));
    renderChip();
    const chip = await screen.findByRole("button", { name: PER_CALL_NAME });

    fireEvent.click(chip);

    await waitFor(() => expect(setAuthorizationMode).toHaveBeenCalled());
    // The resync refetch lands the backend truth (per_call): the chip never
    // shows the toggled posture.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: PER_CALL_NAME })).not.toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    // Initial read + the resync refetch.
    await waitFor(() => expect(getAuthorizationMode).toHaveBeenCalledTimes(2));
  });

  it("disables the chip while the switch is in flight", async () => {
    let release: (value: void) => void = () => {};
    vi.mocked(setAuthorizationMode).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    renderChip();
    const chip = await screen.findByRole("button", { name: PER_CALL_NAME });

    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
    // A second click while in flight does not re-fire the write.
    fireEvent.click(screen.getByRole("button"));
    expect(setAuthorizationMode).toHaveBeenCalledTimes(1);

    release();
    await screen.findByRole("button", { name: NO_CONFIRM_NAME });
  });

  it("shows the honest default face while the session read is pending", async () => {
    // The read stays pending forever: the chip still renders the default
    // per-call posture (the backend default), never a blank slot.
    vi.mocked(getAuthorizationMode).mockReturnValue(new Promise(() => {}));
    renderChip();
    expect(
      await screen.findByRole("button", { name: PER_CALL_NAME }),
    ).not.toHaveAttribute("aria-pressed", "true");
  });
});
