import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ErrorBanner } from "../components/common/ErrorBanner";
import type { AppError } from "../types/error";

// Issue #194: ErrorBanner takes a single `error: AppError` prop -- one render
// path, no shell/session branching. Only message + detail are rendered; kind
// (shell / SessionFlowKind / read) is carried but not displayed. The
// TechnicalDetailsFold appears when detail is present and is omitted when null.

const messages = { "errorBoundary.details": "Technical details" };

function renderBanner(error: AppError, className?: string) {
  return render(
    <IntlProvider locale="en" messages={messages} defaultLocale="en-US">
      <ErrorBanner error={error} className={className} />
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
