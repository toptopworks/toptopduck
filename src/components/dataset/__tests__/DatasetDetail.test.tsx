import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { DatasetDetail } from "../DatasetDetail";
import type { DatasetDescriptor } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { renderI18n } from "../../common/__tests__/helpers";

describe("DatasetDetail", () => {
  it("renders canonical column types and the frozen sample", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // Privacy controls are absent when onPrivacyChange is not supplied.
    expect(screen.queryByText(/隐私控制/)).toBeNull();
  });

  it("pins the schema-type <code> to font-mono (ADR-0067, issue #185)", () => {
    // The global code { font-family } element rule retired; each <code> now
    // carries font-mono inline. With the global backstop gone, a future <code>
    // that drops font-mono would silently render in the body font -- pin the
    // tagName + className here so the regression fails loudly (mirrors the
    // bg-muted pinning pattern in the ResultView cell-null test).
    renderI18n(<DatasetDetail dataset={mockDataset} />);
    const typeCell = screen.getByText("BIGINT");
    expect(typeCell.tagName).toBe("CODE");
    expect(typeCell.className.split(/\s+/)).toContain("font-mono");
  });

  it("shows a no-rows hint when the sample is empty", () => {
    renderI18n(<DatasetDetail dataset={{ ...mockDataset, sample: [], row_count: 0 }} />);
    expect(screen.getByText(/无数据行/)).toBeInTheDocument();
  });

  it("renders fully expanded nested DuckDB types (issue #6)", () => {
    const nested: DatasetDescriptor = {
      ...mockDataset,
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "address", canonical_type: "STRUCT(city VARCHAR, zip VARCHAR)" },
        { name: "tags", canonical_type: "LIST(VARCHAR)" },
      ],
      sample: [["1", "{'city': NYC}", "[a, b]"]],
    };
    renderI18n(<DatasetDetail dataset={nested} />);
    expect(screen.getByText("STRUCT(city VARCHAR, zip VARCHAR)")).toBeInTheDocument();
    expect(screen.getByText("LIST(VARCHAR)")).toBeInTheDocument();
  });

  it("renders privacy controls + disclosure when onPrivacyChange is supplied (issue #9)", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} onPrivacyChange={() => {}} />);
    // The sample toggle and the per-column "type only" header are present.
    expect(screen.getByText(/隐私控制/)).toBeInTheDocument();
    expect(screen.getByText(/向云端 LLM 发送样本值/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /仅类型/ })).toBeInTheDocument();
    // Default disclosure: samples sent, both columns' names sent.
    expect(screen.getByText(/发送冻结的首 3 行样本值/)).toBeInTheDocument();
    expect(screen.getByText(/id、name/)).toBeInTheDocument();
  });
});
