// Runtime open-session state (issue #195). Owns the in-memory OPEN session set
// + active id (ADR-0060 multi-session) + every action that mutates them:
// register / createSessionWithQuestion / openPersisted /
// dropFile / onWebviewDrop / clearPendingIngest / clearPendingQuestion /
// activateSession / goToEmptyState / closeOpen / deletePersisted / renameEntry /
// handleOpenDuck. The resume + persistence-busy indicators live
// here too -- they drive the shell `busy` flag that gates the webview drop
// listener + the sidebar / topbar / hero disabled states.
//
// ADR-0068: this is advisory state held in React (NOT TanStack Query) -- the
// open set is the shell's in-memory bookkeeping, and resumeStatus /
// persistenceBusy are UI gates. The queryClient passed in is the SEAM to the
// session-level Query cache (ADR-0051/0055): unmountOpen drops a session's
// cache slice (ADR-0058 retry / ADR-0055 close / ADR-0063 delete), and
// openPersisted invalidates after a resume replay.
//
// Single webview-level drop router (#81): Tauri's onDragDropEvent is a
// window-level signal with no hit-test, so exactly one listener (here, in the
// shell) routes each drop -- cold start mints a new session UNLESS the drop
// lands on the centered composer bar itself (ADR-0092 Decision 2, #501),
// otherwise the file lands on the ACTIVE session's ingest via the
// pendingIngestPaths pipe (#81 A1). This replaces the per-SessionPane
// FileDropzone listeners, which stacked 1:1 with keep-alive panes and fired N
// ingests per single drop.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IntlShape } from "react-intl";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QueryClient } from "@tanstack/react-query";
import type { CreateSessionReply, SetPosturePersistOutcome } from "../api";
import {
  activateSkill,
  closeSession,
  closeSessionAndWaitRelease,
  createSession,
  deleteSession,
  exportSession,
  getSessionName,
  mountSkill,
  onResumeProgress,
  openDuck,
  prepareImportSession,
  renamePersistedSession,
  renameSession,
  setAuthorizationMode,
  setSessionPosture,
  setSessionRuntime,
} from "../api";
import { errorDetail, fmtError, toAppError } from "../lib/error-presentation";
import { log } from "../lib/log";
import type { AppError } from "../types/error";
import type { ModelPosture } from "../types/app-config";
import type { AuthMode } from "../types/approval";
import { AUTH_MODE_DEFAULT } from "../types/approval";
import type { SessionRuntimeChoice } from "../types/runtime";
import type { OpenSession } from "../session/sidebarModel";
import { sessionKeys } from "../session/queryKeys";
import { isPointOverComposerBar, type DropPoint } from "./dropTarget";

/** Composer posture the user picked on the cold-start bar before a session
 *  existed (ADR-0092 Decision 6, issue #500). The shell applies it to a
 *  freshly minted session BEFORE registering it open, so the SessionPane's
 *  pendingQuestion / pendingIngestPaths consumption on mount runs under the
 *  chosen runtime + authorization mode with the picked skills mounted (MCP
 *  servers are config-level enablement since ADR-0106 -- nothing to apply
 *  per session). authMode defaults to the backend default and a field
 *  still at that default skips its IPC (nothing to apply); runtime's unset
 *  marker is null for the same skip (issue #572: the backend's own
 *  create_session resolution already started the session on the resolved
 *  default_runtime), while an EXPLICIT pick -- including a built-in pick
 *  against an external default -- always applies. modelPosture follows the
 *  same null-sentinel shape (ADR-0099/0100, issue #574): null = untouched
 *  (the backend's create_session startup backfill applies); a non-null pair
 *  is EXPLICIT -- null fields are real clears -- and lands via the two model
 *  set IPCs. The skills list is empty by default; each entry lands one mount
 *  IPC. */
export interface PendingComposerPosture {
  runtime: SessionRuntimeChoice | null;
  authMode: AuthMode;
  /** Model posture picked on the cold-start bar's cascade menu (ADR-0100,
   *  issue #574): applied to the minted session AFTER the runtime write so
   *  the pair lands on the chosen external adapter. */
  modelPosture: ModelPosture | null;
  /** Skill spec names picked on the cold-start Skills trigger (draft mode,
   *  #500): mounted onto the minted session one by one, in pick order. */
  skills: string[];
  /** Pre-activation intents picked on the cold-start picker (ADR-0112, issue
   *  #716): activated onto the minted session AFTER the mount loop, in pick
   *  order -- every name is mounted first (the redundant-mount refusal
   *  absorbed; a name whose mount failed with a genuine error is skipped at
   *  activation time, its root cause already surfaced), so an activation
   *  never masks a mount failure with NotMountedForActivation. The
   *  activation lands before registerOpen, so the pane's first turn
   *  assembles with the activated body injected. */
  activations: string[];
}

/** Narrow a mount reject to the typed wire shape: SessionError's SkillMount
 *  variant carrying SkillMountError::AlreadyMounted (issue #677 -- the
 *  expected redundant-mount refusal, not an error). The ADR-0069 facade
 *  keeps the guards module-internal, so this local predicate mirrors their
 *  defensive L1 shape (the outer kind + the inner kind + the name verified
 *  before the shape is promised). */
function isAlreadyMountedRefusal(
  e: unknown,
): e is {
  kind: "SkillMount";
  data: { kind: "AlreadyMounted"; data: { name: string } };
} {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { kind?: unknown }).kind !== "SkillMount") return false;
  const inner = (e as { data?: unknown }).data;
  if (
    typeof inner !== "object" ||
    inner === null ||
    (inner as { kind?: unknown }).kind !== "AlreadyMounted"
  ) {
    return false;
  }
  return (
    typeof (inner as { data?: { name?: unknown } }).data?.name === "string"
  );
}

