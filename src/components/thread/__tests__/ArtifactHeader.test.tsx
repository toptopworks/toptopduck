// Tests for the stage's persistent file header (issue #1199) in isolation:
// the file name + external-open action, the more menu (issue #1317) with
// its three OS verbs, and the single failure slot. The header owns no
// queries -- existence arrives as a prop -- so the mock surface is just the
// OS opener, the save dialog, and the Rust copy lane. The header-to-stage
// refresh seam (cache invalidation + body re-key) is pinned against the
// full ArtifactView.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { catalogFor } from "../../../i18n";
import { copyArtifactFile } from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import { MENU_REENTRY_GRACE_MS } from "../../../session/sidebarHoverCard";
import { ArtifactHeader } from "../ArtifactHeader";

vi.mock("../../../api", () => ({
  copyArtifactFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

function renderHeader(path: string, exists: boolean) {
  const onRefresh = vi.fn();
  render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <ArtifactHeader
          artifact={{ path, file_name: path.split("/").pop() ?? path }}
          exists={exists}
          onRefresh={onRefresh}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
  return { onRefresh };
}

/** Opens the header's more menu (pointerDown on the trigger, Radix's open
 *  gesture -- the VizExportFrame suite's helper). */
async function openMoreMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "更多操作" }), {
    button: 0,
    pointerType: "mouse",
  });
  await screen.findByRole("menu");
}

/** Fires the select gesture on a Radix menu item (pointerUp + click). */
function activateItem(item: HTMLElement) {
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.click(item);
}

