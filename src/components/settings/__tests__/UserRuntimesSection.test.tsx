import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { UserRuntimesSection } from "../UserRuntimesSection";
import { useAdapterProbes } from "../useAdapterProbes";
import {
  formatArgGroups,
  isSingleTokenCommand,
  parseArgGroups,
} from "../user-runtime-form";
import {
  deleteUserAdapter,
  getAdapterCatalogs,
  listUserAdapters,
  probeAdapter,
  setUserAdapterEnabled,
} from "../../../api";
import type {
  AdapterCatalogs,
  ProbeOk,
  UserAdapterRow,
} from "../../../types/runtime";
import { renderSettings } from "./helpers";

// User-defined runtimes pane (issue #1341): the registry rows (enabled /
// disabled badges, toggle, delete-with-confirm) and the onEdit contract.
// The tab owns the editor form (its header Add button + the full-pane swap
// are covered in LocalCliTab.test). The probe face (issue #1346) rides the
// shared ProbeFaceRow; these tests pin the section's wiring -- the row-level
// Test offer, the mirrored-cache badge, and the failure override -- while
// the fold/badge/tooltip semantics themselves are pinned on the built-in
// rows in LocalCliTab.test.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listUserAdapters: vi.fn(),
    deleteUserAdapter: vi.fn(),
    setUserAdapterEnabled: vi.fn(),
    probeAdapter: vi.fn(),
    getAdapterCatalogs: vi.fn(),
  };
});

function makeRow(overrides: Partial<UserAdapterRow> = {}): UserAdapterRow {
  return {
    id: "user:11111111",
    name: "My CLI",
    command: "my-cli",
    args: ["--acp"],
    env: { MY_KEY: "secret" },
    enabled: true,
    stream_format: "acp",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUserAdapters).mockResolvedValue([]);
  vi.mocked(getAdapterCatalogs).mockResolvedValue({});
});

/** Renders the section wired to a live `useAdapterProbes` instance -- the
 *  probe lifecycle the tab owns and passes down in the app (LocalCliTab is
 *  the single busy counter for the shared "probe" channel). */
function renderSection(
  handlers: {
    onEdit?: (row: UserAdapterRow) => void;
    onIpcBusy?: (channel: "probe" | "userAdapter", busy: boolean) => void;
  } = {},
) {
  const onEdit = handlers.onEdit ?? vi.fn();
  const onIpcBusy =
    handlers.onIpcBusy ??
    vi.fn<(channel: "probe" | "userAdapter", busy: boolean) => void>();
  function Wired() {
    const probes = useAdapterProbes(onIpcBusy);
    return (
      <UserRuntimesSection onEdit={onEdit} onIpcBusy={onIpcBusy} probes={probes} />
    );
  }
  return { ...renderSettings(<Wired />), onEdit, onIpcBusy };
}

describe("parseArgGroups", () => {
  it("splits on whitespace and keeps quoted groups together", () => {
    expect(parseArgGroups("--acp --flag value")).toEqual([
      "--acp",
      "--flag",
      "value",
    ]);
    expect(parseArgGroups("\"two words\" x 'q y'")).toEqual([
      "two words",
      "x",
      "q y",
    ]);
  });

  it("returns null on unbalanced quotes", () => {
    expect(parseArgGroups("\"never closed")).toBeNull();
    expect(parseArgGroups("ok 'stray")).toBeNull();
  });

  it("returns an empty array for blank input", () => {
    expect(parseArgGroups("")).toEqual([]);
    expect(parseArgGroups("   ")).toEqual([]);
  });
});

describe("isSingleTokenCommand", () => {
  it("accepts bare names and absolute paths, rejects multi-token and quoted", () => {
    expect(isSingleTokenCommand("my-cli")).toBe(true);
    expect(isSingleTokenCommand("C:\\tools\\cli.exe")).toBe(true);
    expect(isSingleTokenCommand("my cli")).toBe(false);
    expect(isSingleTokenCommand("\"quoted\"")).toBe(false);
    expect(isSingleTokenCommand("")).toBe(false);
  });
});

