import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";
import { listActivatedSkills, listSkills } from "../../../api";
import { ComposerSkillChips } from "../ComposerSkillChips";
import { QuestionBar } from "../QuestionBar";
import type { SkillEntry } from "../../../types/skills";

// QuestionBar routes all of its chrome (placeholder / aria-label / button
// labels / phase feedback) through react-intl (ADR-0052), so its tests render
// inside a zh-CN IntlProvider. useIntl() runs unconditionally at the top of
// QuestionBar, so the provider must wrap it. The skill picker (ADR-0112)
// rides useQuery, so every render also needs a QueryClientProvider.
function renderQuestionBar(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        {ui}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function skill(name: string): SkillEntry {
  return {
    name,
    description: `${name} skill`,
    acquired: "local",
    license: null,
    compatibility: null,
    mcp_servers: [],
    cli_tools: [],
    body: "",
    link_target: null,
    content_hash: "ab".repeat(32),
  };
}

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    listActivatedSkills: vi.fn(),
  };
});

describe("QuestionBar (issue #28 single in-flight + cancel)", () => {
  it("submits the trimmed question and disables submit on empty", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "  几行  " } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(onSubmit).toHaveBeenCalledWith("几行");
    // The submit button is the sole action when idle (no 停止 button rendered).
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("disables the input and shows 停止 instead of 提问 while loading (ADR-0021)", () => {
    // Single in-flight: while a turn runs the input is disabled and the only
    // action is cancel -- the user cannot start a second concurrent turn.
    const onCancel = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={() => {}} onCancel={onCancel} loading={true} />);
    expect(screen.getByLabelText("提问")).toBeDisabled();
    // Submit is replaced by the stop button; clicking it fires cancel.
    expect(screen.queryByRole("button", { name: "提问" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not submit when the value is blank", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    // The submit button is disabled for a blank question, so a form submit (e.g.
    // via Enter on an empty input) cannot fire a turn.
    expect(screen.getByRole("button", { name: "提问" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "提问" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("QuestionBar keyboard submit (Enter / Shift+Enter / IME)", () => {
  it("submits on Enter with a non-empty value and prevents the newline", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    const textarea = screen.getByRole("textbox", { name: "提问" });
    fireEvent.change(textarea, { target: { value: "几行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    // onSubmit firing proves preventDefault ran (it is called before submit()
    // inside the same guard block; without it the form would also fire submit).
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("几行");
  });

  it("does not submit on Shift+Enter (newline insertion)", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    const textarea = screen.getByRole("textbox", { name: "提问" });
    fireEvent.change(textarea, { target: { value: "几行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on Enter while the value is blank", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    const textarea = screen.getByRole("textbox", { name: "提问" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on Enter during IME composition (isComposing)", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    const textarea = screen.getByRole("textbox", { name: "提问" });
    fireEvent.change(textarea, { target: { value: "zong" } });
    // CJK IME: Enter confirms the composition -- isComposing is true on
    // this keydown, so the guard must bail out without submitting.
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("QuestionBar controlled draft mode (ADR-0092)", () => {
  it("renders the controlled draft and routes edits to setDraft", () => {
    const setDraft = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        draft="prefilled"
        setDraft={setDraft}
      />,
    );
    const textarea = screen.getByLabelText("提问");
    // The controlled value renders instead of the local fallback.
    expect(textarea).toHaveValue("prefilled");
    // Typing calls the controlled setter, not a local one.
    fireEvent.change(textarea, { target: { value: "edited" } });
    expect(setDraft).toHaveBeenCalledWith("edited");
  });
});

describe("QuestionBar header slot", () => {
  it("renders header controls in the container without wiring them into submit", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={onSubmit}
        onCancel={() => {}}
        loading={false}
        header={<button type="button">技能 (0/0)</button>}
      />,
    );
    // The header control rides the container's top row (the Skills / MCP
    // trigger chips in the real app).
    const chip = screen.getByRole("button", { name: "技能 (0/0)" });
    expect(chip).toBeInTheDocument();
    // A header button click never submits the question form (the real
    // triggers are type="button" popover openers).
    fireEvent.click(chip);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("QuestionBar pre-activation chips (ADR-0112, issue #716)", () => {
  it("seats the chips inline in the input area, sharing the textarea's row", () => {
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        chips={<ComposerSkillChips names={["charting"]} />}
      />,
    );
    // The chip list is display:contents inside the input-area row: it shares
    // its flex-wrap container with the textarea (a header chip row would
    // fail this), so the chips wrap inline and the caret seats right after
    // the last one.
    const textarea = screen.getByLabelText("提问");
    expect(
      screen.getByRole("list", { name: "预激活技能" }).parentElement,
    ).toBe(textarea.parentElement);
    expect(screen.getByRole("listitem")).toHaveTextContent("charting");
  });

  it("Backspace at the draft start withdraws the last chip like a text char", () => {
    const onChipBackspace = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        chips={<ComposerSkillChips names={["charting"]} />}
        onChipBackspace={onChipBackspace}
      />,
    );
    // Empty draft: the caret sits at 0, so Backspace deletes the last chip.
    fireEvent.keyDown(screen.getByLabelText("提问"), { key: "Backspace" });
    expect(onChipBackspace).toHaveBeenCalledOnce();
  });

  it("Backspace inside the draft deletes text, not chips", () => {
    const onChipBackspace = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        onChipBackspace={onChipBackspace}
      />,
    );
    const textarea = screen.getByLabelText("提问");
    fireEvent.change(textarea, { target: { value: "hi", selectionStart: 2 } });
    fireEvent.keyDown(textarea, { key: "Backspace" });
    expect(onChipBackspace).not.toHaveBeenCalled();
  });

  it("Backspace with a selection deletes the selection, not chips", () => {
    const onChipBackspace = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        onChipBackspace={onChipBackspace}
      />,
    );
    const textarea = screen.getByLabelText("提问");
    fireEvent.change(textarea, {
      target: { value: "hi", selectionStart: 0, selectionEnd: 2 },
    });
    fireEvent.keyDown(textarea, { key: "Backspace" });
    expect(onChipBackspace).not.toHaveBeenCalled();
  });
});

describe("QuestionBar skill picker (ADR-0112, issue #716)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [skill("charting"), skill("data-cleaning")],
      ignored: [],
      root_error: null,
    });
    vi.mocked(listActivatedSkills).mockResolvedValue([]);
  });

  /** Type into the (uncontrolled) textarea; selectionStart defaults to the
   *  typed value's length, mirroring real caret placement. */
  function type(text: string) {
    const textarea = screen.getByLabelText("提问");
    fireEvent.change(textarea, {
      target: { value: text, selectionStart: text.length },
    });
    return textarea;
  }

  function key(textarea: HTMLElement, k: string) {
    fireEvent.keyDown(textarea, { key: k });
  }

  it("opens the grouped panel on a line-start / and filters as the query types", async () => {
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    type("/");
    await screen.findAllByRole("option");
    // "/" is the global panel: the group header renders above the list.
    expect(screen.getByText("技能")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    type("/cle");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("data-cleaning");
  });

  it("opens the flat skills-direct panel on $ (no group header)", async () => {
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick: () => {} }}
      />,
    );
    type("$");
    await screen.findAllByRole("option");
    expect(screen.queryByText("技能")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("does not open on a mid-line trigger char", () => {
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick: () => {} }}
      />,
    );
    type("hi /");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter selects the highlighted row: consumes the span, reports the pick, never submits", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={onSubmit}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    const textarea = type("/");
    await screen.findAllByRole("option");
    // ↓ moves to the second row (clamped movement), Enter picks it.
    key(textarea, "ArrowDown");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("data-cleaning");
    expect(onSubmit).not.toHaveBeenCalled();
    // The trigger char + query left the draft with the selection.
    expect(textarea).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("↑ clamps at the top (never wraps)", async () => {
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    const textarea = type("/");
    await screen.findAllByRole("option");
    key(textarea, "ArrowUp");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledWith("charting");
  });

  it("Esc closes the panel, keeps the trigger + query as plain text; Enter then submits it", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={onSubmit}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    // The trigger opens the panel as its own keystroke; the query then types
    // into the open panel's filter.
    const textarea = type("/");
    await screen.findAllByRole("option");
    type("/ch");
    key(textarea, "Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/ch");
    expect(onPick).not.toHaveBeenCalled();
    // After Esc the bar is a plain composer again: Enter submits the text.
    key(textarea, "Enter");
    expect(onSubmit).toHaveBeenCalledWith("/ch");
  });

  it("Enter is a no-op on the no-match face (no pick, no submit)", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={onSubmit}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    const textarea = type("/");
    await screen.findAllByRole("option");
    type("/zzz");
    await screen.findByText("没有匹配的技能。");
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/zzz");
  });

  it("re-opens for a repeated selection after one closes", async () => {
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    const textarea = type("/");
    await screen.findAllByRole("option");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledWith("charting");
    type("/");
    await screen.findAllByRole("option");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("selects an already-activated skill identically and shows its Active badge", async () => {
    // The activated cache is DISPLAY data: it renders the badge but never
    // gates selection -- an already-activated pick lands a chip like any
    // other (the submit-time materialization absorbs the redundancy).
    vi.mocked(listActivatedSkills).mockResolvedValue(["charting"]);
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: "sess-1", onPick }}
      />,
    );
    const textarea = type("/");
    const rows = await screen.findAllByRole("option");
    expect(rows[0]).toHaveTextContent("已激活");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledWith("charting");
  });

  it("keeps rows whose description matches and highlights the hit", async () => {
    // Neither name contains "skill"; both descriptions do ("… skill"), so a
    // description-only query keeps both rows -- and the hit renders as its
    // own foreground span inside the muted description.
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick: () => {} }}
      />,
    );
    type("/");
    type("/skill");
    const rows = await screen.findAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("skill")).toBeInTheDocument();
    expect(within(rows[1]).getByText("skill")).toBeInTheDocument();
  });

  it("blur closes the panel, keeping the span as plain text", async () => {
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick: () => {} }}
      />,
    );
    const textarea = type("/");
    await screen.findAllByRole("option");
    // Blur closes without touching the draft; a re-focus does not reopen --
    // the span is plain text until a fresh trigger char opens the panel.
    fireEvent.blur(textarea);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/");
    fireEvent.focus(textarea);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows a provenance badge on every row (personal vs built-in)", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [
        skill("charting"),
        { ...skill("data-cleaning"), acquired: "builtin" },
      ],
      ignored: [],
      root_error: null,
    });
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick: () => {} }}
      />,
    );
    type("/");
    const rows = await screen.findAllByRole("option");
    expect(within(rows[0]).getByText("个人")).toBeInTheDocument();
    expect(within(rows[1]).getByText("系统")).toBeInTheDocument();
  });

  it("renders the empty-registry face and Enter stays a no-op", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [],
      ignored: [],
      root_error: null,
    });
    const onPick = vi.fn();
    renderQuestionBar(
      <QuestionBar
        onSubmit={() => {}}
        onCancel={() => {}}
        loading={false}
        skillPicker={{ sessionId: null, onPick }}
      />,
    );
    const textarea = type("/");
    await screen.findByText("暂无技能");
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
  });
});
