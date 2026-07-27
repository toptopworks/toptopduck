import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

// Windows-style window controls (minimize / maximize-restore / close) rendered
// at the topbar's right edge so the sidebar collapse toggle shares the same
// row as the window controls. Pairs with `decorations: false` in
// tauri.conf.json (no system chrome) and the window permissions in
// capabilities/default.json. The topbar carries data-tauri-drag-region so the
// empty chrome between buttons drags the window; these buttons sit as normal
// interactive children so clicks still register.
// ADR-0052 (issue #261): the button aria-labels are UI chrome (layer 1) and
// must localize -- each is a STATIC intl.formatMessage literal so
// @formatjs/cli extract resolves every id. WindowControls mounts inside
// <IntlProvider> (App topbar), so useIntl reaches the catalog directly.
// Platform note: this renders the Windows/Unix right-side layout on every
// platform; macOS traffic-light styling is a follow-up.
export function WindowControls() {
  const intl = useIntl();
  const [maximized, setMaximized] = useState(false);

  // Sync the maximize/restore glyph with the real window state. onResized
  // covers both the toggle button and OS-level maximization (title-bar double
  // click, snap layouts, etc.). The unsubscribe resolves post-mount; the abort
  // flag covers cleanup firing before the promise resolves (component unmounted
  // mid-attach, e.g. shell-level ErrorBoundary reset).
  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    let aborted = false;
    let resolvedUnsub: (() => void) | null = null;
    appWindow
      .onResized(async () => {
        try {
          const next = await appWindow.isMaximized();
          if (!aborted) setMaximized(next);
        } catch {
          // window torn down during cleanup -- ignore
        }
      })
      .then((unsub) => {
        if (aborted) unsub();
        else resolvedUnsub = unsub;
      });
    return () => {
      aborted = true;
      resolvedUnsub?.();
    };
  }, []);

  // -mr-4 offsets the topbar's px-4 padding so the close button's right edge
  // sits flush with the viewport (Windows-style titlebar hit target).
  return (
    <div className="window-controls flex items-center -mr-4">
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.minimize", defaultMessage: "Minimize" })}
        onClick={() => void getCurrentWindow().minimize()}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={
          maximized
            ? intl.formatMessage({ id: "window.restore", defaultMessage: "Restore" })
            : intl.formatMessage({ id: "window.maximize", defaultMessage: "Maximize" })
        }
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      >
        {maximized ? (
          <Copy className="h-3 w-3" aria-hidden />
        ) : (
          <Square className="h-3 w-3" aria-hidden />
        )}
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.close", defaultMessage: "Close" })}
        onClick={() => void getCurrentWindow().close()}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-destructive hover:text-destructive-foreground"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
