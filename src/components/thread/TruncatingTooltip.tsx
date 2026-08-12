// Tail-ellipsis truncation (ADR-0054) hover-recovery layer (ADR-0050 maps
// Tooltip to card-truncation full-text recovery, issue #106). The truncated span
// is the Tooltip trigger; the full text rides TooltipContent so a hover recovers
// what the fixed rail width clipped. asChild keeps the trigger span a direct
// flex child (no wrapper node) so the `truncate` utility on the same span owns
// the ellipsis end-to-end. Replaces the v0 native title attribute (which carried
// the same full text but only as the browser's slow, unstyled tooltip). max-w-xs
// caps the popover so a long question wraps instead of stretching the rail-wide
// tooltip.
//
// The tooltip opens only when the trigger text actually overflows — no tooltip
// when the text fits (see isTruncated below).
//
// `text` is ReactNode so a source marker can append its i18n'd stale suffix
// alongside the verbatim name. Keyboard recovery is a non-goal: the trigger span
// carries no tabIndex, matching the v0 native title (which keyboard users could
// not surface either); the verbatim text also lives in the persisted session for
// non-pointer access.
//
// Extracted from Thread.tsx (issue #427) as a shared utility consumed by
// SourceMarker, SkillMarker, TurnCard, and the composer popover sections. Lives
// in its own file to avoid a circular dependency between Thread.tsx and
// TurnCard.tsx.

import { useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Whether the trigger span's content overflows its visible box (i.e. the
// `truncate` utility is actively ellipsizing). jsdom reports 0 for both
// dimensions (no layout engine), so the check defaults to true there — keeping
// tests that rely on the tooltip showing functional. Real browsers compute
// actual dimensions and the gate suppresses the tooltip when the text fits.
function isTruncated(el: HTMLElement): boolean {
  if (el.clientWidth === 0) return true;
  return el.scrollWidth > el.clientWidth;
}

export function TruncatingTooltip({
  text,
  className,
  children,
}: {
  text: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        // Gate: suppress the open when the text isn't actually truncated.
        if (next && ref.current && !isTruncated(ref.current)) return;
        setOpen(next);
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className={className}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}
