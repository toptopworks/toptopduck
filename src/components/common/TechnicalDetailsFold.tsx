// The collapsed "Technical details" fold shared by every error surface:
// ErrorBanner (command rejects), the session-pane auto-save warning, and the
// Failed turn outcome in both Thread and SessionPane (issue #125). One source
// for the markup so the summary label and stack <pre> stay in sync across all
// callers. The detail is a raw engine / provider string audited to carry no
// API key (ADR-0029); null / undefined / empty omits the fold entirely.
import { FormattedMessage } from "react-intl";

export interface TechnicalDetailsFoldProps {
  /** Raw technical detail (engine error text, provider call detail). Falsy
   *  (null / undefined / "") -> the fold is omitted. ADR-0029: the Rust side is
   *  audited to keep secrets out of these payloads, so the raw detail is safe to
   *  surface here. */
  detail: string | null | undefined;
  /** Issue #1005: mount the fold already expanded -- the failed card whose
   *  turn is the thread's latest settled one (the shared predicate with the
   *  sidebar's dot). React only writes the `open` attribute when the prop
   *  VALUE changes, so a steady value never clobbers the user's manual
   *  collapse; when the turn stops being the latest, the flip back to
   *  undefined returns the fold to the collapsed posture -- the same
   *  state-style semantics the sidebar dot follows. */
  defaultOpen?: boolean;
}

export function TechnicalDetailsFold({ detail, defaultOpen }: TechnicalDetailsFoldProps) {
  if (!detail) return null;
  return (
    // ADR-0067 (issue #172): the fold's visual rules used to live under
    // .error / .persist-warning parent cascades in styles.css. Those parent
    // containers migrated to shadcn Alert variants (ErrorBanner -> destructive,
    // the session-pane persist-warning -> warning); the Thread / SessionPane
    // Failed-turn folds were bare (no matching parent), so they previously
    // rendered with only browser defaults. The fold now carries its own
    // utilities, so all four callers (two Alerts + two bare Failed-turn cards)
    // render with the same muted-bg + scroll-container treatment. The
    // .error-details / .error-stack class hooks stay for selector / test
    // stability (Shell.test.tsx queries .shell-error .error-details).
    <details className="error-details mt-2" open={defaultOpen}>
      <summary className="text-muted-foreground cursor-pointer text-[0.82rem]">
        <FormattedMessage id="errorBoundary.details" defaultMessage="Technical details" />
      </summary>
      <pre className="error-stack mt-1.5 p-2 bg-muted rounded-md font-mono text-[13px] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
        {detail}
      </pre>
    </details>
  );
}
