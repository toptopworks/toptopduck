// A user-facing error banner with an optional collapsed "Technical details"
// fold (issue #119). The primary `message` is locale-rendered upstream (via
// fmtError / toAppError); the Engine technical detail surfaces only when
// present, reusing the shared errorBoundary.details locale key. Shared by the
// shell, the session pane, and the result view so all three surface Engine.data
// consistently -- a close-wait timeout reject carries its actionable "retry
// shortly" hint in the detail, which must not vanish at any layer.
//
// Issue #194: the prop shape is a single `error: AppError` -- one render path,
// no shell/session branching. kind is carried but not rendered here; it tags
// the originating operation for upstream prefix logic.
//
// Issue #1563: the optional onDismiss handle renders a close affordance (the
// shell banner's manual clear -- the shell error state has no other lifetime
// bound, so the banner used to be immortal). Surfaces that own the error's
// lifetime (session pane / result view / guided load) omit the prop and keep
// their exact render. The button rides common.close for its accessible name
// and the DESIGN.md icon-button shape (28px hit, 14px glyph).
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import type { AppError } from "../../types/error";
import { Alert, AlertDescription } from "../ui/alert";
import { TechnicalDetailsFold } from "./TechnicalDetailsFold";

export interface ErrorBannerProps {
  /** The error to render. Shell rejects carry kind "shell"; session rejects
   *  carry a SessionFlowKind. Only `message` and `detail` are rendered; `kind`
   *  tags the operation and is consumed upstream (verb prefix / tagging). */
  error: AppError;
  /** Extra class names appended to the Alert (e.g. `shell-error` for the shell
   *  track placement, which styles.css consumes as a layout-only hook). */
  className?: string;
  /** Dismiss handle: renders the close affordance and fires on click. Omit on
   *  surfaces that own the error's lifetime -- no close button renders. */
  onDismiss?: () => void;
}

// ADR-0067 (issue #172): the bespoke .error container (hardcoded #fde7e9 bg +
// var padding/radius) retired into a shadcn Alert destructive variant, which
// consumes the --destructive token via bg-destructive/10 + text-destructive.
// The optional className (e.g. `shell-error`) still rides the Alert so the
// shell track's card-slot layout hook in styles.css keeps working.
export function ErrorBanner({ error, className, onDismiss }: ErrorBannerProps) {
  const intl = useIntl();
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>
        <p className="m-0">{error.message}</p>
        <TechnicalDetailsFold detail={error.detail} />
      </AlertDescription>
      {onDismiss && (
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={intl.formatMessage({
            id: "common.close",
            defaultMessage: "Close",
          })}
          onClick={onDismiss}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </Alert>
  );
}
