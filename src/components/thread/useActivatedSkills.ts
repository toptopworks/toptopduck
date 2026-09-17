import { useQuery } from "@tanstack/react-query";
import { listActivatedSkills } from "../../api";
import { sessionKeys } from "../../session/queryKeys";

// The shared activated-skills read (issue #961 review DRY): one query
// declaration behind the picker's display badges and the chips' display
// union -- same key, same fn, same session-only guard, so the two consumers
// can never disagree on which query they ride (they share the cache entry by
// construction).
export function useActivatedSkills(sessionId: string | null) {
  return useQuery({
    queryKey: sessionKeys.activatedSkills(sessionId ?? ""),
    queryFn: () => listActivatedSkills(sessionId as string),
    enabled: sessionId !== null,
  });
}
