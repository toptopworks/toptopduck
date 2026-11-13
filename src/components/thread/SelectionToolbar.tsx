import type { Ref } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Copy, MessageSquareQuote } from "lucide-react";

// The selection toolbar (#1573): the thread's transient-hint face riding the
// inverted floating tier (DESIGN.md) -- dark surface, no border, shadow-md;
// the buttons speak the toast action's control vocabulary (alpha border,
// alpha hover fill, inverted-foreground focus ring). The hook positions the
// box imperatively (left / top / maxWidth / visibility on this element) --
// this component renders NO position style so React never fights the
// placement. It appears without grabbing focus; Escape / dismissal is the
// hook's document-level machine, not the toolbar's.

// The toast action's control chain, re-keyed to the toolbar's 28px row:
// border /25, hover fill /10, focus ring inverted-foreground (DESIGN.md,
// The Inverted Floating Tier).
const TOOLBAR_ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-inverted-foreground/25 bg-transparent px-2.5 text-xs font-medium text-inverted-foreground transition-colors hover:bg-inverted-foreground/10 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted-foreground/60";

export type SelectionToolbarProps = {
  /** Stage the selection as a composer quote chip (#1573). The caller owns
   *  the staging write, the selection clear, and the toolbar dismissal. */
  onQuote: () => void;
  /** Copy the selection's text; the caller reports success (toast) and
   *  failure (the toolbar stays put). */
  onCopy: () => void;
};

export function SelectionToolbar({
  ref,
  onQuote,
  onCopy,
}: SelectionToolbarProps & { ref?: Ref<HTMLDivElement> }) {
  const intl = useIntl();
  return (
    <div
      ref={ref}
      data-selection-toolbar=""
      role="toolbar"
      aria-label={intl.formatMessage({
        id: "thread.selectionSurface.toolbarAria",
        defaultMessage: "Text actions",
      })}
      className="fixed z-20 flex items-center gap-1.5 rounded-md bg-inverted p-1.5 text-inverted-foreground shadow-md"
      // The toolbar's own area never opens the native menu (the policy
      // layer's default stays untouched everywhere else).
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" className={TOOLBAR_ACTION_CLASS} onClick={onQuote}>
        <MessageSquareQuote className="size-3.5 shrink-0" aria-hidden />
        <FormattedMessage
          id="thread.selectionSurface.quote"
          defaultMessage="Quote to chat"
        />
      </button>
      <button type="button" className={TOOLBAR_ACTION_CLASS} onClick={onCopy}>
        <Copy className="size-3.5 shrink-0" aria-hidden />
        <FormattedMessage
          id="thread.selectionSurface.copy"
          defaultMessage="Copy"
        />
      </button>
    </div>
  );
}
