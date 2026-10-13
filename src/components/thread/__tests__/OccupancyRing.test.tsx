// The occupancy ring's own pins (ADR-0130, issue #1272; the pill rework is
// issue #1276): the three evidence states, the single-line tooltip pill's
// copy (the en literals), the pill's billing-free scope, and the shell
// mount's cache plumb.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";

import { OccupancyRing, ComposerOccupancy } from "../OccupancyRing";
import { TooltipProvider } from "../../ui/tooltip";
import { conversation } from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";
import type { ThreadEntry, TurnRecord } from "../../../types/thread";

// Only the shell-mount describe touches the api module; the other
// describes feed the entries prop directly and never fetch.
vi.mock("../../../api", () => ({ conversation: vi.fn() }));

// defaultMessage-only (the UsageFooter precedent): the en literals are the
// contract under test. TooltipProvider rides every render -- the app hangs
// one provider at the shell (ADR-0050/0054) and Radix's Root throws
// without it (the CopyButton/RoundProse precedent).
function renderRing(
  entries: readonly ThreadEntry[] | null,
  contextLimit?: number | null,
) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <TooltipProvider>
        <OccupancyRing entries={entries} contextLimit={contextLimit} />
      </TooltipProvider>
    </IntlProvider>,
  );
}

function turnEntry(over: Partial<TurnRecord> = {}): ThreadEntry {
  const record: TurnRecord = {
    question: "问",
    outcome: {
      kind: "Textual",
      data: { text_kind: "Agent", body: "答", assumption: null },
    },
    trace: [],
    provenance: { skills: [] },
    ...over,
  };
  return { entry: "Turn", data: record };
}

// Radix Tooltip's open path is pointermove (no pointerenter handler, the
// CliSection precedent); with the provider's delayDuration 0 the pill
// mounts on that event -- the async query waits for the portal content,
// which carries role="tooltip".
async function hoverOpen() {
  fireEvent.pointerMove(
    screen.getByRole("button", { name: "Context occupancy" }),
  );
  return within(await screen.findByRole("tooltip"));
}

describe("OccupancyRing three states (ADR-0130, issue #1272)", () => {
  it("renders nothing without a reading (null entries, or no turn carries one)", () => {
    const { container } = renderRing(null);
    expect(container.firstChild).toBeNull();
    renderRing([turnEntry()]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the hollow track without an arc when no denominator is known", async () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 9000, limit: null } })],
      null,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    const circles = ring.querySelectorAll("circle");
    // Track only -- no percentage arc (never a guessed denominator).
    expect(circles).toHaveLength(1);
    // The pill's degraded line: the numerator and the honest why.
    expect(
      (await hoverOpen()).getByText("9K tokens used · context window unknown"),
    ).toBeInTheDocument();
  });

  it("renders the percentage arc against the configured window (config denominator)", async () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 50_000, limit: null } })],
      200_000,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    const arc = ring.querySelectorAll("circle")[1];
    expect(arc).toBeDefined();
    expect(arc.getAttribute("stroke")).toBe("var(--primary)");
    // 50K of 200K = 25% -- the single-line pill with both figures.
    expect(
      (await hoverOpen()).getByText("25% · 50K / 200K of context used"),
    ).toBeInTheDocument();
  });

  it("the reading's own window (ACP size) outranks the profile config", async () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 150_000, limit: 160_000 } })],
      200_000,
    );
    // 150K of the snapshot's own 160K window, not of the config's 200K;
    // floored like every K/M figure (93.75% reads 93.7, never rounds up).
    expect(
      (await hoverOpen()).getByText("93.7% · 150K / 160K of context used"),
    ).toBeInTheDocument();
  });

  it("a non-positive snapshot window is the no-window shape, never a divide-by hazard", async () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 9000, limit: 0 } })],
      null,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    // Track only -- the glyph and the pill agree on hollow, never
    // "100% · ... / 0" under a windowless arc.
    expect(ring.querySelectorAll("circle")).toHaveLength(1);
    expect(
      (await hoverOpen()).getByText("9K tokens used · context window unknown"),
    ).toBeInTheDocument();
  });

  it("the arc takes the warning color above 70% and danger above 90%", () => {
    const warn = renderRing(
      [turnEntry({ occupancy: { tokens: 150_000, limit: 200_000 } })],
      200_000,
    );
    expect(
      within(warn.container)
        .getByRole("button", { name: "Context occupancy" })
        .querySelectorAll("circle")[1]
        .getAttribute("stroke"),
    ).toBe("var(--warning)");
    warn.unmount();
    const danger = renderRing(
      [turnEntry({ occupancy: { tokens: 190_000, limit: 200_000 } })],
      200_000,
    );
    expect(
      within(danger.container)
        .getByRole("button", { name: "Context occupancy" })
        .querySelectorAll("circle")[1]
        .getAttribute("stroke"),
    ).toBe("var(--destructive)");
  });

  it("the latest reading wins -- a later turn without one does not erase it", async () => {
    renderRing([
      turnEntry({ occupancy: { tokens: 10_000, limit: 200_000 } }),
      turnEntry(),
    ]);
    expect(
      (await hoverOpen()).getByText("5% · 10K / 200K of context used"),
    ).toBeInTheDocument();
  });
});

