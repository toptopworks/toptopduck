import { FormattedMessage } from "react-intl";
import { useEffect, useState } from "react";

// Derive the whole elapsed seconds since the wait-window stamp, re-derived
// by a 1s interval. The value derives from the TIMESTAMP (not a
// self-incrementing counter), so a hidden keep-alive page's throttled
// interval heals to the true elapsed time on visibility -- no cumulative
// drift (issue #1264).
function useElapsedSeconds(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt]);
  // Clamped at 0: a fresh stamp can postdate the stale `now` a previous
  // window's ticker left behind, for up to one tick.
  return startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The wait-elapsed suffix leaf ("· 12s"): ticks once a second off the
 *  turn-flow-owned wait stamp, rendered inside the rail's trailing wait
 *  status line and the QuestionBar phase label -- both role="status" live
 *  regions, so the ticking number is aria-hidden: the per-second change is
 *  decoration, never a live-region re-announcement. Renders null outside a
 *  wait window (stamp null). */
export function WaitElapsedSuffix({ startedAt }: { startedAt: number | null }) {
  const seconds = useElapsedSeconds(startedAt);
  if (seconds === null) return null;
  return (
    <span aria-hidden="true">
      {" · "}
      <FormattedMessage id="common.waitElapsed" defaultMessage="{seconds}s" values={{ seconds }} />
    </span>
  );
}
