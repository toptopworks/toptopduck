// The selection toolbar's placement math (#1573), pure so the three-boundary
// clip is testable without a DOM: the visible area is the viewport clipped
// by every scroll/clip ancestor between the anchor's prose container and the
// session column root (boundary one and two), floored by the composer card's
// top edge (boundary three). Anchor = the first selection rect intersecting
// the visible area; above preferred (an 8px gap, the dsh canonical), below
// when the headroom is short. The toolbar's own box is clamped inside the
// visible area; a fully-clipped anchor or an over-tall toolbar yields null
// (the caller hides the toolbar until repositioning finds room again).

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlacementInput {
  viewport: Rect;
  /** The scroll/clip containers between the anchor's source element and the
   *  session column root, outermost first (walk order is irrelevant to the
   *  intersection). */
  clipRects: readonly Rect[];
  /** The composer card, when it horizontally overlaps the visible area --
   *  its top edge floors the placement so the toolbar never covers the
   *  composer. null = no floor (cold start / not overlapping). */
  composerRect: Rect | null;
  /** The selection's client rects (Range.getClientRects()); the anchor is
   *  the first intersecting the visible area. */
  anchorRects: readonly Rect[];
  toolbar: { width: number; height: number };
  gap: number;
}

export interface ToolbarPlacement {
  left: number;
  top: number;
  /** The toolbar's max content width: the visible area's width, so a wide
   *  toolbar wraps instead of overflowing the column. */
  maxWidth: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.right > b.left &&
    a.left < b.right &&
    a.bottom > b.top &&
    a.top < b.bottom
  );
}

export function computeToolbarPlacement(
  input: PlacementInput,
): ToolbarPlacement | null {
  const { viewport, clipRects, composerRect, anchorRects, toolbar, gap } =
    input;
  let visible = viewport;
  for (const clip of clipRects) {
    visible = {
      left: Math.max(visible.left, clip.left),
      top: Math.max(visible.top, clip.top),
      right: Math.min(visible.right, clip.right),
      bottom: Math.min(visible.bottom, clip.bottom),
    };
  }
  if (
    composerRect !== null &&
    composerRect.right > visible.left &&
    composerRect.left < visible.right
  ) {
    visible = { ...visible, bottom: Math.min(visible.bottom, composerRect.top) };
  }
  if (visible.right <= visible.left || visible.bottom <= visible.top) {
    return null;
  }
  const anchor = anchorRects.find((r) => intersects(r, visible));
  if (anchor === undefined) return null;
  const width = toolbar.width;
  const height = toolbar.height;
  const x = Math.max(
    visible.left,
    Math.min(
      (Math.max(anchor.left, visible.left) +
        Math.min(anchor.right, visible.right) -
        width) /
        2,
      visible.right - width,
    ),
  );
  const above = anchor.top - gap - height;
  const below = anchor.bottom + gap;
  const preferredY = above >= visible.top ? above : below;
  if (height > visible.bottom - visible.top) return null;
  const top = Math.max(
    visible.top,
    Math.min(preferredY, visible.bottom - height),
  );
  return { left: x, top, maxWidth: visible.right - visible.left };
}
