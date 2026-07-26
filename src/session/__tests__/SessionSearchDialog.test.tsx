import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { SessionSearchDialog } from "../SessionSearchDialog";
import { renderI18n } from "../../components/common/__tests__/helpers";
import type { OpenSession } from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";

// Component-level tests for the Ctrl/⌘+K session-search modal (ADR-0072,
// issue #252). The pure filter/sort contract is covered in
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
    // The empty state is a sibling <p role="status"> (outside the listbox per
    // WAI-ARIA) so ATs politely announce "no matches" without a listbox violation.
    expect(screen.getByRole("status")).toBeInTheDocument();
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
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("ArrowUp wraps from the first row back to the last", () => {
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 3000 }),
          meta("/b.duck", "beta", { last_modified_at: 2000 }),
          meta("/c.duck", "gamma", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    // Default selection is index 0 (alpha); ArrowUp wraps to the last row.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
  });

  it("mouse-enter over a row syncs the keyboard highlight to it", () => {
    // Hovering a row mirrors native <select>: the tint follows the pointer, and
    // Enter activates the hovered row rather than the prior keyboard highlight.
    const onOpenPersisted = vi.fn();
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        onOpenPersisted={onOpenPersisted}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 2000 }),
          meta("/b.duck", "beta", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseEnter(options[1]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenPersisted).toHaveBeenCalledWith("/b.duck", "beta");
  });

  it("clamps the selection when the filter narrows it past the end", () => {
    // Without the render-phase clamp, narrowing the list while selected=2 would
    // strand the highlight past the end and Enter would read entries[2] =
    // undefined, crashing choose. The clamp pulls it back to a real row.
    const onOpenPersisted = vi.fn();
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        onOpenPersisted={onOpenPersisted}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 3000 }),
          meta("/b.duck", "beta", { last_modified_at: 2000 }),
          meta("/c.duck", "gamma", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    // Filter to alpha only; selected must clamp from 2 -> 0.
    fireEvent.change(input, { target: { value: "alp" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenPersisted).toHaveBeenCalledWith("/a.duck", "alpha");
  });

  it("formats same-year mtimes without a year and prior-year mtimes with one", () => {
    // The dialog captures `now` once per mount via useState(() => Date.now()).
    // Pin it so the year boundary in the sub-line is deterministic.
    const NOW = new Date("2026-07-26T12:00:00").getTime();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      renderDialog(
        <SessionSearchDialog
          {...baseProps}
          sessions={[
            meta("/a.duck", "alpha", {
              last_modified_at: new Date("2026-06-01T12:00:00").getTime(),
            }),
            meta("/b.duck", "beta", {
              last_modified_at: new Date("2024-12-31T12:00:00").getTime(),
            }),
          ]}
        />,
      );
      const options = screen.getAllByRole("option");
      // alpha (2026-06-01, same year as NOW) -> "Jun 1", no year suffix.
      const alphaSubline = options[0].querySelector(".session-search-option-subline");
      expect(alphaSubline?.textContent).toMatch(/Jun 1/);
      expect(alphaSubline?.textContent).not.toMatch(/2026/);
      // beta (2024-12-31, prior year) -> year included.
      const betaSubline = options[1].querySelector(".session-search-option-subline");
      expect(betaSubline?.textContent).toMatch(/Dec 31, 2024/);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("exposes aria-activedescendant pointing at the highlighted option id", () => {
    // The combobox<->listbox wiring is the architectural reason the ARIA pattern
    // exists: aria-controls points at the listbox id, options carry the
    // session-search-option-N id prefix, and aria-activedescendant tracks the
    // keyboard highlight so screen readers announce it without moving DOM
    // focus. A regression that severs any of these is visually invisible but
    // breaks AT announcement.
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 2000 }),
          meta("/b.duck", "beta", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox") as HTMLInputElement;
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", "session-search-listbox");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(listbox).toHaveAttribute("id", "session-search-listbox");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("id", "session-search-option-0");
    expect(options[1]).toHaveAttribute("id", "session-search-option-1");
    // Default highlight is the first row.
    expect(input).toHaveAttribute("aria-activedescendant", "session-search-option-0");
    // ArrowDown moves both the highlight and the activedescendant pointer.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "session-search-option-1");
  });

  it("renders the empty state when there are no persisted sessions at all", () => {
    // Cold-start / fresh-install: the modal opens against an empty list_sessions
    // result. The empty state is a sibling <p role="status"> (outside the
    // listbox per WAI-ARIA); no option renders.
    renderDialog(<SessionSearchDialog {...baseProps} sessions={[]} />);
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("No matching sessions.")).toBeInTheDocument();
  });

  it("Enter on an empty list is a no-op (does not crash choose)", () => {
    // The onKeyDown guard returns early when entries is empty, so Enter never
    // reaches choose(undefined). Pins the guard so a future refactor that drops
    // it cannot crash on an empty list.
    const onActivate = vi.fn();
    const onOpenPersisted = vi.fn();
    renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[]}
        onActivate={onActivate}
        onOpenPersisted={onOpenPersisted}
      />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpenPersisted).not.toHaveBeenCalled();
  });

  it("resets a non-zero keyboard selection when reopened", () => {
    // The prevOpen render-phase reset clears the query AND the selection index.
    // This pins the selection half: ArrowDown to index 1, close, reopen -> the
    // highlight returns to the first row so the next Enter does not activate a
    // stale row from the prior open.
    const { rerender } = renderDialog(
      <SessionSearchDialog
        {...baseProps}
        sessions={[
          meta("/a.duck", "alpha", { last_modified_at: 2000 }),
          meta("/b.duck", "beta", { last_modified_at: 1000 }),
        ]}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <SessionSearchDialog
          {...baseProps}
          open={false}
          sessions={[
            meta("/a.duck", "alpha", { last_modified_at: 2000 }),
            meta("/b.duck", "beta", { last_modified_at: 1000 }),
          ]}
        />
      </IntlProvider>,
    );
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <SessionSearchDialog
          {...baseProps}
          open={true}
          sessions={[
            meta("/a.duck", "alpha", { last_modified_at: 2000 }),
            meta("/b.duck", "beta", { last_modified_at: 1000 }),
          ]}
        />
      </IntlProvider>,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("formats today / yesterday sub-lines via the localized heading words", () => {
    // The today / yesterday arms of sublineDateText reuse the sidebar-group
    // locale message ids; with the empty test catalog the en defaultMessage
    // ("Today" / "Yesterday") surfaces. Pins the relative-day half of the
    // sub-line so a regression on the message id or the classification cannot
    // ship silently.
    const NOW = new Date("2026-07-26T12:00:00").getTime();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      renderDialog(
        <SessionSearchDialog
          {...baseProps}
          sessions={[
            meta("/a.duck", "alpha", {
              last_modified_at: new Date("2026-07-26T10:00:00").getTime(),
            }),
            meta("/b.duck", "beta", {
              last_modified_at: new Date("2026-07-25T10:00:00").getTime(),
            }),
          ]}
        />,
      );
      const options = screen.getAllByRole("option");
      // alpha (modified today) -> "Today"; beta (modified yesterday) -> "Yesterday".
      const alphaSubline = options[0].querySelector(".session-search-option-subline");
      const betaSubline = options[1].querySelector(".session-search-option-subline");
      expect(alphaSubline?.textContent).toMatch(/Today/);
      expect(betaSubline?.textContent).toMatch(/Yesterday/);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
