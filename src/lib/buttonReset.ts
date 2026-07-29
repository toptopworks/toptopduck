// Bare <button> chrome reset for unstyled buttons (ADR-0067). Replaces the
// former [all:unset]: Tailwind v4's arbitrary [all:unset] cascades AFTER the
// display utilities on the same element, so `all: unset` clobbers `display:
// flex` (session-entry-main / grouping options / connection row) and `display:
// block` (menu items) back to inline, collapsing the layout.
// appearance-none/bg-transparent/border-0 strip the same native chrome WITHOUT
// touching display; per-element utilities own padding/color, and the base-layer
// `button { font: inherit }` rule (app.css) owns the font. Shared by the
// sidebar (issue #171), settings rail, profiles list, and connection row
// (issue #282) bare buttons.
export const bareButtonReset = "appearance-none bg-transparent border-0";
