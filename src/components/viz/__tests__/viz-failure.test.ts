import { describe, expect, it } from "vitest";

import { formatVizFailure } from "../viz-failure";
import type { VizFailureReason } from "../viz";
import { catalogIntl } from "../../common/__tests__/helpers";

// Render-level pins for all four failure arms (issue #1098): the #1097 copy
// rewrite left these with zero assertions, and `notObject` is a semantic
// narrowing ("not a Vega-Lite object" -> "unsupported format") whose break
// would otherwise run green. Both locales resolve through the real catalog
// (the shared i18n test seam, issue #1100) -- the en arm now pins the en-US
// catalog values directly, where it previously pinned the defaultMessage
// fallback; i18n:check aligns key sets only, never value semantics. The
// `unsupportedMark` arm interpolates the engine's raw mark (layer 4, never
// translated), so the pin holds the {mark} substitution honest too.
const en = catalogIntl("en-US");
const zh = catalogIntl("zh-CN");

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
  it.each(cases)("renders $reason.kind in en via the en-US catalog", ({ reason, en: pattern }) => {
    expect(formatVizFailure(reason, en)).toMatch(pattern);
  });

  it.each(cases)("renders $reason.kind in zh-CN via the catalog", ({ reason, zh: pattern }) => {
    expect(formatVizFailure(reason, zh)).toMatch(pattern);
  });
});
