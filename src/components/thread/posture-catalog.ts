import type { ModelPosture } from "../../types/app-config";
import type {
  AdapterCatalogEntry,
  AdapterEntry,
  DiscoveredRuntime,
  SessionModelConfig,
} from "../../types/runtime";
import type { CatalogNote, PostureCatalog } from "./ComposerPostureTrigger";

// The posture-catalog pure projection (ADR-0096 D6 priority chain, ADR-0097,
// issues #529/#586): which catalog the composer's posture cascade offers,
// which provenance note the trigger renders, and which turn-end live
// currents the tooltip carries -- derived from the query reads the picker
// assembles. Pure so the ACP/perModel dispatch (D6), the provenance gate
// (#529), and the live-currents gate (#586) carry direct function-level
// tests instead of mount suites.

// The unselected posture pair (ADR-0100): never chosen, or explicitly
// cleared -- the "Default (recommended)" start.
export const EMPTY_POSTURE = {
  model: null,
  thought_level: null,
} as const satisfies ModelPosture;

// The honest default while the model-config read settles (and on the
// cold-start bar, where there is no session to read): no selection, no
// discovery cache. The CLI's own defaults rule the next turn.
export const MODEL_CONFIG_DEFAULT = {
  model: null,
  thought_level: null,
  cached_discovered: null,
} as const satisfies SessionModelConfig;

// The reads the projection consumes: the active runtime's identity + the two
// catalog sources (the session's own discovery cache, and the global probe
// cache entry FOR THIS adapter -- the picker selects it by adapter id).
export type PostureCatalogReads = {
  isExternal: boolean;
  activeAdapterId: string | null;
  activeAdapter: AdapterEntry | null;
  discovered: DiscoveredRuntime | null;
  probeEntry: AdapterCatalogEntry | null;
  // The displayed posture pair (held dimensions): gates the live currents
  // tooltip (a selection always outranks the live read, issue #586).
  posture: ModelPosture;
};

// A posture dimension counts as set only when non-null AND non-empty: the
// menu guards' convention, so a hand-edited blank cannot blank the button.
// Shared by the held-pair display and the live-currents tooltip filter.
function isSetPosturePart(part: string | null | undefined): part is string {
  return part != null && part !== "";
}

// The held posture dimensions as display parts.
export function heldPostureParts(posture: ModelPosture): string[] {
  return [posture.model, posture.thought_level].filter(isSetPosturePart);
}

export type PostureCatalogProjection = {
  // The catalog handed to the posture trigger: null renders the static
  // no-arrow label (built-in, or an external runtime with no directory yet).
  catalog: PostureCatalog | null;
  // The one provenance note the posture trigger renders (#529).
  note: CatalogNote;
  // The turn-end live currents (issue #586, ADR-0095 Decision 5): display
  // only -- never writes the posture (ADR-0100 constraint). The
  // test-observable face of the live-currents gate: `liveValue` folds the
  // currents into a string, so the function-level tests assert the
  // admitted cache object's identity through this field.
  liveDiscovered: DiscoveredRuntime | null;
  // The tooltip's live payload, joined and gated: non-null only while
  // nothing is held AND a catalog seats the menu (the trigger drops the
  // tooltip on its static-label early return).
  liveValue: string | null;
};

