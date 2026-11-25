import type { BuiltinCatalogModel, CatalogModel } from "../../types/runtime";

// The posture cascade menu's display decisions, extracted from
// ComposerPostureTrigger as pure projections (the same face as
// posture-catalog.ts, which derives the catalog itself). Two functions own
// the menu's display derivations; the family-gated rendering itself (the
// loading placeholder, the builtin model dimension's gating) stays
// component-side:
//
// - derivePostureDirectory normalizes the catalog's three family arms (acp /
//   builtin / perModel) into one directory shape -- the model ids, the
//   CLI-reported current per dimension, the held chain (explicit selection
//   ?? the current the next turn would actually run), the strength row's
//   unavailable predicate, and the built-in probe's in-flight flag. The
//   dispatch happens once, not per consumer.
// - deriveDimensionRows projects one dimension's row set from its reads --
//   the query-filtered directory view, the honest no-match gate, and the
//   synthetic row (a held value the directory does not offer) with its
//   provenance note.
//
// The component keeps the Radix wiring that is not a display ruling: the
// radio group's value fallback chain, the clearing-row labels (i18n
// composition), the filter input and its key handling.

// The catalog the cascade menu offers, discriminated by source (ADR-0096 D6):
// "acp" is the flat handshake catalog (independent model / thought-level
// lists + the CLI-reported currents); "perModel" is the probe cache's
// per-model catalog, whose thought-level list is the SELECTED model's
// supported efforts in the CLI's declared order; "builtin" (issue #1639,
// ADR-0153) is the built-in runtime's first-hand endpoint list with catalog
// metadata -- no CLI current (the profile's model field is the effective
// default), and an empty `models` list is the honest fallback shape (probe
// pending or failed -- silent by contract), never an error surface. A null
// `profileModel` is the unpinned profile (ADR-0154).
export type PostureCatalog =
  | {
    kind: "acp";
    models: string[];
    thoughtLevels: string[];
    currentModel: string | null;
    currentThoughtLevel: string | null;
  }
  | { kind: "perModel"; models: CatalogModel[] }
  | {
    kind: "builtin";
    models: BuiltinCatalogModel[];
    profileModel: string | null;
    // True while the lazy probe (issue #1639) is in flight: both dimension
    // lists seat a disabled placeholder row instead of the settled shape
    // (issue #1648) -- an honest wait instead of rows/strength appearing
    // from nothing. Failure stays silent: false renders the fallback shape.
    loading?: boolean;
  };

// The catalog provenance note kind: which of the two honest-source
// explanations, if any, applies.
export type CatalogNote = "stale-runtime" | "from-probe" | null;

// The normalized directory view one catalog renders as. `heldModel` /
// `heldLevel` feed the first-level rows' inline values; the clearing rows
// annotate the currents (`currentModel` / `currentLevel`). `isBuiltin` is
// the family flag the component's builtin-only rulings read; the
// builtin-only `builtinLoading` is undefined outside the builtin family
// (external catalogs never load -- cache-fed), a declared part of the
// shape.
type PostureDirectory = {
  isBuiltin: boolean;
  modelIds: readonly string[];
  currentModel: string | null;
  levelIds: readonly string[];
  currentLevel: string | null;
  levelUnavailable: boolean;
  heldModel: string | null;
  heldLevel: string | null;
  builtinLoading: boolean | undefined;
};

// One catalog projection's reads: the catalog itself plus the session's
// held pair. Named as an object because the two string slots are same-shaped
// and asymmetrically live per family (thoughtLevel carries weight only in
// the builtin arm) -- the sibling projections in this domain all take reads
// objects for the same reason.
export type PostureDirectoryReads = {
  catalog: PostureCatalog;
  model: string | null;
  thoughtLevel: string | null;
};

