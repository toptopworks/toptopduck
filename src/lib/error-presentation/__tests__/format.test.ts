import { describe, expect, it } from "vitest";

import { fmtError } from "../format";
import { catalogIntl } from "../../../components/common/__tests__/helpers";
import type { SkillError } from "../../../types/skills";

// The skill lane of fmtError (issue #1015): the undeletable message points
// at the enablement axis ("disable it instead") -- the old dead-end wording
// named a companion tool that knowledge-only builtins do not have. The lane
// is UI-unreachable today (the builtin delete renders inert, so the confirm
// dialog never opens); the Rust re-check keeps it as a race surface, and
// this pin holds the copy honest if a future surface renders it. The intl
// resolves through the real en-US catalog (the shared i18n test seam, issue
// #1100); the expected string stays literal because the {name} substitution
// is what this pin holds.
const intl = catalogIntl("en-US");

describe("fmtError skill lane", () => {
  it("points the undeletable skill error at the enablement axis", () => {
    const e: SkillError = { kind: "BuiltinUndeletable", data: "vega-chart" };
    expect(fmtError(e, intl)).toBe(
      "System skill \"vega-chart\" cannot be deleted; disable it instead",
    );
  });
});
