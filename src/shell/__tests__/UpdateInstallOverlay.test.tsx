import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UpdateInstallOverlay } from "../UpdateInstallOverlay";
import { updateKeys } from "../../session/queryKeys";

// The install-in-flight overlay (issue #1509): absent while the shared
// install slice is null; once a face starts the install chain the centered
// progress card shows with no dismiss affordance. Empty-catalog English
// IntlProvider resolves labels to the defaultMessage literals (ADR-0052).

function renderOverlay(sliceValue: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (sliceValue !== undefined) {
    queryClient.setQueryData(updateKeys.install(), sliceValue);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <UpdateInstallOverlay />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("UpdateInstallOverlay", () => {
  it("renders nothing while no install is in flight", () => {
    const { container } = renderOverlay(undefined);
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("shows the centered progress card with the preparing posture", () => {
    renderOverlay({ percent: null });
    expect(screen.getByRole("status")).toHaveTextContent("Installing update");
    expect(screen.getByRole("status")).toHaveTextContent(
      "TOPTOPDuck will restart when the update finishes.",
    );
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    // No dismiss affordance: the card's only buttonless content is status.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("mirrors the shared percent onto the progressbar", () => {
    renderOverlay({ percent: 40 });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });
});
