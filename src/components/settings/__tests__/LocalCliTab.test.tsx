import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { LocalCliTab } from "../LocalCliTab";
import { listAdapters, rescanAdapters, probeAdapter, getAdapterCatalogs } from "../../../api";
import type { AdapterEntry, AdapterCatalogs, DiscoveredRuntime, ProbeOk } from "../../../types/runtime";
import { adapterKeys } from "../../../session/queryKeys";
import { renderSettings } from "./helpers";

// Local CLI tab tests (issue #534/#535, ADR-0096; fold contract issue #552):
// the diagnostic probe surface -- the per-adapter Test button (rendered for
// every detected adapter, both formats), the in-flight disable + close-guard
// busy report, the result rendering (per-format catalog on success,
// kind-dispatched error on failure), and the fold: the collapsed row carries
// only summary badges, the chevron toggles, and a probe success auto-expands.
// The tab's list / rescan surface is covered by RuntimeSection.test.

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
  { id: "qwen-code", display_name: "qwen-code", detected: true, binary_path: "/usr/local/bin/qwen", stream_format: "acp" },
  { id: "codex", display_name: "codex", detected: true, binary_path: "/usr/local/bin/codex", stream_format: "json_event_stream" },
  { id: "gemini-cli", display_name: "gemini-cli", detected: false, binary_path: null, stream_format: "acp" },
];

const okCatalog: DiscoveredRuntime = {
  models: ["fake-opus", "fake-sonnet"],
  current_model: "fake-opus",
  thought_levels: ["low", "medium", "high"],
  current_thought_level: "medium",
  adapter_id: "qwen-code",
};

// The per-format tagged success shapes (mirror the Rust ProbeOk wire form).
const acpOk: ProbeOk = { kind: "acp", data: { discovered: okCatalog } };

const codexAvailable: ProbeOk = {
  kind: "json_event_stream",
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
  kind: "json_event_stream",
  data: { outcome: { status: "unavailable", detail: "method not found" } },
};

const codexEmpty: ProbeOk = {
  kind: "json_event_stream",
  data: { outcome: { status: "available", models: [] } },
};

function renderTab(onIpcBusy = vi.fn()) {
  // The returned queryClient lets the catalog-cache tests assert actual
  // setQueryData writes (the probe mirror), not just their render absence.
  return renderSettings(<LocalCliTab onIpcBusy={onIpcBusy} />);
}

// A function matcher over full line text: getByText's default matcher only
// sees DIRECT text nodes, but the folded lines mix FormattedMessage spans +
// sibling text (the react-intl span pitfall) -- match on the joined line
// content instead. The innermost rule (no child element also contains the
// fragment) keeps it unique: since issue #552 the catalog lines are DIVs
// whose DIV ancestors' textContent would otherwise match too.
const byFoldedText = (fragment: string) =>
  (_: unknown, element: Element | null) =>
    element?.textContent?.includes(fragment) === true &&
    !Array.from(element.children).some(
      (c) => c.textContent?.includes(fragment) === true,
    );

/** Click the first Test button (qwen-code's row -- the first detected
 *  adapter). Every detected adapter now offers the button, so a singular
 *  findByRole would be ambiguous. */
async function clickTestButton() {
  const buttons = await screen.findAllByRole("button", { name: "Test" });
  fireEvent.click(buttons[0]);
}

/** The fold chevron for one adapter row (aria-label = the row name, the
 *  MCP-row pattern). Awaited: the chevron only exists once the row has
 *  fold content (probed or cached) -- after a probe settles it appears on
 *  the next render, so a sync getBy would race the state update. */
