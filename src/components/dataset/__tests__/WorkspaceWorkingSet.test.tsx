import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { WorkspaceWorkingSet } from "../WorkspaceWorkingSet";
import type { DatasetDescriptor } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";

// The working-set tab's master/detail composition, extracted from SessionPane
// so the tab's shell decisions (issue #792: one empty card vs the two-column
// pair; the detail's delete fallback) are testable without the pane's IPC
// mock layer. The detail pane is anchored through DatasetDetail's row-count
// line (行数：N) -- the row list renders "N 行", so the two never collide.

// row_count 9 + its own sample make the orders detail distinguishable from
// people's (both fixtures spread the shared mockDataset otherwise).
const orders: DatasetDescriptor = {
  ...mockDataset,
  reference_name: "orders",
  display_name: "orders",
  row_count: 9,
  sample: [["1", "ord-1"]],
};

const NOOPS = {
  onRename: () => {},
  onReplace: () => {},
  onDelete: () => {},
  onPrivacyChange: () => {},
  onAddFiles: () => {},
} as const;

describe("WorkspaceWorkingSet", () => {
  it("renders a single empty-state card when the set is empty (issue #792)", () => {
    const { container } = renderI18n(
      <WorkspaceWorkingSet
        datasets={[]}
        activeName={null}
        loading={false}
        viewedDescriptor={null}
        {...NOOPS}
      />,
    );
    // The two-column master/detail shell does not mount at all -- one panel
    // card carries the hint + the inline add entry.
    expect(container.querySelector(".layout")).toBeNull();
    expect(container.querySelectorAll(".panel")).toHaveLength(1);
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加数据文件" })).toBeInTheDocument();
    // The old near-empty right pane's placeholder is gone with the shell.
    expect(screen.queryByText(/选择一个数据集/)).not.toBeInTheDocument();
  });

  it("shows the picked dataset's detail over the active one", () => {
    renderI18n(
      <WorkspaceWorkingSet
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        viewedDescriptor={null}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
  });

  it("falls back to the active dataset's detail after the pick is deleted (issue #792)", () => {
    const { rerender } = renderI18n(
      <WorkspaceWorkingSet
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        viewedDescriptor={null}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
    // The picked dataset is removed (a confirmed row delete); the detail must
    // follow the ACTIVE dataset, not drop to a placeholder mid-management.
    rerender(
      withIntl(
        <WorkspaceWorkingSet
          datasets={[mockDataset]}
          activeName="people"
          loading={false}
          viewedDescriptor={null}
          {...NOOPS}
        />,
      ),
    );
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    expect(screen.queryByText(/选择一个数据集/)).not.toBeInTheDocument();
  });

  it("falls back to the first list item when the active is absent too (issue #792)", () => {
    const { rerender } = renderI18n(
      <WorkspaceWorkingSet
        datasets={[mockDataset, orders]}
        activeName={null}
        loading={false}
        viewedDescriptor={null}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    rerender(
      withIntl(
        <WorkspaceWorkingSet
          datasets={[orders]}
          activeName={null}
          loading={false}
          viewedDescriptor={null}
          {...NOOPS}
        />,
      ),
    );
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
  });

  it("re-renders into the empty-state card when the last dataset is deleted (issue #792)", () => {
    const { rerender, container } = renderI18n(
      <WorkspaceWorkingSet
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        viewedDescriptor={null}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    rerender(
      withIntl(
        <WorkspaceWorkingSet
          datasets={[]}
          activeName={null}
          loading={false}
          viewedDescriptor={null}
          {...NOOPS}
        />,
      ),
    );
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
    expect(container.querySelector(".layout")).toBeNull();
  });
});