/** Absorb the expected redundant-mount refusal (issue #677): a cold-start
 *  pick or pre-activation that names an auto-included builtin skill is
 *  already in the session's folded initial set -- the backend's
 *  AlreadyMounted is the expected outcome, not an error. Anything else
 *  rethrows. Shared by the mint chain's mount loop and the in-session
 *  materializer (ADR-0112: the composite intent never checks the mounted
 *  cache -- the write runs and the refusal resolves silently). */
function absorbRedundantMount(e: unknown): void {
  if (isAlreadyMountedRefusal(e)) return;
  throw e;
}

/** Build an isolated pending-write wrapper shared by the mint chain and the
 *  in-session materializer (ADR-0092 / ADR-0112): a rejected write logs +
 *  surfaces via setShellError but never fails the surrounding flow -- the
 *  session opens / the ask proceeds without it. Resolves false on a reject
 *  (the fault is already surfaced), so composite sequences can skip what a
 *  failed write would have depended on. */
function isolatedPendingWrite(
  intl: IntlShape,
  setShellError: (error: AppError | null) => void,
  onFault: string,
) {
  return async (
    write: () => Promise<unknown>,
    facet: string,
    ...labels: unknown[]
  ): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch (e) {
      log.warn(
        "useShellSessions",
        `apply pending ${facet} failed; ${onFault}`,
        ...labels,
        fmtError(e, intl),
      );
      setShellError(toAppError(e, intl, "shell"));
      return false;
    }
  };
}

/** Apply a composite pre-activation sequence in the ADR-0112 order: mount
 *  every name first (the expected AlreadyMounted refusal absorbed), then
 *  activate. A name whose mount failed with a genuine error is skipped at
 *  activation time -- the isolated write already surfaced the root cause,
 *  and activating an unmounted name would reject
 *  NotMountedForActivation, overwriting that root cause in the single
 *  shell-error slot. Shared by the mint chain and the in-session
 *  materializer so the ordering contract lives in one place. */
async function applyPendingSkillWrites(
  sid: string,
  mountNames: readonly string[],
  activateNames: readonly string[],
  applyWrite: (
    write: () => Promise<unknown>,
    facet: string,
    ...labels: unknown[]
  ) => Promise<boolean>,
): Promise<void> {
  const mounted = new Set<string>();
  for (const name of mountNames) {
    const ok = await applyWrite(
      () => mountSkill(sid, name).catch(absorbRedundantMount),
      "skill mount",
      name,
    );
    if (ok) mounted.add(name);
  }
  for (const name of activateNames) {
    if (!mounted.has(name)) continue;
    await applyWrite(() => activateSkill(sid, name), "skill activation", name);
  }
}

/** Resume / open-busy status (ADR-0034). A structured discriminated union, not
 *  a pre-baked string: App sits above <IntlProvider> and cannot format messages
 *  itself, so the ResumeProgress child (inside the provider) renders the union
 *  into the active locale. Produced by openPersisted (Source / Replay events
 *  from onResumeProgress) and consumed by ResumeProgress in App.tsx.
 *
 *  `idle` is the first-class resting state (issue #205): it replaces the old
 *  `| null` escape hatch so `busy` and every consumer discriminate via `kind`
 *  inside the ADT instead of truthiness-coercing a nullable. openPersisted
 *  leaves `idle` on both its success and reject tails. */
export type ResumeStatus =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "source"; index: number; total: number; name: string }
  | { kind: "replay"; index: number; total: number; name: string };

export interface UseShellSessionsDeps {
  intl: IntlShape;
  queryClient: QueryClient;
  /** From usePersistedSessions: bumps sessionsEpoch to re-fetch list_sessions
   *  after a save / delete / rename lands on disk. */
  refreshSessions: () => void;
  /** From useShellError: surfaces a shell-layer AppError (kind "shell") for a
   *  createSession / openDuck / save / delete / rename reject. */
  setShellError: (error: AppError | null) => void;
}

/** Merged open-set state (issue #205): the session list + the active id move as
 *  one value so the invariant `activeId !== null => activeId ∈ sessions` is
 *  enforced at a single transition chokepoint (see `apply` in the hook) instead
 *  of re-derived across two independent useStates. */
type SessionsState = {
  sessions: OpenSession[];
  activeId: string | null;
};

