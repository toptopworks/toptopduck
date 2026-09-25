import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

import { getSkillsDir } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import type { SkillEntry } from "../../types/skills";

// The skills pane's registry-root seam (issue #1083): ONE hook owns the
// root's resolution state, its fetch generation guard, and the SKILL.md
// path join -- the race and separator semantics that previously lived
// scattered through the pane container. The contract:
//   - the mount effect fetches the root once (the backend is the path
//     authority, the get_agents_dir posture);
//   - retry() re-fetches (the local row's detail-open is the retry entry,
//     issue #1039);
//   - detailFilePath(skill) synthesizes the open anchor + the SKILL.md
//     file name through each path's own separator;
//   - a failed phase carries the ALREADY-FORMATTED error (fmtError) so the
//     detail dialog's path face renders it verbatim.
//
// The rescan's write-generation guard (writeGenRef) deliberately stays in
// the pane container: same shape, different domain -- one protects the
// config sync from a late mount rescan, this one protects the root state
// from a late fetch. They are orthogonal and must not merge.

/** The registry root's resolution state: `failed` carries the formatted
 *  error the detail dialog's path face reports (issue #1039). */
export type SkillsRoot =
  | { phase: "loading" }
  | { phase: "resolved"; root: string }
  | { phase: "failed"; error: string };

/** The row's open anchor (issue #1033): a `local` row's own
 *  `<root>/<name>` directory; a `linked` row's link target and a `builtin`
 *  row's reserved-subtree copy (`link_target` carries both). Null when a
 *  local row is asked before the registry root has resolved, or when a
 *  linked row's link target is unreadable -- the open stays inert rather
 *  than synthesizing a garbage path. The root's own separator threads
 *  through the join, so a Windows root reads native backslashes. */
function revealTarget(skill: SkillEntry, skillsRoot: SkillsRoot): string | null {
  if (skill.acquired !== "local") return skill.link_target;
  if (skillsRoot.phase !== "resolved") return null;
  const sep = skillsRoot.root.includes("\\") ? "\\" : "/";
  return `${skillsRoot.root}${sep}${skill.name}`;
}

/** The SKILL.md path from an open anchor directory (null passes through
 *  so the caller renders an inert link): joined with the anchor's own
 *  separator so a Windows root reads native backslashes. */
function skillFilePath(target: string | null): string | null {
  if (target === null) return null;
  return target.includes("\\") ? `${target}\\SKILL.md` : `${target}/SKILL.md`;
}

export function useSkillsRoot(): {
  root: SkillsRoot;
  detailFilePath: (skill: SkillEntry) => string | null;
  retry: () => void;
} {
  const intl = useIntl();

  // Fetched on mount and re-fetched by a local row's detail-open while
  // unresolved (issue #1039) -- the open click is the retry entry -- so a
  // failed fetch reports on that row's detail dialog (the path face)
  // instead of leaving the open link permanently inert. A re-fetch keeps
  // the previous phase until its response lands, and the fetch callbacks
  // alone write the state: a response landing after unmount is a silent
  // React no-op, so there is no cancelled guard to thread (the callbacks
  // carry no cross-pane cache write or config sync).
  const [skillsRoot, setSkillsRoot] = useState<SkillsRoot>({
    phase: "loading",
  });

  // Each fetch bumps a generation so a late response from an older fetch
  // cannot overwrite a newer one (the PR #1041 review): with the mount
  // fetch and an open-click re-fetch both in flight, a stale rejection
  // landing after a newer resolve would flip the phase back to failed
  // mid-dialog. The warn still fires unconditionally so a stale failure
  // stays diagnosable.
  const fetchGenRef = useRef(0);

  function fetchSkillsRoot() {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    getSkillsDir()
      .then((dir) => {
        if (fetchGenRef.current === gen) {
          setSkillsRoot({ phase: "resolved", root: dir });
        }
      })
      .catch((e) => {
        log.warn("SkillsRoot", "get_skills_dir failed", e);
        if (fetchGenRef.current === gen) {
          setSkillsRoot({ phase: "failed", error: fmtError(e, intl) });
        }
      });
  }

  useEffect(() => {
    fetchSkillsRoot();
    // fetchSkillsRoot closes over the provider-lifetime intl (stable for
    // the provider's life); the mount-once contract matches the pane's
    // rescan effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The detail dialog's path bar anchor: the row's open anchor with the
   *  SKILL.md file name joined (the synthetic revealTarget + skillFilePath
   *  pair has no other consumer). */
  function detailFilePath(skill: SkillEntry): string | null {
    return skillFilePath(revealTarget(skill, skillsRoot));
  }

  return { root: skillsRoot, detailFilePath, retry: fetchSkillsRoot };
}
