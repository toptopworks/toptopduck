import { FormattedMessage } from "react-intl";

import { useUpdateInstallState } from "./useUpdateInstall";

/** The install-in-flight overlay (ADR-0143, issue #1509): while the one-shot
 *  atomic install chain runs, the app shows a centered progress card -- the
 *  user's only job is to wait, so there is deliberately NO close / cancel
 *  affordance (the chain ends in a process relaunch; its failure path clears
 *  the slice and dismisses this overlay). Mounted once near the shell root;
 *  reads the shared `update-install` slice, so it mirrors an install started
 *  from either face (the sidebar indicator or the About pane). */
export function UpdateInstallOverlay() {
  const install = useUpdateInstallState();
  if (install === null) return null;
  return (
    // role="status" + aria-live: the card's own text (title -> percent) is
    // the live announcement; no separate aria-label needed.
    <div
      className="bg-background/60 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div className="bg-popover text-popover-foreground w-80 rounded-lg border border-border p-5 shadow-lg">
        <p className="text-foreground text-sm font-semibold">
          <FormattedMessage
            id="update.overlay.title"
            defaultMessage="Installing update"
          />
        </p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          <FormattedMessage
            id="update.overlay.body"
            defaultMessage="TOPTOPDuck will restart when the update finishes."
          />
        </p>
        <div
          className="bg-muted mt-4 h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={install.percent ?? undefined}
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: install.percent !== null ? `${install.percent}%` : "0%" }}
          />
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          {install.percent === null ? (
            <FormattedMessage
              id="update.overlay.preparing"
              defaultMessage="Preparing…"
            />
          ) : (
            <FormattedMessage
              id="update.overlay.percent"
              defaultMessage="{percent}%"
              values={{ percent: install.percent }}
            />
          )}
        </p>
      </div>
    </div>
  );
}