describe("ArtifactHeader", () => {
  // Reset implementations too (resetAllMocks, not clearAllMocks): without
  // it, a persistent mockResolvedValue from an earlier case bleeds into
  // later cases that never set their own.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("file header (the persistent stage chrome)", () => {
    it("shows the file name and the external-open action for an existing file", async () => {
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      expect(screen.getByTestId("artifact-header")).toHaveTextContent("report.pdf");
      expect(await screen.findByRole("button", { name: /外部打开|externally/ })).toBeInTheDocument();
    });

    it("swaps the action for the missing note when the file is gone", async () => {
      renderHeader("C:/sessions/s1/artifacts/gone.pdf", false);
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /外部打开|externally/ })).not.toBeInTheDocument();
    });

    it("surfaces an opener failure as a live note", async () => {
      vi.mocked(openPath).mockRejectedValue(new Error("no association"));
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      // Scoped to the header; no other status region exists here (the
      // header owns no frame).
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toHaveTextContent(
        /无法在外部打开|Could not open/,
      );
    });

    it("clears the failure note when a retry opens successfully", async () => {
      // Fresh Error instances per Once-stage: a reused instance keeps
      // rejecting through later stages.
      vi.mocked(openPath)
        .mockRejectedValueOnce(new Error("no association"))
        .mockResolvedValueOnce(undefined);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      const open = await screen.findByRole("button", { name: /外部打开|externally/ });
      fireEvent.click(open);
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toBeInTheDocument();
      fireEvent.click(open);
      await waitFor(() =>
        expect(within(header).queryByRole("status")).not.toBeInTheDocument(),
      );
    });
  });

  describe("file header more menu (issue #1317)", () => {
    it("refuses the menu-close focus restore's tooltip open, then restores real hover", async () => {
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      const trigger = screen.getByRole("button", { name: "更多操作" });
      // Hover opens the tooltip (delay 0). Radix's open gesture keys on
      // pointermove, not pointerenter; the enter rides along first, the
      // same order a real pointer produces.
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await screen.findByText("更多操作");
      // The pointerdown opens the menu and retires the tooltip; the trailing
      // pointerup clears Radix's pointer-down guard so the menu-close focus
      // restore reaches the trigger's onFocus (the phantom-open channel).
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(trigger);
      await screen.findByRole("menu");
      await waitFor(() =>
        expect(screen.queryByText("更多操作")).not.toBeInTheDocument(),
      );
      // Esc closes the menu. Radix restores focus to the trigger and the
      // trigger treats that programmatic focus as an open intent -- the
      // close grace must refuse it or the tooltip resurrects itself.
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
      );
      expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
      // Past the grace a genuine hover (leave + re-enter) opens as usual.
      fireEvent.pointerLeave(trigger);
      await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await screen.findByText("更多操作");
    });

    it("refuses the late focus return (the OS-dialog detour) via the pointer leg", async () => {
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      const trigger = screen.getByRole("button", { name: "更多操作" });
      // The pointer travels to the menu (leave) and opens it.
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      fireEvent.pointerLeave(trigger);
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(trigger);
      await screen.findByRole("menu");
      // The item activates, the menu closes, and the native dialog detours
      // the focus for longer than the close grace ("Save as…" on the real
      // app). When focus finally lands back on the trigger the pointer is
      // still away -- the pointer leg, not the expired grace, must refuse.
      activateItem(screen.getByRole("menuitem", { name: "刷新" }));
      await waitFor(() =>
        expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
      );
      await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
      fireEvent.focus(trigger);
      await waitFor(() => {});
      expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
      // A genuine hover (the pointer re-entering) still opens.
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await screen.findByText("更多操作");
    });

    it("refuses the focus return when the synthetic leave cannot derive (the portal detour)", async () => {
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      const trigger = screen.getByRole("button", { name: "更多操作" });
      // The natural click path: the pointer OPENS the menu while still on
      // the trigger, then moves into the menu portal. In the real app the
      // modal layer can keep React from deriving the synthetic
      // onPointerLeave there (the sidebar hover-card machine's CDP-measured
      // artifact), so NO synthetic leave is fired in this test -- the
      // marker rides "on" until the native backstop clears it.
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(trigger);
      await screen.findByRole("menu");
      // A non-bubbling native pointerleave: the backstop's listener sees
      // it, React's synthetic derivation (root-level, bubble-fed) does not.
      trigger.dispatchEvent(new Event("pointerleave"));
      activateItem(screen.getByRole("menuitem", { name: "刷新" }));
      await waitFor(() =>
        expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
      );
      await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
      fireEvent.focus(trigger);
      await waitFor(() => {});
      // Without the backstop the marker strands "on" and this focus return
      // sails through every leg -- the phantom again.
      expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
      // A genuine hover reopens. The synthetic leave models the pointer's
      // eventual proper exit (post-menu, normal events flow again) -- it
      // also resets Radix's one-shot pointermove edge lock, without which
      // the re-enter's pointermove intent is swallowed by Radix itself.
      fireEvent.pointerLeave(trigger);
      fireEvent.pointerEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await screen.findByText("更多操作");
    });

    it("exposes refresh / show-in-folder / save-as for an existing file", async () => {
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      expect(screen.getByRole("menuitem", { name: "刷新" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "在文件夹中显示" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "另存为…" })).toBeInTheDocument();
    });

    it("saves a copy through the native dialog and the Rust copy lane", async () => {
      vi.mocked(saveDialog).mockResolvedValue("D:/copies/report.pdf");
      vi.mocked(copyArtifactFile).mockResolvedValue(undefined);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "另存为…" }));
      await waitFor(() => expect(copyArtifactFile).toHaveBeenCalledTimes(1));
      // The picker defaults to the artifact's own name (the ticket's AC).
      expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "report.pdf" });
      expect(copyArtifactFile).toHaveBeenCalledWith(
        "C:/sessions/s1/artifacts/report.pdf",
        "D:/copies/report.pdf",
      );
    });

    it("keeps a cancelled save dialog a quiet no-op", async () => {
      vi.mocked(saveDialog).mockResolvedValue(null);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "另存为…" }));
      await waitFor(() => expect(saveDialog).toHaveBeenCalledTimes(1));
      expect(copyArtifactFile).not.toHaveBeenCalled();
      // Quiet means quiet: a cancel routed into the failure slot would show
      // a header note, so none may be live.
      const header = screen.getByTestId("artifact-header");
      expect(within(header).queryByRole("status")).not.toBeInTheDocument();
    });

    it("surfaces a failed copy as a header live note", async () => {
      vi.mocked(saveDialog).mockResolvedValue("D:/copies/report.pdf");
      vi.mocked(copyArtifactFile).mockRejectedValue(new Error("disk full"));
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "另存为…" }));
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toHaveTextContent(
        /无法另存|Could not save/,
      );
    });

    it("reveals the file in the folder through the opener plugin", async () => {
      vi.mocked(revealItemInDir).mockResolvedValue(undefined);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "在文件夹中显示" }));
      await waitFor(() =>
        expect(revealItemInDir).toHaveBeenCalledWith("C:/sessions/s1/artifacts/report.pdf"),
      );
    });

    it("surfaces a failed reveal as a header live note", async () => {
      vi.mocked(revealItemInDir).mockRejectedValue(new Error("no file manager"));
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "在文件夹中显示" }));
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toHaveTextContent(
        /无法在文件夹|Could not locate/,
      );
    });

    it("keeps one failure slot: a new action clears the previous note", async () => {
      vi.mocked(openPath).mockRejectedValue(new Error("no association"));
      vi.mocked(revealItemInDir).mockResolvedValue(undefined);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toBeInTheDocument();
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "在文件夹中显示" }));
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(within(header).queryByRole("status")).not.toBeInTheDocument(),
      );
    });

    it("clears a save-failure note when refresh starts", async () => {
      vi.mocked(saveDialog).mockResolvedValue("D:/copies/report.pdf");
      vi.mocked(copyArtifactFile).mockRejectedValue(new Error("disk full"));
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "另存为…" }));
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toBeInTheDocument();
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "刷新" }));
      // Refresh leads with the same slot-clearing as every other action; no
      // other status region exists in this suite, so the note vanishing
      // from the header is the whole signal.
      await waitFor(() =>
        expect(within(header).queryByRole("status")).not.toBeInTheDocument(),
      );
    });

    it("clears a failure note when a save-as succeeds", async () => {
      vi.mocked(openPath).mockRejectedValue(new Error("no association"));
      vi.mocked(saveDialog).mockResolvedValue("D:/copies/report.pdf");
      vi.mocked(copyArtifactFile).mockResolvedValue(undefined);
      renderHeader("C:/sessions/s1/artifacts/report.pdf", true);
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toBeInTheDocument();
      await openMoreMenu();
      activateItem(screen.getByRole("menuitem", { name: "另存为…" }));
      await waitFor(() => expect(copyArtifactFile).toHaveBeenCalledTimes(1));
      // Save-as leads with the same slot-clearing as every other action;
      // a successful copy retires the live note.
      await waitFor(() =>
        expect(within(header).queryByRole("status")).not.toBeInTheDocument(),
      );
    });

    it("exits the menu with the open action when the file is gone", async () => {
      renderHeader("C:/sessions/s1/artifacts/gone.pdf", false);
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-more-menu")).not.toBeInTheDocument();
    });
  });
});
