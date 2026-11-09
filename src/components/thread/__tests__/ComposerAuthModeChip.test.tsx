import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerAuthModeChip } from "../ComposerAuthModeChip";
import {
  getAuthorizationMode,
  listSessionTrust,
  onApprovalResolved,
  revokeSessionTrust,
  setAuthorizationMode,
} from "../../../api";
import { log } from "../../../lib/log";
import type { ApprovalResolvedPayload } from "../../../types/approval";

// ComposerAuthModeChip is the composer's session-approval composite face
// (ADR-0080, issue #482 / #1369): a Popover whose top half switches the
// session's authorization posture through the get/set authorization-mode IPC
// (#294) and whose bottom half -- only when the session's always-allow trust
// set is non-empty -- lists the trusted tools with a per-row revoke button.
// The no-confirmation face rides the --warning token. Routes its chrome
// through react-intl (ADR-0052); rendered inside an empty-catalog English
// IntlProvider so assertions anchor on the canonical defaultMessage strings.
// The IPC pair + trust pair + event subscription are mocked so the view
// never hits Tauri.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    getAuthorizationMode: vi.fn(),
    setAuthorizationMode: vi.fn(async () => {}),
    listSessionTrust: vi.fn(async () => []),
    revokeSessionTrust: vi.fn(async () => {}),
    onApprovalResolved: vi.fn(async () => () => {}),
  };
});

// The approval-resolved subscriber captured by the onApprovalResolved mock,
// so tests can fire events into the component.
let resolvedSubscriber: ((ev: ApprovalResolvedPayload) => void) | null = null;

function renderChip(sessionId: string | null = "sess-1") {
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
const TRUSTED_NAME_1 =
  "Authorization mode: Request approval. 1 tool trusted for this session";
const TRUSTED_NAME_2 =
  "Authorization mode: Request approval. 2 tools trusted for this session";

/** Opens the Popover and clicks the posture radio matching the given text. */
async function choosePosture(trigger: Element, radioText: RegExp): Promise<void> {
  fireEvent.click(trigger);
  const radio = await screen.findByRole("radio", { name: radioText });
  fireEvent.click(radio);
}

// The happy-path IPC stubs shared by both suites: per-call posture reads,
// empty trust set, captured resolution subscriber. Tests that need other
// answers override per-case via mockResolvedValue.
function stubHappyPath() {
  vi.clearAllMocks();
  resolvedSubscriber = null;
  vi.mocked(getAuthorizationMode).mockResolvedValue("per_call");
  vi.mocked(setAuthorizationMode).mockResolvedValue(undefined);
  vi.mocked(listSessionTrust).mockResolvedValue([]);
  vi.mocked(revokeSessionTrust).mockResolvedValue(undefined);
  vi.mocked(onApprovalResolved).mockImplementation(async (cb) => {
    resolvedSubscriber = cb;
    return () => {};
  });
}

describe("ComposerAuthModeChip (ADR-0080, issue #482)", () => {
  beforeEach(stubHappyPath);

  it("renders the per-call trigger from the session read", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(getAuthorizationMode).toHaveBeenCalledWith("sess-1");
    // The neutral face rides the composer chrome tokens, not the warning hue.
    expect(trigger.className).toContain("bg-card");
    expect(trigger.className).not.toContain("bg-warning");
    // The posture label surfaces in the trigger face.
    expect(trigger).toHaveTextContent("Request approval");
  });

  it("renders the warning-styled trigger when the session is no_confirmation", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const trigger = await screen.findByRole("button", { name: NO_CONFIRM_NAME });
    // ADR-0080: the no-confirmation posture is marked with the --warning
    // token (border / fill / text all consume it).
    expect(trigger.className).toContain("border-warning/40");
    expect(trigger.className).toContain("bg-warning/10");
    expect(trigger.className).toContain("text-warning");
  });

  it("switches per_call -> no_confirmation through the set IPC", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });

    await choosePosture(trigger, /Full access/);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation");
    // The trigger flips once the write lands: warning face.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: NO_CONFIRM_NAME })).toBeInTheDocument(),
    );
  });

  it("switches back no_confirmation -> per_call", async () => {
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");
    renderChip();
    const trigger = await screen.findByRole("button", { name: NO_CONFIRM_NAME });

    await choosePosture(trigger, /Request approval/);

    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "per_call");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: PER_CALL_NAME })).toBeInTheDocument(),
    );
  });

  it("keeps the server posture on a rejected write and resyncs", async () => {
    vi.mocked(setAuthorizationMode).mockRejectedValue(new Error("session gone"));
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });

    await choosePosture(trigger, /Full access/);

    await waitFor(() => expect(setAuthorizationMode).toHaveBeenCalled());
    // The resync refetch lands the backend truth (per_call): the trigger never
    // shows the selected posture.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: PER_CALL_NAME })).toBeInTheDocument(),
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
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });

    await choosePosture(trigger, /Full access/);

    await waitFor(() => expect(screen.getByRole("button", { name: PER_CALL_NAME })).toBeDisabled());
    // The switching guard is held: the set IPC fired exactly once for this
    // single selection, not re-fired while in flight.
    expect(setAuthorizationMode).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: NO_CONFIRM_NAME })).toBeInTheDocument(),
    );
  });

  it("shows the honest default face while the session read is pending", async () => {
    // The read stays pending forever: the trigger still renders the default
    // per-call posture (the backend default), never a blank slot.
    vi.mocked(getAuthorizationMode).mockReturnValue(new Promise(() => {}));
    renderChip();
    expect(
      await screen.findByRole("button", { name: PER_CALL_NAME }),
    ).toBeInTheDocument();
  });

  it("closes the panel on a posture selection", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });
    fireEvent.click(trigger);
    expect(await screen.findByRole("radio", { name: /Full access/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    // Set-and-forget: the selection closes the panel, radios unmount.
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
    expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation");
  });

  it("closes the panel on clicking the already-selected posture", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });
    fireEvent.click(trigger);
    const current = await screen.findByRole("radio", { name: /Request approval/ });
    // Already selected: no onValueChange fires -- the item's own click must
    // still close (the former Select's click-anywhere-to-dismiss feel).
    fireEvent.click(current);
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
    expect(setAuthorizationMode).not.toHaveBeenCalled();
  });

  it("switches the posture with ArrowDown and closes the panel", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });
    fireEvent.click(trigger);
    const radio = await screen.findByRole("radio", { name: /Request approval/ });
    fireEvent.keyDown(radio, { key: "ArrowDown" });
    await waitFor(() =>
      expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation"),
    );
    // The arrow-key selection is a set-and-forget close too.
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
  });
});

