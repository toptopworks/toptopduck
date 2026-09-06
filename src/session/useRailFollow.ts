import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LiveTurn } from "./useTurnFlow";

/** Distance from the bottom (px) inside which the rail counts as "at the
 *  bottom" -- a scroll event landing beyond it pauses the follow, and one
 *  landing inside it (re)enters the follow. One band, both directions: the
 *  hysteresis keeps sub-threshold wiggles from flapping the state. */
const RESUME_BAND_PX = 40;

/** The rail's stick-to-bottom posture (issue #829). Four behaviors over one
 *  boolean state:
 *
 *  - Submit: liveTurn null -> live is the submit signal (the user bubble
 *    mounts at submit), forcing the follow ON and landing the bottom -- even
 *    from a paused read of history, the new question is at the tail.
 *  - Append: settled entries growing (entryCount) or the live turn streaming
 *    (liveTurn identity changes per delta) schedule ONE rAF-coalesced write
 *    to the bottom per frame -- no per-delta hard scroll.
 *  - Pause: a scroll event landing beyond RESUME_BAND_PX from the bottom.
 *    Programmatic aligns always land AT the bottom, so they never trip it;
 *    a mid-timeline jump (the stale-chip scrollIntoView, Thread.tsx) lands
 *    far past the band and pauses with no special case.
 *  - Resume: a scroll event landing back inside the band. The resume itself
 *    does not snap -- the user keeps their position until the next append
 *    realigns.
 *
 *  Geometry interplay (why the distance math needs no special cases): the
 *  overlay bar's height is reserved INSIDE the scroll extent via the rail's
 *  dynamic bottom padding (#836), so scrollHeight - clientHeight - scrollTop
 *  measures the true reading distance without the hook knowing the bar
 *  exists. #839's `scrollbar-gutter: stable both-edges` keeps the scrollbar
 *  appearing/disappearing reflow-free, and fold/unfold changes content height
 *  WITHOUT firing scroll events (scrollTop is unchanged), so the machine
 *  never observes the fold at all.
 *
 *  Session switch PRESERVES posture (the keep-alive contract, ADR-0051):
 *  open panes stay MOUNTED but display:none when not active, so a switch is
 *  the `active` option's false -> true transition -- a pane paused on
 *  history keeps its reading position through it (restored unchanged), while
 *  a following pane re-aligns to catch up on content streamed while hidden.
 *  The initial land is the fresh open: it mounts active with following ON,
 *  and a session whose data loads in after mount re-lands when entryCount
 *  first grows. While hidden, NO geometry write may fire -- display:none
 *  collapses the extent to 0, so an align would land scrollTop 0 and
 *  corrupt even a paused pane's preserved position.
 */
export function useRailFollow({
  active,
  entryCount,
  liveTurn,
}: {
  /** Whether this pane's layer is the visible one (ADR-0051 keep-alive).
   *  Gates geometry writes; its false -> true transition is the
   *  session-switch land-at-bottom signal. */
  active: boolean;
  /** Signal: the settled entries' count. Growth = an append (a turn settled,
   *  the settle swap) -- the align rides the change, so an array identity or
   *  contents are never needed. */
  entryCount: number;
  /** Signal: the in-flight turn. Identity changes per streaming delta; the
   *  null -> non-null transition doubles as the submit signal. */
  liveTurn: LiveTurn | null;
}): {
  /** Attach to the scroll container (.session-rail). */
  railRef: RefObject<HTMLElement | null>;
  /** Whether the rail is currently following the tail. The test seam: the
   *  machine's pause/resume half is observable only through it (scroll-write
   *  counts cannot tell "paused" from "idle-following"). */
  isFollowing: boolean;
} {
  const railRef = useRef<HTMLElement | null>(null);
  // Following starts ON: the fresh pane's posture is "on the latest turn".
  const [isFollowing, setIsFollowing] = useState(true);
  // The listener and the rAF callback read the ref (they must see the latest
  // posture synchronously -- a paused rail's pending frame must not write),
  // while the boolean mirrors it for consumers.
  const followingRef = useRef(true);

  // Latest-value mirror for the same reason (the dep-less sync follows
  // useRailResize's getMaxWidthRef pattern): the rAF callback outlives
  // renders and must read the CURRENT activation, not the one from its
  // creating render.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });

  const rafRef = useRef<number | null>(null);
  const scheduleAlign = useCallback(() => {
    // One write per frame: a frame already pending absorbs the request, so a
    // burst of streaming deltas costs a single scroll write.
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // Never write while hidden: display:none collapses the extent to 0, so
      // the align would land scrollTop 0 and the switch-back would open at
      // the top. The activation transition re-arms the align instead.
      if (!activeRef.current || !followingRef.current) return;
      const el = railRef.current;
      if (el === null) return;
      el.scrollTop = el.scrollHeight - el.clientHeight;
      // A landed write is the machine re-entering the follow, so the
      // published mirror rides the same callback (a bail-out no-op when
      // already true). The mirror is ONLY ever touched from event callbacks
      // (here and the scroll handler) -- never from an effect body.
      setIsFollowing(true);
    });
  }, []);

  // Activation signal (the session switch, ADR-0051 keep-alive): the pane was
  // mounted-but-hidden and is now the visible layer. Posture is PRESERVED --
  // the keep-alive contract is "restored unchanged", so this only schedules:
  // the callback's followingRef gate lets a following pane catch up on what
  // streamed while hidden and leaves a paused pane's reading position alone.
  // Fresh opens mount active with following ON, which is the initial land.
  useEffect(() => {
    if (!active) return;
    scheduleAlign();
  }, [active, scheduleAlign]);

  // Submit signal: force-follow. Runs BEFORE the append effect's pass on the
  // same render, so a submit from a paused rail re-arms the follow the same
  // frame the live bubble mounts; the mirror publishes one frame later, when
  // the forced align lands.
  const liveActive = liveTurn !== null;
  useEffect(() => {
    if (!liveActive) return;
    followingRef.current = true;
    scheduleAlign();
  }, [liveActive, scheduleAlign]);

  // Append signal. Also fires on mount (the initial land for a session
  // switch / cold start), and on the settle swap (live -> null + count+1
  // arrive in one render, and the posture is still following).
  useEffect(() => {
    scheduleAlign();
  }, [entryCount, liveTurn, scheduleAlign]);

  // The pause/resume machine: every scroll event re-evaluates the band. Our
  // own aligns land at the bottom (distance 0), so they re-enter "true" as a
  // no-op; only the user (or a programmatic jump) can land beyond the band.
  // The listener attaches directly to the rail element: the section is
  // unconditional within the pane, so one mount-time attach sees its whole
  // life. Passive: the handler only reads, never scrolls.
  useEffect(() => {
    const el = railRef.current;
    if (el === null) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.clientHeight - el.scrollTop <= RESUME_BAND_PX;
      followingRef.current = atBottom;
      setIsFollowing(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // A pending frame must not fire after unmount (a session switch remounts
  // the pane; the stale callback would write to the retired element's ref --
  // harmless for a detached node, but canceling keeps the frame count honest).
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return { railRef, isFollowing };
}
