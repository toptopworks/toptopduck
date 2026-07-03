import type { StaleAnchor, StaleReason } from "./types";

// The verb for a stale badge, parameterized by why the result went stale
// (issue #41 AC4): a Deleted upstream source -> "已删除"; a Replaced source
// (re-uploaded under the same reference name, ADR-0025) -> "已更新". Exhaustive
// switch mirrors the Rust `match` so a future StaleReason variant forces a
// branch here (types.ts is the hand-maintained mirror -- the TS compiler won't
// catch a missing case without the `never` check).
function staleBadgeVerb(reason: StaleReason): string {
  switch (reason) {
    case "Deleted":
      return "已删除";
    case "Replaced":
      return "已更新";
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled stale reason: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Full stale-badge text naming the source that invalidated the result. Shared
// by the thread (a stale result_N's turn entry) and the working-set list (a
// stale result_N's row) so the wording stays single-sourced -- the reason
// distinguishes "因源已删除而失效" (source removed, issue #40) from "因源已更新
// 而失效" (source re-uploaded, issue #41 ADR-0025).
export function staleBadgeText(anchor: StaleAnchor): string {
  return `因「${anchor.display_name}」${staleBadgeVerb(anchor.reason)}而失效`;
}