describe("OccupancyRing pill shape and scope (ADR-0130, issue #1276)", () => {
  it("the pill carries the occupancy figure alone -- billing sums never enter it", async () => {
    renderRing(
      [
        turnEntry({
          occupancy: { tokens: 1_000, limit: 100_000 },
          usage: {
            total: {
              input_tokens: 1_000,
              cache_read_tokens: 400,
              cache_write_tokens: 90,
              output_tokens: 2_500,
              reasoning_tokens: 12,
            },
          },
        }),
      ],
      null,
    );
    const pill = await hoverOpen();
    expect(pill.getByText("1% · 1K / 100K of context used")).toBeInTheDocument();
    // The session total and its technical fold retired from the popup:
    // the billing sums live on the turn's usage pill (ADR-0130 Decision 1).
    expect(pill.queryByText(/^Input /)).toBeNull();
    expect(pill.queryByText(/^Output /)).toBeNull();
    expect(pill.queryByRole("group")).toBeNull();
  });
});

// The shell-side mount (ADR-0130): the composer's ring rides the SAME
// TanStack cache the SessionPane owner's query fills -- one key, one
// fetch, the mount only adds a reader at the shell; the disabled
// (null-session) form matches no session's key and never requests.
describe("ComposerOccupancy shell mount (ADR-0130, issue #1272)", () => {
  function renderMounted(sessionId: string | null, prefill?: readonly ThreadEntry[]) {
    // Mirrors the app client's globals (queryClient.ts): staleTime
    // Infinity is what lets the prefilled owner cache serve without a
    // refetch on mount.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    if (prefill != null) {
      queryClient.setQueryData(sessionKeys.thread("sess-1"), prefill);
    }
    return render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <ComposerOccupancy sessionId={sessionId} />
          </QueryClientProvider>
        </TooltipProvider>
      </IntlProvider>,
    );
  }

  it("reads the owner query's cache -- the SessionPane key, no second fetch", () => {
    renderMounted("sess-1", [turnEntry({ occupancy: { tokens: 9000, limit: null } })]);
    // The ring renders off the OWNER-shaped cache entry: a key drift
    // would leave the mount cache-less (it would have to fetch, and the
    // spy below stays silent).
    expect(screen.getByRole("button", { name: "Context occupancy" })).toBeInTheDocument();
    expect(vi.mocked(conversation)).not.toHaveBeenCalled();
  });

  it("cold start renders nothing and never fetches", () => {
    const { container } = renderMounted(null);
    // Not even a conversation("__no_session__"): the disabled query's
    // enabled gate is the only thing standing between cold start and a
    // dead IPC.
    expect(container.firstChild).toBeNull();
    expect(vi.mocked(conversation)).not.toHaveBeenCalled();
  });
});
