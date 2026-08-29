import { describe, expect, it } from "vitest";

import {
  clampHighlight,
  detectTrigger,
  filterSkills,
  readPickerQuery,
  removeTriggerSpan,
} from "../skillPickerLogic";

// The ADR-0112 Decision 5 interaction contract, pinned at the pure-algebra
// seam: line-start triggering, query extraction, selection's span removal,
// clamped (non-wrapping) movement, and the mount-list-matching filter.

describe("detectTrigger (line-start contract)", () => {
  it("opens the global panel on / typed into an empty draft", () => {
    expect(detectTrigger("/", 1)).toEqual({ mode: "global", triggerIndex: 0 });
  });

  it("opens the skills-direct panel on $ typed into an empty draft", () => {
    expect(detectTrigger("$", 1)).toEqual({ mode: "skills", triggerIndex: 0 });
  });

  it("opens on a trigger at the start of a later line", () => {
    expect(detectTrigger("hi\n/", 4)).toEqual({
      mode: "global",
      triggerIndex: 3,
    });
  });

  it("never opens on a mid-line character", () => {
    expect(detectTrigger("hi /", 4)).toBeNull();
    expect(detectTrigger("a$b", 2)).toBeNull();
  });

  it("never opens when the caret is not right after a typed char", () => {
    expect(detectTrigger("/", 0)).toBeNull();
    expect(detectTrigger("", 0)).toBeNull();
  });
});

describe("readPickerQuery", () => {
  const trigger = { mode: "global" as const, triggerIndex: 0 };

  it("reads the text between the trigger and the caret", () => {
    expect(readPickerQuery("/char", trigger, 5)).toBe("char");
  });

  it("returns the empty query right after the trigger", () => {
    expect(readPickerQuery("/", trigger, 1)).toBe("");
  });

  it("closes (null) when the trigger character was deleted", () => {
    expect(readPickerQuery("x", trigger, 1)).toBeNull();
  });

  it("closes when the caret moved before the trigger", () => {
    expect(readPickerQuery("/q", trigger, 0)).toBeNull();
  });

  it("closes when the query region crossed a newline", () => {
    expect(readPickerQuery("/q\nx", trigger, 4)).toBeNull();
  });
});

describe("removeTriggerSpan (selection consumes the span)", () => {
  it("removes the trigger + query, keeping the rest of the draft", () => {
    expect(removeTriggerSpan("/chart", 0, 6)).toBe("");
    expect(removeTriggerSpan("hi\n$chart rest", 3, 9)).toBe("hi\n rest");
  });
});

describe("clampHighlight (never wraps)", () => {
  it("clamps at both ends", () => {
    expect(clampHighlight(0, -1, 3)).toBe(0);
    expect(clampHighlight(2, 1, 3)).toBe(2);
    expect(clampHighlight(1, 1, 3)).toBe(2);
  });

  // The degenerate-but-legal non-empty case (a filter that leaves one row):
  // both directions clamp onto that row. The EMPTY list is no longer this
  // function's business (issue #718): the snapshot derives a null highlight
  // there and the arrow keys no-op before the clamp -- its "pin 0" contract
  // is pinned at the QuestionBar level instead (aria-activedescendant
  // absent on the empty face).
  it("holds the only row of a single-row list in both directions", () => {
    expect(clampHighlight(0, -1, 1)).toBe(0);
    expect(clampHighlight(0, 1, 1)).toBe(0);
  });
});

describe("filterSkills (name or description substring, case-insensitive)", () => {
  const skills = [
    { name: "Charting", description: "Draw charts" },
    { name: "data-cleaning", description: "Tidy messy tables" },
  ];

  it("passes everything on an empty / blank query", () => {
    expect(filterSkills(skills, "")).toHaveLength(2);
    expect(filterSkills(skills, "  ")).toHaveLength(2);
  });

  it("matches name substrings ignoring case", () => {
    expect(filterSkills(skills, "CHART")).toEqual([
      { name: "Charting", description: "Draw charts" },
    ]);
    expect(filterSkills(skills, "-clean")).toEqual([
      { name: "data-cleaning", description: "Tidy messy tables" },
    ]);
  });

  it("matches description substrings when the name misses", () => {
    expect(filterSkills(skills, "messy")).toEqual([
      { name: "data-cleaning", description: "Tidy messy tables" },
    ]);
  });

  it("returns nothing on a miss", () => {
    expect(filterSkills(skills, "zzz")).toEqual([]);
  });
});