export function derivePostureCatalog(
  reads: PostureCatalogReads,
): PostureCatalogProjection {
  const { isExternal, activeAdapterId, activeAdapter, discovered, probeEntry } =
    reads;

  // The active adapter's stream format decides the posture catalog surface
  // (ADR-0095/0097): ACP adapters get the flat handshake catalog; the
  // per-model catalog formats (codex_event_stream / claude_stream_json) get
  // the probe-cache-fed per-model catalog. The dispatch enumerates the
  // per-model kinds explicitly (not `!== "acp"`): a future fourth format
  // must be classified here deliberately, never default into a surface.
  const isPerModelCatalogAdapter =
    isExternal &&
    activeAdapter != null &&
    (activeAdapter.stream_format === "codex_event_stream" ||
      activeAdapter.stream_format === "claude_stream_json");

  // Discovery-cache provenance (issue #529): the cached catalog records the
  // adapter that produced it (stamped by the engine at the handshake). After
  // a runtime switch the cache still holds the OLD adapter's catalog until
  // the new runtime's first turn replaces it (replace-on-Some) -- flag that
  // window so the user can judge which residual selection to clear. A cache
  // with NO provenance (persisted before the field existed) is not a
  // mismatch -- it renders without the flag. Scoped to discovery-fed (ACP)
  // adapters: a per-model runtime's selector feeds off the probe cache, so
  // its turns would never replace the discovery cache -- the "refreshes
  // after the next turn" promise would be a permanent lie there.
  const catalogProvenanceStale =
    isExternal &&
    !isPerModelCatalogAdapter &&
    discovered != null &&
    discovered.adapter_id != null &&
    discovered.adapter_id !== activeAdapterId;

  // The turn-end live currents (issue #586, ADR-0095 Decision 5): the
  // session discovery cache records what the last turn ACTUALLY ran -- the
  // ACP handshake currents, the claude system{init} model (codex turns
  // report no discovery, so its cache never exists). The provenance gate is
  // strict: only a cache stamped by the ACTIVE adapter may be asserted as
  // this runtime's last turn -- another adapter's cache is a stale fact
  // (the #529 note covers it) and a pre-stamp cache is an unattributable
  // one.
  const liveDiscovered =
    isExternal &&
    discovered != null &&
    discovered.adapter_id != null &&
    discovered.adapter_id === activeAdapterId
      ? discovered
      : null;

  // Catalog priority chain (ADR-0096 D6, issue #537, ADR-0097): where the
  // posture catalog comes from, per the active runtime's stream format.
  //   ACP:                  session cached_discovered -> the global probe
  //                         cache entry for THIS adapter -> none (static
  //                         label + the settings-test guidance).
  //   codex / claude-code:  the probe cache's per-model entry for THIS
  //                         adapter only; without it the surface stays the
  //                         static CLI-default label -- honest rendering, no
  //                         invented directory.
  const acpCatalog =
    isExternal && !isPerModelCatalogAdapter
      ? (discovered ??
        (probeEntry && probeEntry.probe_kind === "acp"
          ? probeEntry.outcome.acp.discovered
          : null))
      : null;
  // True when the ACP catalog is fed by the probe cache rather than the
  // session's own discovery (drives the provenance note: the session cache
  // replaces it after this runtime's next turn).
  const acpCatalogFromProbe =
    acpCatalog != null && discovered == null && probeEntry != null;

  // The one provenance note the posture trigger renders: the two predicates
  // are complementary over `discovered` (stale requires a session-owned
  // discovery, probe-fed requires none), so at most one ever fires.
  const note: CatalogNote = catalogProvenanceStale
    ? "stale-runtime"
    : acpCatalogFromProbe
      ? "from-probe"
      : null;

  const perModelCatalog =
    isPerModelCatalogAdapter && probeEntry
      ? probeEntry.probe_kind === "codex_event_stream"
        ? probeEntry.outcome.codex_event_stream.models
        : probeEntry.probe_kind === "claude_stream_json"
          ? probeEntry.outcome.claude_stream_json.models
          : null
      : null;

  // The two catalog sources are already stream-format-namespaced above
  // (per-model implies an external per-model adapter; acp implies an
  // external ACP one, and they are mutually exclusive), so the projection
  // re-dispatches on the resolved values alone -- null on both is the
  // static-label surface (built-in, or an external runtime with no
  // directory yet).
  const catalog: PostureCatalog | null = perModelCatalog
    ? { kind: "perModel", models: perModelCatalog }
    : acpCatalog
      ? {
          kind: "acp",
          models: acpCatalog.models,
          thoughtLevels: acpCatalog.thought_levels,
          currentModel: acpCatalog.current_model,
          currentThoughtLevel: acpCatalog.current_thought_level,
        }
      : null;

  // The live payload joins the turn's currents (issue #586): read as facts
  // only while nothing is held (a selection always outranks the live read)
  // and only alongside a catalog -- the trigger drops the tooltip on its
  // static-label early return, so a claude session whose per-model catalog
  // still awaits its first settings probe keeps the live read unsurfaced
  // instead of half-rendered. An empty-string field counts as unset,
  // matching the menu guards' convention.
  const heldParts = heldPostureParts(reads.posture);
  const liveParts = [
    liveDiscovered?.current_model,
    liveDiscovered?.current_thought_level,
  ].filter(isSetPosturePart);
  const liveValue =
    catalog != null && heldParts.length === 0 && liveParts.length > 0
      ? liveParts.join(" · ")
      : null;

  return {
    catalog,
    note,
    liveDiscovered,
    liveValue,
  };
}
