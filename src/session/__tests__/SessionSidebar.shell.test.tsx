import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { DeleteSessionDialog, SessionSidebar } from "../SessionSidebar";
import type { OpenSession } from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";
import type { ProviderConfig } from "../../types/provider";
import { TooltipProvider } from "@/components/ui/tooltip";

// Shell-skeleton tests assert className contracts, not chrome. An empty English
// provider + onError keeps the render quiet (missing-message warnings are
// expected -- the catalog is intentionally empty). Named renderShell (not
// renderSettings) to avoid a cross-domain name clash with the settings
// domain's renderSettings helper. TooltipProvider mirrors the App ancestor
// (the connection footer's dual-state gear carries a Tooltip, issue #282).
function renderShell(ui: ReactElement) {
  return render(
    <TooltipProvider>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>{ui}</IntlProvider>
    </TooltipProvider>,
  );
}

// Two never-saved open sessions: the active one carries .active.open; the other
// carries .open:not(.active). Both land in the Today group (buildSidebarModel
// stamps `now` for unsaved sessions).
function twoOpenSessions(): OpenSession[] {
  return [
    { sid: "sess-active", name: "Active", path: "/sessions/sess-active/session.duck", pendingIngestPaths: [], pendingQuestion: null, pendingSkillInvocations: [] },
    { sid: "sess-bg", name: "Background", path: "/sessions/sess-bg/session.duck", pendingIngestPaths: [], pendingQuestion: null, pendingSkillInvocations: [] },
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
      duck_path: "/x/closed.duck",
      display_name: "Closed",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
      duck_path: "/x/default.duck",
      display_name: "Default",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
      duck_path: "/x/solo.duck",
      display_name: "Solo",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
        onOpenSearch={() => {}}
        provider={null}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement;
    const classes = trigger.className.split(/\s+/);
    expect(classes).toContain("opacity-60");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-offset-2");
    expect(classes).not.toContain("opacity-0");
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
        onOpenDuck={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        archivedSessions={[]}
        showArchived={false}
        onToggleArchived={() => {}}
        onSetPinned={() => {}}
        onArchive={() => {}}
        onDeleteArchived={() => {}}
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
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
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
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
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
    view.rerender(
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <SessionSidebar {...baseProps()} />
        </IntlProvider>
      </TooltipProvider>,
    );
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
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      grouping: "flat" as const,
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
      ...overrides,
    };
  }

  it("shows source summary + turn count when sourceCount > 0", async () => {
    const persisted: SessionMetadata = {
      duck_path: "/x/sourced.duck",
      display_name: "With Sources",
      last_modified_at: Date.now() - 3 * 3600_000,
      source_summary: { first_source_name: "data.csv", source_count: 3, turn_count: 5 },
      format_version: 1,
      pinned: false,
      archived: false,
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
      duck_path: "/x/empty.duck",
      display_name: "No Sources",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
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
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
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
      { duck_path: "/x/p1.duck", display_name: "Pin Old", last_modified_at: Date.now() - 3 * 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: true, archived: false },
      { duck_path: "/x/p2.duck", display_name: "Pin New", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: true, archived: false },
      { duck_path: "/x/plain.duck", display_name: "Plain", last_modified_at: Date.now(), source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: false, archived: false },
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
      // The body keeps its own first section; the pinned rows are gone from it.
      expect(sections[1].dataset.section).not.toBe("pinned");
      const bodyNames = Array.from(
        sections[1].querySelectorAll(".session-name"),
      ).map((n) => n.textContent);
      expect(bodyNames).toEqual(["Plain"]);
    }
  });

  it("omits the pinned section when no rows are pinned (empty-collection rule)", () => {
    const sessions: SessionMetadata[] = [
      { duck_path: "/x/plain.duck", display_name: "Plain", last_modified_at: Date.now(), source_summary: { first_source_name: null, source_count: 0, turn_count: 1 }, format_version: 1, pinned: false, archived: false },
    ];
    const { container } = renderShell(
      <SessionSidebar {...orgProps({ sessions })} />,
    );
    expect(sectionNames(container)).toEqual(["recent"]);
  });

  it("trailing actions fire their callbacks WITHOUT activating the row (sibling buttons)", () => {
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
    // Pin the unpinned row; unpin the already-pinned row (label flips).
    fireEvent.click(within(plainRow).getByRole("button", { name: "Pin" }));
    expect(onSetPinned).toHaveBeenCalledWith("/x/plain.duck", true);
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Unpin" }));
    expect(onSetPinned).toHaveBeenCalledWith("/x/p1.duck", false);
    fireEvent.click(within(plainRow).getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith("/x/plain.duck", true, null);
    // The main activate button never fired from any action click.
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
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <SessionSidebar {...orgProps({ showArchived: true, onToggleArchived })} />
        </IntlProvider>
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Show archived sessions" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("archived section (visible): rows are greyed + non-activatable; restore + delete act; delete goes through the strong-confirm dialog", async () => {
    const onOpenPersisted = vi.fn();
    const onActivate = vi.fn();
    const onArchive = vi.fn();
    const onDeleteArchived = vi.fn();
    const archived: SessionMetadata[] = [
      { duck_path: "/x/arch.duck", display_name: "Archived One", last_modified_at: Date.now() - 86_400_000, source_summary: { first_source_name: null, source_count: 0, turn_count: 2 }, format_version: 1, pinned: false, archived: true },
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
          onDeleteArchived,
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
    fireEvent.click(within(row!).getByRole("button", { name: "Restore" }));
    expect(onArchive).toHaveBeenCalledWith("/x/arch.duck", false, null);
    // Delete opens the strong-confirm dialog; only a confirm fires the mutation.
    fireEvent.click(within(row!).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Archived One/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDeleteArchived).not.toHaveBeenCalled();
    fireEvent.click(within(row!).getByRole("button", { name: "Delete" }));
    const dialog2 = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog2).getByRole("button", { name: "Delete permanently" }),
    );
    expect(onDeleteArchived).toHaveBeenCalledWith("/x/arch.duck");
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

// --- ADR-0127 (issue #1175): the single-flight hover machine ------------------

describe("SessionSidebar single-flight hover machine (issue #1175)", () => {
  // One card max, parent-owned: the machine's transitions -- retire on
  // foreign enter, 200 ms close grace, card-enter cancel, list-leave
  // backstop, stale-leave guard -- are pinned with fake timers. The card's
  // display name renders in a <p> (the row's name is a <span>), so the
  // p-selector tells WHICH card is mounted without colliding with the row.

  afterEach(() => {
    vi.useRealTimers();
  });

  function meta(path: string, name: string): SessionMetadata {
    return {
      duck_path: path,
      display_name: name,
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: false,
    };
  }

  function hoverProps() {
    const base = {
      collapsed: false,
      openSessions: [] as OpenSession[],
      activeSessionId: null,
      disabled: false,
      loadError: null as string | null,
      grouping: "flat" as const,
      onNew: () => {},
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [] as SessionMetadata[],
      showArchived: false,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
      onOpenSearch: () => {},
      provider: null,
      onOpenSettings: () => {},
    };
    return {
      ...base,
      sessions: [meta("/x/a.duck", "Row A"), meta("/x/b.duck", "Row B")],
    };
  }

  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll(".session-entry")) as HTMLElement[];
  }

  it("retires the shown card the moment a different row is entered, before its own dwell", async () => {
    // The retire line is the sweep fix: without it the OLD card stays on
    // screen the whole time the pointer travels (every enter cancels the
    // pending close; the new card only opens after its own 300 ms dwell).
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...hoverProps()} />);
    const [a, b] = rows(container);

    fireEvent.pointerEnter(a);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Row A", { selector: "p" })).toBeInTheDocument();

    fireEvent.pointerEnter(b);
    // NO timer advance: A's card must be gone immediately...
    expect(screen.queryByText("Row A", { selector: "p" })).toBeNull();
    // ...and B's card opens only after its own dwell.
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByText("Row B", { selector: "p" })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Row B", { selector: "p" })).toBeInTheDocument();
  });

  it("honors the 200 ms close grace, and entering the card cancels the close", async () => {
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...hoverProps()} />);
    const [a] = rows(container);

    fireEvent.pointerEnter(a);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Row A", { selector: "p" })).toBeInTheDocument();

    // Leave the row: the grace window keeps the card readable...
    fireEvent.pointerLeave(a);
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByText("Row A", { selector: "p" })).toBeInTheDocument();
    // ...and sweeping onto the card itself cancels the pending close
    // (read-only per ADR-0127, but the pointer may rest there to read).
    const card = screen.getByText("Data source").closest("[data-state=\"open\"]")!;
    fireEvent.pointerEnter(card);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText("Row A", { selector: "p" })).toBeInTheDocument();
    // Leaving the CARD schedules its own close (the row-leave guard cannot
    // serve this path -- the row's leave already ran).
    fireEvent.pointerLeave(card);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Row A", { selector: "p" })).toBeNull();
  });

  it("closes the card when the pointer leaves the whole list (backstop)", async () => {
    // A pointerleave lost to the pill's pointer-events toggling never
    // reaches the row; the list-level leave is the final backstop.
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...hoverProps()} />);
    const [a] = rows(container);
    const list = container.querySelector(".session-list")!;

    fireEvent.pointerEnter(a);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText("Row A", { selector: "p" })).toBeInTheDocument();
    fireEvent.pointerLeave(list);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Row A", { selector: "p" })).toBeNull();
  });

  it("ignores a stale leave from a row the pointer already left", async () => {
    // After A -> B, a late leave of A must not clear B's pending open (the
    // stale-key guard); B's card still opens on schedule.
    vi.useFakeTimers();
    const { container } = renderShell(<SessionSidebar {...hoverProps()} />);
    const [a, b] = rows(container);

    fireEvent.pointerEnter(a);
    fireEvent.pointerLeave(a);
    fireEvent.pointerEnter(b);
    // Stale: the pointer's tracked row is B now.
    fireEvent.pointerLeave(a);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Row B", { selector: "p" })).toBeInTheDocument();
  });
});

// --- ADR-0127 (issue #1175): the archived section's render gating -------------

describe("SessionSidebar archived-view gating (issue #1175)", () => {
  it("renders the archived section only while showArchived is true, independent of the rows prop", () => {
    // Component-contract guard: the section's visibility is the component's
    // own gate on showArchived -- it must not depend on the caller keeping
    // archivedSessions empty while hidden.
    const archived: SessionMetadata = {
      duck_path: "/x/arch.duck",
      display_name: "Archived One",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
      pinned: false,
      archived: true,
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
      onOpenDuck: () => {},
      onActivate: () => {},
      onOpenPersisted: () => {},
      onSwitchGrouping: () => {},
      archivedSessions: [archived],
      showArchived,
      onToggleArchived: () => {},
      onSetPinned: () => {},
      onArchive: () => {},
      onDeleteArchived: () => {},
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
    view.rerender(
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <SessionSidebar {...props(true)} />
        </IntlProvider>
      </TooltipProvider>,
    );
    expect(view.container.querySelector("[data-section=\"archived\"]")).not.toBeNull();
    expect(screen.getByText("Archived One")).toBeInTheDocument();
  });
});