export function useShellSessions({
  intl,
  queryClient,
  refreshSessions,
  setShellError,
}: UseShellSessionsDeps): {
  openSessions: OpenSession[];
  activeSessionId: string | null;
  activateSession: (sid: string) => void;
  /** ADR-0092: navigate to the centered empty state (sidebar "+"). Existing
   *  keep-alive sessions stay mounted hidden. */
  goToEmptyState: () => void;
  /** Shell-wide busy gate: persistenceBusy (save / open / delete wait) OR a
   *  resume in flight. Drives the sidebar / topbar disabled states and
   *  suspends the webview drop listener while busy. */
  busy: boolean;
  resumeStatus: ResumeStatus;
  /** ADR-0092 (#500): create a session from a cold-start bar submit, carrying
   *  the question as pendingQuestion + the picked files as pendingIngestPaths
   *  for the new SessionPane to consume on mount (files ingest BEFORE the
   *  question fires). The posture (runtime + auth mode + skills picked on the
   *  centered bar's draft-mode controls) is applied before the
   *  pane mounts so the FIRST turn runs under it. `pendingFiles` may be empty
   *  (a bare question submit). Resolves true when the session was created (the
   *  shell resets its pending state); false when createSession rejected (the
   *  error rode setShellError). */
  createSessionWithQuestion: (
    question: string,
    posture: PendingComposerPosture,
    pendingFiles: string[],
  ) => Promise<boolean>;
  /** ADR-0112 (issue #716): materialize an ACTIVE session's pre-activation
   *  intents before its next ask. Mount every name (redundant mounts
   *  absorbed), then activate each; each write is isolated like the mint
   *  chain's posture writes. Resolves only after the session's mounted /
   *  activated / thread caches have re-read, so the ask that follows starts
   *  from fresh cache. */
  materializeActivations: (sid: string, names: string[]) => Promise<void>;
  openPersisted: (path: string, name: string) => Promise<void>;
  dropFile: (path: string) => Promise<void>;
  /** Route one webview file drop (#81). `position` is the Tauri drop-event
   *  physical position; on cold start the router hit-tests it against the
   *  centered composer bar, which is inert to drops (#501). Absent position
   *  (legacy / test payloads) skips the guard and keeps the pre-#501 route. */
  onWebviewDrop: (path: string, position?: DropPoint) => void;
  clearPendingIngest: (sid: string) => void;
  /** ADR-0092: clear a consumed pending question after SessionPane fires it. */
  clearPendingQuestion: (sid: string) => void;
  closeOpen: (sid: string) => Promise<void>;
  deletePersisted: (path: string, sid: string | null) => Promise<void>;
  renameEntry: (
    sid: string | null,
    path: string,
    newName: string,
  ) => Promise<void>;
  handleOpenDuck: () => Promise<void>;
  /** Export a copy of the session directory to a user-chosen location
   *  (ADR-0089 Decision 5, issue #449). Opens a save dialog, then calls the
   *  backend file-copy IPC. Silent on success; errors go to setShellError. */
  handleExportSession: (duckPath: string, displayName: string) => Promise<void>;
  /** Sync an open session's display name after the backend auto-names it
   *  (ADR-0089 Decision 4: first terminal turn). Reads the live name from the
   *  backend, updates the in-memory open-session entry, and refreshes the
   *  sidebar so the persisted list matches. */
  syncSessionName: (sid: string) => Promise<void>;
} {
  // The open set + active id live in ONE state object (issue #205) so the
  // invariant "activeId !== null => activeId ∈ sessions" is enforced at a
  // single transition chokepoint (apply) instead of re-derived across two
  // separate useStates. sessions: every session with a live in-memory
  // instance, each rendered as a keep-alive SessionPane. activeId: the visible
  // one (null = the ADR-0092 centered empty state). A close drops the entry +
  // removeQueries its cache (ADR-0055).
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    activeId: null,
  });
  // Resume / open-busy indicator (ADR-0034). `idle` is the resting state
  // (issue #205); Resume blocks the open action + the indicator shows globally
  // while the clicked session is opening.
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>({
    kind: "idle",
  });
  const [persistenceBusy, setPersistenceBusy] = useState(false);

  const busy = persistenceBusy || resumeStatus.kind !== "idle";

  // Single pure transition into the merged open-set state (issue #205). Each
  // caller hands back the intended next { sessions, activeId }; apply() then
  // RECONCILES activeId against the resulting sessions so the invariant
  // (activeId !== null => activeId ∈ sessions) can never be broken -- a
  // transition that drops the active session without naming a successor falls
  // back to the first remaining entry, then null. This replaces unmountOpen's
  // old closure-write of `next` plus a separate setActiveId setter: nesting a
  // setter inside another's updater violates React's purity contract (updaters
  // may double-fire in StrictMode / concurrent mode), so both fields move as
  // one pure function of `prev`.
  const apply = useCallback(
    (transform: (prev: SessionsState) => SessionsState): void => {
      setState((prev) => {
        const next = transform(prev);
        // ADR-0092: explicit null activeId is a valid target (sidebar "+"
        // navigates to the centered empty state). The reconciliation only
        // kicks in for a non-null activeId that is no longer in sessions --
        // a stale sid falls back to the first remaining entry (then null).
        const activeId =
          next.activeId !== null
            ? next.sessions.some((s) => s.sid === next.activeId)
              ? next.activeId
              : (next.sessions[0]?.sid ?? null)
            : null;
        return { sessions: next.sessions, activeId };
      });
    },
    [],
  );

  // Pure list / field update that never touches activeId (issue #205). For
  // transitions that only mutate a session entry (rename / clear-pending /
  // save-as bind / drop-onto-active), the active id is unaffected, so there is
  // nothing to reconcile. Routing these through `apply` would redundantly
  // re-validate activeId and force each caller to echo `activeId: prev.activeId`
  // boilerplate. mapSessions takes only the sessions array and preserves
  // activeId verbatim, so reconciliation stays exclusive to the add / remove /
  // activate paths that can actually invalidate activeId.
  const mapSessions = useCallback(
    (fn: (prev: OpenSession[]) => OpenSession[]): void => {
      setState((prev) => ({
        sessions: fn(prev.sessions),
        activeId: prev.activeId,
      }));
    },
    [],
  );

  const openSessions = state.sessions;
  const activeSessionId = state.activeId;

  // Switch the active session by id (sidebar click). Semantic action -- there
  // is no standalone activeId setter: the merged open-set state moves only
  // through `apply`, and registerOpen / openPersisted / unmountOpen adjust the
  // active id as a side effect of their own transition. THIS is the only
  // public way to flip the active id standalone. The hook contract narrows the
  // arg to a non-null string so an outside caller cannot null-out the active
  // id from outside the open/close lifecycle; `apply` reconciles, so a stale
  // sid (not in sessions) falls back to the first entry rather than dangling.
  const activateSession = useCallback(
    (sid: string): void => {
      // A stale sid (not in sessions -- a sidebar click racing a close) is a
      // no-op: keep the current active id rather than silently jumping to the
      // first session, so a failed switch never activates a session the user
      // did not click (issue #205). `apply` still guarantees activeId ∈
      // sessions on the valid-sid path.
      apply((prev) =>
        prev.sessions.some((s) => s.sid === sid)
          ? { sessions: prev.sessions, activeId: sid }
          : prev,
      );
    },
    [apply],
  );

  // ADR-0092: navigate to the centered empty state (sidebar "+"). Sets
  // activeSessionId to null without closing any keep-alive session — existing
  // panes stay mounted hidden, in-flight turns continue. The user returns to
  // the centered bar + greeting; the next submit creates a fresh session.
  const goToEmptyState = useCallback(() => {
    apply((prev) => ({ sessions: prev.sessions, activeId: null }));
  }, [apply]);

  /** Add a freshly-minted session to the open set and activate it. The caller
   *  hands the createSession result + an optional bound path/name (resume). */
  const registerOpen = useCallback(
    (entry: OpenSession) => {
      apply((prev) =>
        prev.sessions.some((s) => s.sid === entry.sid)
          ? { sessions: prev.sessions, activeId: entry.sid }
          : { sessions: [...prev.sessions, entry], activeId: entry.sid },
      );
    },
    [apply],
  );

  // Shared mint: createSession (backend creates + persists immediately,
  // returning the runtime id + bound .duck path, ADR-0061/0089) -> apply the
  // cold-start composer posture -> registerOpen + activate -> refresh the
  // sidebar. Every cold-start creation path (bar submit, window drop) funnels
  // through here; the paths differ only in the pending payload the new
  // SessionPane consumes on mount. name starts empty; the display layer
  // renders a localized "New session" placeholder until the first turn
  // auto-names or the user renames.
  //
  // Posture ordering (ADR-0092 Decision 6): the posture writes land BEFORE
  // registerOpen so the pane mounts (and consumes pendingIngestPaths /
  // pendingQuestion) only after the session carries the user's picks — the
  // first turn runs on the chosen runtime + auth mode with the picked skills
  // mounted (MCP servers are config-level enablement since ADR-0106 -- no
  // per-session enable step). A rejected posture write is logged and skipped
  // (the session opens on
  // the backend default for that facet; the picker's keep-server-posture
  // semantics) instead of failing the whole creation. A rejected write also
  // surfaces via setShellError so the user is informed their picker selection
  // was not applied.
  //
  // Reentry guard: mintingRef blocks a second creation while the
  // createSession IPC is in flight — a fast double-submit on the cold-start
  // bar would otherwise mint two sessions before activeSessionId flips.
  // Mirrors the droppingRef pattern in dropFile below.
  const mintingRef = useRef(false);
  const mintAndRegister = useCallback(
    async (opts: {
      pendingIngestPaths?: string[];
      pendingQuestion?: string | null;
      posture?: PendingComposerPosture;
    }): Promise<void> => {
      if (mintingRef.current) return;
      mintingRef.current = true;
      try {
        const { session_id: sid, duck_path: path } = await createSession();
        if (opts.posture) {
          const posture = opts.posture;
          // One write per posture facet, isolated: a rejected write logs +
          // surfaces via setShellError but never fails the whole creation --
          // the session opens on the backend default for that facet and the
          // remaining picks still apply (the picker's keep-server-posture
          // semantics). The write kinds share this helper so the catch
          // contract lives in one place.
          const applyPostureWrite = isolatedPendingWrite(
            intl,
            setShellError,
            "the session opens without it",
          );
          // The posture write carries the #529 persist verdict in the
          // RESOLVED value (never a reject): surface it like the picker's
          // fault lines, because an un-surfaced verdict leaves the selection
          // in memory only -- a restart resumes the recipe without it and
          // the user has no signal the .duck write failed, breaking "set
          // means persisted" (ADR-0095 Decision 6) silently.
          const surfacePersistVerdict = (
            outcome: SetPosturePersistOutcome,
          ): void => {
            if (outcome.persist_error !== null) {
              log.warn(
                "useShellSessions",
                "pending posture applied but not persisted",
                fmtError(outcome.persist_error, intl),
              );
              setShellError({
                message: intl.formatMessage(
                  {
                    id: "composer.runtimePicker.persistFault",
                    defaultMessage: "Selection not saved: {reason}",
                  },
                  { reason: fmtError(outcome.persist_error, intl) },
                ),
                kind: "shell",
                detail: errorDetail(outcome.persist_error),
              });
            } else if (outcome.persist_suspended) {
              log.warn(
                "useShellSessions",
                "pending posture applied but persist suspended (ADR-0035 conflict)",
              );
              setShellError({
                message: intl.formatMessage({
                  id: "composer.runtimePicker.persistSuspended",
                  defaultMessage:
                    "Selection not saved: the session file was changed outside the app, so autosave is paused until you resolve the conflict.",
                }),
                kind: "shell",
                detail: null,
              });
            }
          };
          if (posture.runtime !== null) {
            // Local const so the null narrowing survives into the write
            // closure (a property access would widen back to the union).
            const runtimePick = posture.runtime;
            await applyPostureWrite(
              () => setSessionRuntime(sid, runtimePick),
              "runtime",
            );
          }
          if (posture.modelPosture !== null) {
            // ADR-0100 (issue #574): the cold-start cascade menu's explicit
            // pair -- AFTER the runtime write so the model / thought level
            // land on the chosen external adapter. One full-pair command
            // (issue #603): both dimensions always write, null fields being
            // explicit clears the user made on the bar, not "leave whatever
            // the startup backfill seated".
            const modelPick = posture.modelPosture;
            await applyPostureWrite(
              async () =>
                surfacePersistVerdict(await setSessionPosture(sid, modelPick)),
              "posture",
            );
          }
          if (posture.authMode !== AUTH_MODE_DEFAULT) {
            await applyPostureWrite(
              () => setAuthorizationMode(sid, posture.authMode),
              "auth mode",
            );
          }
          // ADR-0112 Decision 4: the mounts (the pending skills UNION the
          // pre-activation names -- the composite intent's mount half rides
          // the same loop even if a future path stages an activation without
          // the mount list) strictly precede the activations;
          // applyPendingSkillWrites owns the ordering, absorbs the expected
          // redundant-mount refusal, and skips activation for names whose
          // mount failed with a genuine error. Activation is idempotent
          // server-side, so a name the folded initial set already activated
          // resolves as a silent no-op.
          await applyPendingSkillWrites(
            sid,
            [...new Set([...posture.skills, ...posture.activations])],
            posture.activations,
            applyPostureWrite,
          );
        }
        registerOpen({
          sid,
          name: "",
          path,
          pendingIngestPaths: opts.pendingIngestPaths ?? [],
          pendingQuestion: opts.pendingQuestion ?? null,
        });
        refreshSessions();
      } finally {
        mintingRef.current = false;
      }
    },
    [intl, registerOpen, refreshSessions, setShellError],
  );

  // ADR-0092 cold-start submit (#500): the centered bar's submit with no
  // active session mints a session carrying the question as pendingQuestion +
  // the pending file list as pendingIngestPaths. The SessionPane consumes
  // them on mount — files ingest first (handleIngestMany), then the question
  // fires via handleAsk — and clears each through onIngestConsumed /
  // onQuestionConsumed. ADR-0089 auto-persist applies (createSession binds
  // the .duck immediately).
  const createSessionWithQuestion = useCallback(
    async (
      question: string,
      posture: PendingComposerPosture,
      pendingFiles: string[],
    ): Promise<boolean> => {
      try {
        await mintAndRegister({
          pendingQuestion: question,
          pendingIngestPaths: pendingFiles,
          posture,
        });
        return true;
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return false;
      }
    },
    [intl, mintAndRegister, setShellError],
  );

  // ADR-0112 (issue #716): materialize the active session's pre-activation
  // intents before an ask. Mount every name (the redundant-mount refusal
  // absorbed -- the composite intent never checks the mounted cache, the
  // write runs and the refusal resolves silently), then activate each
  // (idempotent server-side, so an already-active name is a no-op); a name
  // whose mount failed with a genuine error is skipped at activation time,
  // so the mount's root cause stays surfaced. Each write is isolated like
  // the mint chain's posture writes: a reject logs + surfaces via
  // setShellError but never blocks the ask that follows. The caches re-read
  // before this resolves: the writes bypassed the mutations' synchronous
  // deltas, and awaiting the invalidation also closes the ADR-0051 race (a
  // thread refetch resolving after the ask's optimistic append would wipe
  // it). The invalidations themselves are best-effort -- allSettled, so a
  // failed refetch (recorded by its query's own error state) never rejects
  // the materialization and takes the ask down with it.
  const materializeActivations = useCallback(
    async (sid: string, names: string[]): Promise<void> => {
      const applyWrite = isolatedPendingWrite(
        intl,
        setShellError,
        "the ask proceeds without it",
      );
      await applyPendingSkillWrites(sid, names, names, applyWrite);
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: sessionKeys.mountedSkills(sid),
        }),
        queryClient.invalidateQueries({
          queryKey: sessionKeys.activatedSkills(sid),
        }),
        queryClient.invalidateQueries({
          queryKey: sessionKeys.thread(sid),
        }),
      ]);
    },
    [intl, queryClient, setShellError],
  );

  // Drop-to-create on the empty-state main area (ADR-0061/0089/0092, #81 A1):
  // mint a persisted session and hand the dropped path to the new SessionPane
  // as a one-element pendingIngestPaths list. The pane consumes it via
  // handleIngestMany (the only path that can surface an xlsx NeedsGuidance
  // dialog); the shell never ingests directly. droppingRef guards a second
  // drop landing while the first createSession is still in flight. The
  // window-drop path carries no composer posture (a drop never touches the
  // bar's pending state).
  const droppingRef = useRef(false);
  const dropFile = useCallback(
    async (path: string) => {
      if (droppingRef.current) return;
      droppingRef.current = true;
      try {
        await mintAndRegister({ pendingIngestPaths: [path] });
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      } finally {
        droppingRef.current = false;
      }
    },
    [intl, mintAndRegister, setShellError],
  );

  // Single webview-level drop router (#81): Tauri's onDragDropEvent is a
  // window-level signal with no hit-test, so exactly one listener (here) routes
  // each drop -- cold start mints a new session, otherwise the file lands on
  // the ACTIVE session's ingest via the pendingIngestPaths pipe (#81 A1).
  const onWebviewDrop = useCallback(
    (path: string, position?: DropPoint) => {
      if (activeSessionId === null) {
        // ADR-0092 Decision 2 (#501): the centered composer bar itself is
        // inert to file drops -- a drop ON the bar must not mint a session by
        // accident. The surrounding empty-state main area keeps the ADR-0061
        // drop-to-create. The guard is cold-start only: an active-session drop
        // routes to that session's ingest wherever it lands (AC: the
        // per-session drop path is unchanged).
        if (position !== undefined && isPointOverComposerBar(position)) {
          log.debug(
            "useShellSessions",
            "drop swallowed: landed on composer bar",
          );
          return;
        }
        void dropFile(path);
        return;
      }
      // Route onto the active session's ingest. The guard above and this body
      // both key off the same closure activeSessionId -- a single source of
      // truth for "which session is active right now". If a close races the drop
      // and the target sid is no longer in the set, the map matches nothing and
      // the drop is a no-op rather than landing on a different session
      // (issue #205).
      mapSessions((sessions) =>
        sessions.map((o) =>
          o.sid === activeSessionId ? { ...o, pendingIngestPaths: [path] } : o,
        ),
      );
    },
    [activeSessionId, mapSessions, dropFile],
  );
  useEffect(() => {
    if (busy) return;
    const app = getCurrentWebviewWindow();
    const unlisten = app.onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        // The drop position rides along so the cold-start router can hit-test
        // the centered composer bar (#501).
        onWebviewDrop(event.payload.paths[0], event.payload.position);
      }
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, [busy, onWebviewDrop]);

  // Clear consumed pending ingest paths (#81 A1, #500): once the SessionPane
  // has kicked off ingest, OpenSession.pendingIngestPaths is emptied so a
  // remount cannot re-ingest.
  const clearPendingIngest = useCallback(
    (sid: string) => {
      mapSessions((sessions) =>
        sessions.map((o) =>
          // The length guard keeps the entry identity-stable when nothing is
          // pending (a stale clear cannot churn the pane's consumption effect).
          o.sid === sid && o.pendingIngestPaths.length > 0
            ? { ...o, pendingIngestPaths: [] }
            : o,
        ),
      );
    },
    [mapSessions],
  );

  // ADR-0092: clear a consumed pending question (the SessionPane fired
  // handleAsk on mount). Mirrors clearPendingIngest so a remount cannot
  // re-fire the question.
  const clearPendingQuestion = useCallback(
    (sid: string) => {
      mapSessions((sessions) =>
        sessions.map((o) =>
          o.sid === sid ? { ...o, pendingQuestion: null } : o,
        ),
      );
    },
    [mapSessions],
  );

  // Shared resume-into-new-session logic (ADR-0061/0034). Both the sidebar
  // resume path (openPersisted) and the import path (importAndOpen) funnel
  // through here: the caller provides a `prepare` step that mints the session
  // id + returns the duck path to resume from, and this helper handles the
  // resume-progress listener, openDuck call, registerOpen, and error cleanup.
  const resumeIntoNewSession = useCallback(
    async (prepare: () => Promise<CreateSessionReply>, name: string) => {
      setResumeStatus({ kind: "opening" });
      // ADR-0056 / issue #76: resume-progress is a global Tauri broadcast keyed
      // by session_id. The listener registers BEFORE the prepare step mints the
      // id, so targetSid starts null and is assigned the instant the id lands;
      // every event is then filtered to the session THIS resume opened. An event
      // for a different session (a concurrent resume path, or a stray broadcast)
      // is dropped before it can move our status indicator. #83 R5: this filter
      // is the multi-session seam -- without it a sibling resume's Source/Replay
      // ticks would hijack this opener's progress strip.
      let targetSid: string | null = null;
      const unlisten = await onResumeProgress((ev) => {
        // Defensive try/catch: this callback runs on the Tauri event loop's
        // microtask, so a throw escapes PAST the outer try/catch -- it surfaces
        // as an unhandled rejection, busy sticks true (soft-lock), and the
        // listener leaks. Log and bail; the outer flow still clears
        // resumeStatus when openDuck resolves/rejects. #83 R5: the targetSid
        // filter below is the multi-session isolation seam and is unchanged
        // (issue #203).
        try {
          if (ev.session_id !== targetSid) return;
          const { event } = ev;
          if ("Source" in event) {
            setResumeStatus({
              kind: "source",
              index: event.Source.index,
              total: event.Source.total,
              name: event.Source.reference_name,
            });
          } else if ("Replay" in event) {
            setResumeStatus({
              kind: "replay",
              index: event.Replay.index,
              total: event.Replay.total,
              name: event.Replay.reference_name,
            });
          }
        } catch (e) {
          log.error("onResumeProgress", "listener threw", fmtError(e, intl));
        }
      });
      try {
        const { session_id: sid, duck_path } = await prepare();
        targetSid = sid;
        await openDuck(sid, duck_path);
        await queryClient.invalidateQueries({ queryKey: ["session", sid] });
        registerOpen({
          sid,
          name,
          path: duck_path,
          pendingIngestPaths: [],
          pendingQuestion: null,
        });
        setResumeStatus({ kind: "idle" });
      } catch (e) {
        // C2: if the prepare step succeeded but openDuck failed, the just-minted
        // session is persisted on disk (ADR-0089 auto-persist). Close it
        // best-effort so it does not linger as a ghost empty row in the
        // sidebar scan. The close IPC itself may fail (the session may have
        // been partially created); suppress that — the error toast is already
        // surfaced via setShellError.
        if (targetSid) {
          void closeSession(targetSid).catch(() => {});
          refreshSessions();
        }
        setShellError(toAppError(e, intl, "shell"));
        setResumeStatus({ kind: "idle" });
      } finally {
        void unlisten();
      }
    },
    [intl, queryClient, registerOpen, setShellError, refreshSessions],
  );

  // Resume a persisted .duck into a fresh runtime instance (ADR-0061/0034).
  // open_duck reuses the id (ADR-0056), so createSession mints it first, then
  // openDuck loads the recipe + replays the chain into that id. If the same
  // path is already open, just switch to it (no second instance, keep-alive).
  const openPersisted = useCallback(
    async (path: string, name: string) => {
      const existing = openSessions.find((s) => s.path === path);
      if (existing) {
        apply((prev) => ({ sessions: prev.sessions, activeId: existing.sid }));
        return;
      }
      // createSession mints a new session + binds an empty session.duck at
      // sessions/{new_uuid}/session.duck. The resume target is the EXISTING
      // file at `path` (a prior session's duck), not the freshly-created empty
      // one — so override duck_path with the existing path.
      await resumeIntoNewSession(async () => {
        const { session_id } = await createSession();
        return { session_id, duck_path: path };
      }, name);
    },
    [openSessions, apply, resumeIntoNewSession],
  );

  // Import an external .duck into the managed sessions tree (ADR-0089 Decision
  // 5, issue #450). prepareImportSession copies the external file (+ companion
  // assets/) into a fresh sessions/{uuid}/ directory and returns the local duck
  // path; resumeIntoNewSession then calls openDuck on that local copy.
  const importAndOpen = useCallback(
    async (externalPath: string, name: string) => {
      await resumeIntoNewSession(
        () => prepareImportSession(externalPath),
        name,
      );
    },
    [resumeIntoNewSession],
  );

  // Synchronous UI teardown for an open session: drop the cache + open-set
  // entry + active id. Shared by closeOpen (ADR-0055, runs BEFORE the
  // background close fires) and deletePersisted (ADR-0063, runs AFTER the
  // wait-release variant resolves). Issue #205: the session filter + the
  // active-id fallback are now ONE pure transition through `apply` -- the old
  // shape read `next` out of an updater closure and ran a second setState for
  // the active id, nesting a setter inside another's updater (a React purity
  // violation: updaters may double-fire in StrictMode / concurrent mode).
  // Keeping the stale sid as activeId when the removed sid was active lets
  // `apply`'s reconciler pick the fallback (first remaining session, then
  // null). Explicitly setting null would now be respected as ADR-0092
  // empty-state navigation instead of triggering the fallback.
  const unmountOpen = useCallback(
    (sid: string): void => {
      queryClient.removeQueries({ queryKey: ["session", sid] });
      apply((prev) => {
        const sessions = prev.sessions.filter((s) => s.sid !== sid);
        // Keep the stale sid as activeId so apply's reconciler picks the
        // fallback (first remaining session, then null). Explicitly setting
        // null would now be respected as ADR-0092 empty-state navigation
        // instead of triggering the fallback.
        const activeId = prev.activeId;
        return { sessions, activeId };
      });
    },
    [queryClient, apply],
  );

  // Close an open session (ADR-0055/0060). The user's view must disappear with
  // ZERO wait even when a turn is in-flight: unmount the pane SYNCHRONOUSLY,
  // THEN fire closeSession in the background. closeSession (cancel + mark
  // closing + drop the handle) returns immediately on the backend too -- it
  // does NOT wait for an in-flight ask; the ask's post-turn check sees closing
  // and discards (no thread append, no recipe entry). The orphan ask promise
  // resolves against an absent cache (TanStack setQueryData on a removed key
  // is a no-op) and the turn-progress listener cleanup runs in the pane's
  // unmount effect. The .duck stays on disk and remains in the sidebar
  // (re-openable). NOT delete -- the delete path uses the wait-release variant
  // (see deletePersisted), not this fire-and-forget close.
  //
  // ADR-0089 Decision 6: an empty session (no turns, no sources, no skills)
  // gets its per-session directory deleted by the backend on close. The return
  // value is `true` when that cleanup happened -- in that case, the sidebar's
  // persisted session list is stale (the entry is gone from disk) and needs a
  // refresh so the "新会话" entry disappears.
  const closeOpen = useCallback(
    (sid: string): Promise<void> => {
      unmountOpen(sid);
      // ADR-0055: the UI is already gone; cancel + mark closing only reaches
      // backend bookkeeping. The promise is RETURNED, not awaited here --
      // fire-cancel-don't-wait. Best-effort: NotFound is the expected idempotent
      // path (already dropped); other failures log to devtools so IPC/panic
      // stay observable. NOT a user toast -- pane is gone.
      return closeSession(sid)
        .then((cleanedUp: boolean) => {
          if (cleanedUp) refreshSessions();
        })
        .catch((e: unknown) => {
          // ADR-0055: the UI is already gone, so neither branch is a user toast.
          // Split by SessionError kind. NotFound is the expected idempotent path
          // (the session already dropped -- a double-close, or a close racing a
          // delete's wait-release); debug-level only. Everything else -- panic,
          // lock poison, IPC contract break, canonical single-writer leak -- is a
          // real failure that log.error keeps observable in devtools, so the cause
          // of a later deletePersisted try_acquire gate miss stays diagnosable. The
          // raw kind is logged so a non-SessionError panic (kind "unknown") is
          // distinguishable from a typed SessionError::Engine (issue #203).
          if (
            typeof e === "object" &&
            e !== null &&
            "kind" in e &&
            e.kind === "NotFound"
          ) {
            log.debug(
              "closeSession",
              "background close: session already gone",
              sid,
            );
            return;
          }
          const kind =
            typeof e === "object" && e !== null && "kind" in e
              ? String(e.kind)
              : "unknown";
          log.error(
            "closeSession",
            "background close failed",
            sid,
            kind,
            fmtError(e, intl),
            errorDetail(e),
          );
        });
    },
    [intl, unmountOpen, refreshSessions],
  );

  // Delete a persisted .duck (ADR-0060/0063, irreversible). If the session is
  // open, close it via the WAIT-RELEASE variant: the UI pane STAYS mounted
  // during the wait (delete is an explicit user intent -- it does NOT get
  // close's zero-wait contract, ADR-0063 Decision 2), and only unmounts after
  // the canonical single-writer key is released. This guarantees deleteSession's
  // try_acquire gate sees the key free (no misleading "请先关闭" on an entry the
  // user is already deleting). On wait timeout the entry survives so the user
  // can retry. persistenceBusy gates the UI for the potentially long wait.
  const deletePersisted = useCallback(
    async (path: string, sid: string | null) => {
      setPersistenceBusy(true);
      try {
        if (sid) {
          try {
            await closeSessionAndWaitRelease(sid);
          } catch (e) {
            // Close-wait failed (timeout, or the backend already detached
            // the session). Unmount the pane so the entry falls back to the
            // cold sidebar (sid=null); a retry then takes the pure
            // deleteSession(path) path -- if the canonical key is now free
            // the gate succeeds, otherwise the user sees the real gate error.
            // Without this, the pane stays mounted on a sid the backend no
            // longer knows and every retry hits NotFound (dead loop).
            unmountOpen(sid);
            setShellError(toAppError(e, intl, "shell"));
            return;
          }
          // The wait resolved -- canonical key is free, Session::Drop ran.
          // NOW unmount the pane (ADR-0063: UI teardown after the wait, not
          // before).
          unmountOpen(sid);
        }
        try {
          await deleteSession(path);
        } catch (e) {
          setShellError(toAppError(e, intl, "shell"));
          return;
        }
        refreshSessions();
      } finally {
        setPersistenceBusy(false);
      }
    },
    [intl, unmountOpen, refreshSessions, setShellError],
  );

  // Rename a sidebar entry (ADR-0060, single entry point). An OPEN session
  // renames in-memory + re-persists via its sid; a CLOSED .duck rewrites the
  // recipe header in place by path. The bound path is untouched either way.
  const renameEntry = useCallback(
    async (sid: string | null, path: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      try {
        if (sid) {
          const landed = await renameSession(sid, trimmed);
          mapSessions((sessions) =>
            sessions.map((s) => (s.sid === sid ? { ...s, name: landed } : s)),
          );
        } else {
          await renamePersistedSession(path, trimmed);
        }
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return;
      }
      refreshSessions();
    },
    [intl, mapSessions, refreshSessions, setShellError],
  );

  // --- Import .duck (ADR-0089 Decision 5, issue #450) ----------------------
  // Open = import: copy the external .duck (+ companion assets/) into a fresh
  // per-session directory under the managed sessions root, then resume the
  // local copy. The original file is never modified.
  const handleOpenDuck = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const selected = await openDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
        multiple: false,
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const stem =
        path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.duck$/i, "") ?? "session";
      await importAndOpen(path, stem);
      refreshSessions();
    } catch (e) {
      setShellError(toAppError(e, intl, "shell"));
    } finally {
      setPersistenceBusy(false);
    }
  }, [intl, importAndOpen, refreshSessions, setShellError]);

  // --- Export session (ADR-0089 Decision 5, issue #449) -------------------
  // Export a copy of the per-session directory (session.duck + assets/) to a
  // user-chosen destination. The save dialog collects a directory name; the
  // backend copies the files. No rebind, no registry touch — pure file I/O.
  // Silent on success; errors go to setShellError.
  const handleExportSession = useCallback(
    async (duckPath: string, displayName: string) => {
      setPersistenceBusy(true);
      try {
        const dest = await saveDialog({
          defaultPath: displayName,
        });
        if (!dest) return;
        await exportSession(duckPath, dest);
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      } finally {
        setPersistenceBusy(false);
      }
    },
    [intl, setShellError],
  );

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session from the first question's bounded truncation. This syncs the
  // in-memory open-session entry + the persisted sidebar list so both surfaces
  // reflect the new name without a manual refresh.
  const syncSessionName = useCallback(
    async (sid: string) => {
      try {
        const name = await getSessionName(sid);
        mapSessions((sessions) =>
          sessions.map((s) => (s.sid === sid ? { ...s, name } : s)),
        );
      } catch (e) {
        // Best-effort: a failure here means the sidebar/header keep the old
        // name until the next refresh. The session itself is unaffected.
        log.warn(
          "syncSessionName",
          "failed to sync auto-named session",
          fmtError(e, intl),
        );
      }
      refreshSessions();
    },
    [intl, mapSessions, refreshSessions],
  );

  return {
    openSessions,
    activeSessionId,
    activateSession,
    goToEmptyState,
    busy,
    resumeStatus,
    createSessionWithQuestion,
    materializeActivations,
    openPersisted,
    dropFile,
    onWebviewDrop,
    clearPendingIngest,
    clearPendingQuestion,
    closeOpen,
    deletePersisted,
    renameEntry,
    handleOpenDuck,
    handleExportSession,
    syncSessionName,
  };
}
