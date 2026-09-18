// Issue #993: the user-invocation badge face -- chips flow INLINE inside the
// bubble box ahead of the question text (no muted pill surface, no separate
// row above the bubble). The bubble element stays the semantic host: the
// list is phrasing content with list roles (a <ul> may not nest in a <p>),
// and the stale strike rides the question text alone (text-decoration
// propagates through inline descendants, so chips must sit outside it).
// The bare (no-invocation) bubble keeps the exact pre-#993 markup: the
// question element IS the bubble and carries the strike itself.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { UserBubble } from "../UserBubble";

function renderBubble(props: {
  question?: string;
  isStale?: boolean;
  invokedSkills?: string[];
}) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <UserBubble
          question={props.question ?? "怎么跑这个查询"}
          askedAt={0}
          isStale={props.isStale ?? false}
          invokedSkills={props.invokedSkills ?? []}
        />
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
    // Chips read before the question does.
    expect(q!.firstElementChild).toBe(list);
    expect(q!.textContent).toContain("sql-coach");
    expect(q!.textContent).toContain("chart-kit");
    expect(q!.textContent).toContain("怎么跑这个查询");
  });

  it("drops the pill face: accent-tinted names behind an aria-hidden Puzzle", () => {
    const { container } = renderBubble({ invokedSkills: ["sql-coach"] });
    const items = container.querySelectorAll("[role=\"listitem\"]");
    expect(items).toHaveLength(1);
    // No muted pill surface on the chip (the pre-#993 face was bg-muted).
    expect(items[0].className.split(/\s+/)).not.toContain("bg-muted");
    const icon = items[0].querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    const name = items[0].querySelector("span:not([aria-hidden])");
    expect(name!.className.split(/\s+/)).toContain("text-accent-foreground");
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
    // The bubble element itself carries no strike (the chips are inline
    // children and would inherit it).
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
