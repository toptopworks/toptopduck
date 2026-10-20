import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { UserRuntimesSection } from "../UserRuntimesSection";
import {
  formatArgGroups,
  isSingleTokenCommand,
  parseArgGroups,
} from "../user-runtime-form";
import { adapterKeys } from "../../../session/queryKeys";
import {
  deleteUserAdapter,
  listUserAdapters,
  setUserAdapterEnabled,
} from "../../../api";
import type { UserAdapterRow } from "../../../types/runtime";
import { renderSettings } from "./helpers";

// User-defined runtimes pane (issue #1341): the registry rows (enabled /
// disabled badges, toggle, delete-with-confirm) and the onEdit contract.
// The tab owns the editor form (its header Add button + the full-pane swap
// are covered in LocalCliTab.test).

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listUserAdapters: vi.fn(),
    deleteUserAdapter: vi.fn(),
    setUserAdapterEnabled: vi.fn(),
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
});

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
    renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
    expect(
      await screen.findByText(/No custom adapters/i),
    ).toBeInTheDocument();
  });

  it("reports the row to onEdit when its Edit button is clicked", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    const onEdit = vi.fn();
    renderSettings(
      <UserRuntimesSection onEdit={onEdit} onIpcBusy={vi.fn()} />,
    );
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
    renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
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
    renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
    expect(await screen.findByText(/parse: expected value/i)).toBeInTheDocument();
  });

  it("toggles a row's enabled flag", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockResolvedValueOnce(undefined);
    // The mutation must invalidate the picker-wide `all()` face, not just
    // the pane's own `user()` rows: the catalogs key sits under `all()` but
    // NOT under `user()`, so it turns invalid only if the broad invalidation
    // fired. It has no active observer here, so the flag survives without a
    // refetch race.
    const { queryClient } = renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
    queryClient.setQueryData(adapterKeys.catalogs(), {});
    fireEvent.click(
      await screen.findByRole("switch", { name: "Toggle adapter My CLI" }),
    );
    await waitFor(() =>
      expect(setUserAdapterEnabled).toHaveBeenCalledWith("user:11111111", false),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(adapterKeys.catalogs())?.isInvalidated,
      ).toBe(true),
    );
  });

  it("deletes a row only after the confirm dialog", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(deleteUserAdapter).mockResolvedValueOnce(undefined);
    const { queryClient } = renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
    queryClient.setQueryData(adapterKeys.catalogs(), {});
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
    await waitFor(() =>
      expect(
        queryClient.getQueryState(adapterKeys.catalogs())?.isInvalidated,
      ).toBe(true),
    );
  });

  it("surfaces a toggle failure instead of swallowing it", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockRejectedValueOnce(
      new Error("write failed"),
    );
    renderSettings(
      <UserRuntimesSection onEdit={vi.fn()} onIpcBusy={vi.fn()} />,
    );
    fireEvent.click(
      await screen.findByRole("switch", { name: "Toggle adapter My CLI" }),
    );
    expect(await screen.findByText(/write failed/i)).toBeInTheDocument();
  });
});
