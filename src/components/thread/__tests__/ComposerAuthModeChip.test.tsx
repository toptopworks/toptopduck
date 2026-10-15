import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerAuthModeChip } from "../ComposerAuthModeChip";
import { getAuthorizationMode, setAuthorizationMode } from "../../../api";

// ComposerAuthModeChip is the composer authorization-posture Radix Select
// (ADR-0080, issue #352 / #482): a dropdown (confirm-each-call <->
// no-confirmation) that reads / writes the session's auth mode through the
// get/set authorization-mode IPC (#294). The no-confirmation trigger face
// rides the --warning token. Routes its chrome through react-intl (ADR-0052);
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
        <ComposerAuthModeChip sessionId={sessionId} />
      </IntlProvider>
    </QueryClientProvider>
  );
  return render(view);
}

const PER_CALL_NAME = "Authorization mode: Request approval";
const NO_CONFIRM_NAME = "Authorization mode: Full access";

/** Opens a Radix Select and clicks the option matching the given text. */
async function selectOption(trigger: Element, optionText: RegExp): Promise<void> {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionText });
  fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
  fireEvent.click(option);
}

describe("ComposerAuthModeChip (ADR-0080, issue #482)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthorizationMode).mockResolvedValue("per_call");
    vi.mocked(setAuthorizationMode).mockResolvedValue(undefined);
  });

  it("renders the per-call trigger from the session read", async () => {
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: PER_CALL_NAME });
    expect(getAuthorizationMode).toHaveBeenCalledWith("sess-1");
    // The neutral face rides the composer chrome tokens, not the warning hue.
    expect(trigger.className).toContain("bg-card");
    expect(trigger.className).not.toContain("bg-warning");
    // The ItemText → SelectValue echo surfaces the mode label in the trigger.
    expect(trigger).toHaveTextContent("Request approval");
  });

  it("renders the warning-styled trigger when the session is no_confirmation", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: NO_CONFIRM_NAME });
    // ADR-0080: the no-confirmation posture is marked with the --warning
    // token (border / fill / text all consume it).
    expect(trigger.className).toContain("border-warning/40");
    expect(trigger.className).toContain("bg-warning/10");
    expect(trigger.className).toContain("text-warning");
  });

  it("switches per_call -> no_confirmation through the set IPC", async () => {
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: PER_CALL_NAME });

    await selectOption(trigger, /Full access/);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation");
    // The trigger flips once the write lands: warning face.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: NO_CONFIRM_NAME })).toBeInTheDocument(),
    );
  });

  it("switches back no_confirmation -> per_call", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: NO_CONFIRM_NAME });

    await selectOption(trigger, /Request approval/);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "per_call");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: PER_CALL_NAME })).toBeInTheDocument(),
    );
  });

  it("keeps the server posture on a rejected write and resyncs", async () => {
    vi.mocked(setAuthorizationMode).mockRejectedValue(new Error("session gone"));
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: PER_CALL_NAME });

    await selectOption(trigger, /Full access/);

    await waitFor(() => expect(setAuthorizationMode).toHaveBeenCalled());
    // The resync refetch lands the backend truth (per_call): the trigger never
    // shows the selected posture.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: PER_CALL_NAME })).toBeInTheDocument(),
    );
    // Initial read + the resync refetch.
    await waitFor(() => expect(getAuthorizationMode).toHaveBeenCalledTimes(2));
  });

  it("disables the trigger while the switch is in flight", async () => {
    let release: (value: void) => void = () => {};
    vi.mocked(setAuthorizationMode).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    renderChip();
    const trigger = await screen.findByRole("combobox", { name: PER_CALL_NAME });

    await selectOption(trigger, /Full access/);

    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
    // The switching guard is held: the set IPC fired exactly once for this
    // single selection, not re-fired while in flight.
    expect(setAuthorizationMode).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: NO_CONFIRM_NAME })).toBeInTheDocument(),
    );
  });

  it("shows the honest default face while the session read is pending", async () => {
    // The read stays pending forever: the trigger still renders the default
    // per-call posture (the backend default), never a blank slot.
    vi.mocked(getAuthorizationMode).mockReturnValue(new Promise(() => {}));
    renderChip();
    expect(
      await screen.findByRole("combobox", { name: PER_CALL_NAME }),
    ).toBeInTheDocument();
  });
});
