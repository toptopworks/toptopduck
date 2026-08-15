import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { LocalCliTab } from "../LocalCliTab";
import { listAdapters, rescanAdapters, probeAdapter, getAdapterCatalogs } from "../../../api";
import type { AdapterEntry, AdapterCatalogs, DiscoveredRuntime, ProbeOk } from "../../../types/runtime";
import { adapterKeys } from "../../../session/queryKeys";
import { renderSettings } from "./helpers";

// Local CLI tab tests (issue #534/#535, ADR-0096): the diagnostic probe
// surface -- the per-adapter Test button (rendered for every detected
// adapter, both formats), the in-flight disable + close-guard busy report,
// and the result rendering (per-format catalog on success, kind-dispatched
// error on failure). The tab's list / rescan surface is covered by
// RuntimeSection.test.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listAdapters: vi.fn(),
    rescanAdapters: vi.fn(),
    probeAdapter: vi.fn(),
    getAdapterCatalogs: vi.fn(),
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

// The per-format tagged success shapes (mirror the Rust ProbeOk wire form).
const acpOk: ProbeOk = { kind: "acp", data: { discovered: okCatalog } };

const codexAvailable: ProbeOk = {
  kind: "codex",
  data: {
    outcome: {
      status: "available",
      models: [
        { id: "gpt-5.2-codex", display_name: "GPT-5.2 Codex", is_default: true, default_reasoning_effort: "medium", supported_reasoning_efforts: ["low", "medium", "high"] },
        { id: "gpt-5.1-codex-mini", display_name: "GPT-5.1 Codex Mini", is_default: false, default_reasoning_effort: "low", supported_reasoning_efforts: ["low"] },
      ],
    },
  },
};

const codexUnavailable: ProbeOk = {
  kind: "codex",
  data: { outcome: { status: "unavailable", detail: "method not found" } },
};

const codexEmpty: ProbeOk = {
  kind: "codex",
  data: { outcome: { status: "available", models: [] } },
};

function renderTab(onIpcBusy = vi.fn()) {
  // The returned queryClient lets the catalog-cache tests assert actual
  // setQueryData writes (the probe mirror), not just their render absence.
  return renderSettings(<LocalCliTab onIpcBusy={onIpcBusy} />);
}

// A function matcher over full <p> text: getByText's default matcher only
// sees DIRECT text nodes, but the folded lines mix FormattedMessage spans +
// sibling text (the react-intl span pitfall) -- match on the joined
// paragraph content instead. Shared by both describes (the probe + the
// catalog-cache suites render the same folded lines).
const byFoldedText = (fragment: string) =>
  (_: unknown, element: Element | null) =>
    element?.tagName === "P" && element.textContent?.includes(fragment) === true;

/** Click the first Test button (claude-code's row -- the first detected
 *  adapter). Every detected adapter now offers the button, so a singular
 *  findByRole would be ambiguous. */
async function clickTestButton() {
  const buttons = await screen.findAllByRole("button", { name: "Test" });
  fireEvent.click(buttons[0]);
}