async function rowChevron(name: string) {
  return screen.findByRole("button", { name });
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
    // qwen-code (acp) + codex (json_event_stream) each get one button; the
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
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(onIpcBusy).toHaveBeenCalledWith("probe", true);

    release(acpOk);
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect((await screen.findAllByRole("button", { name: "Test" }))[0]).not.toHaveAttribute("aria-disabled");
  });

  it("reports busy=false even when the probe rejects", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    const onIpcBusy = vi.fn();
    renderTab(onIpcBusy);

    await clickTestButton();
    await waitFor(() => expect(onIpcBusy).toHaveBeenCalledWith("probe", false));
    expect((await screen.findAllByRole("button", { name: "Test" }))[0]).not.toHaveAttribute("aria-disabled");
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

  // --- Success rendering (auto-expanded by the fold contract) --------------

  it("renders the ACP catalog under the row on success", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    // Exact matches pin the per-line structure: the default matcher joins
    // only direct text nodes, so a marker moved outside the span (the wrap
    // bug this issue fixes), a re-joined single line, or a marker on the
    // non-current model all fail these.
    expect(screen.getByText("fake-opus (default)")).toBeInTheDocument();
    expect(screen.getByText("fake-sonnet")).toBeInTheDocument();
    // Thought levels render as badges with the current value marked
    // (issue #552 effort badge group).
    expect(screen.getByText("medium (default)")).toBeInTheDocument();
  });

  it("hides the thought-level row when the ACP catalog carried none", async () => {
    vi.mocked(probeAdapter).mockResolvedValue({
      kind: "acp",
      data: {
        discovered: {
          ...okCatalog,
          thought_levels: [],
          current_thought_level: null,
        },
      },
    });
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    // No levels means no thought-level row at all -- no label, no "—".
    expect(screen.queryByText(byFoldedText("Thought levels"))).toBeNull();
  });

  it("renders the honest no-models line and keeps an unmatched current model visible", async () => {
    vi.mocked(probeAdapter).mockResolvedValue({
      kind: "acp",
      data: {
        discovered: {
          ...okCatalog,
          models: [],
          current_model: "fake-retired",
        },
      },
    });
    renderTab();

    await clickTestButton();
    // An empty catalog renders the same honest line as the codex shape --
    // the probe succeeded, and that fact must not vanish into a bare "—".
    expect(
      await screen.findByText(byFoldedText("Started, but no models were reported.")),
    ).toBeInTheDocument();
    // The current model the empty list did not include still shows on its
    // own line -- losing it would read as "no default reported".
    expect(
      screen.getByText(byFoldedText("Current model: fake-retired")),
    ).toBeInTheDocument();
    // No badge for an empty catalog.
    expect(screen.queryByText("2 models")).toBeNull();
  });

  it("marks no line and keeps the current model visible when it is outside the list", async () => {
    vi.mocked(probeAdapter).mockResolvedValue({
      kind: "acp",
      data: {
        discovered: {
          ...okCatalog,
          current_model: "fake-retired",
        },
      },
    });
    renderTab();

    await clickTestButton();
    // The advertised lines carry no marker (identity match only)...
    expect(await screen.findByText("fake-opus")).toBeInTheDocument();
    expect(screen.getByText("fake-sonnet")).toBeInTheDocument();
    expect(screen.queryByText("fake-opus (default)")).toBeNull();
    // ...and the stale current model still renders on its own line.
    expect(
      screen.getByText(byFoldedText("Current model: fake-retired")),
    ).toBeInTheDocument();
  });

  it("collapses duplicate model ids into one line", async () => {
    // The backend flattens config options without dedup, so the same id can
    // arrive twice -- one line per model, not one key-colliding row per entry.
    vi.mocked(probeAdapter).mockResolvedValue({
      kind: "acp",
      data: {
        discovered: {
          ...okCatalog,
          models: ["fake-opus", "fake-opus", "fake-sonnet"],
        },
      },
    });
    renderTab();

    await clickTestButton();
    await screen.findByText("fake-opus (default)");
    expect(screen.getAllByText("fake-opus (default)")).toHaveLength(1);
    expect(screen.getAllByText("fake-sonnet")).toHaveLength(1);
  });

  it("renders the codex per-model catalog under the row on success", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexAvailable);
    renderTab();

    // The codex row is the second adapter -- click its button specifically.
    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default):")),
    ).toBeInTheDocument();
  });

  it("renders a model line without badges when the model supports no efforts", async () => {
    vi.mocked(probeAdapter).mockResolvedValue({
      kind: "json_event_stream",
      data: {
        outcome: {
          status: "available",
          models: [
            {
              id: "no-effort-model",
              display_name: "No-Effort Model",
              is_default: false,
              default_reasoning_effort: "",
              supported_reasoning_efforts: [],
            },
          ],
        },
      },
    });
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    // The line is the model name alone: no colon, no badge group.
    expect(
      await screen.findByText(byFoldedText("No-Effort Model")),
    ).toBeInTheDocument();
    expect(screen.queryByText(byFoldedText("No-Effort Model:"))).toBeNull();
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
    [{ kind: "NotDetected", data: "qwen-code" }, "Adapter is not detected."],
  ])("renders the %s failure as an error line", async (rejection, expected) => {
    vi.mocked(probeAdapter).mockRejectedValue(rejection);
    renderTab();

    await clickTestButton();
    // The failure row stays collapsed -- the error lives in the fold; expand
    // it to read the detail (the collapsed row shows the red badge).
    fireEvent.click(await rowChevron("qwen-code"));
    expect(await screen.findByText(byFoldedText(expected))).toBeInTheDocument();
  });

  it("renders the technical detail verbatim inside the folded error", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({
      kind: "HandshakeFailure",
      data: "session/new error: boom",
    });
    renderTab();

    await clickTestButton();
    fireEvent.click(await rowChevron("qwen-code"));
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
    fireEvent.click(await rowChevron("qwen-code"));
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
    fireEvent.click(await rowChevron("qwen-code"));
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
    fireEvent.click(await rowChevron("qwen-code"));
    expect(
      await screen.findByText(byFoldedText("Handshake with the CLI failed.")),
    ).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole("button", { name: "Test" }))[0]);
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
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
  // renders on the idle row through the same per-format components -- after
  // the user expands the collapsed row.
  it("renders a cached ACP entry on the idle row", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    renderTab();
    await screen.findAllByRole("button", { name: "Test" });

    // Collapsed by default: the directory is not in the DOM.
    expect(screen.queryByText(byFoldedText("fake-opus (default)"))).toBeNull();

    fireEvent.click(await rowChevron("qwen-code"));
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    // No "Last tested" line in the fold -- the probe time rides the Test
    // button's hover tooltip only (issue #559).
    expect(screen.queryByText(byFoldedText("Last tested"))).toBeNull();
  });

  it("renders a cached codex entry on the idle row", async () => {
    const outcome = codexAvailable.data.outcome;
    if (outcome.status !== "available") throw new Error("fixture shape");
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "json_event_stream",
        outcome: { json_event_stream: { models: outcome.models } },
        probed_at_millis: 0,
      },
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "codex" }));
    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default):")),
    ).toBeInTheDocument();
  });

  // An adapter with no cached entry (never tested) has no fold at all --
  // the cache never fabricates a row state, and the chevron stays absent.
  it("renders nothing for an adapter with no cached entry", async () => {
    renderTab();

    await screen.findAllByRole("button", { name: "Test" });
    expect(screen.queryByRole("button", { name: "qwen-code" })).toBeNull();
    expect(
      screen.queryByText(byFoldedText("fake-opus (default)")),
    ).toBeNull();
  });

  // A successful probe mirrors its entry into the query cache immediately
  // with no extra IPC round-trip. Asserted directly against the query
  // cache -- a call-count assertion alone cannot detect the mirror write
  // being deleted.
  it("shows the cached entry immediately after a successful ACP probe", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    const { queryClient } = renderTab();

    await clickTestButton();
    await screen.findByText(byFoldedText("fake-opus (default)"));
    const cached = queryClient.getQueryData<AdapterCatalogs>(adapterKeys.catalogs());
    expect(cached?.["qwen-code"]).toBeDefined();
    expect(cached?.["qwen-code"].probe_kind).toBe("acp");
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
    // The unavailable outcome auto-expanded the row -- the honest line is
    // already visible without a chevron click.
    await screen.findByText(
      byFoldedText("Started, but the model catalog is unavailable. (method not found)"),
    );
    // No codex entry landed in the query cache (the mirror skipped the
    // degraded outcome).
    const cached = queryClient.getQueryData<AdapterCatalogs>(adapterKeys.catalogs());
    expect(cached?.codex).toBeUndefined();
  });
});

