import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "../../components/ui/tooltip";
import { UpdateIndicator } from "../UpdateIndicator";
import { updateKeys } from "../../session/queryKeys";

// The standalone topbar update indicator (ADR-0143, issue #1509): absent
// while no update is known, present with a version-naming accessible label
// the moment the shared cache slice carries one. Empty-catalog English
// IntlProvider resolves labels to the defaultMessage literals (ADR-0052).

function renderIndicator(cacheValue: unknown, onOpenSettings = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cacheValue !== undefined) {
    queryClient.setQueryData(updateKeys.check(), cacheValue);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <UpdateIndicator onOpenSettings={onOpenSettings} />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const UPDATE = {
  version: "0.5.0",
  notes: null,
  currentVersion: "0.4.0",
};

describe("UpdateIndicator", () => {
  it("renders nothing while no update is known (self-hidden)", () => {
    const { container } = renderIndicator(undefined);
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows an independent icon naming the version once an update lands", () => {
    renderIndicator(UPDATE);
    expect(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    ).toBeInTheDocument();
  });

  it("routes the click to the settings open callback", () => {
    const onOpenSettings = vi.fn();
    renderIndicator(UPDATE, onOpenSettings);
    fireEvent.click(
      screen.getByRole("button", { name: "New version 0.5.0 available" }),
    );
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
