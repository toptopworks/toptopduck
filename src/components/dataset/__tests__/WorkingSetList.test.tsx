import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
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

  it("lists the datasets as selectable rows", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    // The select button's accessible name starts with the display label; the
    // rename sibling's starts with "重命名" -- anchor on the leading label so
    // the two buttons never collide on a /people/ substring match. The active
    // marking itself is pinned by the className test below (#793 retired the
    // suffix text this test used to assert).
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
  });

  it("bands the selected row and bolds the active row -- the band follows the pick, not the active dataset", () => {
    // The accent band is the SELECTION state (which row's detail the right
    // pane shows) and must move with a management click; before this split
    // it was keyed to the active dataset, so picking another row left the
    // highlight stranded on the active one. The active dataset keeps the
    // in-list font-semibold label -- its authoritative identity is the tab
    // header's Targets chip, and since #793 retired the " · current table"
    // suffix, bold is the row's only in-list active marker.
    const orders: DatasetDescriptor = {
      ...mockDataset,
      reference_name: "orders",
      display_name: "orders",
    };
    const { rerender } = renderI18n(
      <WorkingSetList
        datasets={[mockDataset, orders]}
        activeName="people"
        selectedName="orders"
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const ordersRow = screen.getByRole("button", { name: /^orders/ }).closest("li")!;
    expect(ordersRow.className.split(/\s+/)).toContain("bg-accent");
    expect(ordersRow.className.split(/\s+/)).toContain("selected");
    expect(
      screen.getByRole("button", { name: /^orders/ }).className.split(/\s+/),
    ).not.toContain("font-semibold");
    const peopleRow = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(peopleRow.className.split(/\s+/)).not.toContain("bg-accent");
    expect(peopleRow.className.split(/\s+/)).toContain("active");
    expect(
      screen.getByRole("button", { name: /^people/ }).className.split(/\s+/),
    ).toContain("font-semibold");

    // The band follows the pick across rerenders (rows keep their keys, so
    // the li references stay live).
    rerender(
      withIntl(
        <WorkingSetList
          datasets={[mockDataset, orders]}
          activeName="people"
          selectedName="people"
          onSelect={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    expect(peopleRow.className.split(/\s+/)).toContain("bg-accent");
    expect(ordersRow.className.split(/\s+/)).not.toContain("bg-accent");

    // No selection -> no band anywhere, even with an active dataset: the
    // active state never carries the band.
    rerender(
      withIntl(
        <WorkingSetList
          datasets={[mockDataset, orders]}
          activeName="people"
          selectedName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    expect(peopleRow.className.split(/\s+/)).not.toContain("bg-accent");
    expect(peopleRow.className.split(/\s+/)).toContain("active");
  });

  // The empty-set face is no longer this list's concern: WorkspaceWorkingSet
  // renders the single empty-state card instead (issue #792), so the list
  // mounts only for a non-empty set -- its empty-branch test moved to the
  // WorkingSetEmptyState suite.

  it("pins the row-count annotation to the 12px caption token (issue #864)", () => {
    // The workspace body's 14px baseline (issue #864) inherits into the
    // annotation's parent chain, and the preflight small rule (80%) would
    // resolve an unsized small at 11.2px -- below the caption token, the
    // ladder's floor. text-xs pins 12px independent of that chain.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const small = screen
      .getByRole("button", { name: /^people/ })
      .querySelector("small");
    expect(small).not.toBeNull();
    expect(small!.className.split(/\s+/)).toContain("text-xs");
  });

  // --- Rename dialog (issue #759): the native window.prompt retired onto an
  // in-app Dialog + Input (ADR-0037 semantics unchanged -- display label only,
  // the reference name survives).

  it("opens the rename dialog with the current display name prefilled (issue #759)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/重命名/);
    // The input starts from the current display label so an edit builds on it.
    expect(screen.getByRole("textbox")).toHaveValue(mockDataset.display_name);
  });

  it("submits a valid rename through the dialog and closes it (ADR-0037, issue #759)", () => {
    const onRename = vi.fn();
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
    // setMutationLoading(true) synchronously -- batched with the close into one commit,
    // so the deferred restore finds the row trigger disabled and focus() on a
    // disabled button is ignored. The restore must fall back to the list
    // container instead of dropping keyboard focus to <body>.
    const onRename = vi.fn();
    const utils = renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
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
            selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
            selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
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
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /删除/ })).toBeDisabled();
  });

  it("renders a short stale chip; the Deleted causal sentence rides the Radix tooltip (issue #793, #865)", async () => {
    // #793 AC1: the row badge is the short "已失效" chip; the full causal
    // sentence -- with "已删除" for a Deleted anchor and "已更新" for a
    // Replaced one, from the workingSet.staleRow.hint ICU select -- rides the
    // tooltip, so a narrow column can no longer wrap the sentence inside the
    // chip. #865 moves it from the OS-native title to the theme-following
    // Radix tooltip. No action outlet rides the chip: the rerun path stays
    // with the result panel's stale banner (#758).
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
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const chip = screen.getByText("已失效").closest(".stale-badge")!;
    expect(chip).not.toHaveAttribute("title");
    fireEvent.pointerMove(chip);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("因「员工表」已删除而失效");
  });

  it("renders the row-count plural 'one' branch via the en defaultMessage (ADR-0052)", () => {
    // The zh-CN catalog collapses workingSet.rowCount to "{count} 行", so the
    // en {count, plural, ...} branches are reachable only via defaultMessage.
    // An empty English provider (the renderSettings pattern) routes FormattedMessage
    // to the canonical defaultMessage so the plural stays covered. The negative
    // assertion guards against a one/other swap or a stray "rows" in the one arm.
    // The TooltipProvider rides along (renderI18n carries it; this bare-en
    // render must hand-wrap -- the list's tooltips (#865) require it).
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <WorkingSetList
            datasets={[{ ...mockDataset, row_count: 1 }]}
            activeName={null}
            selectedName={null}
            onSelect={() => {}}
            onRename={() => {}}
          />
        </TooltipProvider>
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /1 row/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1 rows/ })).not.toBeInTheDocument();
  });

  it("renders the row-count plural 'other' branch via the en defaultMessage (ADR-0052)", () => {
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <WorkingSetList
            datasets={[{ ...mockDataset, row_count: 5 }]}
            activeName={null}
            selectedName={null}
            onSelect={() => {}}
            onRename={() => {}}
          />
        </TooltipProvider>
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /5 rows/ })).toBeInTheDocument();
  });

  it("renders the stale tooltip verb for a Replaced anchor (issue #41 AC4, #865)", async () => {
    // Pins the Replaced arm of the workingSet.staleRow.hint ICU select (the
    // Deleted arm is covered above) so a regression that drops the arm renders
    // an incomplete tooltip; mirrors the ResultView stale-verb coverage in the
    // Thread suite.
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
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const chip = screen.getByText("已失效").closest(".stale-badge")!;
    fireEvent.pointerMove(chip);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("因「员工表」已更新而失效");
  });

  it("exhausts every StaleReason variant in the workingSet.staleRow.hint select (ADR-0041)", () => {
    // Compile-time guard: the workingSet.staleRow.hint ICU {reason, select}
    // must name every StaleReason variant as an arm. Adding a variant without
    // extending this map fails tsc (mirrors Thread.tsx staleChipVerb's
    // never-guard), so the select's `other` arm stays unreachable instead of
    // silently masking a new case.
    const arms: Record<StaleReason, true> = {
      Deleted: true,
      Replaced: true,
    };
    expect(Object.keys(arms).sort()).toEqual(["Deleted", "Replaced"]);
  });

  // --- Row layout (issue #790): each dataset renders as ONE horizontal row --
  // the select button plus the rename/replace/delete icon actions. The
  // actions ride an absolutely-positioned pill that floats over the label's
  // tail instead of reserving flow width. Icons follow the #774 hit-area
  // spec; their visibility form is the #865 hover-reveal (retiring the
  // #790/#251 weak-show).

  it("lays each dataset out as one flex row with the three icon actions in an overlay pill (issue #790)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    // The select button flexes to fill the row; the icon actions float above
    // its tail instead of sitting beside it in flow.
    const select = screen.getByRole("button", { name: /^people/ });
    const selectClasses = select.className.split(/\s+/);
    expect(selectClasses).toContain("flex-1");
    expect(selectClasses).toContain("min-w-0");
    // All four controls share one row <li>, which is itself the flex container
    // and the overlay pill's positioning anchor.
    const row = select.closest("li")!;
    expect(row.querySelectorAll("button")).toHaveLength(4);
    const rowClasses = row.className.split(/\s+/);
    expect(rowClasses).toContain("flex");
    expect(rowClasses).toContain("relative");
  });

  it("renders lucide glyphs on 28px hit areas, retiring the text-character buttons (issue #790, #774 spec)", () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
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

  it("hover-reveals the action pill: hidden and unhoverable until row hover / focus-visible (issue #865)", () => {
    // #865 retires the #790/#251 weak-visibility convention (opacity-60
    // always on) for the working-set rows: an un-hovered row reads as plain
    // data, with the action pill at opacity-0 + pointer-events-none. Row
    // hover and keyboard focus (any tabbed-into action, via the container's
    // has-[:focus-visible]) restore both display and hit area on the
    // CONTAINER -- the pill owns the visibility form now that it floats over
    // the label, since a button-level focus-visible class cannot light a
    // parent; focus-visible rather than focus-within keeps the dialog-close
    // programmatic focus restore from glowing the pill forever; `invisible`
    // stays rejected (it would drop the buttons from the a11y tree), and the
    // tab order / aria-labels are untouched.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const rename = screen.getByRole("button", { name: /重命名/ });
    // Radix Tooltip renders no DOM wrapper, so the buttons' direct div parent
    // is the overlay pill.
    const pill = rename.closest("div")!;
    const classes = pill.className.split(/\s+/);
    expect(classes).toContain("absolute");
    // The pill anchors to the label-tail wrapper's trailing edge: right-1 +
    // z-10 float it over the label's tail, clear of the chip that follows in
    // flow (see the DOM-order pin in the stale-chip layout test).
    expect(classes).toContain("right-1");
    expect(classes).toContain("z-10");
    // The pill's ground is the row-hover tint itself (bg-accent) -- it reads
    // as part of the row, not a floating widget; opaque, it also keeps the
    // label underneath from bleeding through.
    expect(classes).toContain("bg-accent");
    expect(classes).not.toContain("bg-card");
    expect(classes).not.toContain("shadow-md");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("pointer-events-none");
    expect(classes).toContain("group-hover:opacity-100");
    expect(classes).toContain("group-hover:pointer-events-auto");
    expect(classes).toContain("has-[:focus-visible]:opacity-100");
    expect(classes).toContain("has-[:focus-visible]:pointer-events-auto");
    expect(classes).not.toContain("opacity-60");
    // The buttons themselves carry no visibility form -- the pill owns it.
    expect(rename.className.split(/\s+/)).not.toContain("opacity-0");
    // The row <li> carries the group hook the hover restore keys off.
    expect(rename.closest("li")!.className.split(/\s+/)).toContain("group");
  });

  it("tints the whole row on hover -- the li carries the band, switching instantly", () => {
    // The hover tint lives on the row <li>, not on the select button: the
    // pointer anywhere on the row (the floating action pill included) must
    // light the same full-height band, and the pill's accent ground merges
    // into it. The switch is intentionally NOT transitioned -- per-row 150ms
    // fades cross-fade two bands on every row-to-row crossing, which reads
    // as the strip flashing on a downward sweep.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const select = screen.getByRole("button", { name: /^people/ });
    const rowClasses = select.closest("li")!.className.split(/\s+/);
    expect(rowClasses).toContain("hover:bg-accent");
    // bg-clip-content keeps a py-gutter between adjacent rows' bands (padding
    // carries the gap, not margin -- a margin gap is a hover dead zone).
    expect(rowClasses).toContain("bg-clip-content");
    expect(rowClasses).not.toContain("transition-colors");
    expect(rowClasses).toContain("rounded-md");
    expect(select.className.split(/\s+/)).not.toContain("hover:bg-accent");
  });

  it("rests the icon glyphs muted, highlights the hot icon, and splits the cursor: strip arrow, select hand", () => {
    // The icon strip reads like the reference session list: each glyph rests
    // muted on the pill's accent ground and the hovered / keyboard-focused
    // icon highlights to foreground -- color alone marks the hot icon (a
    // background tint would be invisible on the pill's own accent). The
    // strip keeps the default arrow (the highlight carries the affordance);
    // the select button's hand is pinned at the tail of this test.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    for (const name of [/重命名/, /换源/, /删除/]) {
      const classes = screen.getByRole("button", { name }).className.split(/\s+/);
      expect(classes).toContain("text-muted-foreground");
      expect(classes).toContain("hover:text-foreground");
      expect(classes).toContain("focus-visible:text-foreground");
      expect(classes).toContain("transition-colors");
      // The loading state signals on both channels, like every other action
      // surface: the progress cursor + the disabled dim (the pill container
      // owns visibility, so the dim only marks the one hovered row).
      expect(classes).toContain("disabled:cursor-progress");
      expect(classes).toContain("disabled:opacity-50");
      expect(classes).not.toContain("cursor-pointer");
      expect(classes).not.toContain("hover:bg-accent");
    }
    // The select button carries the hand -- its click is the row's
    // selection, the honest affordance. The label's truncation-recovery
    // affordance is the OS-native title now, which never touches the cursor,
    // so the old text-vs-everywhere flip on the span is gone; the one
    // remaining cursor edge is where the pill meets the button's tail
    // (hand -> arrow), accepted with the hand ruling.
    const select = screen.getByRole("button", { name: /^people/ });
    expect(select.className.split(/\s+/)).toContain("cursor-pointer");
  });

  it("truncates the label but not the row-count note; the full name rides the native title (issue #790)", () => {
    const long: DatasetDescriptor = {
      ...mockDataset,
      display_name: "a-very-long-dataset-display-label",
    };
    renderI18n(
      <WorkingSetList
        datasets={[long]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const select = screen.getByRole("button", { name: /^a-very-long/ });
    // The untruncated display name rides the OS-native title on the label
    // span: truncation recovery with no Radix machinery -- no mutex slot, no
    // open/close handlers, and no cursor interference (a native title never
    // touches the cursor, which the button's hand ruling depends on; the
    // action hints keep their Radix tooltips -- #865 rejected native chrome
    // for those, the name only surfaces its own text).
    expect(select.querySelector("span")).toHaveAttribute(
      "title",
      "a-very-long-dataset-display-label",
    );
    expect(select).not.toHaveAttribute("title");
    // Truncation lives on the label span so the trailing row-count note stays
    // visible (shrink-0, never the elided part) at any column width.
    const label = select.querySelector(".truncate");
    expect(label).toHaveTextContent("a-very-long-dataset-display-label");
    const note = select.querySelector("small");
    expect(note!.className.split(/\s+/)).toContain("shrink-0");
  });

  it("keeps the native titles off the row controls; the action hints ride Radix tooltips (issue #865)", async () => {
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    // All four row control BUTTONS stay free of the OS-native title (its
    // chrome follows the OS, not the theme tokens) -- their affordances ride
    // the theme-following Radix tooltips. The label span's title above is
    // the one deliberate native exception: the name's truncation recovery
    // went native with the hand-cursor ruling.
    for (const name of [/^people/, /重命名/, /换源/, /删除/]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("title");
    }
    // The hint copy moves into the theme-following Radix tooltip -- wire check
    // on the rename action (its siblings share the same wiring). The icon
    // hints open on our own pointer-ENTER handlers; the stale chip's tooltip
    // is controlled too but opens through Radix's pointer-move path (the
    // delayed open bridges through onOpenChange).
    // jsdom fires pointer events with an empty pointerType; the real mouse
    // carries "mouse", which the touch guard requires.
    fireEvent.pointerEnter(screen.getByRole("button", { name: /重命名/ }), {
      pointerType: "mouse",
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("重命名");
  });

  // The mutex's guard arm ("an open action hint owns the slot against a
  // direct non-hint open", issue #865) retired with its only client: the
  // name span's direct pointer-enter open. The name's affordance is the
  // OS-native title now, so no direct non-hint open reaches setTip anymore
  // -- Radix-internal opens arrive on an empty slot (their tooltip.open
  // broadcast closes mounted peers first), and the hints' direct opens are
  // leave-then-enter ordered. The guard and this test's mutant went
  // together.

  it("renders the stale chip inline after the row actions, retiring the wrapped second line (issue #790, #793)", () => {
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
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    // jsdom has no layout engine, so the guard pins the DOM order and the
    // class contract the single-line layout depends on: the label-tail
    // wrapper (select button + the overlay pill with the three icon actions
    // anchored inside it) first, then the short chip as the row's trailing
    // flow child -- the pill's anchor stays structurally clear of the chip,
    // so the chip keeps its hover beside the revealed pill (#865). The #790
    // shape (basis-full badge wrapping onto its own line via flex-wrap) is
    // retired with #793 -- the chip is a shrink-0 inline peer that never
    // compresses and never needs to wrap, so the row stays one flex line.
    const row = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    const rowClasses = row.className.split(/\s+/);
    expect(rowClasses).toContain("flex");
    expect(rowClasses).not.toContain("flex-wrap");
    const children = [...row.children];
    expect(children).toHaveLength(2);
    const wrapper = children[0];
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.className.split(/\s+/)).toContain("flex-1");
    expect(wrapper.querySelector("button")).not.toBeNull();
    const pill = wrapper.children[wrapper.children.length - 1];
    expect(pill.tagName).toBe("DIV");
    expect(pill.querySelectorAll("button")).toHaveLength(3);
    const badge = children[children.length - 1];
    const badgeClasses = badge.className.split(/\s+/);
    expect(badgeClasses).toContain("stale-badge");
    expect(badgeClasses).toContain("shrink-0");
    expect(badgeClasses).not.toContain("basis-full");
  });

  it("retires the ' · current table' suffix; the active fact rides the bold label alone (issue #793)", () => {
    // AC2: active was stated three ways (row suffix + tab-row Targets badge +
    // row highlight). The suffix is deleted, and since the band moved to the
    // selection, the bold label and the Targets badge keep the two remaining
    // surfaces. The label pins to exactly the display name so a restored
    // suffix fails in either locale: the zh catalog supplies the zh word when
    // the key exists, and the en defaultMessage covers the partial revert
    // where only the source hunk comes back and the catalog keys stay
    // deleted.
    renderI18n(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        selectedName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    const select = screen.getByRole("button", { name: /^people/ });
    expect(select.querySelector(".truncate")).toHaveTextContent(/^people$/);
    // No selection here, so no band: active alone carries NO accent -- the
    // in-list active fact is the font-semibold label (+ the li's .active
    // hook), the band is the selection's.
    const rowClasses = select.closest("li")!.className.split(/\s+/);
    expect(rowClasses).toContain("active");
    expect(rowClasses).not.toContain("bg-accent");
    const classes = select.className.split(/\s+/);
    expect(classes).toContain("font-semibold");
    expect(classes).not.toContain("bg-accent");
  });
});