// --- Fold contract (issue #552) ----------------------------------------------

describe("LocalCliTab fold (issue #552)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
  });

  // --- Fold contract -------------------------------------------------------

  it("starts collapsed and toggles open and closed via the chevron", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    renderTab();
    const chevron = await screen.findByRole("button", { name: "qwen-code" });

    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(byFoldedText("fake-opus (default)"))).toBeNull();

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(byFoldedText("fake-opus (default)"))).toBeInTheDocument();

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(byFoldedText("fake-opus (default)"))).toBeNull();
  });

  // --- Chevron existence: only rows with fold content get a toggle ----------

  it("renders no chevron for untested rows (idle without cache)", async () => {
    renderTab();

    await screen.findAllByRole("button", { name: "Test" });
    expect(screen.queryByRole("button", { name: "qwen-code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "codex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "gemini-cli" })).toBeNull();
  });

  it("renders no chevron while probing, and one after the probe settles", async () => {
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderTab();

    await clickTestButton();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Test" })[0]).toHaveAttribute("aria-disabled", "true"),
    );
    // Mid-flight: the probe has no content yet -- no dead toggle.
    expect(screen.queryByRole("button", { name: "qwen-code" })).toBeNull();
    release(acpOk);

    // Settled: the chevron appears and the auto-expand already opened it.
    const chevron = await screen.findByRole("button", { name: "qwen-code" });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a chevron for a failed probe even with no cache", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    renderTab();

    await clickTestButton();
    const chevron = await screen.findByRole("button", { name: "qwen-code" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    // Collapsed (failure never auto-expands); expanding reveals the error.
    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText(byFoldedText("The probe timed out.")),
    ).toBeInTheDocument();
  });

  // --- Auto-expand on success -----------------------------------------------

  it("auto-expands the row after a successful ACP probe", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    expect(await rowChevron("qwen-code")).toHaveAttribute("aria-expanded", "true");
  });

  it("auto-expands the row after a successful codex probe", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexAvailable);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default):")),
    ).toBeInTheDocument();
    expect(await rowChevron("codex")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the fold state through a failed probe", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "HandshakeFailure", data: "boom" });
    renderTab();

    // The row starts chevron-less (never tested); the failed probe leaves
    // it collapsed -- the red badge is the summary, the fold hides the
    // detail until the user expands.
    await clickTestButton();
    const chevron = await rowChevron("qwen-code");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByText("Test failed")).toBeInTheDocument();

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText(byFoldedText("Handshake with the CLI failed. (boom)")),
    ).toBeInTheDocument();
  });

  it("keeps the row expanded when re-probing an expanded row", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    renderTab();

    await clickTestButton();
    const chevron = await rowChevron("qwen-code");
    await screen.findByText(byFoldedText("fake-opus (default)"));

    fireEvent.click((await screen.findAllByRole("button", { name: "Test" }))[0]);
    // This case seeds no cache, so the mid-flight fold is empty -- the row
    // stays expanded, the chevron stays mounted (issue #554: an expanded row
    // never unmounts its toggle mid-flight), and the settled result
    // re-renders in place.
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    await screen.findByText(byFoldedText("fake-opus (default)"));
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  // Issue #554: the chevron's render condition is hasFoldContent || expanded
  // -- an already-expanded row keeps its toggle through the mid-flight state
  // even when the fold itself goes empty (a failed no-cache row re-probing:
  // probing clears the fold, but the visible chevron must not flicker away).
  it("keeps the chevron mounted mid-flight when an expanded no-cache row re-probes", async () => {
    // Seed a failure first so the row gains fold content and can be expanded.
    vi.mocked(probeAdapter).mockRejectedValueOnce({ kind: "Timeout" });
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderTab();

    await clickTestButton();
    const chevron = await rowChevron("qwen-code");
    fireEvent.click(chevron);
    expect(
      await screen.findByText(byFoldedText("The probe timed out.")),
    ).toBeInTheDocument();

    // Re-probe: the fold empties (no cache, status probing), but the
    // expanded row keeps its chevron and aria-expanded stays true.
    await clickTestButton();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Test" })[0]).toHaveAttribute("aria-disabled", "true"),
    );
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    release(acpOk);
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  // The mid-flight staleness contract (issue #554, locked decision): an
  // expanded row WITH a cached entry keeps showing the stale CachedCatalog
  // while probing -- the badge layer clears the stale count, but the fold
  // keeps the directory readable. The spinner on the Test button is the
  // probing cue, and the button stays hoverable while probing
  // (aria-disabled), so the tooltip's last-tested time remains consultable.
  it("keeps the stale cached catalog in the expanded fold while re-probing", async () => {
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    renderTab();

    // Expand the idle+cache row, then start a re-probe.
    fireEvent.click(await rowChevron("qwen-code"));
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();

    await clickTestButton();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Test" })[0]).toHaveAttribute("aria-disabled", "true"),
    );
    // Badge layer: the stale count is gone mid-flight (the pre-existing
    // contract). Fold layer: the stale catalog stays.
    expect(screen.queryByText("2 models")).toBeNull();
    expect(
      screen.getByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    const chevron = await rowChevron("qwen-code");
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    // Resolve with a DIFFERENT catalog so the settled render is
    // distinguishable from the stale one (same text would let a sync
    // first-check waitFor pass against the pre-release DOM). The settled ok
    // branch renders ProbeResult -- the fold shows the fresh catalog.
    release({
      kind: "acp",
      data: {
        discovered: { ...okCatalog, models: ["fake-opus", "fake-new"] },
      },
    });
    expect(
      await screen.findByText(byFoldedText("fake-new")),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(byFoldedText("fake-sonnet")),
    ).toBeNull();
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  // --- Collapsed-row badges -------------------------------------------------

  it("shows an N models badge on a collapsed row with a cached entry", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: 0,
      },
    });
    renderTab();

    expect(await screen.findByText("2 models")).toBeInTheDocument();
  });

  it("shows an N models badge on a collapsed ok row, replacing the stale cache count", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "json_event_stream",
        outcome: { json_event_stream: { models: [] } },
        probed_at_millis: 0,
      },
    });
    vi.mocked(probeAdapter).mockResolvedValue(codexAvailable);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(await screen.findByText("2 models")).toBeInTheDocument();
    expect(screen.queryByText("0 models")).toBeNull();
  });

  it("shows a red Test failed badge after a failed probe", async () => {
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    renderTab();

    await clickTestButton();
    const badge = await screen.findByText("Test failed");
    expect(badge.closest("[data-slot=badge]")).toHaveClass("bg-destructive");
    // The Test buttons stay beside the badge (the badge replaces the N
    // models summary slot, never the actions).
    expect((await screen.findAllByRole("button", { name: "Test" })).length).toBeGreaterThan(0);
  });

  // A failed probe outranks the cached count on every surface: the red badge
  // replaces the stale `N models` and the fold carries the error line, never
  // the stale catalog (the ternary ordering + directoryModelCount's failed
  // null enforce it -- this pins it).
  it("replaces a stale cached count with the failure badge when a re-probe fails", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: 0,
      },
    });
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    renderTab();

    // The idle+cache badge is the pre-state.
    expect(await screen.findByText("2 models")).toBeInTheDocument();

    await clickTestButton();
    expect(await screen.findByText("Test failed")).toBeInTheDocument();
    expect(screen.queryByText("2 models")).toBeNull();

    // The fold carries the error line, not the cached catalog.
    fireEvent.click(await rowChevron("qwen-code"));
    expect(
      await screen.findByText(byFoldedText("The probe timed out.")),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(byFoldedText("fake-opus (default)")),
    ).toBeNull();
  });

  it("shows no badge for an unavailable codex outcome", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexUnavailable);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    await screen.findByRole("button", { name: "codex", expanded: true });
    expect(screen.queryByText("Test failed")).toBeNull();
    expect(screen.queryByText("0 models")).toBeNull();
  });

  it("shows no badge for an empty available codex catalog", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexEmpty);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    await screen.findByRole("button", { name: "codex", expanded: true });
    expect(screen.queryByText("0 models")).toBeNull();
    expect(screen.queryByText("Test failed")).toBeNull();
  });

  it("shows no badge while probing even with a cached entry, none when idle without cache, none on undetected rows", async () => {
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: 0,
      },
    });
    renderTab();

    // Idle with cache first: the badge shows. Then probing must clear it --
    // the mid-flight row carries no summary (the stale cache does not bleed
    // through).
    expect(await screen.findByText("2 models")).toBeInTheDocument();
    await clickTestButton();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Test" })[0]).toHaveAttribute("aria-disabled", "true"),
    );
    expect(screen.queryByText("2 models")).toBeNull();
    expect(screen.queryByText("Test failed")).toBeNull();
    release(acpOk);

    // The undetected gemini-cli row: no badge either (only the pre-existing
    // Available / Not installed badges exist).
    await screen.findByText("2 models");
    expect(screen.queryByText("Test failed")).toBeNull();
  });

  // The Test button's hover tooltip surfaces the cached entry's probed-at
  // timestamp (issue #552): the timestamp stays out of the collapsed row and
  // rides the hover instead. Radix opens on pointer hover with pointerType
  // mouse (jsdom needs it set explicitly; bare mouseEnter does not trigger
  // it -- the ComposerProviderPicker pattern).
  it("surfaces the cached probed-at timestamp on the Test button hover", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.pointerEnter(buttons[0], { pointerType: "mouse" });
    fireEvent.pointerMove(buttons[0], { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Last tested");
    // The timestamp renders in the local timezone, so build the expected
    // string with the same params rather than hardcoding a wall-clock
    // string -- the assertion still pins the source (the cached entry's
    // probed_at_millis, not some other instant).
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(Date.UTC(2026, 7, 15, 10, 30));
    expect(tooltip.textContent).toContain(expected);
  });

  it("shows no tooltip when the row has no cached entry", async () => {
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.pointerEnter(buttons[0], { pointerType: "mouse" });
    fireEvent.pointerMove(buttons[0], { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  // Mid-probe is exactly when the expanded fold shows the stale cached
  // catalog, so the tooltip's last-tested time must stay consultable then:
  // the button is inert via aria-disabled (not the disabled attribute),
  // which keeps pointer events -- and therefore the hover -- alive.
  it("keeps the last-tested tooltip hoverable while a re-probe runs", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: { acp: { discovered: okCatalog } },
        probed_at_millis: Date.UTC(2026, 7, 15, 10, 30),
      },
    });
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise<ProbeOk>((resolve) => { release = resolve; }),
    );
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[0]);
    expect(buttons[0]).toHaveAttribute("aria-disabled", "true");
    fireEvent.pointerEnter(buttons[0], { pointerType: "mouse" });
    fireEvent.pointerMove(buttons[0], { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Last tested");
    release(acpOk);
  });

  // --- Effort badge group ---------------------------------------------------

  it("renders thought levels as badges with the current value marked", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(acpOk);
    renderTab();

    await clickTestButton();
    expect(
      await screen.findByText(byFoldedText("fake-opus (default)")),
    ).toBeInTheDocument();
    // The row's label renders positively too -- a stray deletion of the
    // label span would otherwise leave only the badges pinned.
    expect(screen.getByText(byFoldedText("Thought levels"))).toBeInTheDocument();
    // Three badges, one per level; the current value carries the (default)
    // annotation shape only for marked entries.
    expect(await screen.findByText("low")).toBeInTheDocument();
    expect(screen.getByText("medium (default)")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("renders codex efforts as badges with each model's default marked", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(codexAvailable);
    renderTab();

    const buttons = await screen.findAllByRole("button", { name: "Test" });
    fireEvent.click(buttons[1]);
    expect(
      await screen.findByText(byFoldedText("GPT-5.2 Codex (default):")),
    ).toBeInTheDocument();
    // gpt-5.2-codex: low / medium (default) / high; mini: its single low is
    // the CLI default, so it carries the marker too.
    expect(await screen.findByText("medium (default)")).toBeInTheDocument();
    expect(screen.getByText("low")).toBeInTheDocument();
    expect(screen.getByText("low (default)")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });
});
