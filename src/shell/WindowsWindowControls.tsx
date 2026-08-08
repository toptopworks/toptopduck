import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import type { ReactElement } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { log } from "../lib/log";
import { fireWindowAction } from "./window-actions";

// Windows/Linux window controls (minimize / maximize-restore / close) rendered
// at the topbar's right edge so the sidebar collapse toggle shares the same
// row as the window controls. Pairs with `decorations: false` in
// tauri.conf.json (no system chrome) and the window permissions in
// capabilities/default.json. The topbar carries data-tauri-drag-region so the
// empty chrome between buttons drags the window; these buttons sit as normal
// interactive children so clicks still register. Selected by the
// WindowControls dispatcher on every non-macOS desktop (ADR-0074: Linux also
// lands here — global decorations:false would otherwise leave Linux with no
// window chrome at all).
//
// ADR-0052 i18n contract + fire-and-forget failure routing live on the
// dispatcher (WindowControls.tsx) and the shared fireWindowAction helper.
export function WindowsWindowControls(): ReactElement {
  const intl = useIntl();
  const [maximized, setMaximized] = useState(false);

  // Sync the maximize/restore glyph with the real window state. onResized
  // covers both the toggle button and OS-level maximization (title-bar double
  // click, snap layouts, etc.). The unsubscribe resolves post-mount; the abort
  // flag covers cleanup firing before the promise resolves (component unmounted
  // mid-attach, e.g. shell-level ErrorBoundary reset).
  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.isMaximized().then(setMaximized).catch((e) => {
      // Seed failure is usually teardown; log so a persistent capability
      // failure does not silently leave the maximize/restore glyph out of sync
      // (aligns with the useAppConfigState window-IPC .catch + log template).
      log.warn("window", "isMaximized seed failed", e);
    });
    let aborted = false;
    let resolvedUnsub: (() => void) | null = null;
    appWindow
      .onResized(async () => {
        try {
          const next = await appWindow.isMaximized();
          if (!aborted) setMaximized(next);
        } catch (e) {
          // Most rejects here are teardown races (window closing mid-resize);
          // log anyway so a persistent capability failure stays observable
          // rather than silently leaving the glyph stuck.
          log.warn("window", "onResized isMaximized failed", e);
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
  // sits flush with the viewport (Windows-style titlebar hit target). The
  // focus-visible ring matches SidebarToggle / RailToggle so the three
  // buttons stay keyboard-reachable now that decorations:false removed the
  // system chrome (ADR-0052 layer-1 a11y invariant).
  return (
    <div className="window-controls flex items-center -mr-4">
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.minimize", defaultMessage: "Minimize" })}
        onClick={() => fireWindowAction("minimize")}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
        onClick={() => fireWindowAction("toggleMaximize")}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {maximized ? (
          <Copy className="h-3 w-3" aria-hidden />
        ) : (
          <Square className="h-3 w-3" aria-hidden />
        )}
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "common.close", defaultMessage: "Close" })}
        onClick={() => fireWindowAction("close")}
        className="inline-flex h-8 w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
