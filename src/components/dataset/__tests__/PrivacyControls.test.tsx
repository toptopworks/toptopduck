import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PrivacyControls } from "../PrivacyControls";
import type { DatasetDescriptor } from "../../../types/dataset";
import { defaultPrivacy, mockDataset } from "./helpers";
import { renderI18n } from "../../common/__tests__/helpers";

describe("PrivacyControls", () => {
  it("defaults to samples on and no type-only columns (ADR-0011)", () => {
    renderI18n(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={() => {}} />,
    );
    const sampleToggle = screen.getByLabelText(/向云端 LLM 发送样本值/);
    expect(sampleToggle).toBeChecked();
    // Neither column is type-only by default.
    expect(screen.getByLabelText(/仅类型 id/)).not.toBeChecked();
    expect(screen.getByLabelText(/仅类型 name/)).not.toBeChecked();
  });

  it("turning off samples emits the whole config with send_samples=false (AC1)", () => {
    const onPrivacyChange = vi.fn();
    renderI18n(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/向云端 LLM 发送样本值/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      ...defaultPrivacy,
      send_samples: false,
    });
  });

  it("marking a column type-only adds it to type_only_columns (AC2)", () => {
    const onPrivacyChange = vi.fn();
    renderI18n(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/仅类型 name/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      ...defaultPrivacy,
      type_only_columns: ["name"],
    });
  });

  it("unmarking a type-only column removes it from the config", () => {
    const onPrivacyChange = vi.fn();
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: true, type_only_columns: ["name"] },
    };
    renderI18n(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/仅类型 name/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      send_samples: true,
      type_only_columns: [],
    });
  });

  it("discloses hidden columns as type-only in the current payload summary", () => {
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: false, type_only_columns: ["name"] },
    };
    renderI18n(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    // Samples off + one type-only column reflected honestly. The parenthetical
    // stays brand-neutral: "only the data type", never the engine brand (#739).
    expect(screen.getByText(/不发送任何样本值/)).toBeInTheDocument();
    expect(screen.getByText(/1 列仅类型.*仅数据类型/)).toBeInTheDocument();
    // The type-only column name is NOT listed among sent columns.
    expect(screen.getByText(/id）/)).toBeInTheDocument();
  });

  it("ignores stale type-only entries for columns that no longer exist", () => {
    // After a schema-changing replace, a type-only entry for a dropped column
    // must not show up as "hidden" -- only current columns count.
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: true, type_only_columns: ["gone"] },
    };
    renderI18n(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    // No hidden columns reported (the stale "gone" isn't a current column) --
    // the summary ends with the sent list and a period, never the "列仅类型" clause.
    expect(screen.queryByText(/列仅类型/)).toBeNull();
    expect(screen.getByText(/id、name）。/)).toBeInTheDocument();
  });

  it("shows empty sent columns when all columns are type-only", () => {
    // When every column is marked type-only, sentColumnNames is empty and the
    // disclosure renders "0 列发送" without a parenthesised column list.
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: false, type_only_columns: ["id", "name"] },
    };
    renderI18n(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    expect(screen.getByText(/0 列发送/)).toBeInTheDocument();
    expect(screen.getByText(/2 列仅类型/)).toBeInTheDocument();
  });

  it("disables the toggles while loading (prevents concurrent IPC)", () => {
    renderI18n(
      <PrivacyControls dataset={mockDataset} loading={true} onPrivacyChange={() => {}} />,
    );
    expect(screen.getByLabelText(/向云端 LLM 发送样本值/)).toBeDisabled();
    expect(screen.getByLabelText(/仅类型 id/)).toBeDisabled();
  });
});
