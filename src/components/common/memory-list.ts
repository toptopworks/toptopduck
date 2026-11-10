// Non-component exports for the memory lists (issues #1529/#1531): the
// shared list tokens both memory surfaces ride. Split from MemoryRow.tsx
// so the component file only exports components (react-refresh).

// The list's visible ceiling (#1538 layout): ~5 rows (a full row is
// title 20px + hook 16px + py-2 16px + border 1px = 53px), then the list
// scrolls inside the card instead of stretching its host. Fewer rows keep
// the surface at its natural height.
export const LIST_MAX_HEIGHT_CLASS = "max-h-[265px]";

// The color-scale thresholds (issue #1530): yellow from 80%, red from 95%.
// The red figure mirrors the backend's pause threshold; there is no shared
// cross-end constant channel, so the pair is named here instead.
export const USAGE_YELLOW_PERCENT = 80;
export const USAGE_RED_PERCENT = 95;

/** The index-usage color scale (issue #1530): the warning token for the
 * yellow band (DESIGN.md), destructive for the red. */
export function usageTone(percent: number): string {
  if (percent >= USAGE_RED_PERCENT) {
    return "text-destructive";
  }
  if (percent >= USAGE_YELLOW_PERCENT) {
    return "text-warning";
  }
  return "text-muted-foreground";
}
