// The workspace section's folder-open failure face (issue #1543): the
// group menu's open-folder item delegates to the parent-owned opener, and
// a refusal surfaces as an alert under the failing group's own row -- the
// menu is closed by the time the opener refuses, so the row is the honest
// surface. The suite pins the scoping (only the failing group's row shows
// the alert) and the clear (that group's successful retry retires it; a
// sibling group's success does not).
// The modal-off-the-menu faces (rename / remove / datasets / memory) have
// their own suites; this one rides the section alone with empty groups.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { openPath } from "@tauri-apps/plugin-opener";
import { WorkspaceSidebarSection } from "../WorkspaceSidebarSection";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { WorkspaceGroup } from "../sidebarModel";

const mockedOpenPath = vi.mocked(openPath);

function group(overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return { path: "/w/alpha", label: "Alpha", missing: false, entries: [], ...overrides };
}

function renderSection(groups: WorkspaceGroup[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    withIntl(
      <QueryClientProvider client={client}>
        <WorkspaceSidebarSection
          groups={groups}
          sessions={[]}
          sessionsLoaded={true}
          disabled={false}
          collapsed={false}
          onToggleCollapsed={() => {}}
          renderRows={() => null}
          onNewInWorkspace={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
}

/** Opens a group row's actions menu (pointerDown, Radix's open gesture --
 *  the ArtifactHeader suite's helper posture). Every group row carries the
 *  same-named trigger, so the index picks the row (0 = the first group). */
async function openGroupMenu(index = 0) {
  fireEvent.pointerDown(
    screen.getAllByRole("button", { name: "工作区操作" })[index],
    { button: 0, pointerType: "mouse" },
  );
  await screen.findByRole("menu");
}

/** Fires the select gesture on a Radix menu item (pointerUp + click). */
function activateItem(item: HTMLElement) {
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.click(item);
}

function groupRowLi(label: string): HTMLElement {
  const li = screen.getByText(label).closest("li");
  expect(li).not.toBeNull();
  return li!;
}

describe("WorkspaceSidebarSection folder-open failure (#1543)", () => {
  beforeEach(() => {
    mockedOpenPath.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a refused open as an alert under its own group row, cleared by that group's retry", async () => {
    mockedOpenPath.mockRejectedValueOnce(new Error("folder refused"));
    renderSection([group(), group({ path: "/w/beta", label: "Beta" })]);
    await openGroupMenu();
    activateItem(screen.getByRole("menuitem", { name: "打开文件夹" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("folder refused");
    // Scoped to the failing group's row: the sibling group shows nothing.
    expect(within(groupRowLi("Alpha")).getByRole("alert")).toBe(alert);
    expect(within(groupRowLi("Beta")).queryByRole("alert")).not.toBeInTheDocument();
    // A successful retry of the same group retires the alert.
    await openGroupMenu();
    activateItem(screen.getByRole("menuitem", { name: "打开文件夹" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  // The clear is path-guarded (#1543 review): the functional updater keeps
  // a sibling group's successful open from retiring the failing group's
  // alert -- only that group's own successful retry clears it.
  it("keeps a group's alert when a sibling group opens successfully", async () => {
    mockedOpenPath.mockRejectedValueOnce(new Error("alpha refused"));
    renderSection([group(), group({ path: "/w/beta", label: "Beta" })]);
    await openGroupMenu();
    activateItem(screen.getByRole("menuitem", { name: "打开文件夹" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("alpha refused");
    // Beta's successful open leaves Alpha's alert live.
    await openGroupMenu(1);
    activateItem(screen.getByRole("menuitem", { name: "打开文件夹" }));
    await waitFor(() => expect(mockedOpenPath).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBe(alert);
  });
});
