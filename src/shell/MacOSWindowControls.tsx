import { useIntl } from "react-intl";
import type { ReactElement } from "react";
import { Minus, Plus, X } from "lucide-react";
import { fireWindowAction } from "./window-actions";

// macOS traffic-light window controls (red close / yellow minimize / green
// maximize), frontend-simulated per ADR-0074 route 1. Rendered at the topbar's
// LEFT edge (App.tsx places this component before SidebarToggle on macOS so
// the toggle shifts right of the reserved area).
//
// Hit target (WCAG 2.2 SC 2.5.8): each <button> is 24x24 (h-6 w-6) while the
// visible colored dot stays the native ~12px (h-3 w-3) inside a centered
// <span> — the platform-faithful look without the undersized 12px click
// target the bare dot would give.
//
// Glyph visibility (WCAG 1.4.1): the × / − / + glyph is ALWAYS rendered
// (opacity-60 baseline) so color is not the sole signal distinguishing the
// three dots, and `group-hover` lifts it to opacity-100 for the macOS-native
// hover-affordance emphasis. Native macOS hides glyphs until hover; ADR-0074
// chose default-visible so colorblind / touchpad-only / low-vision users can
// read each dot at rest (a11y > the hover-reveal fidelity cue).
//
// Green button semantics: toggleMaximize (cross-platform parity with the
// Windows path, ADR-0074 Why#7), NOT fullscreen. The aria-label is always
// "Maximize" — there is no restore variant because toggleMaximize is a single
// bidirectional action.
//
// Colors are macOS platform convention (system traffic-light red/yellow/green),
// not product brand tokens — ADR-0050's token system covers brand semantics,
// and pinning these to a token would lose the platform fidelity the route-1
// simulation exists to provide. Arbitrary hex keeps the native macOS palette
// readable at the call site.
//
// ADR-0052: aria-labels localize via STATIC intl.formatMessage literals (reuses
// window.close / window.minimize / window.maximize ids — no new catalog keys).
// i18n contract + failure routing live on the dispatcher (WindowControls.tsx)
// and the shared fireWindowAction helper.
export function MacOSWindowControls(): ReactElement {
  const intl = useIntl();

  // gap-2 (~8px) approximates the native traffic-light dot spacing. Each dot
  // is h-3 w-3 (12px); the glyph is h-2 w-2 centered, opacity-60 at rest and
  // opacity-100 on group-hover. focus-visible keeps the dots keyboard-
  // reachable (ADR-0052 layer-1 a11y invariant — decorations:false removed
  // the system chrome).
  return (
    <div className="macos-window-controls group flex items-center gap-2">
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.close", defaultMessage: "Close" })}
        onClick={() => fireWindowAction("close")}
        className="inline-flex h-6 w-6 items-center justify-center border-0 bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f57]">
          <X className="h-2 w-2 text-black/80 opacity-60 transition-opacity group-hover:opacity-100" aria-hidden />
        </span>
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.minimize", defaultMessage: "Minimize" })}
        onClick={() => fireWindowAction("minimize")}
        className="inline-flex h-6 w-6 items-center justify-center border-0 bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#febc2e]">
          <Minus className="h-2 w-2 text-black/80 opacity-60 transition-opacity group-hover:opacity-100" aria-hidden />
        </span>
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.maximize", defaultMessage: "Maximize" })}
        onClick={() => fireWindowAction("toggleMaximize")}
        className="inline-flex h-6 w-6 items-center justify-center border-0 bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-[#28c840]">
          <Plus className="h-2 w-2 text-black/80 opacity-60 transition-opacity group-hover:opacity-100" aria-hidden />
        </span>
      </button>
    </div>
  );
}
