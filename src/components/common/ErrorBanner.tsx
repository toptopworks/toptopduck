// A user-facing error banner with an optional collapsed "Technical details"
// fold (issue #119). The primary `message` is locale-rendered upstream (via
// fmtError / describeReject); the Engine technical detail surfaces only when
// present, reusing the shared errorBoundary.details locale key. Shared by the
// shell, the session pane, and the result view so all three surface Engine.data
// consistently -- a close-wait timeout reject carries its actionable "retry
// shortly" hint in the detail, which must not vanish at any layer.
//
// Issue #194: the prop shape is a single `error: AppError` -- one render path,
// no shell/session branching. kind is carried but not rendered here; it tags
// the originating operation for upstream prefix logic.
import type { AppError } from "../../types";
import { Alert, AlertDescription } from "../ui/alert";
import { TechnicalDetailsFold } from "./TechnicalDetailsFold";

export interface ErrorBannerProps {
  /** The error to render. Shell rejects carry kind "shell"; session rejects
   *  carry a SessionFlowKind. Only `message` and `detail` are rendered; `kind`
   *  tags the operation and is consumed upstream (verb prefix / tagging). */
  error: AppError;
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
export function ErrorBanner({ error, className }: ErrorBannerProps) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>
        <p className="m-0">{error.message}</p>
        <TechnicalDetailsFold detail={error.detail} />
      </AlertDescription>
    </Alert>
  );
}
