import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { UserRuntimesSection } from "../UserRuntimesSection";
import {
  formatArgGroups,
  isSingleTokenCommand,
  parseArgGroups,
} from "../user-runtime-form";
import {
  createUserAdapter,
  deleteUserAdapter,
  listUserAdapters,
  probeAdapter,
  setUserAdapterEnabled,
  updateUserAdapter,
} from "../../../api";
import type { UserAdapterRow } from "../../../types/runtime";
import { renderSettings } from "./helpers";

// User-defined runtimes pane (issue #1341): the registry rows (enabled /
// disabled badges, toggle, delete-with-confirm), the editor's form gating
// (single-token command + quote-grouped args), the create draft shape, and
// the editor's three-state test (NotDetected -> the launch-failure wording).

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listUserAdapters: vi.fn(),
    createUserAdapter: vi.fn(),
    updateUserAdapter: vi.fn(),
    deleteUserAdapter: vi.fn(),
    setUserAdapterEnabled: vi.fn(),
    probeAdapter: vi.fn(),
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
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    expect(
      await screen.findByText(/No custom runtimes/i),
    ).toBeInTheDocument();
  });

  it("renders every row with its command and enabled state", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([
      makeRow(),
      makeRow({ id: "user:22222222", name: "Off CLI", enabled: false }),
    ]);
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    expect(await screen.findByText("My CLI")).toBeInTheDocument();
    expect(screen.getAllByText(/my-cli --acp/).length).toBeGreaterThan(0);
    expect(screen.getByText("Off CLI")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("surfaces an explicit error when the registry read rejects", async () => {
    // The management face rejects on a corrupt file (issue #1341): the pane
    // renders the error instead of silently dropping the user's rows.
    vi.mocked(listUserAdapters).mockRejectedValueOnce(
      new Error("parse: expected value"),
    );
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    expect(await screen.findByText(/parse: expected value/i)).toBeInTheDocument();
  });

  it("gates Save on name + a single-token command + balanced args", async () => {
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Add$/ }));

    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toBeDisabled();

    const [nameInput, commandInput] = screen.getAllByRole("textbox");
    fireEvent.change(nameInput, { target: { value: "My CLI" } });
    fireEvent.change(commandInput, { target: { value: "my cli" } });
    expect(
      screen.getByText(/Command must be one token/i),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(commandInput, { target: { value: "my-cli" } });
    // The dialog has no saved row yet: Test needs a persisted id, so it
    // stays disabled in create mode.
    expect(screen.getByRole("button", { name: /^Test$/ })).toBeDisabled();
    expect(save).toBeEnabled();
  });

  it("saves the parsed draft (quote-grouped args, env record) via create", async () => {
    const saved = makeRow({ args: ["--acp", "two words"], env: { K: "v" } });
    vi.mocked(createUserAdapter).mockResolvedValueOnce(saved);
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Add$/ }));

    const textboxes = screen.getAllByRole("textbox");
    fireEvent.change(textboxes[0], { target: { value: "My CLI" } });
    fireEvent.change(textboxes[1], { target: { value: "my-cli" } });
    fireEvent.change(textboxes[2], {
      target: { value: "--acp \"two words\"" },
    });
    // One env row: KEY / value.
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    const envInputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).value === "");
    fireEvent.change(envInputs[0], { target: { value: "K" } });
    fireEvent.change(envInputs[1], { target: { value: "v" } });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(createUserAdapter).toHaveBeenCalledTimes(1));
    expect(createUserAdapter).toHaveBeenCalledWith({
      name: "My CLI",
      command: "my-cli",
      args: ["--acp", "two words"],
      env: { K: "v" },
    });
  });

  it("toggles a row's enabled flag", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockResolvedValueOnce(undefined);
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Disable$/ }));
    await waitFor(() =>
      expect(setUserAdapterEnabled).toHaveBeenCalledWith("user:11111111", false),
    );
  });

  it("deletes a row only after the confirm dialog", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(deleteUserAdapter).mockResolvedValueOnce(undefined);
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    expect(deleteUserAdapter).not.toHaveBeenCalled();
    // The confirm names the row; the destructive call only fires on the
    // dialog's Delete action.
    expect(await screen.findByText("Delete My CLI?")).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Delete$/ }).at(-1)!,
    );
    await waitFor(() =>
      expect(deleteUserAdapter).toHaveBeenCalledWith("user:11111111"),
    );
  });

  it("shows the launch-failure wording when the probe rejects NotDetected", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    // A fresh Error instance per rejection (the once-chain pitfall).
    vi.mocked(probeAdapter).mockRejectedValueOnce({
      kind: "NotDetected",
      data: "user:11111111",
    });
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    expect(
      await screen.findByText(/Could not find or start the command/i),
    ).toBeInTheDocument();
    expect(probeAdapter).toHaveBeenCalledWith("user:11111111");
  });

  it("degrades an unknown probe reject kind to the unreachable wording", async () => {
    // Frontend/backend skew: a reject carrying a kind the frontend does not
    // know must NOT pass the narrowing as a structured ProbeError.
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(probeAdapter).mockRejectedValueOnce({ kind: "FutureKind" });
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    expect(
      await screen.findByText(/ACP handshake failed/i),
    ).toBeInTheDocument();
  });

  it("swaps to editing the saved row: Test lights up and a second Save updates", async () => {
    const saved = makeRow({ args: ["--acp", "two words"] });
    vi.mocked(createUserAdapter).mockResolvedValueOnce(saved);
    vi.mocked(updateUserAdapter).mockResolvedValueOnce(saved);
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Add$/ }));

    const textboxes = screen.getAllByRole("textbox");
    fireEvent.change(textboxes[0], { target: { value: "My CLI" } });
    fireEvent.change(textboxes[1], { target: { value: "my-cli" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(createUserAdapter).toHaveBeenCalledTimes(1));

    // The dialog now edits the minted row: Test names a persisted id...
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Test$/ })).toBeEnabled(),
    );
    // ...and the args resync is lossless (the quoted group stays one token).
    expect(
      screen.getByDisplayValue("--acp \"two words\""),
    ).toBeInTheDocument();

    // A second Save routes through update, not a duplicate create.
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(updateUserAdapter).toHaveBeenCalledWith("user:11111111", {
        name: "My CLI",
        command: "my-cli",
        args: ["--acp", "two words"],
        env: { MY_KEY: "secret" },
      }),
    );
    expect(createUserAdapter).toHaveBeenCalledTimes(1);
  });

  it("saves an edit through updateUserAdapter with the row's id", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(updateUserAdapter).mockResolvedValueOnce(
      makeRow({ name: "Renamed" }),
    );
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));

    fireEvent.change(screen.getByDisplayValue("My CLI"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(updateUserAdapter).toHaveBeenCalledWith("user:11111111", {
        name: "Renamed",
        command: "my-cli",
        args: ["--acp"],
        env: { MY_KEY: "secret" },
      }),
    );
    expect(createUserAdapter).not.toHaveBeenCalled();
  });

  it("surfaces a toggle failure instead of swallowing it", async () => {
    vi.mocked(listUserAdapters).mockResolvedValue([makeRow()]);
    vi.mocked(setUserAdapterEnabled).mockRejectedValueOnce(
      new Error("write failed"),
    );
    renderSettings(<UserRuntimesSection onIpcBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Disable$/ }));
    expect(await screen.findByText(/write failed/i)).toBeInTheDocument();
  });
});
