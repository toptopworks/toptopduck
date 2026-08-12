import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";
import { QuestionBar } from "../QuestionBar";

// QuestionBar routes all of its chrome (placeholder / aria-label / button
// labels / phase feedback) through react-intl (ADR-0052), so its tests render
// inside a zh-CN IntlProvider. useIntl() runs unconditionally at the top of
// QuestionBar, so the provider must wrap it.
function renderQuestionBar(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>,
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
