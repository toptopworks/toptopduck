import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  computeToolbarPlacement,
  type Rect,
} from "./selectionSurfacePosition";

// The selection surface's gesture machine (#1573), dsh's text-interaction
// adapted to the ticket's rulings: the toolbar appears when a drag- or
// Shift-selection RELEASES (a pointerdown -> pointerup window records
// selection changes without showing anything, and a window that saw no
// change releases nothing -- a selection-preserving press cannot resurrect
// what it dismissed), coexists with the native
// right-click menu (a non-primary press neither dismisses nor re-arms --
// the ADR-0149 policy layer is untouched), and rides rAF repositioning
// (scroll / window resize / streaming growth move the box, never close it).
// The dismiss matrix: selection narrowed or cleared, Escape, window blur,
// pointercancel, the pane deactivating (session switch), unmount. While
// focus sits inside the toolbar, selection changes do not close it (the
// browser mutates the selection as the buttons are pressed).

interface ActiveSelection {
  readonly text: string;
}

interface SelectionTarget {
  readonly source: HTMLElement;
  /** The selection's range snapshot at appear time -- the live selection
   *  can die (focus moves) while the toolbar must keep placing from the
   *  same anchor. */
  readonly range: Range;
}

export interface SelectionSurface {
  /** Non-null while the toolbar shows: the staged selection's text. */
  readonly active: ActiveSelection | null;
  /** The toolbar element's ref -- the hook drives its placement. */
  readonly toolbarRef: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
  /** Clear the browser selection (the quote / copy success paths). */
  clearSelection: () => void;
}

const TOOLBAR_GAP = 8;
const SCROLL_CLIP_PATTERN = /(auto|scroll|hidden|clip)/u;
// The composer card's selector hook (QuestionBar keeps the class for
// selector / test stability): the placement floor's one DOM probe, shared
// by the placement and the growth observer.
const COMPOSER_SELECTOR = ".question-bar";

function toRect(rect: DOMRect): Rect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function sameRange(a: Range | null, b: Range | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset)
  );
}

/** The prose container the selection lives in, or null: the deepest element
 *  at the range start carrying the caller-side mark, still under the root,
 *  also containing the range's end (a selection spanning two prose
 *  containers belongs to neither). */
function selectionSourceOf(root: HTMLElement, range: Range): HTMLElement | null {
  const startNode = range.startContainer;
  const startEl =
    startNode.nodeType === startNode.ELEMENT_NODE
      ? (startNode as Element)
      : startNode.parentElement;
  const source = startEl?.closest("[data-selection-source]") ?? null;
  if (!(source instanceof HTMLElement)) return null;
  if (!root.contains(source)) return null;
  if (!source.contains(range.endContainer)) return null;
  return source;
}

/** The clip chain (boundary two): the column root's rect plus every
 *  scroll/clip container between the source element and the root. The
 *  placement fn folds these into the viewport -- one intersection fold,
 *  owned by the pure module. */
function collectClips(
  root: HTMLElement,
  source: HTMLElement,
  view: Window,
): Rect[] {
  const clips: Rect[] = [toRect(root.getBoundingClientRect())];
  for (
    let node: HTMLElement | null = source;
    node !== null && node !== root;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (
      SCROLL_CLIP_PATTERN.test(style.overflowX) ||
      SCROLL_CLIP_PATTERN.test(style.overflowY)
    ) {
      clips.push(toRect(node.getBoundingClientRect()));
    }
  }
  return clips;
}