describe("ComposerAuthModeChip trust surface (issue #1369)", () => {
  beforeEach(stubHappyPath);

  it("renders no badge and no trust section while the trust set is empty", async () => {
    renderChip();
    const trigger = await screen.findByRole("button", { name: PER_CALL_NAME });
    // Empty set: no count badge on the trigger (zero-noise contract).
    expect(within(trigger).queryByText(/^\d+$/)).toBeNull();

    // And the open panel is the plain posture picker: no trust section.
    fireEvent.click(trigger);
    expect(await screen.findByRole("radio", { name: /Request approval/ })).toBeInTheDocument();
    expect(screen.queryByText(/Trusted tools/)).not.toBeInTheDocument();
  });

  it("shows the count badge, extended aria-label, and the trusted list when non-empty", async () => {
    vi.mocked(listSessionTrust).mockResolvedValue([
      { server: "fs", tool: "read" },
      { server: "db", tool: "query" },
    ]);
    renderChip();
    // The trigger's aria-label extends with the count; the badge shows it.
    const trigger = await screen.findByRole("button", { name: TRUSTED_NAME_2 });
    expect(within(trigger).getByText("2")).toBeInTheDocument();
    // The badge itself is presentational: the count rides the accessible
    // name only, never announced twice.
    expect(within(trigger).getByText("2")).toHaveAttribute("aria-hidden", "true");

    // The panel lists each trusted pair in display shape (muted server,
    // spaced dot, tool subject); the row's title carries the full pair.
    fireEvent.click(trigger);
    expect(await screen.findByText("Trusted tools (2)")).toBeInTheDocument();
    expect(screen.getByTitle("fs · read")).toBeInTheDocument();
    expect(screen.getByTitle("db · query")).toBeInTheDocument();
  });

  it("revokes one tool through the IPC and drops it from the badge and list", async () => {
    vi.mocked(listSessionTrust).mockResolvedValue([
      { server: "fs", tool: "read" },
      { server: "db", tool: "query" },
    ]);
    renderChip();
    const trigger = await screen.findByRole("button", { name: TRUSTED_NAME_2 });
    fireEvent.click(trigger);

    // Revoke the first row (document order = list order): the IPC receives
    // the split server/tool fields.
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    await waitFor(() =>
      expect(revokeSessionTrust).toHaveBeenCalledWith("sess-1", "fs", "read"),
    );
    // The row leaves the list; the badge decrements (ICU plural: one tool).
    await waitFor(() => expect(screen.queryByTitle("fs · read")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: TRUSTED_NAME_1 }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTitle("db · query")).toBeInTheDocument();
  });

  it("refetches the trust set when an always_allow resolution lands, not on other responses", async () => {
    renderChip();
    await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(listSessionTrust).toHaveBeenCalledTimes(1);

    // always_allow is the only response that grows the trust set.
    act(() => {
      resolvedSubscriber?.({
        session_id: "sess-1",
        request_id: "r1",
        response: "always_allow",
      });
    });
    await waitFor(() => expect(listSessionTrust).toHaveBeenCalledTimes(2));

    // deny / allow_once leave it untouched: no refetch.
    act(() => {
      resolvedSubscriber?.({
        session_id: "sess-1",
        request_id: "r2",
        response: "deny",
      });
    });
    await waitFor(() => expect(listSessionTrust).toHaveBeenCalledTimes(2));
  });

  it("ignores always_allow events from other sessions", async () => {
    renderChip("sess-1");
    await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(listSessionTrust).toHaveBeenCalledTimes(1);

    act(() => {
      resolvedSubscriber?.({
        session_id: "sess-other",
        request_id: "r1",
        response: "always_allow",
      });
    });
    // Give the (non-)invalidation a beat: still only the mount read.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(listSessionTrust).toHaveBeenCalledTimes(1);
  });

  it("reads each session's own trust slice", async () => {
    vi.mocked(listSessionTrust).mockImplementation(async (sessionId) =>
      sessionId === "sess-1"
        ? [{ server: "fs", tool: "read" }]
        : [{ server: "db", tool: "query" }, { server: "net", tool: "fetch" }],
    );
    renderChip("sess-1");
    renderChip("sess-2");

    await waitFor(() => expect(listSessionTrust).toHaveBeenCalledWith("sess-1"));
    await waitFor(() => expect(listSessionTrust).toHaveBeenCalledWith("sess-2"));
    // Each chip reflects its own session only.
    expect(await screen.findByRole("button", { name: TRUSTED_NAME_1 })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Authorization mode: Request approval. 2 tools trusted for this session",
      }),
    ).toBeInTheDocument();
  });

  it("sends no trust IPC on the cold-start bar (null sessionId)", async () => {
    renderChip(null);
    await screen.findByRole("button", { name: PER_CALL_NAME });
    expect(getAuthorizationMode).not.toHaveBeenCalled();
    expect(listSessionTrust).not.toHaveBeenCalled();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("keeps the panel open on Tab and leaves the revoke buttons reachable", async () => {
    vi.mocked(listSessionTrust).mockResolvedValue([{ server: "fs", tool: "read" }]);
    renderChip();
    const trigger = await screen.findByRole("button", { name: TRUSTED_NAME_1 });
    fireEvent.click(trigger);
    const radio = await screen.findByRole("radio", { name: /Request approval/ });
    fireEvent.keyDown(radio, { key: "Tab" });
    // The panel stays open (the former Select swallowed Tab)...
    expect(screen.getByRole("radio", { name: /Request approval/ })).toBeInTheDocument();
    // ...and the trust rows sit after the radios, focusable -- Tab walks in.
    const revoke = screen.getByRole("button", { name: "Revoke" });
    expect(revoke.tabIndex).toBeGreaterThanOrEqual(0);
    revoke.focus();
    expect(document.activeElement).toBe(revoke);
  });

  it("logs a warning when the trust read rejects", async () => {
    vi.mocked(listSessionTrust).mockRejectedValue(new Error("ipc gone"));
    const warnSpy = vi.spyOn(log, "warn");
    renderChip();
    // The chip settles on the empty-set face (no badge, no section)...
    await screen.findByRole("button", { name: PER_CALL_NAME });
    // ...but the operator can tell a failed read from a real empty set.
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "ComposerAuthModeChip",
        "session-trust read failed; showing empty set",
        expect.any(String),
      ),
    );
    vi.restoreAllMocks();
  });

  it("keeps the row and resyncs when the revoke rejects", async () => {
    vi.mocked(listSessionTrust).mockResolvedValue([
      { server: "fs", tool: "read" },
      { server: "db", tool: "query" },
    ]);
    let rejectRevoke: (e: Error) => void = () => {};
    vi.mocked(revokeSessionTrust).mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectRevoke = reject;
        }),
    );
    renderChip();
    const trigger = await screen.findByRole("button", { name: TRUSTED_NAME_2 });
    fireEvent.click(trigger);
    const revokeBtn = screen.getAllByRole("button", { name: "Revoke" })[0];
    fireEvent.click(revokeBtn);
    await waitFor(() =>
      expect(revokeSessionTrust).toHaveBeenCalledWith("sess-1", "fs", "read"),
    );
    // In flight: only that row's button gates.
    await waitFor(() => expect(revokeBtn).toBeDisabled());
    expect(screen.getAllByRole("button", { name: "Revoke" })[1]).toBeEnabled();
    rejectRevoke(new Error("revoke refused"));
    // The row REMAINS (the backend still trusts it) and the chip resyncs:
    // the mount read plus the catch-path refetch.
    await waitFor(() => expect(listSessionTrust).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(revokeBtn).toBeEnabled());
    expect(screen.getByTitle("fs · read")).toBeInTheDocument();
  });
});
