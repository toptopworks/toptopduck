import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import embed from "vega-embed";
import { embedOk, withIntl } from "../../common/__tests__/helpers";
import { log } from "../../../lib/log";
import { RoundProse } from "../RoundProse";
import { CODE_BLOCK_REVEAL_CLASS } from "../turn-visual";

// The link channel is the opener plugin IPC (mocked so clicks are pinned
// without Tauri); the openUrl failure lane logs through the shared sink,
// mocked like the settings tests so no plugin-log IPC runs in jsdom.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
// Vega-Embed needs a real canvas; jsdom has none, so a vega-lite fence's chart
// render is mocked (the fence still drives the real decode gate).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// The prose rides the thread's chrome (ADR-0052 react-intl + Radix Tooltip
// for the code block's CopyButton) -- wrapped via the shared i18n test seam
// the way the thread does. mode mirrors the live round block's wiring
// (ADR-0120 Decision 4, issue #1128).
function renderProse(text: string, mode: "streaming" | "static" = "static") {
  return render(withIntl(<RoundProse text={text} mode={mode} />));
}

function proseOf(ui: ReturnType<typeof renderProse>): HTMLElement {
  const root = ui.container.querySelector(".round-text");
  expect(root).not.toBeNull();
  return root as HTMLElement;
}

