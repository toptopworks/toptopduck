import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_EXPANSION_KEY,
  readSidebarExpansion,
  saveSidebarExpansion,
} from "../sidebarExpansion";

// Issue #1404 sidebar-expansion seam: the section folds + workspace subtree
// expansion + the landing seen baseline share ONE localStorage document. The
// read is a trust boundary -- the stored value is untrusted data, so any
// shape deviation degrades to the default face (three empty sets) instead of
// crashing a render, the same posture as the locale preference (ADR-0052)
// and the resize hook's stored width.

afterEach(() => {
  localStorage.removeItem(SIDEBAR_EXPANSION_KEY);
  vi.restoreAllMocks();
});

describe("readSidebarExpansion", () => {
  it("returns three empty sets when no stored document exists", () => {
    const state = readSidebarExpansion();
    expect(state.collapsedSections.size).toBe(0);
    expect(state.expandedWorkspaces.size).toBe(0);
    expect(state.seenWorkspaces.size).toBe(0);
  });

  it("round-trips a saved document", () => {
    saveSidebarExpansion({
      collapsedSections: new Set(["pinned", "archived"]),
      expandedWorkspaces: new Set(["/w/a", "/w/b"]),
      seenWorkspaces: new Set(["/r/1.json"]),
    });
    const state = readSidebarExpansion();
    expect([...state.collapsedSections]).toEqual(["pinned", "archived"]);
    expect([...state.expandedWorkspaces]).toEqual(["/w/a", "/w/b"]);
    expect([...state.seenWorkspaces]).toEqual(["/r/1.json"]);
  });

  it("falls back to empty sets on corrupt JSON", () => {
    localStorage.setItem(SIDEBAR_EXPANSION_KEY, "{not json");
    const state = readSidebarExpansion();
    expect(state.collapsedSections.size).toBe(0);
    expect(state.expandedWorkspaces.size).toBe(0);
    expect(state.seenWorkspaces.size).toBe(0);
  });

  it("falls back to empty sets when the document is not a plain object", () => {
    for (const raw of ["null", "42", "\"str\"", "[1,2]"]) {
      localStorage.setItem(SIDEBAR_EXPANSION_KEY, raw);
      expect(readSidebarExpansion().seenWorkspaces.size).toBe(0);
    }
  });

  it("falls back to empty sets when any field is not a string array", () => {
    localStorage.setItem(
      SIDEBAR_EXPANSION_KEY,
      JSON.stringify({
        collapsedSections: "pinned", // not an array
        expandedWorkspaces: [1, 2], // non-string elements
        seenWorkspaces: ["ok"],
      }),
    );
    const state = readSidebarExpansion();
    expect(state.collapsedSections.size).toBe(0);
    expect(state.expandedWorkspaces.size).toBe(0);
    expect(state.seenWorkspaces.size).toBe(0);
  });

  it("falls back to empty sets when localStorage itself throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("restricted context");
    });
    expect(readSidebarExpansion().collapsedSections.size).toBe(0);
  });
});

describe("saveSidebarExpansion", () => {
  it("merges the patch over the stored document field-by-field", () => {
    saveSidebarExpansion({
      collapsedSections: new Set(["pinned"]),
      expandedWorkspaces: new Set(["/w/a"]),
      seenWorkspaces: new Set(["/r/1.json"]),
    });
    saveSidebarExpansion({ collapsedSections: new Set(["workspaces"]) });
    const state = readSidebarExpansion();
    expect([...state.collapsedSections]).toEqual(["workspaces"]);
    expect([...state.expandedWorkspaces]).toEqual(["/w/a"]);
    expect([...state.seenWorkspaces]).toEqual(["/r/1.json"]);
  });

  it("writes the full document into a fresh store", () => {
    saveSidebarExpansion({ expandedWorkspaces: new Set(["/w/a"]) });
    const raw = localStorage.getItem(SIDEBAR_EXPANSION_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      collapsedSections: [],
      expandedWorkspaces: ["/w/a"],
      seenWorkspaces: [],
    });
  });

  it("keeps the stored document when the write throws", () => {
    saveSidebarExpansion({ collapsedSections: new Set(["pinned"]) });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() =>
      saveSidebarExpansion({ collapsedSections: new Set(["recent"]) }),
    ).not.toThrow();
    // The failed write leaves the previous document intact.
    expect([...readSidebarExpansion().collapsedSections]).toEqual(["pinned"]);
  });
});
