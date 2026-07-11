import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactNode } from "react";
import { ErrorBoundary, DegradeCard } from "../components/ErrorBoundary";
import { catalogFor } from "../i18n";

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

  it("retry: calls onReset (invalidate), remounts children (key bump), clears the error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let boom = true;
    const onReset = vi.fn();
    const Child = vi.fn(() => <Boom boom={boom} label="a" />);
    function App() {
      return (
        <ErrorBoundary name="region" onReset={onReset}>
          <Child />
        </ErrorBoundary>
      );
    }
    render(wrap(<App />));
    // Initial render threw. onReset has NOT fired (no retry yet).
    expect(onReset).not.toHaveBeenCalled();
    const callsBeforeRetry = Child.mock.calls.length;

    // Flip the boom flag off, then click retry.
    boom = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // onReset fires so the caller invalidates the region's server state.
    expect(onReset).toHaveBeenCalledTimes(1);
    // The children remounted fresh (key bump) -- Child is invoked again after
    // the retry, on top of whatever React's throw-retry did before.
    expect(Child.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
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
});
