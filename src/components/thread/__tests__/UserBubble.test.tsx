// Issue #993 render pins for the user-invocation chips; the markup rationale
// (phrasing-content list roles, strike isolation, the bare bubble's stable
// shape) lives on the component. The bare (no-invocation) bubble keeps the
// exact pre-#993 markup: the question element IS the bubble.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { UserBubble } from "../UserBubble";

function renderBubble(props: { isStale?: boolean; invokedSkills?: string[] }) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <UserBubble
          question="怎么跑这个查询"
          askedAt={0}
          isStale={props.isStale ?? false}
          invokedSkills={props.invokedSkills ?? []}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
}

function renderQuestion(
  question: string,
  props: { isStale?: boolean } = {},
) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <UserBubble question={question} askedAt={0} isStale={props.isStale ?? false} />
      </TooltipProvider>
    </IntlProvider>,
  );
}

describe("UserBubble invocation chips (issue #993)", () => {
  it("renders no chip shell when nothing was invoked", () => {
    const { container } = renderBubble({});
    const q = container.querySelector(".turn-question");
    expect(q).not.toBeNull();
    // The bare bubble keeps the pre-#993 contract: the question element IS
    // the bubble and its text is the verbatim question alone.
    expect(q!.textContent).toBe("怎么跑这个查询");
    expect(container.querySelector("[role=\"list\"]")).toBeNull();
  });

  it("flows the chips inside the bubble box ahead of the question text", () => {
    const { container } = renderBubble({ invokedSkills: ["sql-coach", "chart-kit"] });
    const q = container.querySelector(".turn-question");
    expect(q).not.toBeNull();
    const list = q!.querySelector("[role=\"list\"]");
    expect(list).not.toBeNull();
    // Inside the bubble element itself (the pre-#993 face hosted the list as
    // a sibling row above the bubble).
    expect(list!.parentElement).toBe(q);
    // Chips read before the question does, and the composition is
    // byte-exact: chips, then the literal word-gap space (the declared
    // wrap point), then the question.
    expect(q!.firstElementChild).toBe(list);
    expect(q!.textContent).toBe("sql-coachchart-kit 怎么跑这个查询");
  });

  it("wears the quiet muted pill face behind an aria-hidden Puzzle", () => {
    const { container } = renderBubble({ invokedSkills: ["sql-coach"] });
    const items = container.querySelectorAll("[role=\"listitem\"]");
    expect(items).toHaveLength(1);
    // The reference-aligned recalibration: the chip wears the composer
    // chips' ground-relative transit pill (metadata surface, not a
    // highlighted fragment).
    const classes = items[0].className.split(/\s+/);
    expect(classes).toContain("bg-chip-surface");
    expect(classes).toContain("rounded-md");
    expect(classes).toContain("text-secondary-foreground");
    const icon = items[0].querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(classes).toContain("font-medium");
    // The item margin retired into the question element's arbitrary
    // variant (one spacing carrier for both chip species).
    const q = container.querySelector(".turn-question");
    expect(q!.className).toContain("[&_[role=listitem]]:mr-1");
    const name = items[0].querySelector("span:not([aria-hidden])");
    expect(name!.textContent).toBe("sql-coach");
  });

  it("keeps the accessible group label on the chip list", () => {
    const { container } = renderBubble({ invokedSkills: ["sql-coach"] });
    const list = container.querySelector("[role=\"list\"]");
    expect(list).toHaveAttribute("aria-label", "随此消息调用的技能");
  });

  it("strikes only the question on a stale turn; the chips stay unstruck", () => {
    const { container } = renderBubble({
      invokedSkills: ["sql-coach"],
      isStale: true,
    });
    const q = container.querySelector(".turn-question");
    expect(q).not.toBeNull();
    // The bubble element itself carries no strike; the decoration is
    // scoped to the question span.
    expect(q!.className.split(/\s+/)).not.toContain("line-through");
    const struck = q!.querySelector(".line-through");
    expect(struck).not.toBeNull();
    expect(struck!.className.split(/\s+/)).toContain("decoration-dotted");
    expect(struck!.textContent).toBe("怎么跑这个查询");
    const list = q!.querySelector("[role=\"list\"]");
    expect(list!.className.split(/\s+/)).not.toContain("line-through");
  });

  it("keeps the bare-shape strike on the bubble element itself", () => {
    const { container } = renderBubble({ isStale: true });
    const q = container.querySelector(".turn-question");
    expect(q!.className.split(/\s+/)).toContain("line-through");
    expect(q!.className.split(/\s+/)).toContain("decoration-dotted");
    expect(q!.textContent).toBe("怎么跑这个查询");
  });
});

describe("UserBubble quote chips (#1573)", () => {
  const QUOTE = "宁德时代300750-估值报";
  const DRAFT = "加一张同业 PB-ROE 散点图";
  const QUOTED_QUESTION = `> ${QUOTE}\n\n${DRAFT}`;

  it("renders the materialized quote as a chip ahead of the draft", () => {
    const { container } = renderQuestion(QUOTED_QUESTION);
    const q = container.querySelector(".turn-question");
    expect(q).not.toBeNull();
    // The submit materialization parses back into the composer chip face:
    // the excerpt chip rides the quote list, the full blockquote markers
    // never surface as bubble text.
    expect(screen.getByLabelText("引用的段落")).toBeInTheDocument();
    expect(screen.getByText("宁德时代3007…")).toBeInTheDocument();
    expect(screen.getByText(DRAFT)).toBeInTheDocument();
    expect(q!.textContent).toBe("宁德时代3007… 加一张同业 PB-ROE 散点图");
  });

  it("renders one chip per materialized quote", () => {
    const { container } = renderQuestion("> 甲\n\n> 乙\n\n正文");
    expect(container.querySelectorAll("[role=\"listitem\"]")).toHaveLength(2);
    expect(screen.getByText("正文")).toBeInTheDocument();
  });

  it("renders a quotes-only question without a draft tail", () => {
    const { container } = renderQuestion("> 只有引用");
    const q = container.querySelector(".turn-question");
    expect(q!.textContent).toBe("只有引用");
  });

  it("scopes the stale strike to the draft; the chips stay unstruck", () => {
    const { container } = renderQuestion(QUOTED_QUESTION, { isStale: true });
    const q = container.querySelector(".turn-question");
    expect(q!.className.split(/\s+/)).not.toContain("line-through");
    const struck = q!.querySelector(".line-through");
    expect(struck).not.toBeNull();
    expect(struck!.textContent).toBe(DRAFT);
    expect(struck!.className.split(/\s+/)).toContain("decoration-dotted");
    const list = container.querySelector("[role=\"list\"]");
    expect(list!.className.split(/\s+/)).not.toContain("line-through");
  });
});
