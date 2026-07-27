import { useIntl } from "react-intl";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Plus, X } from "lucide-react";
import { log } from "../lib/log";

// macOS traffic-light window controls (red close / yellow minimize / green
// maximize), frontend-simulated per ADR-0074 route 1. Rendered at the topbar's
// LEFT edge (the dispatcher's caller in App.tsx places this component before
// SidebarToggle on macOS so the toggle shifts right of the reserved area).
//
// Fidelity F2 (ADR-0074 Why#6): the three dots always show their platform
// colors; hovering ANY dot reveals the × / − / + glyph on ALL three at once
// via a pure-CSS `group-hover` (no JS state, no per-button hover). The glyph
// reveal is the highest-signal fidelity item -- without × on hover the close
// dot reads as decorative, not actionable. Omitted: unfocused greyed-out
// state and Alt+click modifier (power-user / single-window low-value, YAGNI).
//
// Green button semantics: toggleMaximize (cross-platform parity with the
// Windows path, ADR-0074 Why#7), NOT fullscreen. The aria-label is always
// "Maximize" -- there is no restore variant because toggleMaximize is a single
// bidirectional action and F2 omits the unfocused state that would otherwise
// warrant a glyph swap.
//
// Colors are macOS platform convention (system traffic-light red/yellow/green),
// not product brand tokens -- ADR-0050's token system covers brand semantics,
// and pinning these to a token would lose the platform-fidelity the route-1
// simulation exists to provide. Arbitrary hex values keep the native macOS
// palette readable at the call site.
//
// ADR-0052 (issue #261): aria-labels are UI chrome (layer 1) and localize via
// STATIC intl.formatMessage literals (reuses the existing window.close /
// window.minimize / window.maximize ids -- no new catalog keys). Mounts inside
// <IntlProvider> (App topbar), so useIntl reaches the catalog directly.
export function MacOSWindowControls() {
  const intl = useIntl();

  // Same fire-and-forget contract as WindowsWindowControls: clicks are user
  // intent, not a subscribe chain, so a rejection is a real capability/runtime
  // failure and log.warn surfaces it (mirrors useAppConfigState IPC .catch).
  const fire = (action: "minimize" | "toggleMaximize" | "close") => {
    void getCurrentWindow()[action]().catch((e) => log.warn("window", `${action} failed`, e));
  };

  // gap-2 (~8px) approximates the native traffic-light dot spacing. Each dot
  // is h-3 w-3 (12px) matching the native hit target; the glyph is h-2 w-2
  // centered, hidden until the group is hovered. focus-visible keeps the dots
  // keyboard-reachable (ADR-0052 layer-1 a11y invariant -- decorations:false
  // removed the system chrome).
  return (
    <div className="macos-window-controls group flex items-center gap-2">
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.close", defaultMessage: "Close" })}
        onClick={() => fire("close")}
        className="inline-flex h-3 w-3 items-center justify-center rounded-full border-0 bg-[#ff5f57] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <X className="h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.minimize", defaultMessage: "Minimize" })}
        onClick={() => fire("minimize")}
        className="inline-flex h-3 w-3 items-center justify-center rounded-full border-0 bg-[#febc2e] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Minus className="h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "window.maximize", defaultMessage: "Maximize" })}
        onClick={() => fire("toggleMaximize")}
        className="inline-flex h-3 w-3 items-center justify-center rounded-full border-0 bg-[#28c840] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Plus className="h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </button>
    </div>
  );
}
