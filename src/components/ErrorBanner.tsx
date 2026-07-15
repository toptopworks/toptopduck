// A user-facing error banner with an optional collapsed "Technical details"
// fold (issue #119). The primary `message` is locale-rendered upstream (via
// fmtError); the Engine technical detail surfaces only when present, reusing
// the shared errorBoundary.details locale key. Shared by the shell, the
// session pane, and the result view so all three surface Engine.data
// consistently -- previously only the session pane rendered the fold, so a
// close-wait timeout reject lost its actionable "retry shortly" hint at the
// shell layer.
import { TechnicalDetailsFold } from "./TechnicalDetailsFold";

export interface ErrorBannerProps {
  message: string;
  /** Technical detail from a typed SessionError::Engine reject (issue #119),
   *  rendered collapsed under the message. null/undefined/empty -> fold
   *  omitted. ADR-0029: the Rust side is audited to keep secrets out of Engine
   *  payloads, so the raw detail is safe to surface here. */
  detail?: string | null;
  /** Extra class names appended to the base `.error` container (e.g.
   *  `shell-error` for the shell grid placement). */
  className?: string;
}

export function ErrorBanner({ message, detail, className }: ErrorBannerProps) {
  return (
    <div className={`error${className ? ` ${className}` : ""}`} role="alert">
      <p className="error-message">{message}</p>
      <TechnicalDetailsFold detail={detail} />
    </div>
  );
}
