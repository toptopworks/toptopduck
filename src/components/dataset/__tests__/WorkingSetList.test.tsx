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
  // Spies must not leak between tests.
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
    // (cn(SELECT_BUTTON_BASE, isActive && "bg-accent font-semibold")), replacing the
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

  // --- Rename dialog (issue #759): the native window.prompt retired onto an
  // in-app Dialog + Input (ADR-0037 semantics unchanged -- display label only,
  // the reference name survives).

  it("opens the rename dialog with the current display name prefilled (issue #759)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/重命名显示名/);
    // The input starts from the current display label so an edit builds on it.
    expect(screen.getByRole("textbox")).toHaveValue(mockDataset.display_name);
  });

  it("submits a valid rename through the dialog and closes it (ADR-0037, issue #759)", () => {
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "员工表" } });
    // jsdom does not dispatch form submit on a submit-button click; drive the
    // form's submit event directly (the SessionSidebar rename-test pattern).
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    // Carries the stable reference name + the new display label; the reference
    // name is what the parent keys selection off, so it survives the rename.
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keys the rename off the reference name after the display label diverges (ADR-0037, issue #759)", () => {
    // After any rename the two names diverge; every fixture in the flows above
    // keeps them equal, so a swap of the two at the call site passes those
    // identically. A diverged fixture pins the backend identity: the callback
    // must carry the stable reference name, never the (old or new) label.
    const onRename = vi.fn();
    const diverged: DatasetDescriptor = { ...mockDataset, display_name: "员工表" };
    renderI18n(
      <WorkingSetList
        datasets={[diverged]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "人事表" } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onRename).toHaveBeenCalledWith("people", "人事表");
  });

  it("keeps Save disabled for a blank or whitespace-only draft (issue #759)", () => {
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    const save = screen.getByRole("button", { name: "保存" });
    for (const draft of ["", "   "]) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
      expect(save).toBeDisabled();
    }
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps Save disabled while the draft trims to the current display name (issue #759)", () => {
    // The dialog opens prefilled with the current name -> no change yet -> Save
    // disabled. A real edit re-enables it; walking the edit back to the
    // current name disables it again. This is the old prompt's no-change ignore
    // expressed as an un-submittable form.
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "员工表" } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  people  " } });
    expect(save).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before renaming (issue #759)", () => {
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  员工表  " } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    // trimmed before reaching the parent -> backend gets a clean label
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
  });

  it("cancels the rename dialog without firing onRename (issue #759)", () => {
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape closes the rename dialog without renaming and restores trigger focus (issue #759)", async () => {
    // Radix Dialog routes ESC through onOpenChange(false) -> cancel. The list
    // captures the opening trigger and re-focuses it on close (Radix's own
    // restore only targets a DialogTrigger ref), so the keyboard flow lands
    // back on the row's rename button.
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    const trigger = screen.getByRole("button", { name: /重命名/ });
    // fireEvent.click does not move focus in jsdom; focus first so Radix has a
    // previously-focused trigger to restore to (a real click would focus it).
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("falls back to focusing the list when Save's loading gate disables the trigger (issue #759)", async () => {
    // The submit fires onRename before closing, and the parent's mutation runs
    // setLoading(true) synchronously -- batched with the close into one commit,
    // so the deferred restore finds the row trigger disabled and focus() on a
    // disabled button is ignored. The restore must fall back to the list
    // container instead of dropping keyboard focus to <body>.
    const onRename = vi.fn();
    const utils = renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    // Mirror the parent: the loading flip rides the same commit as the close.
    onRename.mockImplementation(() => {
      utils.rerender(
        withIntl(
          <WorkingSetList
            datasets={[mockDataset]}
            activeName={null}
            onSelect={() => {}}
            onRename={onRename}
            loading={true}
          />,
        ),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "员工表" } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("list")).toHaveFocus();
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

  // --- Delete dialog (issue #759): the native window.confirm retired onto an
  // in-app AlertDialog. AlertDialog semantics (issue #105 precedent): ESC +
  // overlay click are deliberately inert -- an irreversible removal needs an
  // explicit 取消 / 删除.

  it("opens a delete AlertDialog naming the dataset (issue #38, #759)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    const dialog = screen.getByRole("alertdialog");
    // The title carries the display name (workingSet.delete.confirm semantics).
    expect(dialog).toHaveTextContent(/确定从工作集删除「people」/);
    // The irreversibility description renders (workingSet.delete.description).
    expect(dialog).toHaveTextContent(/不可撤销/);
  });

  it("confirms the delete and forwards the stable reference name (issue #38, #759)", () => {
    const onDelete = vi.fn();
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
    // The Action's accessible name is the bare 删除 (common.delete); the
    // trigger carries "删除 people", so the exact match picks the dialog's
    // Action only -- the identity the backend removes is the reference name.
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith("people");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keys the delete off the reference name after the display label diverges (issue #38, #759)", () => {
    // The dialog's title names the display label, but the backend identity is
    // the reference name -- with the two diverged, the callback must carry the
    // reference name (a swap regression would remove the wrong source).
    const onDelete = vi.fn();
    const diverged: DatasetDescriptor = { ...mockDataset, display_name: "员工表" };
    renderI18n(
      <WorkingSetList
        datasets={[diverged]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/员工表/);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith("people");
  });

  it("reopens the delete dialog for the next row after a confirmed delete (issue #759)", () => {
    // The confirm path must clear the delete target: the AlertDialog is
    // uncontrolled (defaultOpen), so a stale target would leave it mounted
    // with the open consumed -- the next row's delete click would open
    // nothing. Two deletes in a row is the core working-set teardown flow.
    const onDelete = vi.fn();
    const orders: DatasetDescriptor = { ...mockDataset, reference_name: "orders", display_name: "orders" };
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset, orders]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "删除 people" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith("people");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Row B's delete click must open the dialog again, naming B.
    fireEvent.click(screen.getByRole("button", { name: "删除 orders" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/确定从工作集删除「orders」/);
  });

  it("cancels the delete dialog without firing onDelete and restores trigger focus (issue #38, #759)", async () => {
    // A cancel at the confirm gate never reaches the backend -- no IPC, no
    // removal; the keyboard flow lands back on the row's delete trigger.
    const onDelete = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    const trigger = screen.getByRole("button", { name: /删除/ });
    // fireEvent.click does not move focus in jsdom; focus first so the restore
    // has an opener to land on (a real click would focus the trigger).
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(trigger).toHaveFocus();
  });

  it("falls back to focusing the list when the confirm's loading gate disables the trigger (issue #759)", async () => {
    // Same shape as the Save path: onDelete fires before the close and the
    // parent flips loading in the same commit, so the deferred restore meets a
    // disabled trigger -- the fallback keeps focus in the working-set region.
    const onDelete = vi.fn();
    const utils = renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    onDelete.mockImplementation(() => {
      utils.rerender(
        withIntl(
          <WorkingSetList
            datasets={[mockDataset]}
            activeName={null}
            onSelect={() => {}}
            onRename={() => {}}
            onDelete={onDelete}
            loading={true}
          />,
        ),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith("people");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("list")).toHaveFocus();
  });

  it("Escape does not close the delete dialog (AlertDialog semantics, issue #759)", () => {
    // Mirrors the ActiveSourceDeleteDialog ESC pin: the destructive confirm
    // intentionally blocks ESC dismiss -- ESC on the content is inert, so
    // onDelete never fires (no accidental dismiss of an irreversible removal).
    const onDelete = vi.fn();
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
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("overlay-click does not close the delete dialog (AlertDialog semantics, issue #759)", async () => {
    // Radix AlertDialog prevents onInteractOutside, so a pointer-down on the
    // overlay (outside the content) leaves the dialog open and fires onDelete
    // never -- the user must take an explicit 取消 / 删除.
    const onDelete = vi.fn();
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
    // Radix attaches its pointerdown listener on a setTimeout(0) after mount;
    // flush it before the pointer events so the outside-click is observed.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, { button: 0 });
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
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

  // --- Row layout (issue #790): each dataset renders as ONE horizontal row --
  // the select button plus the rename/replace/delete icon actions side by
  // side, retiring the #5-era stack of four full-width block buttons. Icons
  // follow the #774 hit-area spec and weak-show per the #251 convention.

  it("lays each dataset out as one flex row with the three icon actions inline (issue #790)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    // The select button flexes to fill the row; the icon actions sit beside it.
    const select = screen.getByRole("button", { name: /^people/ });
    const selectClasses = select.className.split(/\s+/);
    expect(selectClasses).toContain("flex-1");
    expect(selectClasses).toContain("min-w-0");
    // All four controls share one row <li>, which is itself the flex container.
    const row = select.closest("li")!;
    expect(row.querySelectorAll("button")).toHaveLength(4);
    expect(row.className.split(/\s+/)).toContain("flex");
  });

  it("renders lucide glyphs on 28px hit areas, retiring the text-character buttons (issue #790, #774 spec)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    for (const name of [/重命名/, /换源/, /删除/]) {
      const action = screen.getByRole("button", { name });
      // 28px hit area (h-7 w-7) wrapping a decorative 14px lucide glyph
      // (h-3.5 w-3.5); the accessible name stays on the button's aria-label.
      const hitClasses = action.className.split(/\s+/);
      expect(hitClasses).toContain("h-7");
      expect(hitClasses).toContain("w-7");
      const glyph = action.querySelector("svg");
      expect(glyph).not.toBeNull();
      // svg.className is SVGAnimatedString, not a plain string -- read the
      // attribute instead.
      const glyphClasses = glyph!.getAttribute("class")!.split(/\s+/);
      expect(glyphClasses).toContain("h-3.5");
      expect(glyphClasses).toContain("w-3.5");
    }
    // The pre-#790 text-character glyphs are gone.
    expect(screen.queryByText("✎")).not.toBeInTheDocument();
    expect(screen.queryByText("↻")).not.toBeInTheDocument();
    expect(screen.queryByText("✕")).not.toBeInTheDocument();
  });

  it("weak-shows the icon actions and restores full opacity on row hover / focus (issue #790, #251 convention)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const rename = screen.getByRole("button", { name: /重命名/ });
    const classes = rename.className.split(/\s+/);
    expect(classes).toContain("opacity-60");
    expect(classes).toContain("group-hover:opacity-100");
    expect(classes).toContain("focus-visible:opacity-100");
    // The row <li> carries the group hook the hover restore keys off.
    expect(rename.closest("li")!.className.split(/\s+/)).toContain("group");
  });

  it("truncates the label but not the row-count note, and titles the full name (issue #790)", () => {
    const long: DatasetDescriptor = {
      ...mockDataset,
      display_name: "a-very-long-dataset-display-label",
    };
    renderI18n(
      <WorkingSetList
        datasets={[long]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const select = screen.getByRole("button", { name: /^a-very-long/ });
    // The native tooltip carries the untruncated display name.
    expect(select).toHaveAttribute("title", "a-very-long-dataset-display-label");
    // Truncation lives on the label span so the trailing row-count note stays
    // visible (shrink-0, never the elided part) at any column width.
    const label = select.querySelector(".truncate");
    expect(label).toHaveTextContent("a-very-long-dataset-display-label");
    const note = select.querySelector("small");
    expect(note!.className.split(/\s+/)).toContain("shrink-0");
  });

  it("renders the stale badge after the row actions so the icons share the select line (issue #790)", () => {
    const stale: DatasetDescriptor = {
      ...mockDataset,
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
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    // jsdom has no layout engine, so the guard pins the DOM order the
    // flex-wrap packing depends on: select + three icon actions first, badge
    // last -- its basis-full lands alone on the line below only when it
    // follows the icons (a badge before them would push the icons onto a
    // third line).
    const row = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(row.className.split(/\s+/)).toContain("flex-wrap");
    const children = [...row.children];
    const badge = children[children.length - 1];
    expect(badge.className.split(/\s+/)).toContain("stale-badge");
    expect(badge.className.split(/\s+/)).toContain("basis-full");
    expect(children.slice(1, -1).filter((el) => el.tagName === "BUTTON")).toHaveLength(3);
  });
});