describe("formatArgGroups", () => {
  it("round-trips every token shape parseArgGroups can produce", () => {
    const cases: string[][] = [
      [],
      ["--acp"],
      ["--acp", "two words"],
      ["it's"],
      [`a"b`],
      [""],
    ];
    for (const args of cases) {
      expect(parseArgGroups(formatArgGroups(args))).toEqual(args);
    }
  });

  it("leaves plain tokens unwrapped", () => {
    expect(formatArgGroups(["--acp", "run"])).toBe("--acp run");
  });
});

describe("UserRuntimesSection", () => {
  it("renders the empty state when the registry has no rows", async () => {
    renderSection();
    expect(
      await screen.findByText(/No custom adapters/i),
    ).toBeInTheDocument();
  });

  it("reports the row to onEdit when its Edit button is clicked", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    const onEdit = vi.fn();
    renderSection({ onEdit });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit adapter My CLI" }),
    );
    expect(onEdit).toHaveBeenCalledWith(makeRow());
  });

  it("renders every row with its command and enabled state", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([
      makeRow(),
      makeRow({ id: "user:22222222", name: "Off CLI", enabled: false }),
    ]);
    renderSection();
    expect(await screen.findByText("My CLI")).toBeInTheDocument();
    expect(screen.getAllByText(/my-cli --acp/).length).toBeGreaterThan(0);
    expect(screen.getByText("Off CLI")).toBeInTheDocument();
    // The disabled badge rides the name (the registry-row posture); an
    // enabled row carries no badge -- the Switch is the state.
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
  });

  it("surfaces an explicit error when the registry read rejects", async () => {
    // The management face rejects on a corrupt file (issue #1341): the pane
    // renders the error instead of silently dropping the user's rows.
    vi.mocked(listUserAdapters).mockRejectedValueOnce(
      new Error("parse: expected value"),
    );
    renderSection();
    expect(await screen.findByText(/parse: expected value/i)).toBeInTheDocument();
  });

  it("toggles a row's enabled flag", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockResolvedValueOnce(undefined);
    // The mutation must invalidate the picker-wide `all()` face, not just
    // the pane's own `user()` rows: the catalogs key sits under `all()` but
    // NOT under `user()`, so it refetches only if the broad invalidation
    // fired. The pane itself observes the catalogs face (its rows'
    // last-tested display), so the invalidation lands as an eager refetch:
    // the initial mount read + one refetch after the mutation.
    renderSection();
    fireEvent.click(
      await screen.findByRole("switch", { name: "Toggle adapter My CLI" }),
    );
    await waitFor(() =>
      expect(setUserAdapterEnabled).toHaveBeenCalledWith("user:11111111", false),
    );
    await waitFor(() =>
      expect(getAdapterCatalogs).toHaveBeenCalledTimes(2),
    );
  });

  it("deletes a row only after the confirm dialog", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(deleteUserAdapter).mockResolvedValueOnce(undefined);
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete adapter My CLI" }),
    );
    expect(deleteUserAdapter).not.toHaveBeenCalled();
    // The confirm names the row; the destructive call only fires on the
    // dialog's Delete action.
    expect(await screen.findByText("Delete My CLI?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() =>
      expect(deleteUserAdapter).toHaveBeenCalledWith("user:11111111"),
    );
    // The delete also invalidates the catalogs face (the backend cleans the
    // row's sidecar entry): the pane's active observer refetches it.
    await waitFor(() =>
      expect(getAdapterCatalogs).toHaveBeenCalledTimes(2),
    );
  });

  it("surfaces a toggle failure instead of swallowing it", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockRejectedValueOnce(
      new Error("write failed"),
    );
    renderSection();
    fireEvent.click(
      await screen.findByRole("switch", { name: "Toggle adapter My CLI" }),
    );
    expect(await screen.findByText(/write failed/i)).toBeInTheDocument();
  });
});

