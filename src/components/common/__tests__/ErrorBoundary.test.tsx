import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { useEffect, type ReactNode } from "react";
import { ErrorBoundary, DegradeCard } from "../ErrorBoundary";
import { catalogFor } from "../../../i18n";

// Unit tests for the ADR-0058 ErrorBoundary + DegradeCard. The partition /
// session-isolation behavior is exercised end-to-end in Shell.test.tsx; these
// tests pin the boundary's own contract: render-throw capture, retry key-bump
// remount, onReset invalidate wiring, and the DegradeCard's chrome.

function wrap(children: ReactNode): ReactNode {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")} defaultLocale="en-US">
      {children}
    </IntlProvider>
  );
}

// A component that throws on render when its `boom` prop is set. Lets a test
// flip a partition into the error state without re-mounting the boundary.
function Boom({ boom, label }: { boom: boolean; label: string }): ReactNode {
  if (boom) throw new Error(`boom-${label}`);
  return <p data-testid={`ok-${label}`}>{label}</p>;
}

describe("ErrorBoundary (ADR-0058)", () => {
  afterEach(() => {
    // React logs the intentional render throw; keep the test output clean.
    vi.restoreAllMocks();
  });

  it("renders children when no render throw occurs", () => {
    render(
      wrap(
        <ErrorBoundary name="region">
          <Boom boom={false} label="a" />
        </ErrorBoundary>,
      ),
    );
    expect(screen.getByTestId("ok-a")).toBeInTheDocument();
  });

  it("replaces the thrown subtree with the degrade card", () => {
    // Suppress the expected console.error from the intentional throw.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      wrap(
        <ErrorBoundary name="region">
          <Boom boom={true} label="a" />
        </ErrorBoundary>,
      ),
    );
    // Degrade card is visible; the thrown child is gone.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("ok-a")).not.toBeInTheDocument();
    // The error message rides the expandable details (ADR-0058 honest detail).
    expect(screen.getByText(/boom-a/)).toBeInTheDocument();
    // data-region scopes a test to a specific partition.
    expect(screen.getByRole("alert").dataset.region).toBe("region");
  });

  it("retry: calls onReset, remounts children fresh (clearing client UI state), clears the error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let boom = true;
    const onReset = vi.fn();
    // Track real MOUNTS (not renders). A render throw unmounts the children
    // (the fallback takes their place), so the post-retry mount count rising
    // proves the children remounted fresh -- clearing local UI state like a
    // pagination offset (ADR-0058 retry contract). Asserting a render-call
    // count would be weaker: it fires on reconciliation too.
    let mounts = 0;
    function Child(): ReactNode {
      useEffect(() => {
        mounts++;
      }, []);
      if (boom) throw new Error("boom-a");
      return <p data-testid="ok-a">a</p>;
    }
    function App() {
      return (
        <ErrorBoundary name="region" onReset={onReset}>
          <Child />
        </ErrorBoundary>
      );
    }
    render(wrap(<App />));
    // Initial render threw before commit, so useEffect never ran: mounts is 0.
    expect(onReset).not.toHaveBeenCalled();
    expect(mounts).toBe(0);

    // Flip the boom flag off, then click retry.
    boom = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // onReset fires so the caller drops the region's stale server state.
    expect(onReset).toHaveBeenCalledTimes(1);
    // The retry cleared the error -> children mounted fresh (useEffect ran).
    expect(mounts).toBe(1);
    expect(screen.getByTestId("ok-a")).toBeInTheDocument();
  });

  it("does NOT catch event-handler throws (ADR-0058 L2 only catches render throws)", () => {
    // React ErrorBoundary is structurally incapable of catching an onClick
    // throw. This test documents that contract: a handler throw is NOT
    // swallowed by the boundary (it goes to the global handler / L1 path).
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Clicker(): ReactNode {
      return (
        <button type="button" onClick={() => undefined}>
          click
        </button>
      );
    }
    render(
      wrap(
        <ErrorBoundary name="region">
          <Clicker />
        </ErrorBoundary>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "click" }));
    // No degrade card -- the boundary did not engage.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("accepts a custom fallback (L3 shell reload exit)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      wrap(
        <ErrorBoundary
          name="shell"
          fallback={(error, retry) => (
            <DegradeCard error={error} onRetry={retry} name="shell" onReload={reload} />
          )}
        >
          <Boom boom={true} label="a" />
        </ErrorBoundary>,
      ),
    );
    // The L3 variant renders both retry and reload exits.
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重载" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重载" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("NESTED: the inner boundary catches, not the outer", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      wrap(
        <ErrorBoundary name="outer">
          <ErrorBoundary name="inner">
            <Boom boom={true} label="a" />
          </ErrorBoundary>
        </ErrorBoundary>,
      ),
    );
    const card = document.querySelector(".degrade-card") as HTMLElement | null;
    expect(card).toBeInTheDocument();
    expect(card!.dataset.region).toBe("inner");
  });

  // ADR-0067 (issue #181): the .degrade-* CSS rules retired onto shadcn Card +
  // Button (default + outline variants) + TechnicalDetailsFold. Pin the
  // utility classes so a silent revert (raw <button> / raw <div> / dropped
  // border-l-* accent) is caught at the build level. jsdom has no layout
  // engine, so these are class-list assertions, not visual assertions --
  // mirroring the border-l-* tone pin in Thread.test.tsx (issue #169).
  it("DegradeCard: Card destructive accent + Button default/outline variants ride the token utilities (issue #181)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      wrap(
        <ErrorBoundary
          name="shell"
          fallback={(error, retry) => (
            <DegradeCard error={error} onRetry={retry} name="shell" onReload={() => undefined} />
          )}
        >
          <Boom boom={true} label="a" />
        </ErrorBoundary>,
      ),
    );
    // Left-edge destructive accent -- the ADR-0058 recoverable-but-flagged
    // tone, mirrored from the textual-card failed variant (issue #173).
    const card = document.querySelector(".degrade-card") as HTMLElement;
    expect(card.className.split(/\s+/)).toContain("border-l-destructive");
    expect(card.className.split(/\s+/)).toContain("border-l-[3px]");
    // Retry = primary teal (Button default variant rides --primary).
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry.className.split(/\s+/)).toContain("bg-primary");
    // Reload = outline (Button outline variant rides bg-background + border).
    const reload = screen.getByRole("button", { name: "重载" });
    expect(reload.className.split(/\s+/)).toContain("bg-background");
    // TechnicalDetailsFold carries the error message in its collapsed <pre>.
    expect(screen.getByText(/boom-a/)).toBeInTheDocument();
  });
});
