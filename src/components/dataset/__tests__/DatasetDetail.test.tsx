import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { DatasetDetail } from "../DatasetDetail";
import type { DatasetDescriptor } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { renderI18n } from "../../common/__tests__/helpers";

// The detail pane's live preview reads through props (issue #1061): the
// working-set container owns the readRows query, the detail stays a pure
// renderer. The descriptor's frozen load-time sample no longer renders
// anywhere -- the live page replaces it.
const SAMPLE = {
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  // "Zoe" rides nowhere in the shared mockDataset.sample, so a hit proves
  // the preview renders the PROP page, not the frozen arm.
  rows: [
    ["1", "Zoe"],
    ["2", "Yan"],
  ],
};

const NO_PREVIEW = { sample: SAMPLE, sampleLoading: false, sampleError: null } as const;

const staleDataset = (reason: "Deleted" | "Replaced"): DatasetDescriptor => ({
  ...mockDataset,
  stale: { reference_name: "people", display_name: "people", reason },
});

describe("DatasetDetail", () => {
  it("renders canonical column types and the live sample page", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    // The type column header is brand-neutral (issue #739).
    expect(screen.getByRole("columnheader", { name: "数据类型" })).toBeInTheDocument();
    // The preview table's headers carry the COLUMN NAMES and its rows come
    // from the live read; the frozen descriptor sample ("Alice") is gone.
    expect(screen.getByRole("columnheader", { name: "id" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByText("Zoe")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // Privacy controls are absent when onPrivacyChange is not supplied.
    expect(screen.queryByText(/隐私控制/)).toBeNull();
  });

  it("keeps the meta line to the row count and renders the fingerprint under the source file (issue #793)", () => {
    // AC3: the always-on fingerprint slice is near-zero value at a glance --
    // it exists to prove "the file really did change" during troubleshooting.
    // The visible meta keeps Rows only, and the full fingerprint sits
    // directly under the source-file line so that check needs no hover (the
    // former tooltip form is gone: no title attribute, no tooltip in the
    // tree).
    renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    const meta = screen.getByText(/行数：5/);
    expect(meta).not.toHaveTextContent(/指纹/);
    expect(meta).not.toHaveAttribute("title");
    expect(screen.getByText(/来源文件：\/x\/people\.csv/)).toBeInTheDocument();
    // The hex value rides the {typography.code} mono token (the schema-type
    // <code> form); the prose prefix stays in the body font.
    const fingerprintCode = screen.getByText(mockDataset.fingerprint);
    expect(fingerprintCode.tagName).toBe("CODE");
    expect(fingerprintCode.className.split(/\s+/)).toContain("font-mono");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides the source-file block entirely when the source path is empty", () => {
    // No file provenance -> neither the path line nor the fingerprint that
    // proves its changes renders; a dangling fingerprint alone would prove
    // nothing.
    renderI18n(
      <DatasetDetail dataset={{ ...mockDataset, source_path: "" }} {...NO_PREVIEW} />,
    );
    expect(screen.queryByText(/来源文件/)).toBeNull();
    expect(screen.queryByText(/指纹/)).toBeNull();
  });

  it("pins the schema-type <code> to font-mono (ADR-0067, issue #185)", () => {
    // The global code { font-family } element rule retired; each <code> now
    // carries font-mono inline. With the global backstop gone, a future <code>
    // that drops font-mono would silently render in the body font -- pin the
    // tagName + className here so the regression fails loudly (mirrors the
    // bg-muted pinning pattern in the ResultView cell-null test).
    renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    const typeCell = screen.getByText("BIGINT");
    expect(typeCell.tagName).toBe("CODE");
    expect(typeCell.className.split(/\s+/)).toContain("font-mono");
    // Issue #864: the type code also carries the 13px {typography.code} size
    // -- with the workspace body's 14px baseline, an unsized <code> would
    // silently grow a step above the token.
    expect(typeCell.className.split(/\s+/)).toContain("text-[13px]");
  });

  it("pins the section headings to headline-sm 16px/600 (issue #864)", () => {
    // The workspace body's 14px baseline (issue #864) inherits into the bare
    // h2/h3 unless each carries the headline token explicitly -- a heading
    // that drops the utility would render at the body size with zero
    // hierarchy. Pin all headings the section renders: the title, the schema
    // heading, and the sample heading.
    renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    const headings = [
      screen.getByRole("heading", { level: 2 }),
      ...screen.getAllByRole("heading", { level: 3 }),
    ];
    // The count pins the enumeration itself: deleting a heading outright
    // would pass the per-heading loop below untouched.
    expect(headings).toHaveLength(3);
    for (const heading of headings) {
      expect(heading.className.split(/\s+/)).toContain("text-base");
      expect(heading.className.split(/\s+/)).toContain("font-semibold");
    }
  });

  it("hides the whole sample section when the read returns zero rows", () => {
    // A 0-row dataset renders NO sample section -- no skeleton, no empty
    // table shell, no heading (the meta line's "Rows: 0" already says it).
    renderI18n(
      <DatasetDetail
        dataset={mockDataset}
        {...NO_PREVIEW}
        sample={{ columns: SAMPLE.columns, rows: [] }}
      />,
    );
    expect(screen.queryByText(/数据样本/)).toBeNull();
    expect(screen.queryByText("Zoe")).toBeNull();
  });

  it("shows a muted loading line while the preview fetch is in flight", () => {
    renderI18n(
      <DatasetDetail dataset={mockDataset} {...NO_PREVIEW} sample={null} sampleLoading />,
    );
    expect(screen.getByText(/正在加载行数据/)).toBeInTheDocument();
    expect(screen.queryByText("Zoe")).toBeNull();
  });

  it("shows a one-line read error and keeps the schema table working", () => {
    // A failed preview read is a LOCAL data problem: it renders one inline
    // error line and never takes the management panel down with it.
    renderI18n(
      <DatasetDetail
        dataset={mockDataset}
        {...NO_PREVIEW}
        sample={null}
        sampleError={new Error("boom")}
      />,
    );
    const errorLine = screen.getByText(/boom/);
    expect(errorLine.className.split(/\s+/)).toContain("text-destructive");
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
  });

  it("pins the preview table inside the disclosure scroll cap (issue #1061)", () => {
    // The disclosure threshold is the max-height + internal scroll form: the
    // wrapper caps the section's height so the schema table and the action
    // area above/below never leave the viewport, including the <=600px
    // single-column fallback (issue #791). Pin the classes -- a dropped cap
    // or scroll would silently stretch the panel again.
    const { container } = renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    const scrollWrap = container.querySelector(".sample-body");
    expect(scrollWrap).not.toBeNull();
    expect(scrollWrap!.className.split(/\s+/)).toContain("max-h-64");
    expect(scrollWrap!.className.split(/\s+/)).toContain("overflow-auto");
  });

  it("renders the inert stale badge with the shared causal verb (issue #1061)", () => {
    // The detail title carries a plain muted Badge (ADR-0050 stale semantic)
    // whose wording comes from the SAME verb helper as the thread's stale
    // chip -- Replaced/Deleted never diverge between the two surfaces. It is
    // a label, not the thread chip: no button semantics, no jump promise.
    renderI18n(<DatasetDetail dataset={staleDataset("Deleted")} {...NO_PREVIEW} />);
    expect(screen.getByText("上游已删除")).toBeInTheDocument();
  });

  it("renders the Replaced stale verb for a replaced source", () => {
    renderI18n(<DatasetDetail dataset={staleDataset("Replaced")} {...NO_PREVIEW} />);
    expect(screen.getByText("源已更新")).toBeInTheDocument();
  });

  it("renders no stale badge on an active dataset", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} {...NO_PREVIEW} />);
    expect(screen.queryByText("上游已删除")).toBeNull();
    expect(screen.queryByText("源已更新")).toBeNull();
  });

  it("renders fully expanded nested DuckDB types (issue #6)", () => {
    const nested: DatasetDescriptor = {
      ...mockDataset,
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "address", canonical_type: "STRUCT(city VARCHAR, zip VARCHAR)" },
        { name: "tags", canonical_type: "LIST(VARCHAR)" },
      ],
    };
    renderI18n(<DatasetDetail dataset={nested} {...NO_PREVIEW} />);
    expect(screen.getByText("STRUCT(city VARCHAR, zip VARCHAR)")).toBeInTheDocument();
    expect(screen.getByText("LIST(VARCHAR)")).toBeInTheDocument();
  });

  it("renders privacy controls + disclosure when onPrivacyChange is supplied (issue #9)", () => {
    renderI18n(
      <DatasetDetail dataset={mockDataset} {...NO_PREVIEW} onPrivacyChange={() => {}} />,
    );
    // The sample toggle and the per-column "type only" header are present.
    expect(screen.getByText(/隐私控制/)).toBeInTheDocument();
    expect(screen.getByText(/向云端 LLM 发送样本值/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /仅类型/ })).toBeInTheDocument();
    // Default disclosure: samples sent, both columns' names sent.
    expect(screen.getByText(/发送冻结的首 3 行样本值/)).toBeInTheDocument();
    expect(screen.getByText(/id、name/)).toBeInTheDocument();
  });
});
