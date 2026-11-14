import { describe, expect, it } from "vitest";

import { parseReleaseNotes, releaseNotesLang } from "../release-notes";

// The release-notes body grammar (issue #1577): the canonical three `###`
// sections with `- ` items, optional `<!-- en -->` language split, the
// `(PR …)` provenance tails, and the `---` install-tip footer. The parser is
// total: any shape renders something readable, nothing throws.

const CN_SECTIONS = [
  "### 新功能",
  "",
  "- 新增工作区记忆系统，回合结束自动提取沉淀要点 (PR [#1536](https://example.com/pull/1536))",
  "- 消息文本可划选后一键引用 (PR [#1574](https://example.com/pull/1574))",
  "",
  "### 改进",
  "",
  "- 深浅主题的对比度按分级校准 (PR [#1557](https://example.com/pull/1557))",
  "",
  "### 修复",
  "",
  "- 大型 Excel 工作簿引导导入全程只解析一次 (PR [#1555](https://example.com/pull/1555))",
].join("\n");

const EN_SECTIONS = [
  "### New Features",
  "",
  "- Workspace memory extracts key points at turn end (PR [#1536](https://example.com/pull/1536))",
].join("\n");

const FOOTER = ["", "---", "", "> Install tips that belong to the release page only."].join("\n");

describe("releaseNotesLang", () => {
  it("maps Chinese locales to the zh segment and everything else to en", () => {
    expect(releaseNotesLang("zh-CN")).toBe("zh");
    expect(releaseNotesLang("zh-TW")).toBe("zh");
    expect(releaseNotesLang("en-US")).toBe("en");
    expect(releaseNotesLang("fr")).toBe("en");
  });
});

describe("parseReleaseNotes", () => {
  it("parses canonical sections and strips the PR provenance tails", () => {
    const parsed = parseReleaseNotes(CN_SECTIONS + FOOTER, "zh");

    expect(parsed.kind).toBe("sections");
    if (parsed.kind !== "sections") return;
    expect(parsed.sections.map((s) => s.title)).toEqual(["新功能", "改进", "修复"]);
    expect(parsed.sections[0]?.items).toEqual([
      "新增工作区记忆系统，回合结束自动提取沉淀要点",
      "消息文本可划选后一键引用",
    ]);
  });

  it("picks the language segment the en marker splits", () => {
    const body = CN_SECTIONS + "\n\n<!-- en -->\n\n" + EN_SECTIONS;

    const zh = parseReleaseNotes(body, "zh");
    const en = parseReleaseNotes(body, "en");

    expect(zh.kind).toBe("sections");
    expect(en.kind).toBe("sections");
    if (zh.kind === "sections" && en.kind === "sections") {
      expect(zh.sections[0]?.title).toBe("新功能");
      expect(en.sections[0]?.title).toBe("New Features");
    }
  });

  it("renders the whole body regardless of locale when no en marker exists", () => {
    const zh = parseReleaseNotes(CN_SECTIONS, "zh");
    const en = parseReleaseNotes(CN_SECTIONS, "en");

    expect(zh).toEqual(en);
    expect(en.kind).toBe("sections");
  });

  it("cuts the install-tip footer at the --- separator line", () => {
    const parsed = parseReleaseNotes(CN_SECTIONS + FOOTER, "zh");

    if (parsed.kind !== "sections") return;
    const rendered = JSON.stringify(parsed);
    expect(rendered).not.toContain("Install tips");
    expect(rendered).not.toContain("---");
  });

  it("strips a PR tail from the first (PR marker to the end of the line", () => {
    const body = ["### 修复", "", "- 修复导入卡顿 (PR [#1](https://e.com/1), PR [#2](https://e.com/2))"].join("\n");

    const parsed = parseReleaseNotes(body, "zh");

    if (parsed.kind !== "sections") return;
    expect(parsed.sections[0]?.items).toEqual(["修复导入卡顿"]);
  });

  it("keeps literal parentheses that are not PR tails", () => {
    const body = ["### 修复", "", "- 修复 (括号) 与 (嵌套 (更深)) 文本的解析"].join("\n");

    const parsed = parseReleaseNotes(body, "zh");

    if (parsed.kind !== "sections") return;
    expect(parsed.sections[0]?.items).toEqual(["修复 (括号) 与 (嵌套 (更深)) 文本的解析"]);
  });

  it("falls back to plain lines for text without any section heading", () => {
    const parsed = parseReleaseNotes("一行说明\n\n另一行说明 (PR [#2](https://e.com/2))", "zh");

    expect(parsed.kind).toBe("plain");
    if (parsed.kind !== "plain") return;
    expect(parsed.lines).toEqual(["一行说明", "另一行说明"]);
  });

  it("falls back to the first segment when the en segment is empty", () => {
    const body = CN_SECTIONS + "\n\n<!-- en -->\n";

    const parsed = parseReleaseNotes(body, "en");

    expect(parsed.kind).toBe("sections");
    if (parsed.kind !== "sections") return;
    expect(parsed.sections[0]?.title).toBe("新功能");
  });

  it("falls back to the en segment when the zh segment is empty", () => {
    const body = "\n\n<!-- en -->\n\n" + EN_SECTIONS;

    const parsed = parseReleaseNotes(body, "zh");

    expect(parsed.kind).toBe("sections");
    if (parsed.kind !== "sections") return;
    expect(parsed.sections[0]?.title).toBe("New Features");
  });

  it("parses empty and whitespace-only bodies to an empty plain result", () => {
    expect(parseReleaseNotes("", "zh")).toEqual({ kind: "plain", lines: [] });
    expect(parseReleaseNotes("  \n\t\n", "en")).toEqual({ kind: "plain", lines: [] });
  });
});
