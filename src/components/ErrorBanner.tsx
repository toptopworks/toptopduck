// A user-facing error banner with an optional collapsed "Technical details"
// fold (issue #119). The primary `message` is locale-rendered upstream (via
// fmtError); the Engine technical detail surfaces only when present, reusing
// the shared errorBoundary.details locale key. Shared by the shell, the
// session pane, and the result view so all three surface Engine.data
// consistently -- previously only the session pane rendered the fold, so a
// close-wait timeout reject lost its actionable "retry shortly" hint at the
// shell layer.
import { Alert, AlertDescription } from "./ui/alert";
import { TechnicalDetailsFold } from "./TechnicalDetailsFold";

export interface ErrorBannerProps {
  message: string;
  /** Technical detail from a typed SessionError::Engine reject (issue #119),
   *  rendered collapsed under the message. null/undefined/empty -> fold
   *  omitted. ADR-0029: the Rust side is audited to keep secrets out of Engine
   *  payloads, so the raw detail is safe to surface here. */
  detail?: string | null;
  /** Extra class names appended to the Alert (e.g. `shell-error` for the shell
   *  grid placement, which styles.css keeps as a layout-only hook). */
  className?: string;
}

// ADR-0067 (issue #172): the bespoke .error container (hardcoded #fde7e9 bg +
// var padding/radius) retired into a shadcn Alert destructive variant, which
// consumes the --destructive token via bg-destructive/10 + text-destructive.
// The optional className (e.g. `shell-error`) still rides the Alert so the
// shell grid placement .shell > .shell-error layout hook in styles.css keeps
// working.
export function ErrorBanner({ message, detail, className }: ErrorBannerProps) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>
        <p className="m-0">{message}</p>
        <TechnicalDetailsFold detail={detail} />
      </AlertDescription>
    </Alert>
  );
}
