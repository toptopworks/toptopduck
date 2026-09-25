import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { useSkillsRoot } from "../useSkillsRoot";
import { getSkillsDir } from "../../../api";
import { log } from "../../../lib/log";
import { skillEntry } from "../../../test-fixtures";

// The skills-root seam's only IPC dependency is the path query; fmtError is
// mocked to a sentinel so the failed phase's "already formatted" contract
// asserts on the seam's own output, not the formatter's.
vi.mock("../../../api", () => ({
  getSkillsDir: vi.fn(),
}));
vi.mock("../../../lib/error-presentation", () => ({
  fmtError: vi.fn(() => "formatted-error"),
}));
// log is mocked to the warn-only shape the seam exercises: the guard drops
// a stale rejection's state write but the warn stays diagnosable.
vi.mock("../../../lib/log", () => ({
  log: { warn: vi.fn() },
}));

const localSkill = skillEntry("pdf-tools");

// Empty-catalog English IntlProvider: satisfies the hook's useIntl context;
// formatting itself is mocked out above.
function renderRoot() {
  return renderHook(() => useSkillsRoot(), {
    wrapper: ({ children }) => (
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        {children}
      </IntlProvider>
    ),
  });
}

describe("useSkillsRoot (issue #1083)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the registry root on mount", async () => {
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    renderRoot();
    // Flush the resolve's microtask and the re-render it schedules before
    // counting: a dep-array regression reruns the effect on that render,
    // so the count must still be one AFTER the flush, not just before it.
    await act(async () => {});
    // The mount effect issues the one fetch without any caller action.
    expect(getSkillsDir).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer resolve when an older fetch rejects late", async () => {
    let rejectFirst!: (e: Error) => void;
    vi.mocked(getSkillsDir)
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
            rejectFirst = rej;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve("/roots/retried"));
    const { result } = renderRoot();
    // The open-click retry bumps the generation before the first fetch
    // answered (the mount fetch and the re-fetch both in flight).
    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.root).toEqual({
        phase: "resolved",
        root: "/roots/retried",
      }),
    );
    // The stale first rejection lands after the newer resolve and must
    // not flip the phase back to failed mid-dialog (the #1041 posture).
    // The async act flushes the microtask the rejection's catch rides.
    await act(async () => {
      rejectFirst(new Error("stale"));
    });
    expect(result.current.root).toEqual({
      phase: "resolved",
      root: "/roots/retried",
    });
    // The guard drops the stale rejection's state write, not the warn:
    // a stale failure stays diagnosable (the contract above the catch).
    expect(log.warn).toHaveBeenCalledWith(
      "SkillsRoot",
      "get_skills_dir failed",
      expect.any(Error),
    );
  });

  it("keeps a newer resolve when an older fetch resolves late", async () => {
    let resolveFirst!: (dir: string) => void;
    vi.mocked(getSkillsDir)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve("/roots/retried"));
    const { result } = renderRoot();
    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.root).toEqual({
        phase: "resolved",
        root: "/roots/retried",
      }),
    );
    // The stale first RESOLVE lands after the newer resolve (a slow mount
    // fetch answering after the open-click re-fetch) and must not revert
    // the root to the older directory -- the .then arm of the guard.
    await act(async () => {
      resolveFirst("/roots/stale");
    });
    expect(result.current.root).toEqual({
      phase: "resolved",
      root: "/roots/retried",
    });
  });

  it("joins the SKILL.md path with each root's own separator, null while unresolved", async () => {
    let resolveRoot!: (dir: string) => void;
    vi.mocked(getSkillsDir).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveRoot = res;
        }),
    );
    const { result } = renderRoot();
    // Loading: no anchor yet -- the detail link stays inert, not garbage.
    expect(result.current.root).toEqual({ phase: "loading" });
    expect(result.current.detailFilePath(localSkill)).toBeNull();

    resolveRoot("/roots/skills");
    await waitFor(() =>
      expect(result.current.root).toEqual({
        phase: "resolved",
        root: "/roots/skills",
      }),
    );
    expect(result.current.detailFilePath(localSkill)).toBe(
      "/roots/skills/pdf-tools/SKILL.md",
    );

    // A Windows root: the join reads the root's own backslashes.
    vi.mocked(getSkillsDir).mockResolvedValueOnce("C:\\Users\\me\\skills");
    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.root).toEqual({
        phase: "resolved",
        root: "C:\\Users\\me\\skills",
      }),
    );
    expect(result.current.detailFilePath(localSkill)).toBe(
      "C:\\Users\\me\\skills\\pdf-tools\\SKILL.md",
    );
  });

  it("carries the already-formatted error on the failed phase", async () => {
    vi.mocked(getSkillsDir).mockRejectedValue(new Error("boom"));
    const { result } = renderRoot();
    // fmtError's output is what lands: the consumer renders it verbatim on
    // the detail dialog's path face (issue #1039) with no second formatting.
    await waitFor(() =>
      expect(result.current.root).toEqual({
        phase: "failed",
        error: "formatted-error",
      }),
    );
  });
});
