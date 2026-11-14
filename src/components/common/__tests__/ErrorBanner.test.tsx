import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../ErrorBanner";
import type { AppError } from "../../../types/error";

// Issue #194: ErrorBanner takes a single `error: AppError` prop -- one render
// path, no shell/session branching. Only message + detail are rendered; kind
// (shell / SessionFlowKind / read) is carried but not displayed. The
// TechnicalDetailsFold appears when detail is present and is omitted when null.
// Issue #1563: the optional onDismiss handle renders the close affordance and
// fires on click; surfaces that own the error's lifetime (session pane /
// result view / guided load) omit it and keep their exact render.

const messages = {
  "errorBoundary.details": "Technical details",
  "common.close": "Close",
};

function renderBanner(error: AppError, className?: string, onDismiss?: () => void) {
  return render(
    <IntlProvider locale="en" messages={messages} defaultLocale="en-US">
      <ErrorBanner error={error} className={className} onDismiss={onDismiss} />
    </IntlProvider>,
  );
}

describe("ErrorBanner (single AppError prop, issue #194)", () => {
  it("renders the message for a shell-kind AppError", () => {
    renderBanner({ message: "shell boom", kind: "shell", detail: null });
    expect(screen.getByText("shell boom")).toBeInTheDocument();
  });

  it("renders the message for a session-kind AppError (no shell branch)", () => {
    renderBanner({ message: "rename failed", kind: "rename", detail: null });
    expect(screen.getByText("rename failed")).toBeInTheDocument();
  });

  it("shows the technical-details fold when detail is present", () => {
    const { container } = renderBanner({
      message: "shell boom",
      kind: "shell",
      detail: "close-wait timed out",
    });
    const fold = container.querySelector(".error-details");
    expect(fold).not.toBeNull();
    expect(fold?.textContent).toContain("close-wait timed out");
    // Issue #864: the stack pre rides the code token's 13px idiom -- the
    // fold renders inside the workspace panel, and an off-ladder mono size
    // would drift below the documented code row.
    const stack = fold?.querySelector("pre.error-stack");
    expect(stack?.className.split(/\s+/)).toContain("text-[13px]");
  });

  it("omits the fold when detail is null", () => {
    const { container } = renderBanner({
      message: "rename failed",
      kind: "rename",
      detail: null,
    });
    expect(container.querySelector(".error-details")).toBeNull();
  });

  it("rides the className hook onto the Alert (shell grid placement)", () => {
    const { container } = renderBanner(
      { message: "shell boom", kind: "shell", detail: null },
      "shell-error",
    );
    expect(container.querySelector(".shell-error")).not.toBeNull();
  });

  it("does not render the kind into the banner DOM", () => {
    // kind tags the operation upstream (verb prefix / tagging); ErrorBanner
    // renders only message + detail, never kind. A regression leaking kind
    // into the DOM (e.g. `{error.kind}: {error.message}`) would surface the
    // literal kind text alongside the message.
    const { container } = renderBanner({
      message: "operation rejected",
      kind: "shell",
      detail: null,
    });
    expect(container.textContent).not.toContain("shell");
  });
});

describe("ErrorBanner (optional dismiss, issue #1563)", () => {
  it("renders no dismiss button without onDismiss", () => {
    // detail is null here, so the fold toggle is absent too: the banner
    // carries zero buttons when the surface owns the error's lifetime.
    const { container } = renderBanner({
      message: "shell boom",
      kind: "shell",
      detail: null,
    });
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the close button with onDismiss and fires it on click", () => {
    const onDismiss = vi.fn();
    renderBanner({ message: "shell boom", kind: "shell", detail: null }, undefined, onDismiss);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
