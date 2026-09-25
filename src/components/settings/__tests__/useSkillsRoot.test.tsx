import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { useSkillsRoot } from "../useSkillsRoot";
import { getSkillsDir } from "../../../api";
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

const localSkill = skillEntry("pdf-tools");

// Empty-catalog English IntlProvider: the hook formats the failed phase's
// error through the pane's own provider posture (ADR-0052).
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

  it("fetches the registry root on mount", () => {
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    renderRoot();
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
