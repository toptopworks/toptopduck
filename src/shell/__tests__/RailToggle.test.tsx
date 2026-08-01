import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { RailToggle } from "../RailToggle";

// RailToggle is chrome; an empty English catalog + onError keeps the render
// quiet while aria-label assertions anchor on the defaultMessage fallback.
function renderToggle(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

describe("RailToggle pending-approval badge (ADR-0083, issue #297)", () => {
  it("badges a COLLAPSED rail when an approval awaits (dot + named aria-label)", () => {
    const { container } = renderToggle(
      <RailToggle collapsed disabled={false} onToggle={() => {}} alert />,
    );
    expect(container.querySelector(".rail-alert")).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Expand conversation rail (an approval awaits your answer)",
      }),
    ).toBeInTheDocument();
  });

  it("hides the dot on an EXPANDED rail (the in-flow card is visible then)", () => {
    const { container } = renderToggle(
      <RailToggle collapsed={false} disabled={false} onToggle={() => {}} alert />,
    );
    expect(container.querySelector(".rail-alert")).toBeNull();
  });

  it("carries no dot without an alert regardless of collapse state", () => {
    const { container } = renderToggle(
      <RailToggle collapsed disabled={false} onToggle={() => {}} />,
    );
    expect(container.querySelector(".rail-alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand conversation rail" }),
    ).toBeInTheDocument();
  });
});
