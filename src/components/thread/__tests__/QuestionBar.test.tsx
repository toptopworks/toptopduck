import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
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

/** Render the bar with the skill picker channel on -- the single
 *  boilerplate point for the picker props (issue #718), including the
 *  required chips bundle (its stub absorbs what the scenario doesn't
 *  exercise). */
function renderPicker(
  onPick: (name: string) => void,
  opts: {
    sessionId?: string | null;
    onSubmit?: (question: string) => void;
    chips?: ReactNode;
    onChipBackspace?: () => void;
  } = {},
) {
  return renderQuestionBar(
    <QuestionBar
      onSubmit={opts.onSubmit ?? (() => {})}
      onCancel={() => {}}
      loading={false}
      skillPicker={{
        sessionId: opts.sessionId ?? null,
        onPick,
        chips: {
          node: opts.chips,
          onBackspace: opts.onChipBackspace ?? (() => {}),
        },
      }}
    />,
  );
}

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
    renderPicker(() => {}, { chips: <ComposerSkillChips names={["charting"]} /> });
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
    renderPicker(() => {}, {
      chips: <ComposerSkillChips names={["charting"]} />,
      onChipBackspace,
    });
    // Empty draft: the caret sits at 0, so Backspace deletes the last chip.
    fireEvent.keyDown(screen.getByLabelText("提问"), { key: "Backspace" });
    expect(onChipBackspace).toHaveBeenCalledOnce();
  });

  it("Backspace inside the draft deletes text, not chips", () => {
    const onChipBackspace = vi.fn();
    renderPicker(() => {}, { onChipBackspace });
    const textarea = screen.getByLabelText("提问");
    fireEvent.change(textarea, { target: { value: "hi", selectionStart: 2 } });
    fireEvent.keyDown(textarea, { key: "Backspace" });
    expect(onChipBackspace).not.toHaveBeenCalled();
  });

  it("Backspace with a selection deletes the selection, not chips", () => {
    const onChipBackspace = vi.fn();
    renderPicker(() => {}, { onChipBackspace });
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
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("提问");
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
    renderPicker(onPick);
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
    renderPicker(() => {});
    type("$");
    await screen.findAllByRole("option");
    expect(screen.queryByText("技能")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("does not open on a mid-line trigger char", () => {
    renderPicker(() => {});
    type("hi /");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter selects the highlighted row: consumes the span, reports the pick, never submits", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderPicker(onPick, { onSubmit });
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
    renderPicker(onPick);
    const textarea = type("/");
    await screen.findAllByRole("option");
    key(textarea, "ArrowUp");
    key(textarea, "Enter");
    expect(onPick).toHaveBeenCalledWith("charting");
  });

  it("Esc closes the panel, keeps the trigger + query as plain text; Enter then submits it", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderPicker(onPick, { onSubmit });
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

  it("a submit while the panel is open closes it and submits the span as plain text (issue #718)", async () => {
    // The submit button click is the explicit turn boundary: the panel
    // closes FIRST and the trigger char + query ride along as plain text --
    // the same semantics Esc established, pinned here on the click path the
    // Esc test only covers indirectly.
    const onSubmit = vi.fn();
    renderPicker(() => {}, { onSubmit });
    const textarea = type("/");
    await screen.findAllByRole("option");
    type("/ch");
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(onSubmit).toHaveBeenCalledWith("/ch");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/ch");
  });

  it("Enter is a no-op on the no-match face (no pick, no submit)", async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    renderPicker(onPick, { onSubmit });
    const textarea = type("/");
    await screen.findAllByRole("option");
    type("/zzz");
    await screen.findByText("没有匹配的技能。");
    // The null-highlight derivation (issue #718): an open panel over an
    // empty filtered list names NO active option -- the sentinel itself
    // guards aria-activedescendant -- and the arrow keys are consumed
    // no-ops (nothing to move; the clamp's precondition is a non-empty
    // list). This is the component-level pin of the retired "empty list
    // pins 0" clamp contract.
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    key(textarea, "ArrowDown");
    key(textarea, "ArrowUp");
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/zzz");
    // Recovery: shrinking the query back to a match must land on a legal
    // row -- the empty-face arrows above must also leave the STORED
    // highlight untouched (an unguarded run would corrode it negative and
    // this assert would name a dangling option id).
    type("/ch");
    await screen.findAllByRole("option");
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "question-bar-skill-picker-option-0",
    );
  });

  it("re-opens for a repeated selection after one closes", async () => {
    const onPick = vi.fn();
    renderPicker(onPick);
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
    renderPicker(onPick, { sessionId: "sess-1" });
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
    renderPicker(() => {});
    type("/");
    type("/skill");
    const rows = await screen.findAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("skill")).toBeInTheDocument();
    expect(within(rows[1]).getByText("skill")).toBeInTheDocument();
  });

  it("blur closes the panel, keeping the span as plain text", async () => {
    renderPicker(() => {});
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
    renderPicker(() => {});
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
    const onSubmit = vi.fn();
    renderPicker(onPick, { onSubmit });
    const textarea = type("/");
    await screen.findByText("暂无技能");
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    // Enter on the empty face neither picks nor submits -- the draft keeps
    // the trigger span.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/");
  });

  it("closes without picking when the caret moved past the span (no change event)", async () => {
    // "hello" + Home + "/" + "c" opens the panel (trigger 0, query "c",
    // span [0, 2)); clicking at the END of "/chello" moves the caret to 7
    // with NO change event -- the stored span stays [0, 2), and the removal
    // the old code bounded by the live caret would eat "hello" with it.
    const onPick = vi.fn();
    renderPicker(onPick);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("提问");
    fireEvent.change(textarea, {
      target: { value: "/hello", selectionStart: 1 },
    });
    fireEvent.change(textarea, {
      target: { value: "/chello", selectionStart: 2 },
    });
    await screen.findAllByRole("option");
    textarea.setSelectionRange(7, 7);
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/chello");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes without picking when the caret moved before the trigger (no change event)", async () => {
    // "hi\n/cha" with the panel open on the second line's "/" (trigger 3,
    // query "cha"); a click inside "hi" moves the caret to 1 with no change
    // event -- the old removal bounded by that caret would duplicate "hi\n".
    const onPick = vi.fn();
    renderPicker(onPick);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("提问");
    fireEvent.change(textarea, {
      target: { value: "hi\n/", selectionStart: 4 },
    });
    fireEvent.change(textarea, {
      target: { value: "hi\n/cha", selectionStart: 7 },
    });
    await screen.findAllByRole("option");
    textarea.setSelectionRange(1, 1);
    key(textarea, "Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("hi\n/cha");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("an open panel suppresses the chip Backspace withdrawal at caret 0", async () => {
    // Caret 0 while the panel is open is outside the span -- the pick flow
    // owns the keys, and the chips only withdraw once the panel is closed.
    const onChipBackspace = vi.fn();
    renderPicker(() => {}, { onChipBackspace });
    const textarea = type("/");
    await screen.findByRole("listbox");
    textarea.setSelectionRange(0, 0);
    key(textarea, "Backspace");
    expect(onChipBackspace).not.toHaveBeenCalled();
    key(textarea, "Escape");
    key(textarea, "Backspace");
    expect(onChipBackspace).toHaveBeenCalledTimes(1);
  });

  it("carries the combobox semantics on the textarea while the panel is open", async () => {
    renderPicker(() => {});
    const textarea = screen.getByLabelText("提问");
    // Closed: a plain textbox, no role override.
    expect(textarea).not.toHaveAttribute("role");
    type("/");
    await screen.findAllByRole("option");
    // Open: the ARIA combobox pattern -- focus stays in the textarea, so
    // the active-option hand-off rides aria-activedescendant HERE (AT
    // tracks only the focused element's), never on the listbox.
    expect(textarea).toHaveAttribute("role", "combobox");
    expect(textarea).toHaveAttribute("aria-expanded", "true");
    expect(textarea).toHaveAttribute("aria-controls", "question-bar-skill-picker");
    expect(textarea).toHaveAttribute("aria-haspopup", "listbox");
    expect(textarea).toHaveAttribute("aria-autocomplete", "list");
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "question-bar-skill-picker-option-0",
    );
    expect(screen.getByRole("listbox")).not.toHaveAttribute(
      "aria-activedescendant",
    );
    key(textarea, "ArrowDown");
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "question-bar-skill-picker-option-1",
    );
    // Bottom clamp: the second ArrowDown on a two-row list stays on the
    // last row (never wrapping).
    key(textarea, "ArrowDown");
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "question-bar-skill-picker-option-1",
    );
  });

  it("renders the listing error row instead of the empty face when the fetch fails", async () => {
    vi.mocked(listSkills).mockRejectedValue(new Error("ipc down"));
    renderPicker(() => {});
    type("/");
    // A failed fetch is a fault, not an empty registry: the error row
    // replaces the "No skills" face.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("暂无技能")).not.toBeInTheDocument();
  });
});