describe("RoundProse markdown rendering (issue #746)", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
  });

  it("renders a plain single-line answer as one paragraph (the pre-markdown shape)", () => {
    renderProse("我先查一下数据");
    const p = screen.getByText("我先查一下数据");
    expect(p.tagName).toBe("P");
  });

  it("carries the conversation tier and its CJK line-height on its own root", () => {
    // The .round-text root is where the conversation tier (text-sm, matching
    // the user bubble's question) lives for all three consumers -- live
    // rounds, settled rounds, and the textual outcome; this is the only
    // guard inside the component's own suite (the cross-component pins in
    // Thread.test select through TurnCard's container).
    const prose = proseOf(renderProse("正文"));
    const classes = prose.className.split(/\s+/);
    expect(classes).toContain("text-sm");
    // Body line-height floats at 1.75 -- a deliberate step above the
    // body-md token's 1.5, which CJK discourse reads as cramped once
    // answers run long (issue #828). The negative guard keeps the old
    // compact leading from sneaking back onto the prose root.
    expect(classes).toContain("leading-[1.75]");
    expect(classes).not.toContain("leading-snug");
    // The root hangs off the stream (flex-col items-start) as a
    // non-stretched flex item: the max-w-full cap keeps a wide markdown
    // table's min-content from stretching the prose past the card (the
    // #826 trace-round precedent -- the clamp must sit on the flex item
    // itself, a containing block one level down clamps nothing).
    expect(classes).toContain("max-w-full");
  });

  describe("structure", () => {
    it("leaves block-level children bare so the root's space-y owns block spacing", () => {
      // Tailwind v4's space-y selector sits inside :where() (zero
      // specificity), so a child's own m-0 (0,1,0) always outranks it -- m-0
      // on the mapped blocks killed the root's 16px inter-block rhythm
      // entirely (paragraphs and headings rendered flush on real hardware).
      // The block-level entries that land directly under the root carry no
      // margin classes (CodeBlock's inner pre keeps a nested m-0, but it
      // sits inside the wrapper div, out of the root's reach); the preflight
      // reset already zeroes the nested contexts the root's space-y never
      // reaches (issue #828).
      const ui = renderProse(
        "# 标题\n## 次级\n### 三级\n#### 四级\n##### 五级\n###### 六级\n\n段落一\n\n> 引用\n\n- 列表项\n\n1. 有序项\n\n---",
      );
      expect(proseOf(ui).className.split(/\s+/)).toContain("space-y-4");
      // Every mapped block tag, over every margin class that could flatten
      // the rhythm: the space-y rule pays out margin-block-end, so m-0,
      // my-0, and mb-0 all suppress it (mt-0 alone would be inert).
      const blockTags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "hr"];
      for (const tag of blockTags) {
        const classes = (ui.container.querySelector(tag)?.className ?? "").split(/\s+/);
        for (const margin of ["m-0", "my-0", "mb-0"]) {
          expect(classes).not.toContain(margin);
        }
      }
    });

    it("compresses the heading ladder: 17px h1 stepping down, h4+ at body size with weight only", () => {
      const { container } = renderProse(
        "# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级",
      );
      const classesOf = (tag: string) =>
        (container.querySelector(tag)?.className ?? "").split(/\s+/);
      expect(screen.getByRole("heading", { level: 1, name: "一级" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 6, name: "六级" })).toBeInTheDocument();
      // The compact ladder: h1 at 17px, one step per level, body size from h4.
      expect(classesOf("h1")).toContain("text-[1.0625rem]");
      expect(classesOf("h2")).toContain("text-base");
      expect(classesOf("h3")).toContain("text-[0.9375rem]");
      expect(classesOf("h4")).toContain("text-sm");
      expect(classesOf("h5")).toContain("text-sm");
      expect(classesOf("h6")).toContain("text-sm");
      // Weight caps at semibold (DESIGN.md forbids 700).
      for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
        expect(classesOf(tag)).toContain("font-semibold");
        expect(classesOf(tag)).not.toContain("font-bold");
      }
    });

    it("renders unordered and ordered lists", () => {
      renderProse("- 甲\n- 乙\n\n1. 丙\n2. 丁");
      const lists = screen.getAllByRole("list");
      expect(lists).toHaveLength(2);
      const ul = lists[0] as HTMLUListElement;
      const ol = lists[1] as HTMLOListElement;
      expect(ul.tagName).toBe("UL");
      expect(ul.className).toContain("list-disc");
      expect(ol.tagName).toBe("OL");
      expect(ol.className).toContain("list-decimal");
      expect(screen.getAllByRole("listitem")).toHaveLength(4);
    });

    it("renders a GFM task list as a native disabled checkbox", () => {
      // The bare input mapping keeps the checkbox preflight-native; the
      // disabled attribute is what the hast conversion carries.
      renderProse("- [ ] 待办\n- [x] 已办");
      const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      expect(boxes).toHaveLength(2);
      expect(boxes[0]?.checked).toBe(false);
      expect(boxes[1]?.checked).toBe(true);
      for (const box of boxes) {
        expect(box).toBeDisabled();
        // readOnly suppresses React's controlled-input warning on checked.
        expect(box).toHaveAttribute("readonly");
      }
    });

    it("renders a GFM pipe table in a scroll container with hairline borders", () => {
      const { container } = renderProse("| 列 | 值 |\n| --- | --- |\n| a | 1 |");
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "列" })).toBeInTheDocument();
      expect(screen.getByRole("cell", { name: "a" })).toBeInTheDocument();
      const wrapper = container.querySelector(".round-text > div");
      expect(wrapper?.className).toContain("overflow-x-auto");
      expect(wrapper?.className).toContain("border-border");
      expect(container.querySelector("th")?.className).toContain("border-border");
      // w-full alone lets a table whose min-content fits the column
      // squeeze down to the column width (cells wrap, no scroll range
      // appears); min-w-max keeps the table at natural width so it
      // scrolls instead of squeezing, while narrow tables keep the
      // w-full fill.
      const table = container.querySelector("table");
      expect(table).toHaveClass("w-full");
      expect(table).toHaveClass("min-w-max");
    });

    it("renders a blockquote as a left-ruled quote", () => {
      const { container } = renderProse("> 引文内容");
      const quote = container.querySelector("blockquote");
      expect(quote).not.toBeNull();
      expect(quote?.textContent).toContain("引文内容");
      // A 1px hairline rule (DESIGN.md: no 2px borders).
      expect(quote?.className.split(/\s+/)).toContain("border-l");
    });

    it("renders inline emphasis, strong, and code-chip runs", () => {
      renderProse("**粗体** *斜体* `片段`");
      expect(screen.getByText("粗体").tagName).toBe("STRONG");
      expect(screen.getByText("斜体").tagName).toBe("EM");
      const chip = screen.getByText("片段");
      expect(chip.tagName).toBe("CODE");
      // The code-inline token: muted chip surface + monospace.
      expect(chip.className).toContain("bg-muted");
      expect(chip.className).toContain("font-mono");
    });

    it("turns a single newline into a break (continuity with pre-wrap)", () => {
      const { container } = renderProse("第一行\n第二行");
      const p = container.querySelector("p");
      expect(p?.querySelector("br")).not.toBeNull();
      expect(p?.textContent).toContain("第一行");
      expect(p?.textContent).toContain("第二行");
    });

    it("renders a thematic break as a hairline rule", () => {
      const { container } = renderProse("上\n\n---\n\n下");
      const hr = container.querySelector("hr");
      expect(hr).not.toBeNull();
      expect(hr?.className).toContain("border-t");
    });
  });

  describe("safety", () => {
    it("shows embedded HTML as raw tag text, never rendered", () => {
      const view = renderProse(
        "开头 <b>加粗</b> 结尾\n\n<div class=\"injected\">内容</div>\n\n<script>alert(1)</script>",
      );
      const prose = proseOf(view);
      // Nothing the author wrote as markup becomes an element.
      expect(prose.querySelector("b")).toBeNull();
      expect(prose.querySelector("script")).toBeNull();
      expect(prose.querySelector("div")).toBeNull();
      // The tag characters survive as text.
      expect(prose.textContent).toContain("<b>加粗</b>");
      expect(prose.textContent).toContain("<div class=\"injected\">");
      expect(prose.textContent).toContain("<script>alert(1)</script>");
    });

    it.each([
      ["javascript:alert(1)", "小写 javascript:", "点我 (javascript:alert(1))"],
      ["JAVASCRIPT:alert(1)", "大写 JAVASCRIPT:", "点我 (JAVASCRIPT:alert(1))"],
      [
        "data:text/html,<script>alert(1)</script>",
        "data:",
        "点我 (data:text/html,%3Cscript%3Ealert(1)%3C/script%3E)",
      ],
      ["vbscript:MsgBox(1)", "vbscript:", "点我 (vbscript:MsgBox(1))"],
    ])("does not turn a %s link into a clickable anchor (%s)", (url, _label, degraded) => {
      const { container } = renderProse(`[点我](${url})`);
      // Streamdown's urlTransform passes unsafe schemes through un-stripped,
      // so the anchor gate is the ProseLink http(s) check itself -- the link
      // degrades to text with the target beside the label.
      expect(container.querySelector("a")).toBeNull();
      expect(screen.getByText(degraded)).toBeInTheDocument();
    });

    it("shows HTML embedded inside table cells and list items as raw text too", () => {
      const view = renderProse("| 列 |\n| --- |\n| <b>胞内</b> |\n\n- 项内 <i>斜注</i>");
      const prose = proseOf(view);
      expect(prose.querySelector("b")).toBeNull();
      expect(prose.querySelector("i")).toBeNull();
      expect(prose.textContent).toContain("<b>胞内</b>");
      expect(prose.textContent).toContain("<i>斜注</i>");
    });

    it("degrades images to alt text plus the URL, never an img element", () => {
      const view = renderProse("前 ![标志图](https://example.com/i.png) 后");
      const prose = proseOf(view);
      expect(prose.querySelector("img")).toBeNull();
      // The CSP blocks the fetch, but where the image lives is the one
      // recoverable fact -- it stays on the visible surface beside the alt.
      expect(screen.getByText("标志图 (https://example.com/i.png)")).toBeInTheDocument();
    });

    it("degrades an empty-alt image to the bare URL, never to nothing", () => {
      const view = renderProse("前 ![](https://example.com/a.png) 后");
      const prose = proseOf(view);
      expect(prose.querySelector("img")).toBeNull();
      // An image-led answer must not render as an answered turn with
      // nothing on screen (issue #827): no alt still shows the URL.
      expect(screen.getByText("https://example.com/a.png")).toBeInTheDocument();
      expect(prose.textContent).not.toBe("");
    });
  });

  describe("links", () => {
    it("opens https links through the OS opener, preventing the WebView navigation", () => {
      const { container } = renderProse("[文档](https://example.com/docs)");
      const link = screen.getByRole("link", { name: "文档" });
      expect(link).toHaveAttribute("href", "https://example.com/docs");
      let defaultPrevented = false;
      container.addEventListener("click", (event) => {
        defaultPrevented = event.defaultPrevented;
      });
      fireEvent.click(link);
      expect(defaultPrevented).toBe(true);
      expect(vi.mocked(openUrl)).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("opens http links through the OS opener too", () => {
      renderProse("[旧站](http://example.com/legacy)");
      fireEvent.click(screen.getByRole("link", { name: "旧站" }));
      expect(vi.mocked(openUrl)).toHaveBeenCalledWith("http://example.com/legacy");
    });

    it("degrades mailto links to plain text that keeps the address", () => {
      const { container } = renderProse("[邮件](mailto:dev@example.com)");
      expect(container.querySelector("a")).toBeNull();
      // The urlTransform preserves mailto:, so the target reaches the
      // component -- it rides beside the label instead of vanishing.
      expect(screen.getByText("邮件 (mailto:dev@example.com)")).toBeInTheDocument();
      expect(vi.mocked(openUrl)).not.toHaveBeenCalled();
    });

    it("degrades file links to plain text that keeps the target", () => {
      const { container } = renderProse("[本地](file:///C:/data/x.csv)");
      expect(container.querySelector("a")).toBeNull();
      // Streamdown's urlTransform passes file: through un-stripped, so the
      // degrade lane shows the target beside the label (the mailto: shape).
      expect(screen.getByText("本地 (file:///C:/data/x.csv)")).toBeInTheDocument();
      expect(vi.mocked(openUrl)).not.toHaveBeenCalled();
    });

    it("degrades relative links to plain text that keeps the reference", () => {
      const { container } = renderProse("[相对](docs/x.md)");
      expect(container.querySelector("a")).toBeNull();
      expect(screen.getByText("相对 (docs/x.md)")).toBeInTheDocument();
    });

    it("autolinks a bare https URL through the opener", () => {
      renderProse("详见 https://example.com/docs 后续");
      fireEvent.click(screen.getByRole("link", { name: "https://example.com/docs" }));
      expect(vi.mocked(openUrl)).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("autolinks a bare www host as http and degrades a bare email with its target", () => {
      renderProse("www.example.com 与 a@b.example.com");
      fireEvent.click(screen.getByRole("link", { name: "www.example.com" }));
      expect(vi.mocked(openUrl)).toHaveBeenCalledWith("http://www.example.com");
      // GFM autolinks the bare email to mailto:, which the fallback keeps
      // beside the label so the address reads as a link target, not plain
      // text that lost something.
      expect(screen.getByText("a@b.example.com (mailto:a@b.example.com)").closest("a")).toBeNull();
    });

    it("passes an uppercase-scheme https link through the gate as written", () => {
      renderProse("[大写](HTTPS://example.com/x)");
      fireEvent.click(screen.getByRole("link", { name: "大写" }));
      expect(vi.mocked(openUrl)).toHaveBeenCalledWith("HTTPS://example.com/x");
    });

    it("surfaces an opener failure as a live note beside the link and logs it", async () => {
      vi.mocked(openUrl).mockRejectedValueOnce(new Error("no browser"));
      renderProse("[文档](https://example.com/docs)");
      fireEvent.click(screen.getByRole("link", { name: "文档" }));
      const note = await screen.findByRole("status");
      expect(note.textContent).toBe("无法打开链接");
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        "RoundProse",
        "openUrl failed",
        expect.any(Error),
      );
    });
  });

  describe("code blocks", () => {
    // CopyButton writes through the clipboard API; stub it the way the
    // thread's copy tests do (test-setup un-stubs after each test).
    function stubClipboard(): ReturnType<typeof vi.fn> {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      return writeText;
    }

    it("renders the fence as monospace block + language label + hover copy", async () => {
      const writeText = stubClipboard();
      const { container } = renderProse("```python\nprint(1)\n```");
      const block = container.querySelector("pre");
      expect(block).not.toBeNull();
      expect(block?.textContent).toContain("print(1)");
      const code = block?.querySelector("code");
      expect(code?.className).toContain("font-mono");
      expect(code?.className).toContain("text-[13px]");
      // The fence language rides the caption label; the surface follows the
      // theme via the muted token.
      expect(screen.getByText("python")).toBeInTheDocument();
      expect(container.querySelector(".group\\/code-block")?.className).toContain("bg-muted");
      // The copy affordance reuses CopyButton with its localized label.
      const copy = screen.getByRole("button", { name: "复制代码" });
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("print(1)"));
    });

    it("renders a language-less fence with the copy button only", async () => {
      const writeText = stubClipboard();
      renderProse("```\nplain text\n```");
      const copy = screen.getByRole("button", { name: "复制代码" });
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("plain text"));
    });

    it("renders an unclosed fence as a code block while streaming", () => {
      const { container } = renderProse("```python\nprint(1)");
      expect(container.querySelector("pre")).not.toBeNull();
      expect(container.querySelector("pre")?.textContent).toContain("print(1)");
    });

    it("reveals the copy affordance through the code block's named-group reveal class", () => {
      renderProse("```\nplain\n```");
      const copy = screen.getByRole("button", { name: "复制代码" });
      // Assert against the imported constant so a same-meaning rewrite of
      // the class string cannot silently pass.
      expect(copy.parentElement?.className).toBe(CODE_BLOCK_REVEAL_CLASS);
    });

    it("keeps the copy ack across a streamed delta (stable component identity)", async () => {
      stubClipboard();
      const view = renderProse("```python\nprint(1)\n```");
      fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
      // The ack flips the accessible name to the shared "Copied" label.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument(),
      );
      // The next streamed delta extends the fence body; the custom component
      // must reconcile in place, not remount (a remount drops the ack state).
      view.rerender(
        withIntl(<RoundProse text={"```python\nprint(1)\nprint(2)\n```"} />),
      );
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
      expect(view.container.querySelector("pre")?.textContent).toContain("print(2)");
    });
  });

  describe("vega-lite fences (ADR-0120)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(embed).mockResolvedValue(embedOk());
    });

    it("renders a settled vega-lite fence as a chart, interleaved with the prose", async () => {
      // The chart is prose content (Decision 1): the surrounding paragraphs
      // keep rendering, and the fence body draws through the chart renderer
      // instead of showing as a code block.
      const { container } = renderProse(
        "报告如下\n\n```vega-lite\n{\"mark\": \"bar\", \"data\": {\"values\": [{\"a\": 1}]}}\n```\n\n完",
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual({
        mark: "bar",
        data: { values: [{ a: 1 }] },
        width: "container",
      });
      expect(container.querySelector(".viz-chart")).toBeInTheDocument();
      expect(screen.getByText("报告如下")).toBeInTheDocument();
      expect(screen.getByText("完")).toBeInTheDocument();
      // The fence body never shows as a code block on the settled side.
      expect(container.querySelector("pre")).toBeNull();
    });

    it("degrades a settled fence with a disclosure when the body is not a chart spec", async () => {
      // ADR-0033 on the fence surface: a corrupt or non-whitelisted body gets
      // an honest disclosure, never a silent blank and never a raw-JSON dump.
      const { container } = renderProse("```vega-lite\n{\"mark\": \"geoshape\"}\n```");
      await waitFor(() => expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument());
      expect(screen.getByText(/geoshape/)).toBeInTheDocument();
      expect(embed).not.toHaveBeenCalled();
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector(".viz-chart")).toBeNull();
    });

    it("renders two fences in one answer as two charts (the multi-chart report)", async () => {
      const { container } = renderProse(
        "```vega-lite\n{\"mark\": \"bar\"}\n```\n\n分隔\n\n```vega-lite\n{\"mark\": \"line\"}\n```",
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
      expect(container.querySelectorAll(".viz-chart")).toHaveLength(2);
      expect(screen.getByText("分隔")).toBeInTheDocument();
    });

    it("keeps every other fence language a plain code block (Decision 6: no guessing)", async () => {
      // A chart-shaped body under the `json` language is not a chart intent:
      // it stays a copyable code block and Vega-Embed never runs.
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = renderProse("```json\n{\"mark\": \"bar\"}\n```");
      const block = container.querySelector("pre");
      expect(block).not.toBeNull();
      expect(block?.textContent).toContain("{\"mark\": \"bar\"}");
      expect(screen.getByText("json")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(embed).not.toHaveBeenCalled();
    });

    it("shows a live vega-lite fence as a placeholder -- no source, no decode (Decision 4)", async () => {
      // While the round streams the fence body is half-written: the
      // placeholder names the chart without showing the source and without
      // attempting a parse (which would flash a degradation banner on every
      // partial delta).
      const { container } = renderProse("```vega-lite\n{\"mark\": \"ba", "streaming");
      expect(screen.getByText("图表生成中…")).toBeInTheDocument();
      expect(container.textContent).not.toContain("mark");
      expect(container.querySelector("pre")).toBeNull();
      expect(embed).not.toHaveBeenCalled();
    });

    it("keeps the live placeholder as the fence body streams in", async () => {
      // The live map is a module-level constant, so the growing fence
      // reconciles the placeholder in place instead of remounting per delta.
      const view = renderProse("```vega-lite\n{\"mark\": \"ba", "streaming");
      expect(screen.getAllByText("图表生成中…")).toHaveLength(1);
      view.rerender(
        withIntl(<RoundProse text={"```vega-lite\n{\"mark\": \"bar\"}"} mode="streaming" />),
      );
      expect(screen.getAllByText("图表生成中…")).toHaveLength(1);
      expect(view.container.textContent).not.toContain("mark");
      expect(embed).not.toHaveBeenCalled();
    });

    it("renders a settled fence after the live stream (the settle swap)", async () => {
      // The same text that streamed as a placeholder decodes into the chart
      // once the turn settles.
      const text = "```vega-lite\n{\"mark\": \"bar\"}\n```";
      const view = renderProse(text, "streaming");
      expect(screen.getByText("图表生成中…")).toBeInTheDocument();
      view.rerender(withIntl(<RoundProse text={text} />));
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("图表生成中…")).not.toBeInTheDocument();
      expect(view.container.querySelector(".viz-chart")).toBeInTheDocument();
    });
  });

  describe("streaming repair (issue #1128)", () => {
    it("completes a half-open bold marker into strong instead of flashing the source", () => {
      const view = renderProse("前文 **加粗", "streaming");
      expect(screen.getByText("加粗").tagName).toBe("STRONG");
      expect(proseOf(view).textContent).not.toContain("*");
    });

    it("renders a half-open link as its label without flashing the raw syntax", () => {
      const view = renderProse("参考 [文档](https://example.com", "streaming");
      expect(screen.getByText("文档")).toBeInTheDocument();
      // Remend completes the link with a provisional `streamdown:` href
      // (the urlTransform never strips it -- the component's own prefix
      // guard does), so the label survives as text -- never an anchor
      // pointing at a made-up URL, and never the raw `](` syntax on screen.
      expect(view.container.querySelector("a")).toBeNull();
      expect(proseOf(view).textContent).not.toContain("](");
    });

    it("renders an unclosed fence as a code block while streaming, never the fence source", () => {
      const view = renderProse("结果如下\n```python\nprint(1)", "streaming");
      const pre = view.container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toContain("print(1)");
      expect(proseOf(view).textContent).not.toContain("```");
    });
  });

  describe("caret (issue #1128)", () => {
    // The caret is the library's `--streamdown-caret` CSS custom property on
    // the root plus an after-content utility class; jsdom cannot paint pseudo
    // elements, so the assertions pin the two conditions the CSS reads.
    const CARET_CLASS = "after:content-[var(--streamdown-caret)]";

    function caretArmed(root: HTMLElement): boolean {
      return (
        root.className.includes(CARET_CLASS) &&
        root.style.getPropertyValue("--streamdown-caret") !== ""
      );
    }

    it("arms the caret on the last block while streaming", () => {
      const prose = proseOf(renderProse("正文", "streaming"));
      expect(caretArmed(prose)).toBe(true);
      // The library writes the glyph as a quoted CSS content value.
      expect(prose.style.getPropertyValue("--streamdown-caret")).toBe("\" ▋\"");
    });

    it("hides the caret while the last block is an unclosed fence", () => {
      const prose = proseOf(renderProse("```python\nprint(1)", "streaming"));
      expect(caretArmed(prose)).toBe(false);
    });

    it("leaves no caret on the settled side", () => {
      const prose = proseOf(renderProse("正文"));
      expect(caretArmed(prose)).toBe(false);
    });
  });

  describe("settled/streaming parity (issue #1128)", () => {
    // The library's mode prop is never forwarded, so its "streaming"
    // default holds on both sides and the remend pass repairs half-open
    // markers identically (measured, not assumed). That is the settle-swap
    // guarantee in its strongest form (ADR-0103): whatever streamed
    // completes identically once settled, so the swap can never flash a
    // different shape.
    it("renders the same half-open marker identically on both sides", () => {
      const settled = renderProse("开头 **加粗");
      const streaming = render(withIntl(<RoundProse text="开头 **加粗" mode="streaming" />));
      expect(streaming.container.querySelector("p")?.outerHTML).toBe(
        settled.container.querySelector("p")?.outerHTML,
      );
      expect(settled.container.querySelector("strong")).not.toBeNull();
    });

    it("renders complete text with bare tildes identically on both sides", () => {
      // The spec's discriminating shape (issue #1128): a complete text must
      // carry the same markup once settled as while streaming.
      const text = "样本 20~25 与 30~40 各取一点";
      const settled = renderProse(text);
      const streaming = render(withIntl(<RoundProse text={text} mode="streaming" />));
      expect(streaming.container.querySelector("p")?.outerHTML).toBe(
        settled.container.querySelector("p")?.outerHTML,
      );
      expect(settled.container.textContent).toContain("20~25");
    });

    it("renders an unparseable link as its bare label, never internal protocol noise", () => {
      // Both modes leave the library's `streamdown:incomplete-link`
      // placeholder href on the degrade lane; the label-only span keeps the
      // internal protocol string off the visible surface.
      const view = renderProse("开头 [链接](https://example.com");
      expect(screen.getByText("链接")).toBeInTheDocument();
      expect(view.container.querySelector("a")).toBeNull();
      expect(proseOf(view).textContent).not.toContain("streamdown:");
    });
  });
});

