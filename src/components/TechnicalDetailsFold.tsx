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
}

export function TechnicalDetailsFold({ detail }: TechnicalDetailsFoldProps) {
  if (!detail) return null;
  return (
    <details className="error-details">
      <summary className="muted">
        <FormattedMessage id="errorBoundary.details" defaultMessage="Technical details" />
      </summary>
      <pre className="error-stack">{detail}</pre>
    </details>
  );
}