export function useSelectionSurface(
  rootRef: RefObject<HTMLElement | null>,
  /** The pane's active posture (#1573): a deactivating pane (session
   *  switch) dismisses its toolbar. */
  enabled = true,
): SelectionSurface {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<ActiveSelection | null>(null);
  // The machine's refs: gesture arms, the gesture-window's change record,
  // the last-seen range (the post-pointerup selectionchange echo is the
  // same range and must not re-dismiss), and the placed target.
  const pointerArmedRef = useRef(false);
  const shiftArmedRef = useRef(false);
  const gestureChangedRef = useRef(false);
  const lastRangeRef = useRef<Range | null>(null);
  const targetRef = useRef<SelectionTarget | null>(null);

  const dismiss = useCallback(() => {
    targetRef.current = null;
    setActive(null);
  }, []);

  const clearSelection = useCallback(() => {
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges();
  }, [rootRef]);

  // The placement: pure math (selectionSurfacePosition) over live geometry.
  // A detached source/range (streaming swapped the prose out) dismisses; a
  // fully-clipped anchor only hides the toolbar (it stays "active" until a
  // real dismissal so scrolling back finds it again).
  const place = useCallback(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    const target = targetRef.current;
    if (root === null || toolbar === null || target === null) return;
    if (
      !root.isConnected ||
      !root.contains(target.source) ||
      !target.range.startContainer.isConnected
    ) {
      dismiss();
      return;
    }
    const view = root.ownerDocument.defaultView;
    if (view === null) return;
    const size = toolbar.getBoundingClientRect();
    // jsdom's Range implements neither client-rect API; the guards keep the
    // machine tests running with an empty anchor (the placement then hides
    // the toolbar -- geometry is the pure fn's business).
    const anchorRects =
      typeof target.range.getClientRects === "function"
        ? [...target.range.getClientRects()].map(toRect)
        : [];
    const rects =
      anchorRects.length > 0
        ? anchorRects
        : typeof target.range.getBoundingClientRect === "function"
          ? [toRect(target.range.getBoundingClientRect())]
          : [];
    // Boundaries one and two ride the clip chain; boundary three (the
    // composer floor) is the placement fn's composerRect.
    const composer = root.ownerDocument.querySelector(COMPOSER_SELECTOR);
    const placement = computeToolbarPlacement({
      viewport: {
        left: 0,
        top: 0,
        right: view.innerWidth,
        bottom: view.innerHeight,
      },
      clipRects: collectClips(root, target.source, view),
      composerRect:
        composer instanceof HTMLElement
          ? toRect(composer.getBoundingClientRect())
          : null,
      anchorRects: rects,
      toolbar: { width: size.width, height: size.height },
      gap: TOOLBAR_GAP,
    });
    if (placement === null) {
      toolbar.style.visibility = "hidden";
      return;
    }
    toolbar.style.maxWidth = `${placement.maxWidth}px`;
    toolbar.style.left = `${placement.left}px`;
    toolbar.style.top = `${placement.top}px`;
    toolbar.style.visibility = "visible";
  }, [dismiss, rootRef, toolbarRef]);

  // The appear: the releasing gesture hands over a live, non-empty
  // selection inside one of the caller-marked prose containers.
  const tryAppear = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    const selection = root.ownerDocument.getSelection();
    if (selection === null || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const text = selection.toString();
    if (text === "") return;
    const source = selectionSourceOf(root, range);
    if (source === null) return;
    lastRangeRef.current = range.cloneRange();
    gestureChangedRef.current = false;
    targetRef.current = { source, range: range.cloneRange() };
    setActive({ text });
  }, [rootRef]);

  // Document-level gesture machine. Every dep below is identity-stable.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const doc = root.ownerDocument;
    const view = doc.defaultView;
    if (view === null) return;
    let frame: number | undefined;
    const insideToolbar = (event: Event): boolean =>
      toolbarRef.current !== null &&
      event.composedPath().includes(toolbarRef.current);
    const schedulePlacement = (): void => {
      if (targetRef.current === null || frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    };
    const cancel = (): void => {
      pointerArmedRef.current = false;
      shiftArmedRef.current = false;
      dismiss();
    };
    const readRange = (): Range | null => {
      const selection = doc.getSelection();
      return selection !== null && selection.rangeCount === 1
        ? selection.getRangeAt(0).cloneRange()
        : null;
    };
    const onSelectionChange = (): void => {
      if (
        targetRef.current !== null &&
        toolbarRef.current?.contains(doc.activeElement) === true
      ) {
        return; // focus inside the toolbar: selection churn is the buttons' doing
      }
      if (pointerArmedRef.current || shiftArmedRef.current) {
        gestureChangedRef.current = true;
        return; // inside a gesture window: record, never show
      }
      const range = readRange();
      if (!gestureChangedRef.current && sameRange(lastRangeRef.current, range)) {
        return; // the post-appear echo
      }
      gestureChangedRef.current = false;
      lastRangeRef.current = range;
      dismiss();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (insideToolbar(event)) return;
      if (event.button !== 0) return; // right-click coexists with the toolbar
      dismiss();
      lastRangeRef.current = readRange();
      gestureChangedRef.current = false;
      pointerArmedRef.current =
        event.target instanceof Node && root.contains(event.target);
    };
    const onPointerUp = (): void => {
      if (!pointerArmedRef.current) return;
      pointerArmedRef.current = false;
      // A window that saw no selection change releases nothing: the press
      // preserved the selection (a scrollbar drag, a menu trigger that
      // preventDefaults mousedown), so the release has no gesture to show.
      if (!gestureChangedRef.current) return;
      tryAppear();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancel();
        return;
      }
      if (insideToolbar(event)) return;
      if (event.key === "Shift") {
        shiftArmedRef.current = true;
        dismiss();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!shiftArmedRef.current) return;
      if (event.key !== "Shift" && event.shiftKey) return;
      shiftArmedRef.current = false;
      // The pointerup gate's twin: a Shift window that changed nothing
      // (the key was tapped alone) releases nothing.
      if (!gestureChangedRef.current) return;
      tryAppear();
    };
    const onWindowBlur = (): void => cancel();

    doc.addEventListener("selectionchange", onSelectionChange);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointerup", onPointerUp);
    doc.addEventListener("pointercancel", cancel);
    doc.addEventListener("keydown", onKeyDown);
    doc.addEventListener("keyup", onKeyUp);
    doc.addEventListener("scroll", schedulePlacement, true);
    view.addEventListener("resize", schedulePlacement);
    view.addEventListener("blur", onWindowBlur);
    return () => {
      doc.removeEventListener("selectionchange", onSelectionChange);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", onPointerUp);
      doc.removeEventListener("pointercancel", cancel);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("keyup", onKeyUp);
      doc.removeEventListener("scroll", schedulePlacement, true);
      view.removeEventListener("resize", schedulePlacement);
      view.removeEventListener("blur", onWindowBlur);
      if (frame !== undefined) view.cancelAnimationFrame(frame);
    };
  }, [dismiss, place, tryAppear, rootRef, toolbarRef]);

  // Repositioning matrix (active-gated): scroll / window resize /
  // streaming growth move the toolbar, never dismiss it. rAF-coalesced.
  useEffect(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    if (active === null || root === null || toolbar === null) return;
    const view = root.ownerDocument.defaultView;
    if (view === null) return;
    let frame: number | undefined;
    const schedule = (): void => {
      if (frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    };
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(root);
      resizeObserver.observe(toolbar);
      const composer = root.ownerDocument.querySelector(COMPOSER_SELECTOR);
      if (composer instanceof HTMLElement) resizeObserver.observe(composer);
    }
    const mutations = new MutationObserver((records) => {
      if (
        records.some((record) => !toolbar.contains(record.target as Node))
      ) {
        schedule();
      }
    });
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      resizeObserver?.disconnect();
      mutations.disconnect();
      if (frame !== undefined) view.cancelAnimationFrame(frame);
    };
  }, [active, place, rootRef, toolbarRef]);

  // First placement rides the mounting frame (before paint).
  useLayoutEffect(place, [active, place]);

  // The deactivating pane (session switch) closes its toolbar. A prop edge,
  // not an external subscription -- the render-phase alternative would
  // write refs during render (the dismissal clears the placement target),
  // so the effect stands with the rule's exemption, the useViewedResult
  // precedent.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!enabled) dismiss();
  }, [enabled, dismiss]);

  return { active, toolbarRef, dismiss, clearSelection };
}
