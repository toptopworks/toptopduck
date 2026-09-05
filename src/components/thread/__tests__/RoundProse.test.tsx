import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
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

// The prose rides the thread's chrome (ADR-0052 react-intl + Radix Tooltip
// for the code block's CopyButton) -- wrap it the way the thread does.
function renderProse(text: string) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <RoundProse text={text} />
      </TooltipProvider>
    </IntlProvider>,
  );
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

  it("carries the conversation tier on its own root", () => {
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
    // answers run long (issue #828). The negative guard keeps the compact
    // chrome override from sneaking back alongside it.
    expect(classes).toContain("leading-[1.75]");
    expect(classes).not.toContain("leading-snug");
  });

  describe("structure", () => {
    it("leaves block-level children bare so the root's space-y owns block spacing", () => {
      // Tailwind v4's space-y selector sits inside :where() (zero
      // specificity), so a child's own m-0 (0,1,0) always outranks it -- m-0
      // on the mapped blocks killed the root's 16px inter-block rhythm
      // entirely (paragraphs and headings rendered flush on real hardware).
      // The map carries no margin classes; the preflight reset already
      // zeroes the nested contexts the root's space-y never reaches (issue
      // #828).
      const ui = renderProse("# 标题\n\n段落一\n\n> 引用\n\n- 列表项");
      expect(proseOf(ui).className.split(/\s+/)).toContain("space-y-4");
      for (const tag of ["h1", "p", "blockquote", "ul"]) {
        const classes = (ui.container.querySelector(tag)?.className ?? "").split(/\s+/);
        expect(classes).not.toContain("m-0");
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

    it("renders a GFM pipe table in a scroll container with hairline borders", () => {
      const { container } = renderProse("| 列 | 值 |\n| --- | --- |\n| a | 1 |");
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "列" })).toBeInTheDocument();
      expect(screen.getByRole("cell", { name: "a" })).toBeInTheDocument();
      const wrapper = container.querySelector(".round-text > div");
      expect(wrapper?.className).toContain("overflow-x-auto");
      expect(wrapper?.className).toContain("border-border");
      expect(container.querySelector("th")?.className).toContain("border-border");
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
      ["javascript:alert(1)", "小写 javascript:"],
      ["JAVASCRIPT:alert(1)", "大写 JAVASCRIPT:"],
      ["data:text/html,<script>alert(1)</script>", "data:"],
      ["vbscript:MsgBox(1)", "vbscript:"],
    ])("does not turn a %s link into a clickable anchor (%s)", (url) => {
      const { container } = renderProse(`[点我](${url})`);
      expect(container.querySelector("a")).toBeNull();
      expect(screen.getByText("点我")).toBeInTheDocument();
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

    it("degrades file links to plain text without the target", () => {
      const { container } = renderProse("[本地](file:///C:/data/x.csv)");
      expect(container.querySelector("a")).toBeNull();
      // file: is outside the default urlTransform's allowlist, so the href
      // is stripped before the component sees it -- only the label remains.
      expect(screen.getByText("本地")).toBeInTheDocument();
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
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <RoundProse text={"```python\nprint(1)\nprint(2)\n```"} />
          </TooltipProvider>
        </IntlProvider>,
      );
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
      expect(view.container.querySelector("pre")?.textContent).toContain("print(2)");
    });
  });
});
