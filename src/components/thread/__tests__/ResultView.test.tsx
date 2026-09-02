import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";
import { COLUMN_DISCLOSURE_THRESHOLD, ResultView, ROW_DISCLOSURE_THRESHOLD } from "../ResultView";
import { catalogFor } from "../../../i18n";
import { readRows } from "../../../api";
import embed from "vega-embed";

// ResultView paginates via readRows; stub it so the tests script the page
// payloads without the Tauri bridge. Only readRows is mocked (ResultView's sole
// api surface) -- the rest of the module passes through unchanged.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    readRows: vi.fn(),
  };
});
// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked. ResultView still drives the real decodeViz + the embed call/catch
// branches -- the mock lets each test script a successful embed or a rejected
// one to exercise the degradation path (ADR-0033).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// Columns just over the column threshold -- the smallest fixture that trips
// the many-columns disclosure (shared by the col-only and both-hit tests).
const MANY_COLUMNS = Array.from({ length: COLUMN_DISCLOSURE_THRESHOLD + 1 }, (_, i) => ({
  name: `c${i}`,
  canonical_type: "VARCHAR",
}));

describe("ResultView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders rows, total, and the assumption note from readRows", async () => {
    // AC: the materialized result is shown as a table + row count; the
    // assumption note (ADR-0009) renders as a correctable side note.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "n", canonical_type: "BIGINT" }],
      rows: [["5"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption="把 id 当作主键" viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 100));
    expect(screen.getByText(/行数：1/)).toBeInTheDocument();
    expect(screen.getByText("n")).toBeInTheDocument(); // column header
    expect(screen.getByText("5")).toBeInTheDocument(); // cell value
    expect(screen.getByText(/假设：把 id 当作主键/)).toBeInTheDocument();
    // Issue #768 "neither" combo: no threshold crossed -> no info banner.
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("paginates forward and discloses a total larger than the page", async () => {
    // ADR-0024/0030: a bounded page is shown with the honest total, so a
    // truncated view never looks complete; the next-page button fetches onward.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"], ["2"]],
      total: 5,
      offset: 0,
      limit: 2,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
    expect(screen.getByText(/共 5 行/)).toBeInTheDocument(); // total disclosed
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 2, 2));
  });

  it("renders the empty-state row and a zero total for a 0-row result", async () => {
    // ADR-0030: a 0-row result is a valid materialized result, shown with the
    // honest total (0) and the empty-state row -- never special-cased away.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [],
      total: 0,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 100));
    expect(screen.getByText(/行数：0/)).toBeInTheDocument();
    expect(screen.getByText(/（无数据行）/)).toBeInTheDocument();
  });

  it("renders a NULL cell as muted whitespace, never the literal \"NULL\" (ADR-0057)", async () => {
    // ADR-0057: the server CASTs NULL to "" so a NULL cell renders as a muted
    // empty cell (td.cell-null), never the literal string "NULL". Pins the NULL
    // branch ResultView touches -- a regression would leak the literal or drop
    // the cell class that drives the muted background.
    vi.mocked(readRows).mockResolvedValue({
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "opt", canonical_type: "VARCHAR" },
      ],
      rows: [["1", ""]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    const { container } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    // The empty-string cell carries the cell-null hook (kept for selector
    // stability) AND the bg-muted utility (ADR-0067, issue #173: the muted bg
    // retired from styles.css onto the cell). Pin the utility so a regression
    // that drops bg-muted but leaves the hook stays caught; the populated cell
    // carries neither.
    expect(container.querySelectorAll("td.cell-null")).toHaveLength(1);
    expect(container.querySelector("td.cell-null")?.className.split(/\s+/)).toContain("bg-muted");
    // The literal "NULL" never appears in the rendered output.
    expect(screen.queryByText("NULL")).not.toBeInTheDocument();
    // The non-NULL cell value still renders.
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("applies the .num class + tabular-nums to a numeric column header + cell (ADR-0057, issue #222)", async () => {
    // ADR-0057: numeric canonical-types right-align. ADR-0067 (issue #173):
    // the right-align retired from styles.css onto the cells as a text-right
    // utility (alongside the .num hook, kept for selector stability). Issue
    // #222: numeric columns also carry tabular-nums (font-variant-numeric) so
    // digits line up in a column under a proportional UI font. Pin the hook AND
    // both utilities on the real <th>/<td> the primitive renders -- jsdom
    // cannot lay out text-align / font-variant-numeric, but it CAN assert the
    // className, so a regression that drops text-right / tabular-nums but
    // leaves the hook stays caught.
    vi.mocked(readRows).mockResolvedValue({
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "label", canonical_type: "VARCHAR" },
      ],
      rows: [["7", "x"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    const { container } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    // The BIGINT column carries .num + text-right + tabular-nums on both its
    // header and its cell; the VARCHAR column carries neither.
    expect(container.querySelectorAll("th.num")).toHaveLength(1);
    expect(container.querySelectorAll("td.num")).toHaveLength(1);
    expect(container.querySelector("th.num")?.className.split(/\s+/)).toContain("text-right");
    expect(container.querySelector("td.num")?.className.split(/\s+/)).toContain("text-right");
    expect(container.querySelector("th.num")?.className.split(/\s+/)).toContain("tabular-nums");
    expect(container.querySelector("td.num")?.className.split(/\s+/)).toContain("tabular-nums");
    // A non-numeric column carries none of the numeric utilities. Guard
    // existence first so the assertion cannot silently pass via ?. short-circuit
    // if a future fixture drops the non-numeric column.
    const nonNumericHead = container.querySelector("th:not(.num)");
    expect(nonNumericHead).not.toBeNull();
    expect(nonNumericHead?.className.split(/\s+/)).not.toContain("tabular-nums");
  });

  it("paginates backward via the previous button", async () => {
    vi.mocked(readRows)
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["1"], ["2"]],
        total: 5,
        offset: 0,
        limit: 2,
      })
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["3"], ["4"]],
        total: 5,
        offset: 2,
        limit: 2,
      })
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["1"], ["2"]],
        total: 5,
        offset: 0,
        limit: 2,
      });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 2, 2));
    fireEvent.click(screen.getByRole("button", { name: /上一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
  });

  it("discards a late-arriving stale page when the result changes (seq race guard)", async () => {
    // ResultView's seqRef: switching results starts a new loadPage(0) that
    // supersedes the prior result's in-flight readRows. The stale response (for
    // the old reference name) must be discarded -- its seq is no longer current.
    // Without the guard, switching results then having the old page land late
    // would yank the workspace back to the stale rows.
    let resolveResult1: (page: Awaited<ReturnType<typeof readRows>>) => void = () => {};
    vi.mocked(readRows).mockImplementation((_sid, ref) => {
      if (ref === "result_1") {
        return new Promise((resolve) => {
          resolveResult1 = resolve;
        });
      }
      return Promise.resolve({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["99"]],
        total: 1,
        offset: 0,
        limit: 100,
      });
    });
    const { rerender } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    // result_1's page-0 is still pending; switch to result_2 (resolves fast).
    rerender(
      withIntl(<ResultView sessionId="sess-1" referenceName="result_2" assumption={null} viz={null} />),
    );
    await waitFor(() => expect(screen.getByText("99")).toBeInTheDocument());
    // Now result_1's stale page-0 lands -- it must be discarded, not rendered.
    resolveResult1({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["11"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    // Flush microtasks; result_2's "99" stays, result_1's "11" never shows.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.queryByText("11")).not.toBeInTheDocument();
  });

  it("renders the large-result disclosure as a note Alert (ADR-0050/0057, issue #108)", async () => {
    // ADR-0057: a result crossing the row threshold discloses honestly (not
    // silent pagination). Migrated to a default info Alert (ADR-0050);
    // role="note" is static reference, not announced. Issue #768 merged the
    // row and column hints into ONE banner with per-threshold segments:
    // columns stay small here, so the banner carries the row segment only.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: ROW_DISCLOSURE_THRESHOLD + 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/此结果较大.*分页显示中/);
    // The column segment is absent when its threshold is not crossed.
    expect(alert).not.toHaveTextContent(/可横向滚动查看全部/);
  });

  it("renders the many-column disclosure as a note Alert (ADR-0050/0057, issue #108)", async () => {
    // ADR-0057: columns render in full with horizontal scroll (no cap); this
    // banner tells the user to scroll. Same default info Alert + role="note"
    // as the large-result hint. Columns just over the threshold with a small
    // total, so the merged banner (issue #768) carries the column segment
    // only.
    vi.mocked(readRows).mockResolvedValue({
      columns: MANY_COLUMNS,
      rows: [MANY_COLUMNS.map(() => "x")],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/可横向滚动查看全部/);
    // The row segment is absent when its threshold is not crossed.
    expect(alert).not.toHaveTextContent(/此结果较大/);
  });

  it("merges both disclosures into one note when both thresholds are crossed (issue #768)", async () => {
    // Issue #768: the two info-class hints share a trigger scenario (result
    // scale) and a semantic, so both landing at once is ONE banner with two
    // segments, never two stacked banners. The length check makes the
    // single-banner contract explicit; each segment keeps its own copy and
    // its own threshold.
    vi.mocked(readRows).mockResolvedValue({
      columns: MANY_COLUMNS,
      rows: [MANY_COLUMNS.map(() => "x")],
      total: ROW_DISCLOSURE_THRESHOLD + 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(screen.getAllByRole("note")).toHaveLength(1);
    const alert = screen.getByRole("note");
    expect(alert).toHaveTextContent(/此结果较大.*分页显示中/);
    expect(alert).toHaveTextContent(/可横向滚动查看全部/);
    // The segments stay distinct <p> lines inside the banner (not run-on
    // text) -- one paragraph per crossed threshold.
    expect(alert.querySelectorAll("p")).toHaveLength(2);
    // The intra-banner rhythm rides on the vertical-spacing utility (xxs,
    // 4px) -- pinned so the segments cannot collapse into flush paragraphs.
    const description = alert.querySelector("[data-slot=\"alert-description\"]");
    expect(description?.className.split(/\s+/)).toContain("space-y-1");
  });

  it("renders no disclosure exactly at the thresholds (ADR-0057)", async () => {
    // ADR-0057 thresholds are strict: a result AT either count is not large
    // yet -- the disclosures start one past the threshold. The boundary
    // fixture pins both comparisons against an inclusive flip (10,000 rows
    // and 100 columns exactly stay silent).
    vi.mocked(readRows).mockResolvedValue({
      columns: MANY_COLUMNS.slice(0, COLUMN_DISCLOSURE_THRESHOLD),
      rows: [["x"]],
      total: ROW_DISCLOSURE_THRESHOLD,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("gives warning banners more separation than the info banner (issue #768)", async () => {
    // Issue #768 rhythm: warning-class callouts (stale disclosure, viz
    // degradation, read-error banner) take the sm step (my-3, 12px) while
    // the merged info banner keeps xs (my-2, 8px), so a multi-banner stack
    // no longer reads as one uniform rhythm. The malformed viz makes the
    // degradation disclosure replace the chart slot, so both warning
    // surfaces co-occur with the info banner. jsdom cannot lay out, but it
    // can read the className -- same idiom as the th.num utility pins above.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: ROW_DISCLOSURE_THRESHOLD + 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: "not-valid-json" }}
        staleAnchor={{ reference_name: "people", display_name: "员工表", reason: "Replaced" as const }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    // Both warning surfaces (stale + degraded) carry the sm step.
    expect(screen.getAllByRole("status")).toHaveLength(2);
    for (const warning of screen.getAllByRole("status")) {
      expect(warning.className.split(/\s+/)).toContain("my-3");
    }
    const info = screen.getByRole("note");
    expect(info.className.split(/\s+/)).toContain("my-2");
  });

  it("rides the read-error banner on the warning rhythm (issue #768)", async () => {
    // The read-error ErrorBanner keeps the destructive default role="alert"
    // and takes the warning margin only at this call site, via its className
    // passthrough -- the other ErrorBanner callers are untouched.
    vi.mocked(readRows).mockRejectedValue(new Error("read boom"));
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    const errorBanner = await waitFor(() => screen.getByRole("alert"));
    expect(errorBanner.className.split(/\s+/)).toContain("my-3");
  });

  it("renders the stale-result disclosure as a warning status Alert (ADR-0050, issue #108)", async () => {
    // ADR-0047 stage-stale: the result is no longer valid to build on (the
    // invalidating source was replaced). Migrated to a warning Alert;
    // role="status" is polite -- important, not an interrupting emergency. The
    // verb splits via an ICU select on the anchor reason: Replaced -> 已更新.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={null}
        staleAnchor={{ reference_name: "people", display_name: "员工表", reason: "Replaced" as const }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/员工表/);
    expect(alert).toHaveTextContent(/已更新/);
  });

  it("splits the stale verb by anchor reason: Deleted -> 已删除 (ADR-0041, issue #108)", async () => {
    // The stale disclosure's ICU select has two branches: Replaced -> 已更新
    // (new backing exists, re-ask recovers) and Deleted -> 已删除 (truly gone).
    // The Replaced branch is covered above; this pins the Deleted / other branch
    // so a regression that drops the other arm renders empty, and a future
    // StaleReason kind still falls through honestly.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={null}
        staleAnchor={{ reference_name: "people", display_name: "员工表", reason: "Deleted" as const }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert).toHaveTextContent(/已删除/);
    expect(alert).not.toHaveTextContent(/已更新/);
  });

  describe("stale banner rerun (issue #758)", () => {
    // The zh-CN accessible name of the rerun button, resolved from the catalog
    // so the assertion tracks the wording instead of duplicating a literal
    // (issue #139 convention). The aria-label carries the fuller name.
    const RERUN_LABEL = catalogFor("zh-CN")["disclosure.result.staleRerunLabel"];
    const page = {
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: 1,
      offset: 0,
      limit: 100,
    };
    const staleAnchor = {
      reference_name: "people",
      display_name: "员工表",
      reason: "Replaced" as const,
    };

    it("renders a rerun button that fires the bound handler", async () => {
      // The stale disclosure's advice ("ask again to recompute") becomes an
      // action: the button fires the caller-bound rerun (the producing
      // question rides the derivation, never the button itself).
      vi.mocked(readRows).mockResolvedValue(page);
      const onRerun = vi.fn();
      renderI18n(
        <ResultView
          sessionId="sess-1"
          referenceName="result_1"
          assumption={null}
          viz={null}
          staleAnchor={staleAnchor}
          onRerun={onRerun}
        />,
      );
      await waitFor(() => expect(readRows).toHaveBeenCalled());
      const alert = screen.getByRole("status");
      fireEvent.click(within(alert).getByRole("button", { name: RERUN_LABEL }));
      expect(onRerun).toHaveBeenCalledTimes(1);
    });

    it("disables the rerun button while a turn is in flight (busy gate)", async () => {
      // rerunBusy mirrors the composer's loading gate: no second turn fires
      // underneath a running one.
      vi.mocked(readRows).mockResolvedValue(page);
      renderI18n(
        <ResultView
          sessionId="sess-1"
          referenceName="result_1"
          assumption={null}
          viz={null}
          staleAnchor={staleAnchor}
          onRerun={() => {}}
          rerunBusy
        />,
      );
      await waitFor(() => expect(readRows).toHaveBeenCalled());
      const alert = screen.getByRole("status");
      expect(within(alert).getByRole("button", { name: RERUN_LABEL })).toBeDisabled();
    });

    it("renders no rerun button when the caller wires none", async () => {
      // Honest degrade: a stale banner without a wired rerun keeps its text
      // advice and never promises an action it cannot perform.
      vi.mocked(readRows).mockResolvedValue(page);
      renderI18n(
        <ResultView
          sessionId="sess-1"
          referenceName="result_1"
          assumption={null}
          viz={null}
          staleAnchor={staleAnchor}
        />,
      );
      await waitFor(() => expect(readRows).toHaveBeenCalled());
      const alert = screen.getByRole("status");
      expect(within(alert).queryByRole("button", { name: RERUN_LABEL })).not.toBeInTheDocument();
    });
  });
});

describe("ResultView viz (ADR-0016/0033, issue #26)", () => {
  // A minimal successful Vega-Embed Result -- ResultView only touches finalize.
  const embedOk = () =>
    ({ finalize: vi.fn() }) as unknown as Awaited<ReturnType<typeof embed>>;
  const page = {
    columns: [{ name: "n", canonical_type: "BIGINT" }],
    rows: [["5"]],
    total: 1,
    offset: 0,
    limit: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRows).mockResolvedValue(page);
  });

  it("renders the chart above the table on success (ADR-0062 R4 layout)", async () => {
    // AC1 + ADR-0062 R4: a provider viz renders AND the table stays visible
    // below it (chart = answer, table = evidence); no degradation disclosure.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".viz-chart")).toBeInTheDocument();
    // The table pagination is present below the chart (table is always shown).
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("degrades to the table with a disclosure when the spec is malformed JSON", async () => {
    // AC2/AC6: a malformed viz degrades to the table + an honest disclosure
    // (ADR-0033 -- silent degradation is a silent lie). Vega-Embed is never
    // called: decodeViz rejects before rendering.
    const { container } = renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: "not-valid-json" }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument();
    expect(container.querySelector(".viz-chart")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("degrades to the table with a disclosure for a non-whitelisted mark", async () => {
    // AC2/AC6: a spec that draws a chart v1 does not ship (a heatmap "rect")
    // degrades. Whitelist = bar/line/area/scatter/pie only.
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "rect" }) }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument();
    expect(screen.getByText(/rect/)).toBeInTheDocument();
  });

  it("degrades to the underlying table when Vega-Embed render fails", async () => {
    // AC5: a spec that decodes but fails to render degrades to the table with a
    // disclosure -- the underlying data is always shown, never lost.
    vi.mocked(embed).mockRejectedValue(new Error("vega render boom"));
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("renders a plain table with no disclosure when viz is null", async () => {
    // ADR-0033: a null viz is the default table turn -- NOT a degradation, so no
    // disclosure shows and Vega-Embed is never called.
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("finalizes the Vega view on unmount to free the chart resource", async () => {
    // The render effect's cleanup calls finalize so an unmounted chart frees its
    // Vega view (no canvas/view leak across result switches). ResultView is keyed
    // by reference name in App.tsx, so every result switch remounts and runs
    // this cleanup path -- leaving it unguarded would leak views silently.
    const finalize = vi.fn();
    vi.mocked(embed).mockResolvedValue(
      { finalize } as unknown as Awaited<ReturnType<typeof embed>>,
    );
    const { unmount } = renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    unmount();
    // finalize fires either synchronously in cleanup (if embed already resolved)
    // or on the resolved promise (if unmount raced it); waitFor covers both.
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });

  it("renders the degradation as a warning status Alert (ADR-0050, issue #108)", async () => {
    // The viz-degradation disclosure migrated to a warning Alert; role="status"
    // is polite -- the table still shows, so it reads as a caution, not an
    // interrupting emergency. Pins the disclosure surfaces move to Alert.
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: "not-valid-json" }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/图表无法渲染，已显示表格/);
  });
});