describe("LocalCliTab probe (issue #534/#535, ADR-0096)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
  });

  // --- Button rendering ----------------------------------------------------

  it("renders the Test button for detected adapters of either format", async () => {
    renderTab();
    // claude-code (acp) + codex (json_event_stream) each get one button; the
    // undetected gemini-cli gets none.
    const buttons = await screen.findAllByRole("button", { name: "Test" });
    expect(buttons).toHaveLength(2);
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

    await clickTestButton();
    const busy = (await screen.findAllByRole("button", { name: "Test" }))[0];
    expect(busy).toBeDisabled();
    expect(onIpcBusy).toHaveBeenCalledWith("probe", true);

    release(acpOk);
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect((await screen.findAllByRole("button", { name: "Test" }))[0]).toBeEnabled();
  });

  it("reports busy=false even when the probe rejects", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    const onIpcBusy = vi.fn();
    renderTab(onIpcBusy);

    await clickTestButton();
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect((await screen.findAllByRole("button", { name: "Test" }))[0]).toBeEnabled();
  });

  // The busy report is a count mirror, not a boolean mirror: the first probe
  // to settle must NOT clear the channel while the second is still in flight
  // (the close guard would open early, ADR-0075).
  it("keeps busy=true while any of two concurrent probes is in flight", async () => {
    const released: Array<(v: ProbeOk) => void> = [];
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { released.push(resolve); }),
    );
    vi.mocked(listAdapters).mockResolvedValue([
      mockAdapters[0],
      { ...mockAdapters[0], id: "opencode", display_name: "opencode", binary_path: "/usr/local/bin/opencode" },
    ]);
    const onIpcBusy = vi.fn();
    renderTab(onIpcBusy);

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onIpcBusy).toHaveBeenCalledWith("probe", true);
    expect(onIpcBusy).not.toHaveBeenCalledWith("probe", false);

    // First probe settles: the channel must stay busy (the second is alive).
    released[0](acpOk);
    await screen.findAllByRole("button", { name: "Test" });
    expect(onIpcBusy).not.toHaveBeenCalledWith("probe", false);

    // Second settles: now the channel goes quiet.
    released[1](acpOk);
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
  });

  // --- Success rendering ---------------------------------------------------

  it("renders the ACP catalog under the row on success", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(byFoldedText("low, medium, high (medium)")),
    ).toBeInTheDocument();
  });

  it("renders the codex per-model catalog under the row on success", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexAvailable);
    renderTab();

    // The codex row is the second adapter -- click its button specifically.
    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default): low, medium, high")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(byFoldedText("GPT-5.1 Codex Mini: low")),
    ).toBeInTheDocument();
  });

  it("renders the degraded codex state under the row", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexUnavailable);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(
        byFoldedText("Started, but the model catalog is unavailable. (method not found)"),
      ),
    ).toBeInTheDocument();
  });

  it("renders an honest line for an empty available codex catalog", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexEmpty);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(byFoldedText("Started, but no models were reported.")),
    ).toBeInTheDocument();
  });

  // --- Failure rendering ---------------------------------------------------

  it.each([
    [{ kind: "Timeout" }, "The probe timed out."],
    [{ kind: "SpawnFailure", data: "failed to spawn ACP agent" }, "Failed to start the CLI."],
    [{ kind: "HandshakeFailure", data: "initialize: empty response" }, "Handshake with the CLI failed."],
    [{ kind: "NotDetected", data: "claude-code" }, "Adapter is not detected."],
  ])("renders the %s failure as an error line", async (rejection, expected) => {
    vi.mocked(probeAdapter).mockRejectedValue(rejection);
    renderTab();

    await clickTestButton();
    expect(await screen.findByText(byFoldedText(expected))).toBeInTheDocument();
  });

  it("renders the technical detail verbatim inside the folded error", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({
      kind: "HandshakeFailure",
      data: "session/new error: boom",
    });
    renderTab();

    await clickTestButton();
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

    await clickTestButton();
    expect(
      await screen.findByText(
        byFoldedText(
          "The probe request could not reach the CLI (internal error). (Error: transport exploded)",
        ),
      ),
    ).toBeInTheDocument();
  });

  // A reject carrying a `kind` outside the backend's refusal set (frontend /
  // backend skew) must degrade the same way -- never reach ProbeErrorText's
  // contract-break throw, which would take down the whole shell.
  it("renders an unknown kind as unreachable instead of throwing", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "SomeFutureKind" });
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(
        byFoldedText("The probe request could not reach the CLI (internal error)."),
      ),
    ).toBeInTheDocument();
  });

  // Re-probing after a failure replaces the error row with the catalog (the
  // per-id state overwrite -- old results never linger under a new one).
  it("replaces a failed result with the catalog on a successful re-probe", async () => {
    vi.mocked(probeAdapter)
      .mockRejectedValueOnce({ kind: "HandshakeFailure", data: "initialize: empty response" })
      .mockResolvedValueOnce(acpOk);
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("Handshake with the CLI failed.")),
    ).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole("button", { name: "Test" }))[0]);
    expect(
      await screen.findByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)")),
    ).toBeInTheDocument();
    expect(screen.queryByText(byFoldedText("Handshake with the CLI failed."))).toBeNull();
  });
});

// --- Catalog cache consumption (issue #536, ADR-0096 D5) --------------------

describe("LocalCliTab catalog cache (issue #536)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
  });

  // The restart read: a cache entry (written by a previous app run's probe)
  // renders on the idle row through the same per-format components, plus the
  // "Last tested" timestamp line.
  it("renders a cached ACP entry with its timestamp on the idle row", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "claude-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    renderTab();

    expect(
      await screen.findByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)")),
    ).toBeInTheDocument();
    expect(screen.getByText(byFoldedText("Last tested"))).toBeInTheDocument();
  });

  it("renders a cached codex entry on the idle row", async () => {
    const outcome = codexAvailable.data.outcome;
    if (outcome.status !== "available") throw new Error("fixture shape");
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "codex",
        outcome: { codex: { models: outcome.models } },
        probed_at_millis: 0,
      },
    });
    renderTab();

    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default): low, medium, high")),
    ).toBeInTheDocument();
  });

  // An adapter with no cached entry (never tested) renders nothing -- the
  // cache never fabricates a row state.
  it("renders nothing for an adapter with no cached entry", async () => {
    renderTab();

    await screen.findAllByRole("button", { name: "Test" });
    expect(screen.queryByText(byFoldedText("Last tested"))).toBeNull();
    expect(
      screen.queryByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)")),
    ).toBeNull();
  });

  // A successful probe mirrors its entry into the query cache immediately:
  // the timestamped cached rendering shows after the fresh result row, with
  // no extra IPC round-trip. Asserted directly against the query cache -- a
  // call-count assertion alone cannot detect the mirror write being deleted.
  it("shows the cached entry immediately after a successful ACP probe", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    const { queryClient } = renderTab();

    await clickTestButton();
    await screen.findByText(byFoldedText("fake-opus, fake-sonnet (fake-opus)"));
    const cached = queryClient.getQueryData<AdapterCatalogs>(adapterKeys.catalogs());
    expect(cached?.["claude-code"]).toBeDefined();
    expect(cached?.["claude-code"].probe_kind).toBe("acp");
    // The mirror is a setQueryData write, not an invalidation: the sidecar
    // read is not re-fetched.
    expect(getAdapterCatalogs).toHaveBeenCalledTimes(1);
  });

  // The degraded codex outcome is NOT cached (only a usable catalog is a
  // cache point, ADR-0096 D5) -- the query cache must stay untouched.
  it("does not mirror a degraded codex outcome into the cache", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexUnavailable);
    const { queryClient } = renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    await screen.findByText(
      byFoldedText("Started, but the model catalog is unavailable. (method not found)"),
    );
    // No codex entry landed in the query cache (the mirror skipped the
    // degraded outcome), and the display never shows a cached row.
    const cached = queryClient.getQueryData<AdapterCatalogs>(adapterKeys.catalogs());
    expect(cached?.codex).toBeUndefined();
    expect(screen.queryByText(byFoldedText("Last tested"))).toBeNull();
  });
});