describe("RoundProse viz stage link (issue #1093)", () => {
  // The fence body IS the stage identity: the handler receives the raw text
  // and the mirror keys on it, so a same-body twin lights with the original.
  const BODY = "{\"mark\": \"bar\"}";
  const FENCE = "```vega-lite\n" + BODY + "\n```";

  function renderLinked(ui: ReactElement) {
    return render(withIntl(ui));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires the settled fence's chart-body click to the stage handler", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const onSelectViz = vi.fn();
    renderLinked(<RoundProse text={FENCE} onSelectViz={onSelectViz} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "在结果页查看图表" }));
    expect(onSelectViz).toHaveBeenCalledTimes(1);
    expect(onSelectViz).toHaveBeenCalledWith(BODY);
  });

  it("lights every fence sharing the staged body (same-spec identity)", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderLinked(
      <RoundProse
        text={FENCE + "\n\n" + FENCE}
        onSelectViz={vi.fn()}
        selectedVizSpec={BODY}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    const mirrors = screen.getAllByRole("button", { name: "在结果页查看图表" });
    expect(mirrors).toHaveLength(2);
    for (const mirror of mirrors) {
      expect(mirror).toHaveAttribute("aria-current", "true");
    }
  });

  it("keeps the live placeholder static even when a handler is wired", () => {
    // The live side never parses (ADR-0120 Decision 4), so there is no chart
    // body to click -- the link exists for the settled side only.
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderLinked(<RoundProse text={FENCE} mode="streaming" onSelectViz={vi.fn()} />);
    expect(embed).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "在结果页查看图表" }),
    ).not.toBeInTheDocument();
  });
});
