import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import type embedType from "vega-embed";
import { vi } from "vitest";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";

// Shared zh-CN react-intl test wrapper for components that route their chrome
// through react-intl (ADR-0052) and assert on Chinese strings. withIntl wraps a
// node for a rerender call (RTL's rerender replaces the whole tree, so it must
// re-provide the provider); renderI18n is the render-time convenience. Lives in
// the common base so the common + dataset domains share one wrapper instead of
// each inline-copying it (issue #216 split).
//
// The TooltipProvider mirrors the app tree (App mounts the one app-wide
// provider; Radix tooltip consumers below it must not grow their own) -- so
// tests for components that render Tooltips (the working-set rows since #865)
// get the same ancestor instead of each suite hand-wrapping one.

/** A minimal successful Vega-Embed Result for suites that mock vega-embed
 * (jsdom has no canvas): the members the chart surfaces touch -- `finalize`
 * always, plus the view resize behind the unhide path (guarded off under the
 * never-firing jsdom observer today, but a suite stubbing a firing
 * ResizeObserver would hit it). Shared so the chart surfaces -- the result
 * card, the vega-lite fence (ADR-0120) -- script the same stub shape instead
 * of each hand-copying the cast. */
export const embedOk = () =>
  ({ finalize: vi.fn(), view: { resize: vi.fn() } }) as unknown as Awaited<
    ReturnType<typeof embedType>
  >;

export function withIntl(ui: ReactElement) {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>
  );
}

export function renderI18n(ui: ReactElement) {
  return render(withIntl(ui));
}