export function derivePostureDirectory(
  reads: PostureDirectoryReads,
): PostureDirectory {
  const { catalog, model, thoughtLevel } = reads;
  let modelIds: readonly string[];
  let currentModel: string | null;
  let levelIds: readonly string[];
  let currentLevel: string | null;
  // The strength row is a permanent seat on every family (issue #1648
  // feedback, retiring #1639's hide): the probe's in-flight window renders
  // the placeholder, a tiered held model renders its list, and a held model
  // without discrete tiers renders the disabled no-levels hint -- hiding
  // the row after the placeholder had shown it was the flicker this fixes.
  // A held level (explicit selection) never reads unavailable: the row
  // stays live for its synthetic row (issue #529).
  let levelUnavailable = false;
  if (catalog.kind === "acp") {
    modelIds = catalog.models;
    currentModel = catalog.currentModel;
    levelIds = catalog.thoughtLevels;
    currentLevel = catalog.currentThoughtLevel;
  } else if (catalog.kind === "builtin") {
    modelIds = catalog.models.map((m) => m.id);
    // The effective default: the profile's pinned model, or null for an
    // unpinned profile (ADR-0154) -- what the unselected state runs next
    // turn when one is pinned; no CLI reports a current here.
    currentModel = catalog.profileModel;
    currentLevel = null;
    const held = model ?? catalog.profileModel;
    const entry = held != null ? catalog.models.find((m) => m.id === held) : undefined;
    levelIds = entry?.supported_reasoning_efforts ?? [];
    levelUnavailable =
      !catalog.loading && levelIds.length === 0 && thoughtLevel == null;
  } else {
    modelIds = catalog.models.map((m) => m.id);
    currentModel = catalog.models.find((m) => m.is_default)?.id ?? null;
    // The strength list rides the held model (issue #1648, retiring #537's
    // disable-while-unselected): the CLI current IS the held value when
    // nothing is picked, so its efforts seat the list -- the default and an
    // explicit pick of the same id configure strength alike. Unavailable
    // only when no held id exists (an empty directory): an explicit pick
    // outside the directory keeps the row enabled with an empty list, where
    // the held level's own synthetic row (if any) carries the state.
    const held = model ?? currentModel;
    const heldEntry = held != null
      ? (catalog.models.find((m) => m.id === held) ?? null)
      : null;
    levelIds = heldEntry?.supported_reasoning_efforts ?? [];
    currentLevel = heldEntry?.default_reasoning_effort ?? null;
    levelUnavailable = held == null;
  }

  // The held value per dimension: the explicit selection, else the
  // CLI-reported current the next turn would actually run (the retired
  // select's held chain). The second-level synthetic row is derived from
  // the same value inside deriveDimensionRows.
  const heldModel = model ?? currentModel;
  const heldLevel = thoughtLevel ?? currentLevel;

  return {
    isBuiltin: catalog.kind === "builtin",
    modelIds,
    currentModel,
    levelIds,
    currentLevel,
    levelUnavailable,
    heldModel,
    heldLevel,
    builtinLoading: catalog.kind === "builtin" ? catalog.loading : undefined,
  };
}

// One dimension's row-set reads: the directory ids, the held value displayed
// on the first-level row, the filter box's raw query, the probe's in-flight
// flag, whether the filter row is seated at all, and the built-in model
// dimension's flag (absent on the external dimensions).
export type DimensionRowReads = {
  ids: readonly string[];
  displayValue: string | null;
  query: string;
  loading?: boolean;
  searchable?: boolean;
  isBuiltinModel?: boolean;
};

// One dimension's row-set projection. `note` is the synthetic row's
// provenance: "runtime" warns that the endpoint no longer serves the held
// id; undefined on ordinary rows and on the built-in model dimension (the
// built-in runtime has no CLI to "not offer" anything).
type DimensionRows = {
  filteredIds: readonly string[];
  showNoMatch: boolean;
  unrepresentedId: string | null;
  note: "runtime" | undefined;
};

export function deriveDimensionRows(reads: DimensionRowReads): DimensionRows {
  const loading = reads.loading ?? false;
  const searchable = reads.searchable ?? false;
  const normalizedQuery = reads.query.trim().toLowerCase();
  // The directory view under the current query: a row survives when its id
  // carries the query as a case-insensitive substring (issue #1648 retired
  // the display-name half with the names themselves). An empty (or
  // whitespace-only) query is the full list.
  const filteredIds =
    normalizedQuery === ""
      ? reads.ids
      : reads.ids.filter((id) => id.toLowerCase().includes(normalizedQuery));
  // The empty state's gates (issue #1648 review): not while the probe is in
  // flight (the placeholder owns the wait -- "no match" over an unloaded
  // list is a false statement), and only when the directory itself has rows
  // to filter (an empty directory is the probe's settled fallback, not a
  // filter miss -- the silence keeps a failed probe from reading as one).
  const showNoMatch =
    searchable &&
    !loading &&
    normalizedQuery !== "" &&
    reads.ids.length > 0 &&
    filteredIds.length === 0;

  // The synthetic row's id, derived from the dimension's own inputs: it
  // exists if and only if the displayed value is a non-empty id outside
  // `ids`. Selectable, so the menu stays honest about an active posture it
  // cannot otherwise show and the user can adopt it explicitly.
  const unrepresentedId =
    reads.displayValue != null && reads.displayValue !== "" && !reads.ids.includes(reads.displayValue)
      ? reads.displayValue
      : null;
  const isBuiltinModel = reads.isBuiltinModel ?? false;
  // The "pinned" annotation retired (issue #1648 feedback): the held
  // checkmark already names the row the next turn runs, and where the
  // value came from (a pick vs the profile's pin) is not a distinction
  // the mark carries either. Only the runtime omission keeps its note --
  // selecting an id the endpoint no longer serves deserves the warning.
  const note =
    unrepresentedId == null || isBuiltinModel ? undefined : "runtime";

  return { filteredIds, showNoMatch, unrepresentedId, note };
}
