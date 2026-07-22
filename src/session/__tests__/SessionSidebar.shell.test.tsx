import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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
  it("session-entry.active lifts bg-primary + text-primary-foreground + font-semibold", () => {
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
      />,
    );
    const active = container.querySelector(".session-entry.active .session-entry-main");
    expect(active).not.toBeNull();
    const classes = active?.className.split(/\s+/);
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
    expect(classes).toContain("font-semibold");
  });

  it("session-entry.open:not(.active) lifts the left accent shadow", () => {
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
      />,
    );
    const bg = container.querySelector(".session-entry.open:not(.active) .session-entry-main");
    expect(bg).not.toBeNull();
    expect(bg?.className.split(/\s+/)).toContain("shadow-[inset_2px_0_var(--primary)]");
    expect(bg?.className.split(/\s+/)).not.toContain("bg-primary");
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
    expect(classes).not.toContain("bg-primary");
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
      />,
    );
    fireEvent.click(container.querySelector(".session-entry-menu") as HTMLButtonElement);
    const danger = container.querySelector(".session-menu button.danger");
    expect(danger).not.toBeNull();
    expect(danger?.className.split(/\s+/)).toContain("text-destructive");
  });
});
