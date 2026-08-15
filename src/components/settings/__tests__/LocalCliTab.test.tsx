import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { LocalCliTab } from "../LocalCliTab";
import { listAdapters, rescanAdapters, probeAdapter } from "../../../api";
import type { AdapterEntry, DiscoveredRuntime, ProbeOk } from "../../../types/runtime";
import { renderSettings } from "./helpers";

// Local CLI tab tests (issue #534, ADR-0096): the diagnostic probe surface --
// the per-adapter Test button (rendered only for detected ACP adapters), the
// in-flight disable + close-guard busy report, and the result rendering
// (catalog on success, kind-dispatched error on failure). The tab's list /
// rescan surface is covered by RuntimeSection.test.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listAdapters: vi.fn(),
    rescanAdapters: vi.fn(),
    probeAdapter: vi.fn(),
  };
});

const mockAdapters: AdapterEntry[] = [
  { id: "claude-code", display_name: "claude-code", detected: true, binary_path: "/usr/local/bin/claude", stream_format: "acp" },
  { id: "codex", display_name: "codex", detected: true, binary_path: "/usr/local/bin/codex", stream_format: "json_event_stream" },
  { id: "gemini-cli", display_name: "gemini-cli", detected: false, binary_path: null, stream_format: "acp" },
];

const okCatalog: DiscoveredRuntime = {
  models: ["fake-opus", "fake-sonnet"],
  current_model: "fake-opus",
  thought_levels: ["low", "medium", "high"],
  current_thought_level: "medium",
  adapter_id: "claude-code",
};

function renderTab(onIpcBusy = vi.fn()) {
  return renderSettings(<LocalCliTab onIpcBusy={onIpcBusy} />);
}

describe("LocalCliTab probe (issue #534, ADR-0096)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
  });

  // --- Button rendering ----------------------------------------------------

  it("renders the Test button only for detected ACP adapters", async () => {
    renderTab();
    // claude-code (detected + acp) gets exactly one button.
    const row = (await screen.findByText("claude-code")).closest("div");
    expect(row).not.toBeNull();
    const buttons = await screen.findAllByRole("button", { name: "Test" });
    expect(buttons).toHaveLength(1);
    // codex (json_event_stream) + gemini-cli (undetected) get none.
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("gemini-cli")).toBeInTheDocument();
  });

  // --- In-flight contract --------------------------------------------------

  it("disables the button and reports busy while the probe is in flight", async () => {
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const onIpcBusy = vi.fn();
    renderTab(onIpcBusy);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    const busy = screen.getByRole("button", { name: "Test" });
    expect(busy).toBeDisabled();
    expect(onIpcBusy).toHaveBeenCalledWith("probe", true);

    release({ discovered: okCatalog });
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });

  it("reports busy=false even when the probe rejects", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    const onIpcBusy = vi.fn();
    renderTab(onIpcBusy);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });

  // --- Success rendering ---------------------------------------------------

  // A function matcher over full <p> text: getByText's default matcher only
  // sees DIRECT text nodes, but the folded lines mix FormattedMessage spans +
  // sibling text (the react-intl span pitfall) -- match on the joined
  // paragraph content instead.
  const byFoldedText = (fragment: string) =>
    (_: unknown, element: Element | null) =>
      element?.tagName === "P" && element.textContent?.includes(fragment) === true;

  it("renders the discovered catalog under the row on success", async () => {
    vi.mocked(probeAdapter).mockResolvedValue({ discovered: okCatalog });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(
      await screen.findByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(byFoldedText("low, medium, high (medium)")),
    ).toBeInTheDocument();
  });

  // --- Failure rendering ---------------------------------------------------

  it.each([
    [{ kind: "Timeout" }, "The probe timed out."],
    [{ kind: "SpawnFailure", data: "failed to spawn ACP agent" }, "Failed to start the CLI."],
    [{ kind: "HandshakeFailure", data: "initialize: empty response" }, "Handshake with the CLI failed."],
    [{ kind: "NotDetected", data: "claude-code" }, "Adapter is not detected."],
    [{ kind: "Unsupported", data: "codex" }, "Probing this adapter is not supported yet."],
  ])("renders the %s failure as an error line", async (rejection, expected) => {
    vi.mocked(probeAdapter).mockRejectedValue(rejection);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(await screen.findByText(byFoldedText(expected))).toBeInTheDocument();
  });

  it("renders the technical detail verbatim inside the folded error", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({
      kind: "HandshakeFailure",
      data: "session/new error: boom",
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(
      await screen.findByText(
        byFoldedText("Handshake with the CLI failed. (session/new error: boom)"),
      ),
    ).toBeInTheDocument();
  });

  // A non-shaped reject (harness / transport fault) never reached the CLI --
  // it must not masquerade as a handshake failure.
  it("renders a non-shaped rejection as unreachable, not a handshake failure", async () => {
    vi.mocked(probeAdapter).mockRejectedValue(new Error("transport exploded"));
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(
      await screen.findByText(
        byFoldedText(
          "The probe request could not reach the CLI (internal error). (Error: transport exploded)",
        ),
      ),
    ).toBeInTheDocument();
  });
});
