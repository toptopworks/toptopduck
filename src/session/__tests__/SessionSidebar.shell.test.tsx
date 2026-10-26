import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { IntlProvider } from "react-intl";
import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { SessionSidebar } from "../SessionSidebar";
import { DeleteSessionDialog } from "../SessionDialogs";
import type { OpenSession } from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";
import type { ProviderConfig } from "../../types/provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The sidebar's workspace section queries the registry listing (issue
// #1392) and its menu fires the rename/remove/create IPCs; the shell tests
// are display-contract tests, so the listing is an empty registry and the
// mutations resolve unless a test overrides them.
vi.mock("../../api", () => ({
  listWorkspaces: vi.fn().mockResolvedValue([]),
  renameWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
}));
import { openPath } from "@tauri-apps/plugin-opener";
import {
  createWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
} from "../../api";

// Radix DropdownMenu's pointer-event handling recurses under jsdom (the
// SessionHeaderMenu suite's known limitation), so the dropdown-menu module is
// mocked as a simple controlled shape: the trigger is a plain <button> and the
// content always renders inline. The row-menu tests verify SessionSidebar's
// LOGIC -- which items per row state, which callbacks, which dialog state --
// not Radix's portal/focus-trap internals. The content's onCloseAutoFocus is
// captured where tests can fire it (the mocked shape has no close machinery
// of its own).
const menuClose = vi.hoisted(() => ({
  current: null as null | ((e: { preventDefault: () => void }) => void),
}));
vi.mock("@/components/ui/dropdown-menu", () => {
  // The root's open intent rides context so the trigger can mirror Radix's
  // contract (a trigger click fires onOpenChange(true)) without an open
  // state machine -- the menu tests that care wire their assertions to it.
  const MenuOpenCtx = createContext<{
    onOpenChange?: (open: boolean) => void;
  }>({});
  function DropdownMenu({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) {
    return (
      <MenuOpenCtx.Provider value={{ onOpenChange }}>
        <div data-testid="dropdown-menu-root">{children}</div>
      </MenuOpenCtx.Provider>
    );
  }
  function DropdownMenuTrigger({
    children,
    onClick,
    ...rest
  }: ComponentProps<"button"> & { children: ReactNode }) {
    const { onOpenChange } = useContext(MenuOpenCtx);
    return (
      <button
        type="button"
        onClick={(e) => {
          onClick?.(e);
          onOpenChange?.(true);
        }}
        {...rest}
      >
        {children}
      </button>
    );
  }
  function DropdownMenuContent({
    children,
    onCloseAutoFocus,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
  }) {
    menuClose.current = onCloseAutoFocus ?? null;
    return (
      <div role="menu">
        {children}
      </div>
    );
  }
  function DropdownMenuItem({
    children,
    onSelect,
    variant,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    variant?: "default" | "destructive";
  }) {
    return (
      <div
        role="menuitem"
        data-variant={variant ?? "default"}
        onClick={onSelect}
        style={{ cursor: "pointer" }}
      >
        {children}
      </div>
    );
  }
  function DropdownMenuSeparator() {
    return <div role="separator" />;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  };
});

// Shell-skeleton tests assert className contracts, not chrome. An empty English
// provider + onError keeps the render quiet (missing-message warnings are
// expected -- the catalog is intentionally empty). Named renderShell (not
// renderSettings) to avoid a cross-domain name clash with the settings
// domain's renderSettings helper. TooltipProvider mirrors the App ancestor
// (the connection footer's dual-state gear carries a Tooltip, issue #282).
// The full provider stack, shared by renderShell AND the rerender calls:
// RTL's rerender replaces the WHOLE tree, so the wrappers (the QueryClient
// included -- the workspace listing query reads it, issue #1392) must ride
// along. A fresh client per tree keeps the query cache test-local.
function shellTree(ui: ReactElement) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>{ui}</IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderShell(ui: ReactElement) {
  return render(shellTree(ui));
}

// Two never-saved open sessions: the active one carries .active.open; the other
// carries .open:not(.active). Both land in the Today group (buildSidebarModel
// stamps `now` for unsaved sessions).
function twoOpenSessions(): OpenSession[] {
  return [
    { sid: "sess-active", name: "Active", path: "/sessions/sess-active/recipe.json", pendingIngestPaths: [], pendingQuestion: null, pendingSkillInvocations: [] },
    { sid: "sess-bg", name: "Background", path: "/sessions/sess-bg/recipe.json", pendingIngestPaths: [], pendingQuestion: null, pendingSkillInvocations: [] },
  ];
}

describe("SessionSidebar shell-skeleton visuals (ADR-0067, issue #171)", () => {
  it("session-entry.active lifts bg-accent + text-accent-foreground + aria-current (ADR-0093, issue #511)", () => {
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const activeLi = container.querySelector(".session-entry.active");
    expect(activeLi).not.toBeNull();
    expect(activeLi?.className.split(/\s+/)).toContain("bg-accent");
    const active = container.querySelector(".session-entry.active .session-entry-main");
    expect(active).not.toBeNull();
    const classes = active?.className.split(/\s+/);
    expect(classes).toContain("text-accent-foreground");
    // ADR-0093 (issue #511): the inset shadow left bar is retired — active
    // state is expressed solely via the accent background.
    expect(classes).not.toContain("shadow-[inset_2px_0_var(--primary)]");
    expect(classes).not.toContain("bg-primary");
    // The tint is decorative; aria-current is the active row's AT signal.
    expect(active).toHaveAttribute("aria-current", "true");
  });

  it("session-entry.open:not(.active) carries no inset bar and no accent tint (ADR-0093, issue #511)", () => {
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const bg = container.querySelector(".session-entry.open:not(.active) .session-entry-main");
    expect(bg).not.toBeNull();
    const classes = bg?.className.split(/\s+/);
    // ADR-0093 (issue #511): no inset shadow on any row — active-only tint.
    expect(classes).not.toContain("shadow-[inset_2px_0_var(--primary)]");
    expect(classes).not.toContain("bg-accent");
    expect(classes).not.toContain("text-accent-foreground");
    // Only the active row carries aria-current.
    expect(bg).not.toHaveAttribute("aria-current");
  });

  it("session-entry-main renders a primary status dot for open sessions (ADR-0093, issue #511)", () => {
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const rows = container.querySelectorAll(".session-entry-main");
    expect(rows.length).toBe(2);
    // Both open sessions carry a primary-colored status dot on the right edge;
    // no MessageSquare icon anymore.
    rows.forEach((row) => {
      const dot = row.querySelector(".sidebar-status-dot");
      expect(dot).not.toBeNull();
      expect(dot?.className.split(/\s+/)).toContain("bg-primary");
      expect(dot).toHaveAttribute("aria-hidden", "true");
      // No lucide icon remains.
      expect(row.querySelector("svg.lucide-message-square")).toBeNull();
    });
  });

  it("session-entry-main has no status dot for a not-open persisted entry (ADR-0093, issue #511)", () => {
    const persisted: SessionMetadata = {
      recipe_path: "/x/closed.json",
      display_name: "Closed",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[persisted]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    // A not-open row has no status dot (ADR-0093: dot only when open).
    expect(container.querySelector(".sidebar-status-dot")).toBeNull();
  });

  it("session-entry-main keeps appearance-none reset + hover:bg-accent + rounded-md on the default row", () => {
    const persisted: SessionMetadata = {
      recipe_path: "/x/default.json",
      display_name: "Default",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[persisted]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const row = container.querySelector(".session-entry");
    expect(row?.className.split(/\s+/)).toContain("hover:bg-accent");
    expect(row?.className.split(/\s+/)).toContain("rounded-md");
    const main = container.querySelector(".session-entry-main");
    expect(main).not.toBeNull();
    const classes = main?.className.split(/\s+/);
    expect(classes).toContain("appearance-none");
    // The row li owns the hover background + radius (the absolute action
    // pill intercepts the pointer over the row tail); the main button keeps
    // only the reset + busy gating.
    expect(classes).not.toContain("hover:bg-accent");
    expect(classes).not.toContain("rounded-md");
    expect(classes).toContain("disabled:opacity-50");
    expect(classes).toContain("disabled:cursor-progress");
    // Default row is not open and not active — no accent tint, no inset bar
    // (ADR-0093 retired inset bars entirely).
    expect(classes).not.toContain("bg-primary");
    expect(classes).not.toContain("bg-accent");
    expect(classes).not.toContain("shadow-[inset_2px_0_var(--primary)]");
    // No title attribute (ADR-0093 retired the native tooltip).
    expect(main).not.toHaveAttribute("title");
  });

  // ADR-0093 (issue #511): the session-menu popover + danger item tests are
  // retired — the ⋯ context menu moved to .session-header (slice 2, #512).

  // ADR-0072 (issue #250): brand title row (product name left + circular
  // search magnifier right) + fused bg-secondary New icon button replace the
  // ADR-0060 full-width solid teal New button. ADR-0072 (issue
  // #252) wires the magnifier to the Ctrl/⌘+K modal.
  it("sidebar-brand-row shows TOPTOPDuck brand + circular search button that opens the modal on click (ADR-0072, issue #250/#252)", () => {
    const onOpenSearch = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={onOpenSearch}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const brandRow = container.querySelector(".sidebar-brand-row");
    expect(brandRow).not.toBeNull();
    // Brand name on the left (FormattedMessage -> TOPTOPDuck).
    const brand = brandRow?.querySelector(".sidebar-brand");
    expect(brand).not.toBeNull();
    expect(brand).toHaveTextContent("TOPTOPDuck");
    // Circular search button on the right; enabled (modal is wired). Clicking
    // fires onOpenSearch -- the same shell-owned open state the global Ctrl/⌘+K
    // keydown routes to (ADR-0072).
    const searchBtn = brandRow?.querySelector(".sidebar-search-button");
    expect(searchBtn).not.toBeNull();
    expect(searchBtn?.tagName).toBe("BUTTON");
    expect(searchBtn).not.toBeDisabled();
    expect(searchBtn?.className.split(/\s+/)).toContain("rounded-full");
    fireEvent.click(searchBtn as HTMLButtonElement);
    expect(onOpenSearch).toHaveBeenCalledOnce();
    const searchIcon = searchBtn?.querySelector("svg");
    expect(searchIcon).not.toBeNull();
    expect(searchIcon).toHaveClass("lucide-search");
    expect(searchIcon).toHaveAttribute("aria-hidden", "true");
  });

  it("sidebar-search-button is disabled when the shell is busy (issue #250)", () => {
    // busy shell -> disabled propagates to the search button (parity with the
    // New button / context-menu / grouping toggle): the modal must not open
    // mid-resume / mid-save.
    const onOpenSearch = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={true}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={onOpenSearch}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const searchBtn = container.querySelector(".sidebar-search-button") as HTMLButtonElement;
    expect(searchBtn).toBeDisabled();
    fireEvent.click(searchBtn);
    expect(onOpenSearch).not.toHaveBeenCalled();
  });

  it("sidebar-new-button is a fused bg-secondary Pencil + text button, not solid primary (ADR-0072, issue #250)", () => {
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const newBtn = container.querySelector(".sidebar-new-button");
    expect(newBtn).not.toBeNull();
    const classes = newBtn?.className.split(/\s+/);
    // ADR-0072 retires the ADR-0060 solid primary look: fused bg-secondary
    // (no border, no primary fill) + hover:bg-accent.
    expect(classes).toContain("bg-secondary");
    expect(classes).toContain("hover:bg-accent");
    expect(classes).not.toContain("bg-primary");
    expect(classes).not.toContain("text-primary-foreground");
    expect(classes).not.toContain("border-primary");
    // Pencil leading icon + the "New session" label text.
    const icon = newBtn?.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("lucide-pencil");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(newBtn).toHaveTextContent("New session");
  });
});

describe("SessionSidebar grouping toggle (ADR-0072, issue #251)", () => {
  // One persisted session so a group renders and the toggle's hover affordance
  // has an anchor (the first group-title row).
  function onePersisted(): SessionMetadata {
    return {
      recipe_path: "/x/solo.json",
      display_name: "Solo",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
  }

  it("keeps the chrome row on an empty sidebar (ADR-0127 all-archived escape)", () => {
    // ADR-0072 -> ADR-0127 recalibration: an empty sidebar renders no group
    // title, but the chrome row (grouping + archived toggles) still renders
    // on a bare title row -- an all-archived sidebar must keep the archived
    // view reachable, or the hidden rows would be stranded forever.
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    expect(container.querySelector(".sidebar-grouping-toggle")).not.toBeNull();
  });

  it("reveals the toggle on the first group-title row and opens the popover on click", () => {
    const onSwitchGrouping = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    // Exactly one toggle (on the first group title); flat mode renders one
    // "Recent" group, so the toggle sits on that row.
    const toggles = container.querySelectorAll(".sidebar-grouping-toggle");
    expect(toggles).toHaveLength(1);

    fireEvent.click(toggles[0] as HTMLButtonElement);

    // Two radio options render in the Radix Popover portal (mutually-exclusive
    // modes -> radio semantics). The flat option carries aria-checked=true (the
    // current mode) and the trailing Check glyph; the time option is unchecked.
    const flat = screen.getByRole("radio", { name: /In a list/i });
    const time = screen.getByRole("radio", { name: /By time/i });
    expect(flat).toHaveAttribute("aria-checked", "true");
    expect(time).toHaveAttribute("aria-checked", "false");
    expect(flat.querySelector("svg.lucide-check")).not.toBeNull();
    expect(time.querySelector("svg.lucide-check")).toBeNull();

    // Picking "By time" fires onSwitchGrouping("time") (the App wires the hook
    // that persists the change). pick() also closes the popover, so the second
    // option is asserted from a fresh render in the next test.
    fireEvent.click(time);
    expect(onSwitchGrouping).toHaveBeenCalledWith("time");
  });

  it("marks By time checked when grouping is time", () => {
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="time"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement);
    const flat = screen.getByRole("radio", { name: /In a list/i });
    const time = screen.getByRole("radio", { name: /By time/i });
    expect(flat).toHaveAttribute("aria-checked", "false");
    expect(time).toHaveAttribute("aria-checked", "true");
    expect(time.querySelector("svg.lucide-check")).not.toBeNull();
  });

  it("carries a focus-visible outline + weak default opacity so keyboard/touch users can discover it (issue #251 review)", () => {
    // The prior opacity-0 + group-hover-only pattern hid the trigger from
    // non-mouse users; opacity-60 keeps it weakly visible. bareButtonReset strips
    // the native focus ring, so focus-visible:outline-ring re-adds one (the
    // --ring token is the project focus-indicator standard).
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement;
    const classes = trigger.className.split(/\s+/);
    // Hover-revealed posture: hidden at rest, visible on keyboard focus.
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover:opacity-100");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-offset-2");
  });

  it("disables the trigger and refuses to open the popover when the shell is busy (issue #251 review)", () => {
    // busy shell -> disabled propagates to the trigger (button disabled) AND
    // the popover must not open (Radix does not activate a disabled trigger).
    // Matches the New button / context-menu disabled contract.
    const onSwitchGrouping = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={true}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement;
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("radio", { name: /In a list/i })).toBeNull();
    expect(onSwitchGrouping).not.toHaveBeenCalled();
  });

  it("closes the popover on Escape (keyboard dismiss, issue #251 review)", () => {
    // Radix Popover's onOpenChange(false) fires on Escape; this is the keyboard
    // dismiss path for AT users. fireEvent.keyDown mirrors the alert-dialog
    // Escape precedent (userEvent is not installed in this repo).
    const { container } = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement;
    fireEvent.click(trigger);
    const flat = screen.getByRole("radio", { name: /In a list/i });
    expect(flat).toBeInTheDocument();

    fireEvent.keyDown(flat, { key: "Escape" });
    expect(screen.queryByRole("radio", { name: /In a list/i })).toBeNull();
  });

  // ADR-0093 (issue #511): the context-menu click-away + Escape tests are
  // retired — the ⋯ context menu + its hand-positioned dismissal logic moved
  // to .session-header (slice 2, #512).
});

describe("SessionSidebar settings footer (issue #282)", () => {
  // The sidebar footer carries a single settings gear (the connection row was
  // removed from both views). The gear stays absent until app-config resolves.
  const footerProvider: ProviderConfig = {
    profiles: [
      {
        id: "default",
        display_name: "Anthropic",
        protocol: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-sonnet",
      },
    ],
    active_profile: "default",
  };

  function renderWithFooter({
    provider = footerProvider,
    onOpenSettings = vi.fn(),
  }: {
    provider?: ProviderConfig | null;
    onOpenSettings?: () => void;
  } = {}) {
    const result = renderShell(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onNewInWorkspace={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
        onOpenSearch={() => {}}
        provider={provider}
        onOpenSettings={onOpenSettings}
      />,
    );
    return { ...result, onOpenSettings };
  }

  it("renders the settings gear with the correct accessible name + icon", () => {
    renderWithFooter();
    const gear = screen.getByRole("button", { name: "Settings" });
    const icon = gear.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("lucide-settings");
  });

  it("opens settings on gear click", () => {
    const { onOpenSettings } = renderWithFooter();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("stays absent until app-config resolves (provider null; C1 render-when-ready)", () => {
    // The retired topbar gear carried a settingsDisabled gate; the footer
    // replaces it with absence -- no settings entry exists to open the
    // white-screen state (settings-mode shell + unmounted SettingsView) while
    // appConfig is null.
    const { container } = renderWithFooter({ provider: null });
    expect(container.querySelector(".sidebar-footer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});

describe("SessionSidebar pending-approval coloring (ADR-0083, issue #297)", () => {
  function baseProps() {
    return {
      collapsed: false,
      sessions: [] as SessionMetadata[],
      openSessions: twoOpenSessions(),
      activeSessionId: "sess-active",
      disabled: false,
      loadError: null,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
    };
  }

  it("tints the entry of a session with an unanswered approval (warning dot + sr-only + data hook)", () => {
    const { container } = renderShell(
      <SessionSidebar
        {...baseProps()}
        pendingApprovalSids={new Set(["sess-bg"])}
      />,
    );
    const entry = container.querySelector(".session-entry[data-pending-approval=\"true\"]");
    expect(entry).not.toBeNull();
    expect(entry?.className.split(/\s+/)).toContain("pending-approval");
    // The background session's row -- not the active one -- carries the mark.
    expect(entry?.querySelector(".session-name")?.textContent).toContain("Background");
    // ADR-0093 (issue #511): the status dot flips to warning color (was a
    // separate inline dot + inset bar; both replaced by the status dot).
    const dot = entry?.querySelector(".sidebar-status-dot");
    expect(dot).not.toBeNull();
    expect(dot?.className.split(/\s+/)).toContain("bg-warning");
    // The sr-only pending-approval text stays for assistive tech.
    expect(entry?.querySelector(".sr-only")?.textContent).toContain("awaiting approval");
    // No inset shadow on any row (ADR-0093 retired bars).
    const main = entry?.querySelector(".session-entry-main");
    expect(main?.className.split(/\s+/)).not.toContain("shadow-[inset_2px_0_var(--warning)]");
    // The active session has no pending approval: no mark on its row.
    expect(container.querySelector(".session-entry.active[data-pending-approval]")).toBeNull();
  });

  it("leaves every row unmarked when no session has a pending approval (default)", () => {
    const { container } = renderShell(<SessionSidebar {...baseProps()} />);
    expect(container.querySelector("[data-pending-approval]")).toBeNull();
    expect(container.querySelector(".bg-warning")).toBeNull();
  });
});

describe("SessionSidebar turn-failed coloring (issue #1005)", () => {
  function baseProps() {
    return {
      collapsed: false,
      sessions: [] as SessionMetadata[],
      openSessions: twoOpenSessions(),
      activeSessionId: "sess-active",
      disabled: false,
      loadError: null,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
    };
  }

  it("marks the entry of a session whose latest turn failed (destructive dot + sr-only + data hook)", () => {
    const { container } = renderShell(
      <SessionSidebar {...baseProps()} turnFailedSids={new Set(["sess-bg"])} />,
    );
    const entry = container.querySelector(".session-entry[data-turn-failed=\"true\"]");
    expect(entry).not.toBeNull();
    expect(entry?.className.split(/\s+/)).toContain("turn-failed");
    // The background session's row -- not the active one -- carries the mark.
    expect(entry?.querySelector(".session-name")?.textContent).toContain("Background");
    const dot = entry?.querySelector(".sidebar-status-dot");
    expect(dot?.className.split(/\s+/)).toContain("bg-destructive");
    // The sr-only failure text stays for assistive tech.
    expect(entry?.querySelector(".sr-only")?.textContent).toContain("last turn failed");
    // This set does not name the active session, so its row stays unmarked.
    expect(container.querySelector(".session-entry.active[data-turn-failed]")).toBeNull();
  });

  it("does not exempt the active row: a failed active session lights like any other", () => {
    const { container } = renderShell(
      <SessionSidebar {...baseProps()} turnFailedSids={new Set(["sess-active"])} />,
    );
    expect(
      container.querySelector(".session-entry.active[data-turn-failed=\"true\"]"),
    ).not.toBeNull();
  });

  it("gives the approval tint priority (classes coexist; the dot + label take the highest)", () => {
    const { container } = renderShell(
      <SessionSidebar
        {...baseProps()}
        pendingApprovalSids={new Set(["sess-bg"])}
        turnFailedSids={new Set(["sess-bg"])}
      />,
    );
    const entry = container.querySelector(".session-entry[data-turn-failed=\"true\"]");
    expect(entry).not.toBeNull();
    // Both state classes ride the row -- they are not mutually exclusive.
    const classes = entry?.className.split(/\s+/);
    expect(classes).toContain("pending-approval");
    expect(classes).toContain("turn-failed");
    // The dot + sr-only label take the higher-priority approval state.
    const dot = entry?.querySelector(".sidebar-status-dot");
    expect(dot?.className.split(/\s+/)).toContain("bg-warning");
    expect(dot?.className.split(/\s+/)).not.toContain("bg-destructive");
    expect(entry?.querySelector(".sr-only")?.textContent).toContain("awaiting approval");
  });

  it("leaves every row unmarked when no session's latest turn failed (default)", () => {
    const { container } = renderShell(<SessionSidebar {...baseProps()} />);
    expect(container.querySelector("[data-turn-failed]")).toBeNull();
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  it("clears all three marks together once the latest turn settles non-Failed", () => {
    // The full state flip in one row: class + dot + sr-only label + data
    // hook all ride the same prop, so the extinguish is one render away.
    const view = renderShell(
      <SessionSidebar {...baseProps()} turnFailedSids={new Set(["sess-bg"])} />,
    );
    expect(view.container.querySelector(".session-entry[data-turn-failed]")).not.toBeNull();
    view.rerender(shellTree(<SessionSidebar {...baseProps()} />));
    expect(view.container.querySelector("[data-turn-failed]")).toBeNull();
    expect(view.container.querySelector(".turn-failed")).toBeNull();
    expect(view.container.querySelector(".bg-destructive")).toBeNull();
    expect(view.container.querySelector(".sr-only")).toBeNull();
  });
});

describe("SessionSidebar hover card content (ADR-0093, issue #513)", () => {
  // Radix HoverCard opens on pointerEnter / focus after openDelay (300 ms). The
  // content renders inside a Radix Portal (document.body); React context
  // (IntlProvider) is preserved, so FormattedMessage + useIntl resolve to the
  // English defaultMessage (the test's IntlProvider carries an empty catalog).
  // Fake timers advance the 300 ms openDelay deterministically.

  afterEach(() => {
    vi.useRealTimers();
  });

  function sidebarProps(overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {}) {
    return {
      collapsed: false,
      sessions: [] as SessionMetadata[],
      openSessions: [] as OpenSession[],
      activeSessionId: null,
      disabled: false,
      loadError: null,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
      ...overrides,
    };
  }

  it("shows source summary + turn count when sourceCount > 0", async () => {
    const persisted: SessionMetadata = {
      recipe_path: "/x/sourced.json",
      display_name: "With Sources",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: "data.csv", source_count: 3, turn_count: 5 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    fireEvent.pointerEnter(container.querySelector(".session-entry")!);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    // Data source label + the pluralized summary (defaultMessage fallback).
    expect(screen.getByText("Data source")).toBeInTheDocument();
    expect(screen.getByText(/data\.csv/)).toBeInTheDocument();
    expect(screen.getByText(/3 sources/)).toBeInTheDocument();
    // Turns label + count (defaultMessage: "{count, plural, =0 {no turns} ...}").
    expect(screen.getByText("Turns")).toBeInTheDocument();
    expect(screen.getByText("5 turns")).toBeInTheDocument();
  });

  it("shows em-dash fallback for data source when sourceCount === 0", async () => {
    const persisted: SessionMetadata = {
      recipe_path: "/x/empty.json",
      display_name: "No Sources",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    fireEvent.pointerEnter(container.querySelector(".session-entry")!);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    // Data source value falls back to em-dash (the false arm of the ternary).
    expect(screen.getByText("Data source")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    // Turn count with 0 renders "no turns" (defaultMessage =0 arm).
    expect(screen.getByText("no turns")).toBeInTheDocument();
  });

  it("holds the card through the leave grace, cancels the close on card enter, closes on card leave", async () => {
    // Wiring pin (issue #1325): the row's pointerleave runs the 200 ms close
    // grace; a pointer sweeping onto the card itself cancels the pending
    // close (read-only per ADR-0127, but the pointer may rest there to
    // read); leaving the CARD schedules its own close -- the row-leave guard
    // cannot serve that path, the row's leave already ran.
    const persisted: SessionMetadata = {
      recipe_path: "/x/grace.json",
      display_name: "Grace Card",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    const row = container.querySelector<HTMLElement>(".session-entry")!;
    fireEvent.pointerEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();
    // Inside the 200 ms grace the card stays up.
    fireEvent.pointerLeave(row);
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();
    // Sweeping onto the card cancels the pending close.
    const card = screen.getByText("Data source").closest("[data-state=\"open\"]")!;
    fireEvent.pointerEnter(card);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();
    // Leaving the CARD schedules its own close.
    fireEvent.pointerLeave(card);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Data source")).toBeNull();
  });

  it("closes the card when the pointer leaves the whole list (backstop)", async () => {
    // Wiring pin (issue #1325): a pointerleave lost to the pill's
    // pointer-events toggling never reaches the row; the list-level leave is
    // the final backstop.
    const persisted: SessionMetadata = {
      recipe_path: "/x/backstop.json",
      display_name: "Backstop Card",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    const row = container.querySelector<HTMLElement>(".session-entry")!;
    const list = container.querySelector<HTMLElement>(".session-list")!;
    fireEvent.pointerEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();
    fireEvent.pointerLeave(list);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Data source")).toBeNull();
  });

  it("opening the row menu retires the hover metadata card", async () => {
    // The pointer necessarily dwelt on the row to reach the menu trigger,
    // so the card is necessarily open when the menu opens -- the two
    // row-tail overlays must not stack. The mocked trigger fires the
    // root's onOpenChange(true) (Radix's real contract), and the parent
    // machine answers by dropping the card.
    const persisted: SessionMetadata = {
      recipe_path: "/x/menudismiss.json",
      display_name: "Menu Dismiss",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: "data.csv", source_count: 1, turn_count: 2 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    const row = container.querySelector<HTMLElement>(".session-entry")!;
    fireEvent.pointerEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    expect(screen.queryByText("Data source")).not.toBeInTheDocument();
  });

  it("menu-trigger focus never re-opens the card (bridge exclusion)", async () => {
    // Real browsers focus the trigger on click, and Radix re-focuses it on
    // menu close; both bubble to the li, where the HoverCard wiring would
    // re-arm the 300 ms dwell and pop the card back over the open menu.
    // The trigger's own focus is a pill intent and must stop there.
    const persisted: SessionMetadata = {
      recipe_path: "/x/focusgate.json",
      display_name: "Focus Gate",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: "data.csv", source_count: 1, turn_count: 2 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...sidebarProps({ sessions: [persisted] })} />);
    const row = container.querySelector<HTMLElement>(".session-entry")!;
    fireEvent.pointerEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    const trigger = within(row).getByRole("button", { name: "Row actions" });
    fireEvent.click(trigger);
    expect(screen.queryByText("Data source")).not.toBeInTheDocument();

    // The close-restore (or click) focus lands here: no card may return.
    fireEvent.focus(trigger);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Data source")).not.toBeInTheDocument();
  });

  it("pointer-driven menu close strands no focus; keyboard close restores it", () => {
    // The mocked content captures onCloseAutoFocus (no close machinery of
    // its own). The close classification rides usePointerCloseIntent's
    // window-level capture: a pointerdown anywhere before the close marks
    // it pointer-driven -> the close-restore focus is refused; jsdom's
    // synthetic clicks fire no pointerdown, so without one the default
    // (keyboard) restore stands. (The Escape-clears-the-mark leg is pinned
    // by usePointerCloseIntent's own specs -- keydown clears, in either
    // order -- and is not re-pinned here.)
    const persisted: SessionMetadata = {
      recipe_path: "/x/closegate.json",
      display_name: "Close Gate",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 1 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace: null,
    };
    const { container } = renderShell(
      <SessionSidebar {...sidebarProps({ sessions: [persisted] })} />,
    );
    const trigger = within(
      container.querySelector<HTMLElement>(".session-entry")!,
    ).getByRole("button", { name: "Row actions" });

    // Keyboard close first: jsdom's synthetic click fires no pointerdown
    // -> restore stands.
    fireEvent.click(trigger);
    const preventDefault = vi.fn();
    menuClose.current?.({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();

    // Pointer close: a pointerdown (window capture -- a menu item select,
    // an outside dismiss, the trigger itself) arms it -> refused.
    fireEvent.pointerDown(window);
    menuClose.current?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe("DeleteSessionDialog ESC routing (issue #258)", () => {
  // AlertDialog blocks overlay-click dismiss (destructive guard) but ESC is a
  // deliberate keyboard signal; onOpenChange bridges ESC -> onCancel so parent
  // pendingAction stays in sync instead of dangling after Radix visually closes.
  it("routes ESC to onCancel so pendingAction does not dangle (issue #258)", () => {
    const onCancel = vi.fn();
    renderShell(
      <DeleteSessionDialog
        name="Session"
        onCancel={onCancel}
        onConfirm={() => {}}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
// --- ADR-0127 (issue #1175): pin / archive organization surface --------------

describe("SessionSidebar organization (ADR-0127, issue #1175)", () => {
  function orgProps(overrides: Record<string, unknown> = {}) {
    return {
      collapsed: false,
      sessions: [],
      openSessions: [],
      activeSessionId: null,
      disabled: false,
      loadError: null,
      grouping: "flat" as const,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
      ...overrides,
    };
  }

  function pinnedMeta(): SessionMetadata[] {
    // Server order: the pinned block rides first (array position = MRU), so
    // Pin Old (older mtime) precedes Pin New; the body follows mtime-desc.
    return [
      { recipe_path: "/x/p1.json", display_name: "Pin Old", last_modified_at: Date.now() - 3 * 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: true, archived: false, workspace: null },
      { recipe_path: "/x/p2.json", display_name: "Pin New", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: true, archived: false, workspace: null },
      { recipe_path: "/x/plain.json", display_name: "Plain", last_modified_at: Date.now(), source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: false, archived: false, workspace: null },
    ];
  }

  function sectionNames(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(".session-list > .session-group"),
    ).map((li) => li.dataset.section ?? "");
  }

  it("renders the pinned section above the grouped body in BOTH modes, server order (ADR-0127 Decision 5)", () => {
    for (const grouping of ["flat", "time"] as const) {
      const { container } = renderShell(
        <SessionSidebar {...orgProps({ sessions: pinnedMeta(), grouping })} />,
      );
      const sections = container.querySelectorAll<HTMLElement>(
        ".session-list > .session-group",
      );
      expect(sections[0].dataset.section).toBe("pinned");
      // Array order (Pin Old before Pin New), NOT mtime order.
      const names = Array.from(
        sections[0].querySelectorAll(".session-name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["Pin Old", "Pin New"]);
      // The permanent workspaces head sits between pinned and the body.
      expect(sections[1].dataset.section).toBe("workspaces");
      // The body keeps its own first section; the pinned rows are gone from it.
      expect(sections[2].dataset.section).not.toBe("pinned");
      const bodyNames = Array.from(
        sections[2].querySelectorAll(".session-name"),
      ).map((n) => n.textContent);
      expect(bodyNames).toEqual(["Plain"]);
    }
  });

  it("omits the pinned section when no rows are pinned (empty-collection rule)", () => {
    const sessions: SessionMetadata[] = [
      { recipe_path: "/x/plain.json", display_name: "Plain", last_modified_at: Date.now(), source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: false, archived: false, workspace: null },
    ];
    const { container } = renderShell(
      <SessionSidebar {...orgProps({ sessions })} />,
    );
    expect(sectionNames(container)).toEqual(["workspaces", "recent"]);
  });

  it("row-menu actions fire their callbacks WITHOUT activating the row (sibling trigger)", () => {
    const onActivate = vi.fn();
    const onOpenPersisted = vi.fn();
    const onSetPinned = vi.fn();
    const onArchive = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        {...orgProps({
          sessions: pinnedMeta(),
          onActivate,
          onOpenPersisted,
          onSetPinned,
          onArchive,
        })}
      />,
    );
    const rows = container.querySelectorAll<HTMLElement>(".session-entry");
    const plainRow = rows[rows.length - 1];
    // Pin the unpinned row; unpin the already-pinned row (item label flips).
    fireEvent.click(within(plainRow).getByRole("menuitem", { name: "Pin" }));
    expect(onSetPinned).toHaveBeenCalledWith("/x/plain.json", true);
    fireEvent.click(within(rows[0]).getByRole("menuitem", { name: "Unpin" }));
    expect(onSetPinned).toHaveBeenCalledWith("/x/p1.json", false);
    fireEvent.click(within(plainRow).getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith("/x/plain.json", true, null);
    // The main activate button never fired from any item click.
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpenPersisted).not.toHaveBeenCalled();
  });

  it("reveals the action group on hover OR focus-within (keyboard reachability)", () => {
    const { container } = renderShell(
      <SessionSidebar {...orgProps({ sessions: pinnedMeta() })} />,
    );
    const actions = container.querySelector(".session-entry-actions");
    expect(actions).not.toBeNull();
    const classes = actions?.className.split(/\s+/);
    // The WorkingSetList ROW_ACTIONS_OVERLAY posture: an absolute pill with
    // zero flex footprint (no squeezing the truncating session name), hidden
    // via opacity-0 + pointer-events-none, revealed on row hover or
    // focus-visible (opacity keeps the buttons in the tab order, unlike
    // visibility:hidden).
    expect(classes).toContain("absolute");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("pointer-events-none");
    expect(classes).toContain("group-hover/row:opacity-100");
    expect(classes).toContain("has-[:focus-visible]:opacity-100");
    // The complementary half: the inline relative-time label hides under the
    // SAME two conditions -- the pill's opaque ground is narrower than the
    // label, so the label would peek out beside the trigger otherwise.
    const time = container.querySelector<HTMLElement>(
      ".session-entry .tabular-nums",
    );
    expect(time).not.toBeNull();
    const timeClasses = time?.className.split(/\s+/);
    expect(timeClasses).toContain("group-hover/row:opacity-0");
    expect(timeClasses).toContain(
      "group-has-[.session-entry-actions_:focus-visible]/row:opacity-0",
    );
  });

  it("archived toggle carries aria-pressed and fires onToggleArchived", () => {
    const onToggleArchived = vi.fn();
    const { rerender } = renderShell(
      <SessionSidebar {...orgProps({ onToggleArchived })} />,
    );
    const toggle = screen.getByRole("button", {
      name: "Show archived sessions",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
    rerender(
      shellTree(
        <SessionSidebar {...orgProps({ showArchived: true, onToggleArchived })} />,
      ),
    );
    expect(
      screen.getByRole("button", { name: "Show archived sessions" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("archived section (visible): rows are greyed + non-activatable; restore + delete act; delete goes through the strong-confirm dialog", async () => {
    const onOpenPersisted = vi.fn();
    const onActivate = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const archived: SessionMetadata[] = [
      { recipe_path: "/x/arch.json", display_name: "Archived One", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 2 }, format_version: 1, pinned: false, archived: true, workspace: null },
    ];
    const { container } = renderShell(
      <SessionSidebar
        {...orgProps({
          sessions: pinnedMeta(),
          archivedSessions: archived,
          showArchived: true,
          onOpenPersisted,
          onActivate,
          onArchive,
          onDelete,
        })}
      />,
    );
    // The archived section rides BELOW the main sections.
    const names = sectionNames(container);
    expect(names.at(-1)).toBe("archived");
    const row = container.querySelector<HTMLElement>(
      ".session-group[data-section=\"archived\"] .session-entry",
    );
    expect(row?.classList.contains("archived")).toBe(true);
    // Non-activatable: the main button carries aria-disabled (NOT the
    // disabled attribute -- that would kill the HoverCard's pointer events in
    // real browsers) + a click does nothing.
    const main = row?.querySelector<HTMLButtonElement>(".session-entry-main");
    expect(main).toHaveAttribute("aria-disabled", "true");
    expect(main?.disabled).toBe(false);
    fireEvent.click(main!);
    expect(onOpenPersisted).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    // The HoverCard stays available on the archived row (ADR-0127 Decision 7:
    // read-only viewing is not activation). The trigger is the row li, so the
    // probe targets it (pointerenter does not bubble from the button).
    vi.useFakeTimers();
    fireEvent.pointerEnter(row!);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Data source")).toBeInTheDocument();
    vi.useRealTimers();
    // Restore takes the pure path (no sid to close).
    fireEvent.click(within(row!).getByRole("menuitem", { name: "Restore" }));
    expect(onArchive).toHaveBeenCalledWith("/x/arch.json", false, null);
    // Delete opens the strong-confirm dialog; only a confirm fires the mutation.
    fireEvent.click(within(row!).getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Archived One/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(row!).getByRole("menuitem", { name: "Delete" }));
    const dialog2 = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog2).getByRole("button", { name: "Delete permanently" }),
    );
    expect(onDelete).toHaveBeenCalledWith("/x/arch.json", null);
  });

  it("keeps the chrome row on an empty sidebar so the archived view stays reachable (all-archived escape)", () => {
    // With every session archived the default list is empty; without a
    // chrome anchor the archived toggle would be unfindable and the hidden
    // rows stranded behind it forever.
    const { container } = renderShell(<SessionSidebar {...orgProps()} />);
    expect(
      screen.getByRole("button", { name: "Show archived sessions" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".session-empty")).not.toBeNull();
  });
});

// --- ADR-0133 (issue #1319): the row-end actions menu -------------------------

describe("SessionSidebar row actions menu (ADR-0133, issue #1319)", () => {
  function menuProps(overrides: Record<string, unknown> = {}) {
    return {
      collapsed: false,
      // One open row (bound via openSessions) + one cold persisted row: the
      // item sets and the sid-bearing callbacks diverge between the two.
      sessions: [
        { recipe_path: "/x/open.json", display_name: "Open One", last_modified_at: Date.now(), source_summary: { first_source_name: null, source_count: 1, turn_count: 2 }, format_version: 1, pinned: false, archived: false, workspace: null },
        { recipe_path: "/x/cold.json", display_name: "Cold One", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: false, archived: false, workspace: null },
      ],
      openSessions: [
        { sid: "sess-1", name: "Open One", path: "/x/open.json", pendingIngestPaths: [], pendingQuestion: null, pendingSkillInvocations: [] },
      ],
      activeSessionId: null,
      disabled: false,
      loadError: null,
      grouping: "flat" as const,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
      ...overrides,
    };
  }

  function rowBy(container: HTMLElement, name: string) {
    const row = Array.from(
      container.querySelectorAll<HTMLElement>(".session-entry"),
    ).find((r) => r.querySelector(".session-name")?.textContent === name);
    expect(row).toBeDefined();
    return row!;
  }

  // The mock renders every row's menu content inline (always open), so the
  // queries are scoped per row.
  const itemNames = (row: HTMLElement) =>
    Array.from(within(row).getAllByRole("menuitem")).map(
      (item) => item.textContent,
    );

  it("open row carries Pin, Rename, Close, Archive, Delete; the persisted row drops Close", () => {
    const { container } = renderShell(<SessionSidebar {...menuProps()} />);
    expect(itemNames(rowBy(container, "Open One"))).toEqual([
      "Pin",
      "Rename",
      "Close",
      "Archive",
      "Delete",
    ]);
    expect(itemNames(rowBy(container, "Cold One"))).toEqual([
      "Pin",
      "Rename",
      "Archive",
      "Delete",
    ]);
    // The destructive variant is the destructive styling's only net (the
    // module mock does not render Radix's variant classes).
    expect(
      within(rowBy(container, "Open One")).getByRole("menuitem", {
        name: "Delete",
      }),
    ).toHaveAttribute("data-variant", "destructive");
  });

  it("archived row carries only Restore + Delete", () => {
    const archived: SessionMetadata[] = [
      { recipe_path: "/x/arch.json", display_name: "Archived One", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 2 }, format_version: 1, pinned: false, archived: true, workspace: null },
    ];
    const { container } = renderShell(
      <SessionSidebar
        {...menuProps({ archivedSessions: archived, showArchived: true })}
      />,
    );
    expect(itemNames(rowBy(container, "Archived One"))).toEqual([
      "Restore",
      "Delete",
    ]);
  });

  it("Close fires the shell callback with the sid directly (no dialog)", () => {
    const onClose = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onClose })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Open One")).getByRole("menuitem", {
        name: "Close",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("sess-1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Archive on an open row passes the sid so the shell closes it (ADR-0127 close-on-archive)", () => {
    const onArchive = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onArchive })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Open One")).getByRole("menuitem", {
        name: "Archive",
      }),
    );
    expect(onArchive).toHaveBeenCalledWith("/x/open.json", true, "sess-1");
  });

  it("Rename opens the dialog and submits with the row's path + open sid", async () => {
    const onRename = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onRename })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Open One")).getByRole("menuitem", {
        name: "Rename",
      }),
    );
    const input = await screen.findByLabelText("Session name");
    expect((input as HTMLInputElement).value).toBe("Open One");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).toHaveBeenCalledWith("/x/open.json", "sess-1", "Renamed");
  });

  it("Rename on a persisted row submits with a null sid", async () => {
    const onRename = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onRename })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Cold One")).getByRole("menuitem", {
        name: "Rename",
      }),
    );
    const input = await screen.findByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Cold Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).toHaveBeenCalledWith("/x/cold.json", null, "Cold Renamed");
  });

  it("Delete goes through the strong-confirm dialog and passes the open sid", async () => {
    const onDelete = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onDelete })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Open One")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Open One/)).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    expect(onDelete).toHaveBeenCalledWith("/x/open.json", "sess-1");
  });

  it("Delete cancel fires nothing", async () => {
    const onDelete = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ onDelete })} />,
    );
    fireEvent.click(
      within(rowBy(container, "Cold One")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("the busy gate disables the trigger (busy parity with the retired pill)", () => {
    const { container } = renderShell(
      <SessionSidebar {...menuProps({ disabled: true })} />,
    );
    expect(
      within(rowBy(container, "Open One")).getByRole("button", {
        name: "Row actions",
      }),
    ).toBeDisabled();
  });
});

// --- ADR-0127 (issue #1175): the archived section's render gating -------------

describe("SessionSidebar archived-view gating (issue #1175)", () => {
  it("renders the archived section only while showArchived is true, independent of the rows prop", () => {
    // Component-contract guard: the section's visibility is the component's
    // own gate on showArchived -- it must not depend on the caller keeping
    // archivedSessions empty while hidden.
    const archived: SessionMetadata = {
      recipe_path: "/x/arch.json",
      display_name: "Archived One",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: true,
      workspace: null,
    };
    const props = (showArchived: boolean) => ({
      collapsed: false,
      sessions: [] as SessionMetadata[],
      openSessions: [] as OpenSession[],
      activeSessionId: null,
      disabled: false,
      loadError: null,
      grouping: "flat" as const,
      onNew: () => {},
      onNewInWorkspace: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [archived],
      showArchived,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
    });
    const view = renderShell(<SessionSidebar {...props(false)} />);
    // Rows are present in the props but the view is hidden: no section.
    expect(view.container.querySelector("[data-section=\"archived\"]")).toBeNull();
    expect(screen.queryByText("Archived One")).toBeNull();
    // Flipping the toggle alone surfaces them (also pins the non-empty
    // collection's section rule).
    view.rerender(shellTree(<SessionSidebar {...props(true)} />));
    expect(view.container.querySelector("[data-section=\"archived\"]")).not.toBeNull();
    expect(screen.getByText("Archived One")).toBeInTheDocument();
  });
});

describe("SessionSidebar workspace section (issue #1392)", () => {
  function metaRow(
    path: string,
    name: string,
    workspace: string | null = null,
  ): SessionMetadata {
    return {
      recipe_path: path,
      display_name: name,
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
      workspace,
    };
  }

  function wsProps(
    overrides: Record<string, unknown> = {},
  ): ComponentProps<typeof SessionSidebar> {
    return {
      collapsed: false,
      sessions: [],
      openSessions: [],
      activeSessionId: null,
      disabled: false,
      loadError: null,
      grouping: "flat",
      archivedSessions: [],
      showArchived: false,
      onNew: () => {},
      onNewInWorkspace: vi.fn(),
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onRename: () => {},
      onClose: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
      ...overrides,
    } as ComponentProps<typeof SessionSidebar>;
  }

  it("renders explicit groups under a counted section head; implicit records never surface", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
      { path: "/w/implicit", label: "implicit", explicit: false, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    // The section head is permanent now, so waiting on IT would race the
    // listing query -- wait on the group row the record produces.
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    const section = container.querySelector(
      "[data-section=\"workspaces\"]",
    ) as HTMLElement;
    expect(section.textContent).toContain("explicit");
    expect(section.textContent).toContain("(1)");
    expect(section.textContent).not.toContain("implicit");
  });

  it("keeps a missing-directory group with the not-found hint", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/gone", label: "gone", explicit: true, exists: false },
    ]);
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/gone\"]"),
      ).not.toBeNull(),
    );
    expect(container.querySelector("[data-section=\"workspaces\"]")?.textContent).toContain(
      "Folder not found",
    );
  });

  it("expands the subtree into the SAME session rows the recent body renders", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar
        {...wsProps({ sessions: [metaRow("/a.json", "alpha", "/w/explicit")] })}
      />,
    );
    // The listing lands async: before it does, the row rides the recent
    // body; after, the bound row leaves the recent body entirely (the
    // subtree is its only face).
    const group = await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/explicit\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Collapsed by default: the member row is absent until the group row
    // (aria-expanded) toggles it open.
    expect(container.querySelector(".session-entry-main")).toBeNull();
    fireEvent.click(group);
    const row = container.querySelector(".session-entry-main .session-name");
    expect(row?.textContent).toContain("alpha");
  });

  it("keeps a session bound to a non-explicit workspace in the recent body", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
      { path: "/w/implicit", label: "implicit", explicit: false, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar
        {...wsProps({
          sessions: [
            metaRow("/a.json", "alpha", "/w/explicit"),
            metaRow("/i.json", "impl-row", "/w/implicit"),
          ],
        })}
      />,
    );
    // Waiting on the explicit group row means the listing query has landed:
    // the bound-to-explicit row left the recent body for its group, while
    // the non-explicit binding keeps its recent face (the partition's
    // implicit-workspace clause -- no group buckets it, ever).
    await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/explicit\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
    });
    const recent = container.querySelector(
      "[data-section=\"recent\"]",
    ) as HTMLElement;
    expect(recent.textContent).not.toContain("alpha");
    expect(recent.textContent).toContain("impl-row");
    expect(container.textContent).not.toContain("implicit");
  });

  it("an open bound session rides its group only; the refetch-window open stays recent", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const openRow = (sid: string, name: string, path: string) => ({
      sid,
      name,
      path,
      pendingIngestPaths: [],
      pendingQuestion: null,
      pendingSkillInvocations: [],
    });
    const view = renderShell(
      <SessionSidebar
        {...wsProps({
          sessions: [metaRow("/a.json", "alpha", "/w/explicit")],
          openSessions: [
            openRow("sid-a", "alpha", "/a.json"),
            openRow("sid-b", "freshie", "/fresh.json"),
          ],
        })}
      />,
    );
    const { container } = view;
    const group = await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/explicit\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // The bound open session's ONLY face is its workspace group: the recent
    // body must not resurrect it via the not-yet-persisted open loop (the
    // open-lifetime duplicate bug).
    const recent = container.querySelector(
      "[data-section=\"recent\"]",
    ) as HTMLElement;
    expect(recent.textContent).not.toContain("alpha");
    // The refetch-window open (its persisted scan hasn't landed) stays recent.
    expect(recent.textContent).toContain("freshie");
    // Collapsed by default: toggling reveals the group's face of alpha.
    fireEvent.click(group);
    expect(container.textContent).toContain("alpha");
    // The persisted scan lands with freshie bound: it leaves the recent
    // body for its group (the partition's transition half).
    view.rerender(
      shellTree(
        <SessionSidebar
          {...wsProps({
            sessions: [
              metaRow("/a.json", "alpha", "/w/explicit"),
              metaRow("/fresh.json", "freshie", "/w/explicit"),
            ],
            openSessions: [
              openRow("sid-a", "alpha", "/a.json"),
              openRow("sid-b", "freshie", "/fresh.json"),
            ],
          })}
        />,
      ),
    );
    await waitFor(() => {
      // The recent body is now empty: its content-driven section is gone
      // entirely (freshie left it for the group -- the departure half), and
      // the landed row arrived on its group face (the arrival half).
      expect(
        view.container.querySelector("[data-section=\"recent\"]"),
      ).toBeNull();
      expect(
        view.container.querySelector(
          "[data-workspace-group=\"/w/explicit\"]",
        )?.textContent,
      ).toContain("freshie");
    });
  });

  it("a session landing in a workspace opens its group", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const view = renderShell(<SessionSidebar {...wsProps()} />);
    const group = await waitFor(() => {
      const el = view.container.querySelector(
        "[data-workspace-group=\"/w/explicit\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(group).toHaveAttribute("aria-expanded", "false");
    // The listing lands with a new bound member: the group fans open on its
    // own -- the landed row visible without a manual toggle.
    view.rerender(
      shellTree(
        <SessionSidebar
          {...wsProps({ sessions: [metaRow("/a.json", "alpha", "/w/explicit")] })}
        />,
      ),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector(
          "[data-workspace-group=\"/w/explicit\"] [aria-expanded]",
        ),
      ).toHaveAttribute("aria-expanded", "true"),
    );
    expect(
      view.container.querySelector(
        "[data-workspace-group=\"/w/explicit\"] .session-entry-main",
      ),
    ).not.toBeNull();
  });

  it("heads the action buttons with tooltips and the diagonal expand glyphs", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const { container } = renderShell(<SessionSidebar {...wsProps()} />);
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    // Collapsed face: the outward 45° diagonal (Maximize2). The tooltip reuses
    // the aria-label entry -- the hover channel is the Radix pointer pair
    // (jsdom needs pointerType set explicitly; bare mouseEnter does not
    // trigger it -- the LocalCliTab pattern).
    const toggle = screen.getByRole("button", { name: "Expand all workspaces" });
    expect(toggle.querySelector(".lucide-maximize-2")).not.toBeNull();
    fireEvent.pointerEnter(toggle, { pointerType: "mouse" });
    fireEvent.pointerMove(toggle, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Expand all workspaces",
    );
    // Expand-all flips both faces: the inward diagonal (Minimize2) rides the
    // button and the tooltip re-labels to the collapse entry.
    fireEvent.click(toggle);
    const expanded = screen.getByRole("button", { name: "Collapse all workspaces" });
    expect(expanded.querySelector(".lucide-minimize-2")).not.toBeNull();
    expect(expanded.querySelector(".lucide-maximize-2")).toBeNull();
  });

  it("caps the subtree preview at 5 and expands the rest via Show more (N)", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/big", label: "big", explicit: true, exists: true },
    ]);
    const members = Array.from({ length: 7 }, (_, i) =>
      metaRow(`/m${i}.json`, `m${i}`, "/w/big"),
    );
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ sessions: members })} />,
    );
    const group = await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/big\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(group);
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    fireEvent.click(screen.getByText("Show more (2)"));
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(7);
  });

  it("collapse resets the preview: re-expanding shows the cap again", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/big", label: "big", explicit: true, exists: true },
    ]);
    const members = Array.from({ length: 7 }, (_, i) =>
      metaRow(`/m${i}.json`, `m${i}`, "/w/big"),
    );
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ sessions: members })} />,
    );
    const toggle = await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/big\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(toggle); // expand -> preview
    fireEvent.click(screen.getByText("Show more (2)")); // full list
    fireEvent.click(toggle); // collapse
    fireEvent.click(toggle); // expand again -> the preview, NOT the full list
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    expect(screen.getByText("Show more (2)")).toBeInTheDocument();
  });

  it("caps each recent-body group at 5 with the Show more tail", async () => {
    const members = Array.from({ length: 7 }, (_, i) =>
      metaRow(`/r${i}.json`, `r${i}`),
    );
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ sessions: members })} />,
    );
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    fireEvent.click(screen.getByText("Show more (2)"));
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(7);
  });

  it("wires the menu three-piece and the same-workspace new-session shortcut", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const onNewInWorkspace = vi.fn();
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ onNewInWorkspace })} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    // The menu rides the row-end pill; the mocked dropdown renders its
    // items inline, so the three pieces are queryable directly. The rename
    // modal goes LAST: an open Radix dialog hides the outside tree from
    // accessible queries (the portaled content is the only face).
    fireEvent.click(screen.getByRole("menuitem", { name: "Open folder" }));
    expect(openPath).toHaveBeenCalledWith("/w/explicit");
    vi.mocked(removeWorkspace).mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    // The staged confirm: the mutation waits for the dialog's Action.
    expect(
      await screen.findByText("Remove explicit?"),
    ).toBeInTheDocument();
    expect(removeWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeWorkspace).toHaveBeenCalledWith("/w/explicit"),
    );
    // The pill's plus stages the binding on the shell channel.
    fireEvent.click(
      screen.getByRole("button", { name: "New session in this workspace" }),
    );
    expect(onNewInWorkspace).toHaveBeenCalledWith("/w/explicit", "explicit");
    // Rename opens the modal pre-filled with the current label.
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", {
      name: "Workspace name",
    });
    expect(input).toHaveValue("explicit");
  });

  it("remove stages the strong-confirm; cancel keeps the record", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    vi.mocked(removeWorkspace).mockClear();
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    expect(await screen.findByText("Remove explicit?")).toBeInTheDocument();
    // Cancel (Radix auto-focuses it): the dialog drops, the record stays.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeWorkspace).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText("Remove explicit?")).toBeNull(),
    );
    // Re-opening the menu re-stages the confirm and the Action fires it.
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await screen.findByText("Remove explicit?");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeWorkspace).toHaveBeenCalledWith("/w/explicit"),
    );
  });

  it("folds the section from its head; the zero-group face shows the empty hint", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    const head = await screen.findByRole("button", { name: "Workspaces(1)" });
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(
      container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
    ).toBeNull();
    fireEvent.click(head);
    expect(
      container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
    ).not.toBeNull();
  });

  it("a zero-group section still renders the head with the empty hint", () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    renderShell(<SessionSidebar {...wsProps()} />);
    expect(
      screen.getByRole("button", { name: "Workspaces(0)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No sessions")).toBeInTheDocument();
  });

  it("collapsing the recent section resets its Show-more preview", () => {
    const members = Array.from({ length: 7 }, (_, i) =>
      metaRow(`/r${i}.json`, `r${i}`),
    );
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ sessions: members })} />,
    );
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    fireEvent.click(screen.getByText("Show more (2)"));
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(7);
    const head = screen.getByRole("button", { name: "Recent(7)" });
    fireEvent.click(head); // collapse
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(0);
    fireEvent.click(head); // expand again -> the cap, NOT the full list
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    expect(screen.getByText("Show more (2)")).toBeInTheDocument();
  });

  it("collapse-all resets every group's Show-more preview", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/big", label: "big", explicit: true, exists: true },
    ]);
    const members = Array.from({ length: 7 }, (_, i) =>
      metaRow(`/m${i}.json`, `m${i}`, "/w/big"),
    );
    const { container } = renderShell(
      <SessionSidebar {...wsProps({ sessions: members })} />,
    );
    const group = await waitFor(() => {
      const el = container.querySelector(
        "[data-workspace-group=\"/w/big\"] [aria-expanded]",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(group);
    fireEvent.click(screen.getByText("Show more (2)"));
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(7);
    // The bulk collapse must apply the same reset the single toggle does.
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse all workspaces" }),
    );
    fireEvent.click(group);
    expect(container.querySelectorAll(".session-entry-main")).toHaveLength(5);
    expect(screen.getByText("Show more (2)")).toBeInTheDocument();
  });

  it("the rename modal surfaces a refusal, guards Save, and submits the trimmed title", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", {
      name: "Workspace name",
    });
    // A backend refusal lands inline and keeps the modal open.
    vi.mocked(renameWorkspace).mockRejectedValueOnce(
      new Error("no workspace record for /w/explicit"),
    );
    fireEvent.change(input, { target: { value: "  renamed  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("no workspace record for /w/explicit"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    // The shared guard keeps the Save button honest.
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Back to a valid name: the retry (now resolving) submits the TRIMMED
    // title and the success closes the modal.
    fireEvent.change(input, { target: { value: "  renamed  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(renameWorkspace).toHaveBeenCalledWith("/w/explicit", "renamed"),
    );
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("the head's New workspace modal creates with the trimmed name and the group lands via the listing", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
    ]);
    const { container } = renderShell(
      <SessionSidebar {...wsProps()} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/explicit\"]"),
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const input = await screen.findByRole("textbox", {
      name: "Workspace name",
    });
    fireEvent.change(input, { target: { value: "  fresh  " } });
    // The post-create refetch returns the grown registry -- the group must
    // arrive through the invalidation channel, not local state.
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/explicit", label: "explicit", explicit: true, exists: true },
      { path: "/w/fresh", label: "fresh", explicit: true, exists: true },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("fresh"));
    await waitFor(() =>
      expect(
        container.querySelector("[data-workspace-group=\"/w/fresh\"]"),
      ).not.toBeNull(),
    );
  });
});
