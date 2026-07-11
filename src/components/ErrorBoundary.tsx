import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { useIntl } from "react-intl";

// Layered render-phase error boundaries (ADR-0058).
//
// React ErrorBoundary catches ONLY errors thrown during render (component map,
// JSX construction). It does NOT catch event-handler throws, async / Promise
// rejections, or `useEffect` throws -- those are L0/L1 concerns and stay on
// their own paths (Vega degradation in ResultView, IPC error banners, etc.).
// This component therefore cannot accidentally swallow business-error
// semantics: it only fires for genuine render crashes.
//
// Partitioning (ADR-0058 Decision 1): the shell wraps each crash-prone region
// (Thread rail, ResultView workspace, one SessionPane body) in its own
// <ErrorBoundary> so a render crash degrades ONLY that block; an L3 boundary
// at the App root is the last-resort fallback. Each retry calls `onReset` so
// the caller drops the region's stale server state (re-fetch fresh instead of
// re-throwing against stale), then clears the error so the children remount
// fresh -- the render throw already unmounted them, so the clear-mount cycle
// inherently resets any local UI state (pagination offset, etc.).
//
// The boundary is a class component because React still requires the
// `getDerivedStateFromError` / `componentDidCatch` lifecycle, which has no
// hook equivalent. `onReset` keeps queryClient out of this file: the caller
// decides which TanStack Query slice to invalidate for its region.

interface ErrorBoundaryProps {
  /** Region label (debug + log). Rendered into the fallback's data-region so a
   *  test can scope assertions and dev-tools can locate the degrade card. */
  name: string;
  /** Fired when the user hits Retry. The caller invalidates the region's server
   *  state so the remount re-fetches fresh data (ADR-0058 Decision 2). */
  onReset?: () => void;
  /** Custom fallback. Defaults to <DegradeCard>. Render-prop so the caller can
   *  add a "reload window" exit for the L3 shell-level boundary. */
  fallback?: (error: Error, retry: () => void, name: string) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log -- a render crash must never go dark silently. The degrade
    // card carries the message in its expandable details (ADR-0058: honest,
    // not hidden, not scary); this trace adds the component stack for dx and
    // Tauri users opening devtools, and gives a future telemetry hook a seat.
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
  }

  retry = (): void => {
    // ADR-0058 Decision 2: drop the region's stale server state, then clear
    // the error so the children remount fresh. onReset runs BEFORE the clear
    // so a synchronous cache drop queues the refetch the remounted children
    // read. No key bump is needed: the render throw already unmounted the
    // children (the fallback took their place), so clearing the error mounts
    // them fresh and any local UI state is naturally reset.
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      const fallback = this.props.fallback ?? defaultFallback;
      return fallback(this.state.error, this.retry, this.props.name);
    }
    // Return children via a Fragment. On a render throw the children unmount
    // (the fallback takes their place); on retry they mount fresh -- the
    // remount is inherent to the error -> fallback -> retry -> children cycle.
    // A bare `return this.props.children` defeats nested-boundary resolution:
    // React does not treat the boundary as the throwing child's parent for
    // error-bubbling purposes, so the throw skips the inner boundary and lands
    // on the next ancestor that renders a real subtree. Wrapping in a Fragment
    // gives the boundary a concrete child subtree it owns.
    return <Fragment>{this.props.children}</Fragment>;
  }
}

// Default fallback factory: renders <DegradeCard>. Kept as a function (not a
// static element) so the retry callback re-evaluates with the current `retry`
// binding after each render.
function defaultFallback(
  error: Error,
  retry: () => void,
  name: string,
): ReactNode {
  return <DegradeCard error={error} onRetry={retry} name={name} />;
}

interface DegradeCardProps {
  error: Error;
  onRetry: () => void;
  name: string;
  /** Optional reload handler -- the L3 shell-level boundary passes this so a
   *  whole-shell crash offers a "reload window" exit in addition to retry. */
  onReload?: () => void;
}

// The degrade card (ADR-0058 Decision 2): friendly text + Retry + expandable
// technical details. The details are collapsed by default (honest -- not
// hidden, but not scary), and carry the error message verbatim. onReload is
// only wired by the L3 shell boundary; session/region boundaries omit it.
export function DegradeCard({ error, onRetry, name, onReload }: DegradeCardProps) {
  const intl = useIntl();
  return (
    <div className="degrade-card" role="alert" data-region={name}>
      <p className="degrade-message">
        {intl.formatMessage({
          id: "errorBoundary.message",
          defaultMessage: "This area couldn’t be displayed.",
        })}
      </p>
      <div className="degrade-actions">
        <button type="button" className="degrade-retry" onClick={onRetry}>
          {intl.formatMessage({ id: "errorBoundary.retry", defaultMessage: "Retry" })}
        </button>
        {onReload && (
          <button type="button" className="degrade-reload" onClick={onReload}>
            {intl.formatMessage({ id: "errorBoundary.reload", defaultMessage: "Reload" })}
          </button>
        )}
      </div>
      <details className="degrade-details">
        <summary className="muted">
          {intl.formatMessage({
            id: "errorBoundary.details",
            defaultMessage: "Technical details",
          })}
        </summary>
        <pre className="degrade-stack">{error.message}</pre>
      </details>
    </div>
  );
}
