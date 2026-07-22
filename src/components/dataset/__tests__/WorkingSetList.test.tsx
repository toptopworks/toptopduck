import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { WorkingSetList } from "../WorkingSetList";
import type { DatasetDescriptor, StaleReason } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";

// WorkingSetList's replace action opens the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";

describe("WorkingSetList", () => {
  // window.prompt spies must not leak between tests (jsdom default returns null).
  afterEach(() => vi.restoreAllMocks());

  it("lists datasets and marks the active one", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    // The select button's accessible name starts with the display label; the
    // rename sibling's starts with "重命名" -- anchor on the leading label so
    // the two buttons never collide on a /people/ substring match.
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
    expect(screen.getByText(/当前表/)).toBeInTheDocument();
  });

  it("lifts the active select button via bg-accent + font-semibold (ADR-0067, issue #184)", () => {
    // The active STATE drives the select button's own conditional className
    // (cn(BUTTON_BASE, isActive && "bg-accent font-semibold")), replacing the
    // retired .working-set li.active button descendant selector. The 当前表
    // suffix is driven by a separate conditional, so it does NOT pin the
    // className branch -- this assertion does. An inactive row carries neither
    // class.
    const { rerender } = renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const activeClasses = screen.getByRole("button", { name: /^people/ }).className.split(/\s+/);
    expect(activeClasses).toContain("bg-accent");
    expect(activeClasses).toContain("font-semibold");

    rerender(
      withIntl(
        <WorkingSetList
          datasets={[mockDataset]}
          activeName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    const inactiveClasses = screen.getByRole("button", { name: /^people/ }).className.split(/\s+/);
    expect(inactiveClasses).not.toContain("bg-accent");
    expect(inactiveClasses).not.toContain("font-semibold");
  });

  it("shows an empty hint when there are no datasets", () => {
    renderI18n(
      <WorkingSetList datasets={[]} activeName={null} onSelect={() => {}} onRename={() => {}} />,
    );
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
  });

  it("renames a dataset's display label via prompt (ADR-0037, issue #8)", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    // Carries the stable reference name + the new display label; the reference
    // name is what the parent keys selection off, so it survives the rename.
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
  });

  it("ignores an empty, cancelled, or no-change rename prompt", () => {
    const onRename = vi.fn();
    const promptSpy = vi.spyOn(window, "prompt");
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    const renameBtn = screen.getByRole("button", { name: /重命名/ });
    // Cancel (null), empty string, and a no-change answer all count as "no
    // rename" -- onRename must never fire. One render, repeated clicks, so the
    // queries don't accumulate across renders.
    for (const answer of [null, "", mockDataset.display_name]) {
      onRename.mockClear();
      promptSpy.mockReturnValue(answer);
      fireEvent.click(renameBtn);
      expect(onRename).not.toHaveBeenCalled();
    }
  });

  it("trims surrounding whitespace before renaming", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("  员工表  ");
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    // trimmed before reaching the parent -> backend gets a clean label
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
  });

  it("ignores a whitespace-only rename prompt", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("disables the rename button while loading (prevents concurrent IPC)", () => {
    // A rename in flight locks the button: rapid double-clicks must not fire a
    // second IPC before the first settles (the backend would run its label-
    // collision check against stale state and reject a valid rename).
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /重命名/ })).toBeDisabled();
  });

  it("picks a file and replaces the dataset via onReplace (issue #11)", async () => {
    // AC4: replace is a distinct entry from add. The per-row button opens a
    // structured-file picker (no xlsx) and forwards the choice with the stable
    // reference name -- the name the backend takes over.
    const onReplace = vi.fn();
    vi.mocked(open).mockResolvedValue("/x/new.csv");
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /换源/ }));
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("people", "/x/new.csv"));
  });

  it("ignores a cancelled replace picker (issue #11)", async () => {
    const onReplace = vi.fn();
    vi.mocked(open).mockResolvedValue(null); // cancelled
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /换源/ }));
    await waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("disables the replace button while loading (issue #11)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /换源/ })).toBeDisabled();
  });

  it("deletes a dataset after a confirm, forwarding the stable reference name (issue #38)", () => {
    // The per-row delete button confirms, then forwards the reference name --
    // the identity the backend removes (not the display label).
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("people"));
    expect(onDelete).toHaveBeenCalledWith("people");
  });

  it("ignores a cancelled delete confirm (issue #38)", () => {
    // A no at the confirm gate never reaches the backend -- no IPC, no removal.
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("disables the delete button while loading (execution window, ADR-0040)", () => {
    // loading is true while any async op (incl. an in-flight turn) runs -- the
    // execution window disables source management so a mid-turn delete cannot
    // interleave with the query.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /删除/ })).toBeDisabled();
  });

  it("renders a stale badge whose verb follows the anchor reason (issue #41 AC4)", () => {
    // AC4: a stale result row carries a badge naming the invalidating source,
    // with "已删除" for a Deleted anchor and "已更新" for a Replaced anchor
    // (wording sourced from the workingSet.staleRow ICU select message; Thread's
    // chip uses its own i18n staleChipVerb, so the two surfaces do not share
    // wording -- issue #107 retired staleBadge.ts when the badge became a Badge).
    const stale: DatasetDescriptor = {
      ...mockDataset,
      reference_name: "result_1",
      display_name: "count",
      stale: {
        reference_name: "people",
        display_name: "员工表",
        reason: "Deleted" as const,
      },
    };
    renderI18n(
      <WorkingSetList
        datasets={[stale]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    expect(screen.getByText(/因「员工表」已删除而失效/)).toBeInTheDocument();
  });

  it("renders the row-count plural 'one' branch via the en defaultMessage (ADR-0052)", () => {
    // The zh-CN catalog collapses workingSet.rowCount to "{count} 行", so the
    // en {count, plural, ...} branches are reachable only via defaultMessage.
    // An empty English provider (the renderSettings pattern) routes FormattedMessage
    // to the canonical defaultMessage so the plural stays covered. The negative
    // assertion guards against a one/other swap or a stray "rows" in the one arm.
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <WorkingSetList
          datasets={[{ ...mockDataset, row_count: 1 }]}
          activeName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /1 row/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1 rows/ })).not.toBeInTheDocument();
  });

  it("renders the row-count plural 'other' branch via the en defaultMessage (ADR-0052)", () => {
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <WorkingSetList
          datasets={[{ ...mockDataset, row_count: 5 }]}
          activeName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /5 rows/ })).toBeInTheDocument();
  });

  it("renders the stale badge verb for a Replaced anchor (issue #41 AC4)", () => {
    // Pins the Replaced arm of the workingSet.staleRow ICU select (the Deleted
    // arm is covered above) so a regression that drops the arm renders empty;
    // mirrors the ResultView stale-verb coverage in the Thread suite.
    const stale: DatasetDescriptor = {
      ...mockDataset,
      reference_name: "result_1",
      display_name: "count",
      stale: {
        reference_name: "people",
        display_name: "员工表",
        reason: "Replaced" as const,
      },
    };
    renderI18n(
      <WorkingSetList
        datasets={[stale]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    expect(screen.getByText(/因「员工表」已更新而失效/)).toBeInTheDocument();
  });

  it("exhausts every StaleReason variant in the workingSet.staleRow select (ADR-0041)", () => {
    // Compile-time guard: the workingSet.staleRow ICU {reason, select} must name
    // every StaleReason variant as an arm. Adding a variant without extending
    // this map fails tsc (mirrors Thread.tsx staleChipVerb's never-guard), so the
    // select's `other` arm stays unreachable instead of silently masking a new case.
    const arms: Record<StaleReason, true> = {
      Deleted: true,
      Replaced: true,
    };
    expect(Object.keys(arms).sort()).toEqual(["Deleted", "Replaced"]);
  });
});
