// Sidebar expansion persistence (issue #1404): the section folds + the
// workspace subtree expansion + the landing seen baseline share ONE
// localStorage document under the `toptopduck.sidebar-*` key family (the
// resize hook's `toptopduck.sidebar-width` is the naming precedent). Pure
// UI layout state -- localStorage, not app-config: nothing is lost when it
// is dropped, and the app-config schema cost (Rust model + format_version +
// fixtures) is out of proportion. No version field: a document that fails
// validation reads as the default face (everything expanded, nothing seen),
// the same degrade posture as a missing key.

const SIDEBAR_EXPANSION_KEY = "toptopduck.sidebar-expansion";

/** The persisted expansion faces, keyed the way their consumers hold them
 * (sets -- every read site is a membership query). */
export interface SidebarExpansionState {
  collapsedSections: ReadonlySet<string>;
  expandedWorkspaces: ReadonlySet<string>;
  seenWorkspaces: ReadonlySet<string>;
}

export { SIDEBAR_EXPANSION_KEY };

/** The JSON wire shape: string arrays, one per face. */
type StoredDocument = {
  collapsedSections: string[];
  expandedWorkspaces: string[];
  seenWorkspaces: string[];
};

function emptyState(): SidebarExpansionState {
  return {
    collapsedSections: new Set(),
    expandedWorkspaces: new Set(),
    seenWorkspaces: new Set(),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Read the persisted document. Any deviation -- missing key, corrupt JSON,
 * non-object shape, a field that is not a string array -- returns the
 * default face; the stored value is untrusted data. */
export function readSidebarExpansion(): SidebarExpansionState {
  try {
    const raw = localStorage.getItem(SIDEBAR_EXPANSION_KEY);
    if (!raw) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptyState();
    }
    const doc = parsed as Record<string, unknown>;
    if (
      !isStringArray(doc.collapsedSections) ||
      !isStringArray(doc.expandedWorkspaces) ||
      !isStringArray(doc.seenWorkspaces)
    ) {
      return emptyState();
    }
    return {
      collapsedSections: new Set(doc.collapsedSections),
      expandedWorkspaces: new Set(doc.expandedWorkspaces),
      seenWorkspaces: new Set(doc.seenWorkspaces),
    };
  } catch {
    return emptyState();
  }
}

/** Merge the patch over the current document and write it back whole --
 * each consumer owns one face and must not clobber the others' (the
 * three faces live in one document on purpose: persisting the expansion
 * without the seen baseline would replay the cold-start fan-out on every
 * launch). A failed write keeps the stored document; the change is lost,
 * which for layout state is a no-op, not an error surface. */
export function saveSidebarExpansion(patch: Partial<SidebarExpansionState>): void {
  const base = readSidebarExpansion();
  const doc: StoredDocument = {
    collapsedSections: [...(patch.collapsedSections ?? base.collapsedSections)],
    expandedWorkspaces: [...(patch.expandedWorkspaces ?? base.expandedWorkspaces)],
    seenWorkspaces: [...(patch.seenWorkspaces ?? base.seenWorkspaces)],
  };
  try {
    localStorage.setItem(SIDEBAR_EXPANSION_KEY, JSON.stringify(doc));
  } catch {
    // The resize hook's posture: a dropped layout write is not surfaced.
  }
}
