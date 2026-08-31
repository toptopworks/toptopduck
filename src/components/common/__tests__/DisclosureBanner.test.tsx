import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { DisclosureBanner } from "../DisclosureBanner";
import { renderI18n } from "./helpers";

// DisclosureBanner routes its chrome through react-intl (ADR-0052, issue #108).
// The zh-CN IntlProvider wrapper (renderI18n) is shared from the common test
// helpers, keeping the Chinese chrome assertions holding.

describe("DisclosureBanner", () => {
  it("discloses the default-to-send payload and local-only guarantee", () => {
    const { container } = renderI18n(<DisclosureBanner />);
    expect(screen.getByText(/完整数据集永不离开本机/)).toBeInTheDocument();
    expect(screen.getByText(/首 3 行样本/)).toBeInTheDocument();
    // The schema segment is brand-neutral: "data types", never the engine (#739).
    expect(container).toHaveTextContent(/列名 \+ 数据类型/);
  });

  it("discloses Excel formula cells use cached snapshot values (issue #7 AC4)", () => {
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container).toHaveTextContent(/Excel 工作簿按 sheet 分别加载为独立/);
    expect(container).toHaveTextContent(/隐藏的工作表会被跳过/);
    expect(container).toHaveTextContent(/公式单元格取加载时的缓存值（不重算）/);
    // issue #10: disclose auto-tidy + guided fallback + .xls rejection.
    expect(container).toHaveTextContent(/自动规整/);
    expect(container).toHaveTextContent(/请另存为 .xlsx/);
  });

  it("discloses the per-dataset / per-column privacy control surface (issue #9)", () => {
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container).toHaveTextContent(/按数据集关闭样本发送/);
    expect(container).toHaveTextContent(/按列标记「仅类型」/);
  });

  it("renders as a static note Alert (ADR-0050, issue #108)", () => {
    // The privacy disclosure migrated from a bespoke <aside role="note"> to a
    // shadcn Alert (default variant). role="note" overrides the Alert's
    // assertive "alert" default -- this is static reference info shown inside a
    // collapsible <details>, not an announcement. getByRole asserts the a11y
    // semantics (not a DOM-structure query), mirroring the viz-degradation test.
    renderI18n(<DisclosureBanner />);
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
  });

  it("resolves the <bold> rich-text tag to <strong> emphasis (ADR-0052, issue #108)", () => {
    // Each privacy message carries <bold>...</bold> tags resolved via the
    // values.bold renderer to <strong>. A regression that drops the renderer
    // would leak the raw tag name or flatten the emphasis; getByText alone can't
    // tell (it flattens text), so pin the <strong> count directly.
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container.querySelectorAll("strong").length).toBeGreaterThan(0);
  });
});
