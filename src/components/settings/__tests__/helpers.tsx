import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { withIntlAt } from "../../common/__tests__/helpers";

// Settings routes its chrome through react-intl (ADR-0052). Rendered inside
// the shared i18n test seam's en-US wrap -- the REAL catalog (issue #1100):
// the prior empty-catalog + defaultMessage fallback let a defaultMessage
// drift from the catalog hide here forever, so assertions now anchor on the
// en-US catalog wording and a drift fails loudly.
//
// QueryClientProvider wraps the tree because the Runtime section's Local CLI
// tab reads the adapter table via TanStack Query (issue #489). retry is off so
// a rejected query does not retry under waitFor.
//
// The seam's TooltipProvider mirrors the App ancestor (the rail's dual-state
// gear carries a Tooltip); App mounts one high in the tree, so the pane tests
// reproduce that context. Shared by the SettingsView tests (issue #216 split).
export function renderSettings(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      {withIntlAt("en-US", ui)}
    </QueryClientProvider>,
  );
  // The query client rides along so tests can assert cache writes made by
  // the component (e.g. the post-probe setQueryData mirror, issue #536) via
  // getQueryData.
  return { ...result, queryClient };
}

// Radix Select in jsdom: the trigger opens on a primary pointer-down + click;
// an option selects on pointer-up + click (the test-setup polyfills stub the
// pointer APIs jsdom lacks).
export function openSelect(combobox: HTMLElement) {
  fireEvent.pointerDown(combobox, { button: 0, pointerType: "mouse" });
  fireEvent.click(combobox);
}

export function chooseOption(name: string) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
  fireEvent.click(option);
}
