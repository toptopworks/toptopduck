import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { formatVizFailure } from "../viz-failure";
import type { VizFailureReason } from "../viz";
import { catalogFor } from "../../../i18n/catalogs";

// Render-level pins for all four failure arms (issue #1098): the #1097 copy
// rewrite left these with zero assertions, and `notObject` is a semantic
// narrowing ("not a Vega-Lite object" -> "unsupported format") whose break
// would otherwise run green. The en intl carries no messages, so what is
// asserted is the defaultMessage render path; the zh-CN intl pins the catalog
// values -- i18n:check aligns key sets only, never value semantics. The
// `unsupportedMark` arm interpolates the engine's raw mark (layer 4, never
// translated), so the pin holds the {mark} substitution honest too.
const en = createIntl({ locale: "en", messages: {} });
const zh = createIntl({ locale: "zh-CN", messages: catalogFor("zh-CN") });

const cases: ReadonlyArray<{
  reason: VizFailureReason;
  en: RegExp;
  zh: RegExp;
}> = [
  {
    reason: { kind: "invalidJson" },
    en: /chart definition is not valid JSON/,
    zh: /不是有效的 JSON/,
  },
  {
    reason: { kind: "notObject" },
    en: /unsupported format/,
    zh: /格式不受支持/,
  },
  {
    reason: { kind: "unsupportedMark", mark: "circle" },
    en: /chart type "circle" is not supported/,
    zh: /不支持的图表类型「circle」/,
  },
  {
    reason: { kind: "render" },
    en: /error occurred while drawing/,
    zh: /绘制图表时出错/,
  },
];

describe("formatVizFailure", () => {
  it.each(cases)("renders $reason.kind in en via the defaultMessage", ({ reason, en: pattern }) => {
    expect(formatVizFailure(reason, en)).toMatch(pattern);
  });

  it.each(cases)("renders $reason.kind in zh-CN via the catalog", ({ reason, zh: pattern }) => {
    expect(formatVizFailure(reason, zh)).toMatch(pattern);
  });
});
