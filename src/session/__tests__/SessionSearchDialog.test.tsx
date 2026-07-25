import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { SessionSearchDialog } from "../SessionSearchDialog";
import { renderI18n } from "../../components/common/__tests__/helpers";
import type { OpenSession } from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";

// Component-level tests for the Ctrl/⌘+K session-search modal (ADR-0072
// Decision 1, issue #252). The pure filter/sort contract is covered in
// sidebarModel.test.ts; these tests cover the React-layer behavior the pure
// helper cannot pin: open/close rendering, typing → filter, keyboard nav, and
// the activate-vs-resume choose contract.

function meta(
  path: string,
  name: string,
  opts: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    session_id: path,
    display_name: name,
    last_modified_at: opts.last_modified_at ?? Date.now(),
    source_summary: opts.source_summary ?? {
      first_source_name: `${name}_src`,
      source_count: 1,
      turn_count: 1,
    },
    format_version: opts.format_version ?? 2,
  };
}

// The dialog content renders inside a Radix portal at document.body, so all
// queries go through `screen` (not container). The empty-catalog English
// provider keeps the render quiet; missing-message warnings are expected.
function renderDialog(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  openSessions: [] as OpenSession[],
  activeSessionId: null,
  onActivate: vi.fn(),
  onOpenPersisted: vi.fn(),
};

describe("SessionSearchDialog (ADR-0072, issue #252)", () => {
  it("does not render the dialog when open is false", () => {
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        open={false}
        sessions={[meta("/a.duck", "alpha")]}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the input + every persisted session (mtime desc) when open with an empty query", () => {
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 2000 }),
          meta("/b.duck", "beta", { last_modified_at: 1000 }),
        ]}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // Both sessions render as listbox options; alpha (fresher) first.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("alpha");
    expect(options[1]).toHaveTextContent("beta");
  });

  it("filters case-insensitively on display_name and first_source_name", () => {
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[
          meta("/a.duck", "alpha", {
            source_summary: { first_source_name: "alpha_src", source_count: 1, turn_count: 1 },
          }),
          meta("/b.duck", "beta", {
            source_summary: { first_source_name: "beta_src", source_count: 1, turn_count: 1 },
          }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox") as HTMLInputElement;
    // Display-name hit (case-insensitive).
    fireEvent.change(input, { target: { value: "ALP" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("alpha"),
    ]);
    // First-source-name hit.
    fireEvent.change(input, { target: { value: "BETA_SRC" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("beta"),
    ]);
  });

  it("renders the empty state when the query matches nothing", () => {
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[meta("/a.duck", "alpha")]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.queryByRole("option")).toBeNull();
    // The empty-state copy comes from sidebar.search.empty (en defaultMessage
    // surfaces when the catalog is empty, as in the test provider).
    expect(screen.getByText("No matching sessions.")).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp move the selection; Enter activates the highlighted row", () => {
    const onActivate = vi.fn();
    const onOpenPersisted = vi.fn();
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        onActivate={onActivate}
        onOpenPersisted={onOpenPersisted}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 2000 }),
          meta("/b.duck", "beta", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox");
    // Default selection is index 0 (alpha); arrow down moves to beta.
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    // Enter on beta (cold persisted row) -> onOpenPersisted with path + name.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenPersisted).toHaveBeenCalledWith("/b.duck", "beta");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("Enter on an open binding activates by sid instead of re-resuming", () => {
    // A persisted row that is open in this shell carries its runtime sid; the
    // modal mirrors the sidebar row contract and activates by sid.
    const onActivate = vi.fn();
    const onOpenPersisted = vi.fn();
    const openSessions: OpenSession[] = [
      { sid: "uuid-a", name: "alpha", path: "/a.duck", pendingIngestPath: null },
    ];
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        openSessions={openSessions}
        activeSessionId="uuid-a"
        onActivate={onActivate}
        onOpenPersisted={onOpenPersisted}
        sessions={[meta("/a.duck", "alpha")]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("uuid-a");
    expect(onOpenPersisted).not.toHaveBeenCalled();
  });

  it("clicking an option chooses it (activate-by-sid for an open binding)", () => {
    const onActivate = vi.fn();
    const onOpenPersisted = vi.fn();
    const openSessions: OpenSession[] = [
      { sid: "uuid-a", name: "alpha", path: "/a.duck", pendingIngestPath: null },
    ];
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        openSessions={openSessions}
        onActivate={onActivate}
        onOpenPersisted={onOpenPersisted}
        sessions={[meta("/a.duck", "alpha")]}
      />,
    );
    fireEvent.click(screen.getByRole("option"));
    expect(onActivate).toHaveBeenCalledWith("uuid-a");
  });

  it("resets the query and selection when reopened", () => {
    // A prior query from an earlier open must not leak into the next open: the
    // dialog always starts from a clean slate (empty query, first row selected).
    const { rerender } = renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[meta("/a.duck", "alpha"), meta("/b.duck", "beta")]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    // Close + reopen with the same mounted component instance.
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <SessionSearchDialog
          {...baseProps}
          open={false}
          sessions={[meta("/a.duck", "alpha"), meta("/b.duck", "beta")]}
        />
      </IntlProvider>,
    );
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <SessionSearchDialog
          {...baseProps}
          open={true}
          sessions={[meta("/a.duck", "alpha"), meta("/b.duck", "beta")]}
        />
      </IntlProvider>,
    );
    // Empty query -> both sessions back; selection back at index 0.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ESC dismisses via Radix Dialog's onOpenChange(false)", async () => {
    // Radix routes ESC through onOpenChange(false); the modal does not handle
    // ESC itself, so this pins that the primitive's contract is what closes it.
    const onOpenChange = vi.fn();
    renderI18n(
      <SessionSearchDialog
        {...baseProps}
        onOpenChange={onOpenChange}
        sessions={[meta("/a.duck", "alpha")]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
