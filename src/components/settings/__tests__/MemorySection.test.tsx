// The user-memory settings pane's render contract (issue #1531): the
// read-only list (title + category badge + hook) with the reveal wiring,
// the MCP-style count line + title-and-hook search filter above the card,
// the empty guide (the folder is the hand-write entry point), the folder
// open, and the listing error face. The suite mocks the api module (the
// IPC boundary) and the opener plugin, rendered through the settings seam
// (the REAL en-US catalog, issue #1100).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listUserMemory: vi.fn(),
    openUserMemoryDir: vi.fn(),
  };
});

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listUserMemory, openUserMemoryDir } from "../../../api";
import { MemorySection } from "../MemorySection";
import { renderSettings } from "./helpers";
import type { ListedMemory } from "../../../types/workspace-memory";

const mockedList = vi.mocked(listUserMemory);
const mockedOpenDir = vi.mocked(openUserMemoryDir);
const mockedReveal = vi.mocked(revealItemInDir);
const mockedOpenPath = vi.mocked(openPath);

function memory(overrides: Partial<ListedMemory> = {}): ListedMemory {
  return {
    title: "Reply in Simplified Chinese",
    file: "user-language.md",
    hook: "always zh",
    type: "user",
    file_path: "/appdata/memory/user-language.md",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MemorySection", () => {
  beforeEach(() => {
    mockedOpenDir.mockResolvedValue("/appdata/memory");
    mockedOpenPath.mockResolvedValue(undefined);
    mockedReveal.mockResolvedValue(undefined);
  });

  it("renders the rows with title, badge, hook, and the count", async () => {
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    renderSettings(<MemorySection />);
    expect(
      await screen.findByText("Reply in Simplified Chinese"),
    ).toBeInTheDocument();
    expect(screen.getByText("always zh")).toBeInTheDocument();
    // The category badge renders localized (the en-US catalog).
    expect(screen.getByText("User")).toBeInTheDocument();
    // The pane title is the static nav name; the count rides the MCP-style
    // line above the card (the count digit sits in a nested span, so the
    // matcher rides the line's own text node -- exact: false).
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("User memories", { exact: false })).toBeInTheDocument();
    // The read-only layer has no enabled axis: search box only, no Select.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("filters rows through the search box and shows the no-results face", async () => {
    mockedList.mockResolvedValue({
      rows: [
        memory(),
        memory({ title: "Pinned projects", file: "pinned.md", hook: "favorites" }),
      ],
      usage_percent: 0,
      unreadable: [],
    });
    renderSettings(<MemorySection />);
    const box = await screen.findByPlaceholderText("Search memories…");
    // Baseline: both rows visible before the query lands.
    expect(screen.getByText("Reply in Simplified Chinese")).toBeInTheDocument();
    expect(screen.getByText("Pinned projects")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "pinned" } });
    expect(screen.queryByText("Reply in Simplified Chinese")).not.toBeInTheDocument();
    expect(screen.getByText("Pinned projects")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(/No memories match the current search/)).toBeInTheDocument();
  });

  it("reveals the row's memory file in the folder", async () => {
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    renderSettings(<MemorySection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reveal in folder" }),
    );
    await waitFor(() =>
      expect(mockedReveal).toHaveBeenCalledWith("/appdata/memory/user-language.md"),
    );
  });

  it("renders the empty guide when the layer has no memories", async () => {
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    renderSettings(<MemorySection />);
    expect(
      await screen.findByText(/No user memories yet/),
    ).toBeInTheDocument();
  });

  it("shows only the unreadable tail when every file is unrecognized", async () => {
    mockedList.mockResolvedValue({
      rows: [],
      usage_percent: 0,
      unreadable: ["loose.md"],
    });
    renderSettings(<MemorySection />);
    // No search is active, so the no-results face must not claim a
    // failed search -- the tail stands alone (issue #1544 review).
    expect(await screen.findByText(/Unrecognized files/)).toBeInTheDocument();
    expect(screen.queryByText(/No memories match/)).not.toBeInTheDocument();
  });

  it("opens the memory folder through the backend-minted root", async () => {
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    renderSettings(<MemorySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    await waitFor(() =>
      expect(mockedOpenPath).toHaveBeenCalledWith("/appdata/memory"),
    );
  });

  it("surfaces a folder-open failure as the alert and clears it on retry", async () => {
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    mockedOpenDir.mockRejectedValueOnce(
      new Error("failed to create the memory folder"),
    );
    renderSettings(<MemorySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "failed to create the memory folder",
    );
    // The default resolve takes over: a successful retry clears the alert.
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("surfaces a listing failure as the alert", async () => {
    mockedList.mockRejectedValue(new Error("boom"));
    renderSettings(<MemorySection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("shows the red usage band at the cap", async () => {
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 96, unreadable: [] });
    renderSettings(<MemorySection />);
    expect(await screen.findByText("96% used")).toBeInTheDocument();
  });
});
