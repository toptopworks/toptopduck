import { FormattedMessage } from "react-intl";
import { useEffect, useState } from "react";

// A 1s-ticking `now` while `ticking` is true; frozen otherwise (the stale
// value costs nothing -- the reader clamps and the pause math never reads
// past the freeze). Leaf-local on purpose: the tick re-renders only this
// component, never the hosts (issue #1264).
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

// The elapsed seconds a turn clock displays (issue #1264): derived from the
// TIMESTAMP (not a self-incrementing counter), so a hidden keep-alive page's
// throttled ticker heals to the true elapsed time on visibility -- no
// cumulative drift. `pausedSince` freezes the figure while the turn waits on
// the user (Codex-style pause: user think-time stays out of the elapsed
// figure) -- the display reads the clock as of the pause's start and the
// ticker stops with it. Clamped at 0: a fresh stamp can postdate the stale
// `now` a previous window left behind, for up to one tick.
function useElapsedSeconds(startedAt: number | null, pausedSince: number | null): number | null {
  const now = useNow(startedAt !== null && pausedSince === null);
  if (startedAt === null) return null;
  const end = pausedSince !== null ? Math.min(now, pausedSince) : now;
  return Math.max(0, Math.floor((end - startedAt) / 1000));
}

/** The elapsed-seconds suffix leaf ("· 12s"): ticks once a second off a
 *  turn-flow-owned stamp, rendered inside the rail's trailing wait status
 *  line and the QuestionBar phase label -- both role="status" live regions,
 *  so the ticking number is aria-hidden: the per-second change is
 *  decoration, never a live-region re-announcement. Renders null when no
 *  clock is running (stamp null). */
export function WaitElapsedSuffix({
  startedAt,
  pausedSince = null,
}: {
  startedAt: number | null;
  /** The turn clock's pause origin: the figure freezes at the pause's start
   *  and the ticker stops (the turn is waiting on the user). */
  pausedSince?: number | null;
}) {
  const seconds = useElapsedSeconds(startedAt, pausedSince);
  if (seconds === null) return null;
  return (
    <span aria-hidden="true">
      {" · "}
      <FormattedMessage id="common.waitElapsed" defaultMessage="{seconds}s" values={{ seconds }} />
    </span>
  );
}
