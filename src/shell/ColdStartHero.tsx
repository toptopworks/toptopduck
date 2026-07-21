import { FormattedMessage } from "react-intl";
import { Button } from "../components/ui/button";

// Cold-start / all-closed hero (ADR-0061). The right side when no session is
// active: a "new session" call-to-action. The privacy disclosure lives in
// SettingsView's Privacy pane (ADR-0066) -- the hero no longer duplicates it.
// This is the shell-level empty state before any DuckDB instance exists (zero
// memory until the user acts). A freshly-created unsaved session shows its own
// hero inside its SessionPane.
export function ColdStartHero({
  disabled,
  onNew,
}: {
  disabled: boolean;
  onNew: () => void;
}) {
  // Drop-to-create (ADR-0061, #81 A1) is now routed by the single shell-level
  // webview drop listener in App, which treats activeSessionId === null as the
  // cold-start case. This component is pure UI.
  // ADR-0067 (issue #173): the .workspace-hero visual rule (flex column,
  // centered, gap, padding, text-align) retired from styles.css onto utility.
  // .cold-start-hero (positioning overlay) stays in styles.css as a layout-only
  // hook; the workspace-hero hook stays for selector stability.
  // ADR-0067 (issue #182): the .cold-start-title bespoke font-size (1.4rem) +
  // margin retired onto utility (text-[1.4rem] + m-0 mb-2) -- arbitrary value
  // preserves the exact retired size (Tailwind's nearest scale step text-2xl is
  // 1.5rem, a 0.1rem drift from the AC "字号渲染不变"), and the .primary-cta
  // bespoke primary teal styling retired onto a shadcn Button default variant
  // (bg-primary + text-primary-foreground + rounded-md) sized lg for the CTA
  // weight. The disabled progress cursor is preserved via className override
  // (disabled:pointer-events-auto disabled:cursor-progress disabled:opacity-60):
  // disabled:pointer-events-auto re-opens the shadcn base's
  // disabled:pointer-events-none (without it browsers ignore cursor under
  // pointer-events:none and the cursor-progress hint never renders), and
  // disabled:opacity-60 nudges the Button default's disabled:opacity-50 back to
  // 0.6 to match the retired rule. A native disabled <button> still does not
  // dispatch click, so re-enabling pointer-events is safe. The .cold-start-title
  // / .primary-cta class hooks stay on the elements for selector / test stability.
  return (
    <div className="workspace-hero cold-start-hero flex flex-col items-center gap-4 p-8 text-center">
      <h2 className="cold-start-title m-0 mb-2 text-[1.4rem]">
        <FormattedMessage id="coldStart.title" defaultMessage="Start an analysis" />
      </h2>
      <p className="text-muted-foreground">
        <FormattedMessage
          id="coldStart.hint"
          defaultMessage="Click “New session” on the left, or open a saved session to resume. Drop a data file to start a new analysis in one step."
        />
      </p>
      <Button
        size="lg"
        className="primary-cta disabled:pointer-events-auto disabled:cursor-progress disabled:opacity-60"
        disabled={disabled}
        onClick={onNew}
      >
        <FormattedMessage id="coldStart.newSession" defaultMessage="New session" />
      </Button>
    </div>
  );
}
