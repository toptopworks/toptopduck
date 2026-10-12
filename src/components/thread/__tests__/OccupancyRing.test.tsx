// The composer occupancy ring's three-state pins (ADR-0130, issue #1272):
// every state maps an evidence shape, never a guess -- not rendered without
// a reading, hollow without a window, a percentage arc only against a known
// denominator (warning above 70%, danger above 90%); the popover carries
// the primary occupancy line, the session total's secondary line, and the
// cache-write / reasoning technical fold.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";

import { OccupancyRing, ComposerOccupancy } from "../OccupancyRing";
import { conversation } from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";
import type { ThreadEntry, TurnRecord } from "../../../types/thread";

// Only the shell-mount describe touches the api module; the other
// describes feed the entries prop directly and never fetch.
vi.mock("../../../api", () => ({ conversation: vi.fn() }));

// defaultMessage-only (the UsageFooter precedent): the en literals are the
// contract under test.
function renderRing(
  entries: readonly ThreadEntry[] | null,
  contextLimit?: number | null,
) {
  vi.useFakeTimers();
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <OccupancyRing entries={entries} contextLimit={contextLimit} />
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

// Radix HoverCard opens on pointerEnter after openDelay (the sidebar
// hover-card test's fake-timer precedent); the portal content carries no
// role, so hoverOpen returns the popover's body scope: screen, once open.
function hoverOpen() {
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Context occupancy" }));
  act(() => {
    vi.advanceTimersByTime(150);
  });
  return screen;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OccupancyRing three states (ADR-0130, issue #1272)", () => {
  it("renders nothing without a reading (null entries, or no turn carries one)", () => {
    const { container } = renderRing(null);
    expect(container.firstChild).toBeNull();
    renderRing([turnEntry()]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the hollow track without an arc when no denominator is known", () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 9000, limit: null } })],
      null,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    const circles = ring.querySelectorAll("circle");
    // Track only -- no percentage arc (never a guessed denominator).
    expect(circles).toHaveLength(1);
    // The popover's degraded primary line: numerator only.
    expect(hoverOpen().getByText("last round-trip 9K tokens")).toBeInTheDocument();
  });

  it("renders the percentage arc against the configured window (config denominator)", () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 50_000, limit: null } })],
      200_000,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    const arc = ring.querySelectorAll("circle")[1];
    expect(arc).toBeDefined();
    expect(arc.getAttribute("stroke")).toBe("var(--primary)");
    // 50K of 200K = 25% -- the full primary line with both figures.
    expect(
      hoverOpen().getByText("25% · last round-trip 50K / window 200K"),
    ).toBeInTheDocument();
  });

  it("the reading's own window (ACP size) outranks the profile config", () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 150_000, limit: 160_000 } })],
      200_000,
    );
    // 150K of the snapshot's own 160K window, not of the config's 200K.
    expect(
      hoverOpen().getByText("94% · last round-trip 150K / window 160K"),
    ).toBeInTheDocument();
  });

  it("a non-positive snapshot window is the no-window shape, never a divide-by hazard", () => {
    renderRing(
      [turnEntry({ occupancy: { tokens: 9000, limit: 0 } })],
      null,
    );
    const ring = screen.getByRole("button", { name: "Context occupancy" });
    // Track only -- the glyph and the popover agree on hollow, never
    // "100% · ... / window 0" under a windowless arc.
    expect(ring.querySelectorAll("circle")).toHaveLength(1);
    expect(hoverOpen().getByText("last round-trip 9K tokens")).toBeInTheDocument();
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

  it("the latest reading wins -- a later turn without one does not erase it", () => {
    renderRing([
      turnEntry({ occupancy: { tokens: 10_000, limit: 200_000 } }),
      turnEntry(),
    ]);
    expect(
      hoverOpen().getByText("5% · last round-trip 10K / window 200K"),
    ).toBeInTheDocument();
  });
});

describe("OccupancyRing popover secondary line (ADR-0130, issue #1272)", () => {
  it("sums the evidence turns into the secondary line + technical fold", () => {
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
        turnEntry({
          usage: {
            total: {
              input_tokens: 2_000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              output_tokens: 500,
            },
          },
        }),
      ],
      null,
    );
    const popover = hoverOpen();
    // The same source entries the footer rides (Decision 5): full words,
    // the cache-read breakdown in parentheses, K/M scale.
    expect(popover.getByText("Input 3K")).toBeInTheDocument();
    expect(popover.getByText("(cache 400)")).toBeInTheDocument();
    expect(popover.getByText("Output 3K")).toBeInTheDocument();
    // The technical fold carries cache write + reasoning (present in the
    // DOM regardless of the open posture, the UsageFooter rule).
    const fold = popover.getByRole("group");
    expect(fold.textContent).toContain("cache write 90");
    expect(fold.textContent).toContain("reasoning 12");
  });

  it("omits the secondary line and the fold when no turn carries usage", () => {
    renderRing([turnEntry({ occupancy: { tokens: 9000, limit: null } })], null);
    const popover = hoverOpen();
    expect(popover.queryByRole("group")).toBeNull();
    expect(popover.queryByText(/^Input /)).toBeNull();
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
        <QueryClientProvider client={queryClient}>
          <ComposerOccupancy sessionId={sessionId} />
        </QueryClientProvider>
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