// The row-level probe face (issue #1346): the registry row's Test offer, the
// mirrored-cache badge + auto-expanded fold on success, and the failure
// badge overriding a stale cached count. The shared ProbeFaceRow semantics
// (chevron existence, mid-flight staleness, tooltip) are pinned on the
// built-in rows in LocalCliTab.test -- these cover the section's wiring.
describe("UserRuntimesSection probe face (issue #1346)", () => {
  // The wire success shape for the fixture row: ACP (the only format the
  // registry accepts today), two models for a countable badge.
  const userProbeOk: ProbeOk = {
    kind: "acp",
    data: {
      discovered: {
        models: ["fake-opus", "fake-sonnet"],
        current_model: "fake-opus",
        thought_levels: [],
        current_thought_level: null,
        adapter_id: "user:11111111",
      },
    },
  };

  const userCachedCatalog: AdapterCatalogs = {
    "user:11111111": {
      probe_kind: "acp",
      outcome: { acp: { discovered: userProbeOk.data.discovered } },
      probed_at_millis: Date.UTC(2026, 9, 20, 9, 0),
    },
  };

  function renderRow() {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
  }

  it("offers the row-level Test and reports the shared busy channel", async () => {
    let release!: (v: ProbeOk) => void;
    vi.mocked(probeAdapter).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderRow();
    const onIpcBusy =
      vi.fn<(channel: "probe" | "userAdapter", busy: boolean) => void>();
    renderSection({ onIpcBusy });

    fireEvent.click(
      await screen.findByRole("button", { name: "Test adapter My CLI" }),
    );
    expect(probeAdapter).toHaveBeenCalledWith("user:11111111");
    await waitFor(() =>
      expect(onIpcBusy).toHaveBeenCalledWith("probe", true),
    );
    expect(
      screen.getByRole("button", { name: "Test adapter My CLI" }),
    ).toBeDisabled();

    release(userProbeOk);
    await waitFor(() =>
      expect(onIpcBusy).toHaveBeenCalledWith("probe", false),
    );
  });

  it("renders the success badge and the auto-expanded fold from the mirrored cache", async () => {
    vi.mocked(probeAdapter).mockResolvedValue(userProbeOk);
    renderRow();
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "Test adapter My CLI" }),
    );
    // The badge reads the mirrored query-cache entry, not the ephemeral
    // probe state -- the same source a restart reads.
    expect(await screen.findByText("2 models")).toBeInTheDocument();
    // The success auto-expands the row (the fold contract): the directory
    // is visible without a second click.
    const chevron = screen.getByRole("button", { name: "My CLI" });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("fake-opus (default)")).toBeInTheDocument();
  });

  it("replaces the cached count with the failure badge when the probe rejects", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue(userCachedCatalog);
    vi.mocked(probeAdapter).mockRejectedValue({ kind: "Timeout" });
    renderRow();
    renderSection();

    // The idle+cache pre-state: the count badge and the collapsed fold.
    expect(await screen.findByText("2 models")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Test adapter My CLI" }),
    );
    // The failure outranks the stale count on the badge layer...
    expect(await screen.findByText("Test failed")).toBeInTheDocument();
    expect(screen.queryByText("2 models")).toBeNull();
    // ...and the fold carries the error line, never the stale catalog.
    fireEvent.click(screen.getByRole("button", { name: "My CLI" }));
    expect(
      await screen.findByText("The probe timed out."),
    ).toBeInTheDocument();
    expect(screen.queryByText("fake-opus (default)")).toBeNull();
  });

  it("renders the cached fold behind the chevron on an idle row", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue(userCachedCatalog);
    renderRow();
    renderSection();

    expect(await screen.findByText("2 models")).toBeInTheDocument();
    const chevron = screen.getByRole("button", { name: "My CLI" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chevron);
    expect(
      await screen.findByText("fake-opus (default)"),
    ).toBeInTheDocument();
  });
});
