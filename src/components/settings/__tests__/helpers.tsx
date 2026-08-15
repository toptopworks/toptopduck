import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "../../ui/tooltip";

// Settings routes its chrome through react-intl (ADR-0052). Rendered inside an
// empty-catalog English IntlProvider so FormattedMessage / useIntl fall back to
// the defaultMessage -- the canonical English source (ADR-0052) -- and
// assertions anchor on stable English strings without coupling to the zh-CN
// catalog. onError silences the expected missing-message warnings (the ids
// intentionally resolve via defaultMessage, not the empty catalog).
//
// QueryClientProvider wraps the tree because the Runtime section's Local CLI
// tab reads the adapter table via TanStack Query (issue #489). retry is off so
// a rejected query does not retry under waitFor.
//
// TooltipProvider mirrors the App ancestor (the rail's dual-state gear carries a
// Tooltip); App mounts one high in the tree, so the pane tests reproduce that
// context. Shared by the SettingsView tests (issue #216 split).
export function renderSettings(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>{ui}</IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  // The query client rides along so tests can assert cache writes made by
  // the component (e.g. the post-probe setQueryData mirror, issue #536) via
  // getQueryData.
  return { ...result, queryClient };
}
