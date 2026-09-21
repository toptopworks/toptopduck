import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { fmtError } from "../format";
import type { SkillError } from "../../../types/skills";

// The skill lane of fmtError (issue #1015): the undeletable message points
// at the enablement axis ("disable it instead") -- the old dead-end wording
// named a companion tool that knowledge-only builtins do not have. The lane
// is UI-unreachable today (the builtin delete renders inert, so the confirm
// dialog never opens); the Rust re-check keeps it as a race surface, and
// this pin holds the copy honest if a future surface renders it. The intl
// carries no messages, so what is asserted is the defaultMessage itself --
// the id-level binding lives in the locale catalogs and the i18n guard.
const intl = createIntl({ locale: "en", messages: {} });

describe("fmtError skill lane", () => {
  it("points the undeletable skill error at the enablement axis", () => {
    const e: SkillError = { kind: "BuiltinUndeletable", data: "vega-chart" };
    expect(fmtError(e, intl)).toBe(
      "Built-in skill \"vega-chart\" cannot be deleted; disable it instead",
    );
  });
});
