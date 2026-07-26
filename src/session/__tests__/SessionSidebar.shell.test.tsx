import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { SessionSidebar } from "../SessionSidebar";
import type { OpenSession } from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";

// Shell-skeleton tests assert className contracts, not chrome. An empty English
// provider + onError keeps the render quiet (missing-message warnings are
// expected -- the catalog is intentionally empty). Named renderShell (not
// renderSettings) to avoid a cross-domain name clash with the settings
// domain's renderSettings helper.
function renderShell(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

// Two never-saved open sessions: the active one carries .active.open; the other
// carries .open:not(.active). Both land in the Today group (buildSidebarGroups
// stamps `now` for unsaved sessions).
function twoOpenSessions(): OpenSession[] {
  return [
    { sid: "sess-active", name: "Active", path: null, pendingIngestPath: null },
    { sid: "sess-bg", name: "Background", path: null, pendingIngestPath: null },
  ];
}

describe("SessionSidebar shell-skeleton visuals (ADR-0067, issue #171)", () => {
  it("session-entry.active lifts bg-accent + text-accent-foreground + left inset bar + aria-current (ADR-0072, issue #249)", () => {
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    const active = container.querySelector(".session-entry.active .session-entry-main");
    expect(active).not.toBeNull();
    const classes = active?.className.split(/\s+/);
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("text-accent-foreground");
    expect(classes).toContain("shadow-[inset_2px_0_var(--primary)]");
    expect(classes).not.toContain("bg-primary");
    expect(classes).not.toContain("text-primary-foreground");
    expect(classes).not.toContain("font-semibold");
    // The tint is decorative; aria-current is the active row's AT signal.
    expect(active).toHaveAttribute("aria-current", "true");
  });

  it("session-entry.open:not(.active) lifts the left accent shadow with no tint (ADR-0072, issue #249)", () => {
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    const bg = container.querySelector(".session-entry.open:not(.active) .session-entry-main");
    expect(bg).not.toBeNull();
    const classes = bg?.className.split(/\s+/);
    expect(classes).toContain("shadow-[inset_2px_0_var(--primary)]");
    // The tint is active-only: an open-but-background row carries just the bar.
    expect(classes).not.toContain("bg-accent");
    expect(classes).not.toContain("text-accent-foreground");
    // Only the active row carries aria-current.
    expect(bg).not.toHaveAttribute("aria-current");
  });

  it("session-entry-main renders a leading MessageSquare icon on every row (ADR-0072, issue #249)", () => {
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    const rows = container.querySelectorAll(".session-entry-main");
    expect(rows.length).toBe(2);
    rows.forEach((row) => {
      const first = row.firstElementChild;
      expect(first).not.toBeNull();
      // Verifying the FIRST child is the svg proves the "leading" claim --
      // a count alone would miss a reordering. Decorative (aria-hidden) since
      // the session name is the accessible label.
      if (!first) return;
      expect(first.tagName).toBe("svg");
      expect(first).toHaveClass("lucide-message-square");
      expect(first).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("session-entry-main keeps [all:unset] + hover:bg-accent + rounded-md on the default row", () => {
    const persisted: SessionMetadata = {
      session_id: "/x/default.duck",
      display_name: "Default",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
    };
    const { container } = renderShell(
      <SessionSidebar
        sessions={[persisted]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    const main = container.querySelector(".session-entry-main");
    expect(main).not.toBeNull();
    const classes = main?.className.split(/\s+/);
    expect(classes).toContain("[all:unset]");
    expect(classes).toContain("hover:bg-accent");
    expect(classes).toContain("rounded-md");
    expect(classes).toContain("disabled:opacity-50");
    expect(classes).toContain("disabled:cursor-progress");
    // Default row is not open and not active, so it carries neither the tint
    // (bg-accent, active-only since ADR-0072) nor the left bar (entry.sid-only).
    expect(classes).not.toContain("bg-primary");
    expect(classes).not.toContain("bg-accent");
    expect(classes).not.toContain("shadow-[inset_2px_0_var(--primary)]");
  });

  it("session-menu popover carries absolute + bg-card + shadow + border", () => {
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={twoOpenSessions()}
        activeSessionId="sess-active"
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".session-entry-menu") as HTMLButtonElement);
    const menu = container.querySelector(".session-menu");
    expect(menu).not.toBeNull();
    const classes = menu?.className.split(/\s+/);
    expect(classes).toContain("absolute");
    expect(classes).toContain("bg-card");
    expect(classes).toContain("border");
    expect(classes).toContain("border-border");
    expect(classes).toContain("shadow-md");
  });

  it("session-menu danger item lifts text-destructive (retires .session-menu button.danger)", () => {
    const persisted: SessionMetadata = {
      session_id: "/x/persisted.duck",
      display_name: "Persisted",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
    };
    const { container } = renderShell(
      <SessionSidebar
        sessions={[persisted]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".session-entry-menu") as HTMLButtonElement);
    const danger = container.querySelector(".session-menu button.danger");
    expect(danger).not.toBeNull();
    expect(danger?.className.split(/\s+/)).toContain("text-destructive");
  });

  // ADR-0072 (issue #250): brand title row (product name left + circular
  // search magnifier right) + fused bg-secondary New icon button replace the
  // ADR-0060 full-width solid teal New button. ADR-0072 (issue
  // #252) wires the magnifier to the Ctrl/⌘+K modal.
  it("sidebar-brand-row shows TOPTOPDuck brand + circular search button that opens the modal on click (ADR-0072, issue #250/#252)", () => {
    const onOpenSearch = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={onOpenSearch}
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

  it("sidebar-search-button is disabled when the shell is busy (issue #252)", () => {
    // busy shell -> disabled propagates to the search button (parity with the
    // New button / context-menu / grouping toggle): the modal must not open
    // mid-resume / mid-save.
    const onOpenSearch = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={true}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={onOpenSearch}
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
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        grouping="flat"
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
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
      session_id: "/x/solo.duck",
      display_name: "Solo",
      last_modified_at: Date.now(),
      source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
      format_version: 1,
    };
  }

  it("hides the grouping toggle on an empty sidebar (no group title to anchor it)", () => {
    // ADR-0072: empty sidebar renders no group title, so the toggle's hover
    // affordance has no anchor -- the empty-state row renders instead.
    const { container } = renderShell(
      <SessionSidebar
        sessions={[]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    expect(container.querySelector(".sidebar-grouping-toggle")).toBeNull();
  });

  it("reveals the toggle on the first group-title row and opens the popover on click", () => {
    const onSwitchGrouping = vi.fn();
    const { container } = renderShell(
      <SessionSidebar
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        onOpenSearch={() => {}}
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
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="time"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
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
    // non-mouse users; opacity-60 keeps it weakly visible. `[all:unset]` strips
    // the native focus ring, so focus-visible:outline-ring re-adds one (the
    // --ring token is the project focus-indicator standard).
    const { container } = renderShell(
      <SessionSidebar
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
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
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={true}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={onSwitchGrouping}
        onOpenSearch={() => {}}
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
        sessions={[onePersisted()]}
        openSessions={[]}
        activeSessionId={null}
        disabled={false}
        loadError={null}
        grouping="flat"
        onNew={() => {}}
        onActivate={() => {}}
        onOpenPersisted={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onSwitchGrouping={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    const trigger = container.querySelector(".sidebar-grouping-toggle") as HTMLButtonElement;
    fireEvent.click(trigger);
    const flat = screen.getByRole("radio", { name: /In a list/i });
    expect(flat).toBeInTheDocument();

    fireEvent.keyDown(flat, { key: "Escape" });
    expect(screen.queryByRole("radio", { name: /In a list/i })).toBeNull();
  });
});
