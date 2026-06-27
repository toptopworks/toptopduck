import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DatasetDetail } from "../components/DatasetDetail";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { WorkingSetList } from "../components/WorkingSetList";
import type { DatasetDescriptor } from "../types";

const mockDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/people.csv",
  row_count: 5,
  fingerprint: "abc123def4560000000000000000000000000000000000000000000000000999",
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [
    ["1", "Alice"],
    ["2", "Bob"],
  ],
};

describe("DisclosureBanner", () => {
  it("discloses the default-to-send payload and local-only guarantee", () => {
    render(<DisclosureBanner />);
    expect(screen.getByText(/完整数据集永不离开本机/)).toBeInTheDocument();
    expect(screen.getByText(/首 3 行样本/)).toBeInTheDocument();
  });

  it("discloses Excel formula cells use cached snapshot values (issue #7 AC4)", () => {
    const { container } = render(<DisclosureBanner />);
    expect(container).toHaveTextContent(/Excel 工作簿按 sheet 分别加载为独立/);
    expect(container).toHaveTextContent(/隐藏的工作表会被跳过/);
    expect(container).toHaveTextContent(/公式单元格取加载时的缓存值（不重算）/);
  });
});

describe("DatasetDetail", () => {
  it("renders canonical column types and the frozen sample", () => {
    render(<DatasetDetail dataset={mockDataset} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
  });

  it("shows a no-rows hint when the sample is empty", () => {
    render(<DatasetDetail dataset={{ ...mockDataset, sample: [], row_count: 0 }} />);
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
    render(<DatasetDetail dataset={nested} />);
    expect(screen.getByText("STRUCT(city VARCHAR, zip VARCHAR)")).toBeInTheDocument();
    expect(screen.getByText("LIST(VARCHAR)")).toBeInTheDocument();
  });
});

describe("WorkingSetList", () => {
  it("lists datasets and marks the active one", () => {
    render(
      <WorkingSetList datasets={[mockDataset]} activeName="people" onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /people/ })).toBeInTheDocument();
    expect(screen.getByText(/当前表/)).toBeInTheDocument();
  });

  it("shows an empty hint when there are no datasets", () => {
    render(<WorkingSetList datasets={[]} activeName={null} onSelect={() => {}} />);
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
  });
});
