import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { fmtError } from "../format";
import { isSessionError, isSkillMountError } from "../guards";
import type { SkillMountError } from "../../../types/skills";

// An IntlShape carrying the SkillMountError message ids (mirroring en-US.json)
// so fmtError resolves kind -> catalog wording. The wording lives once in the
// locale files; this pins the kind -> id mapping + the L1 shape verification,
// not the wording itself.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.skillMount.alreadyMounted": "Skill \"{name}\" is already mounted",
    "error.skillMount.notMounted": "Skill \"{name}\" is not mounted",
  },
});

describe("isSkillMountError", () => {
  // Each well-formed variant narrows true; the L1 shape check verifies the
  // payload before promising the shape so fmtError never reads an unverified
  // field.
  it("accepts each well-formed variant", () => {
    const cases: SkillMountError[] = [
      { kind: "AlreadyMounted", data: { name: "sql-coach" } },
      { kind: "NotMounted", data: { name: "sql-coach" } },
    ];
    for (const value of cases) {
      expect(isSkillMountError(value), value.kind).toBe(true);
    }
  });

  it("rejects an unknown kind tag", () => {
    expect(isSkillMountError({ kind: "Schroedinger", data: { name: "x" } })).toBe(false);
  });

  // A matching kind tag with a malformed payload must NOT narrow true: data
  // missing / null / non-object / name not a string all refuse the shape, so
  // fmtError never reads an unverified field.
  it("rejects a matching kind tag with a malformed payload", () => {
    expect(isSkillMountError({ kind: "AlreadyMounted" })).toBe(false);
    expect(isSkillMountError({ kind: "AlreadyMounted", data: null })).toBe(false);
    expect(isSkillMountError({ kind: "AlreadyMounted", data: {} })).toBe(false);
    expect(isSkillMountError({ kind: "AlreadyMounted", data: { name: 42 } })).toBe(false);
  });

  it("rejects non-object / null / undefined input", () => {
    expect(isSkillMountError(null)).toBe(false);
    expect(isSkillMountError("AlreadyMounted")).toBe(false);
    expect(isSkillMountError(undefined)).toBe(false);
  });

  // Reached via isSessionError's SkillMount branch: a SessionError.SkillMount
  // reject narrows true iff its data is a well-formed SkillMountError. This is
  // the TS side of the Rust->TS contract ipc_contract.rs pins from the other
  // side (skill_mount_error_serializes_adjacently_tagged).
  it("narrows through isSessionError's SkillMount branch", () => {
    expect(
      isSessionError({
        kind: "SkillMount",
        data: { kind: "AlreadyMounted", data: { name: "sql-coach" } },
      }),
    ).toBe(true);
    expect(
      isSessionError({
        kind: "SkillMount",
        data: { kind: "Bogus", data: { name: "x" } },
      }),
    ).toBe(false);
  });
});

describe("fmtError via SessionError.SkillMount", () => {
  // Each SkillMountError variant renders through its own catalog id (issue
  // #363), not a backend Display string; the offending skill name rides the
  // primary message via {name}. formatSkillMountError is module-private, so
  // drive it through the public fmtError dispatch on the SessionError.
  // SkillMount envelope.
  it("renders each variant via the locale catalog with the skill name", () => {
    expect(
      fmtError(
        {
          kind: "SkillMount",
          data: { kind: "AlreadyMounted", data: { name: "sql-coach" } },
        },
        intl,
      ),
    ).toBe("Skill \"sql-coach\" is already mounted");
    expect(
      fmtError(
        {
          kind: "SkillMount",
          data: { kind: "NotMounted", data: { name: "chart-helper" } },
        },
        intl,
      ),
    ).toBe("Skill \"chart-helper\" is not mounted");
  });
});
