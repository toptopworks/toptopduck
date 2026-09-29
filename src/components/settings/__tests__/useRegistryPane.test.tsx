import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { useRegistryPane } from "../useRegistryPane";

// fmtError is mocked to a sentinel so the error-face contract asserts on the
// pane hook's own output, not the formatter's (the useSkillsRoot posture).
// The settings-filters predicates stay real: the visible nail pins the actual
// combined projection the panes render.
vi.mock("../../../lib/error-presentation", () => ({
  fmtError: vi.fn(() => "formatted-error"),
}));

type Row = { key: string; name: string; enabled: boolean };

const ROWS: Row[] = [
  { key: "a", name: "alpha", enabled: true },
  { key: "b", name: "beta", enabled: false },
  { key: "g", name: "gamma", enabled: true },
];

function renderPane() {
  return renderHook(() => useRegistryPane(ROWS, (row) => row.name), {
    wrapper: ({ children }) => (
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        {children}
      </IntlProvider>
    ),
  });
}

describe("useRegistryPane", () => {
  describe("runCommit", () => {
    it("surfaces a resolve-to-error through the error face and returns it", async () => {
      const { result } = renderPane();
      let returned: string | null | undefined;
      await act(async () => {
        returned = await result.current.runCommit(async () => "disk-full");
      });
      expect(returned).toBe("disk-full");
      expect(result.current.error).toBe("disk-full");
    });

    it("surfaces a rejection through the error face without rejecting", async () => {
      const { result } = renderPane();
      let returned: string | null | undefined;
      await act(async () => {
        returned = await result.current.runCommit(async () => {
          throw new Error("boom");
        });
      });
      expect(returned).toBe("formatted-error");
      expect(result.current.error).toBe("formatted-error");
    });

    it("resolves to null on success and leaves an existing error untouched", async () => {
      const { result } = renderPane();
      await act(async () => {
        result.current.report(new Error("stale"));
      });
      let returned: string | null | undefined;
      await act(async () => {
        returned = await result.current.runCommit(async () => null);
      });
      expect(returned).toBeNull();
      expect(result.current.error).toBe("formatted-error");
    });
  });

  describe("toggle", () => {
    it("runs the four-step dance: busy on, clear-before-write, write, busy off", async () => {
      const { result } = renderPane();
      await act(async () => {
        result.current.report(new Error("stale"));
      });
      let released!: () => void;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      act(() => {
        void result.current.toggle("a", async () => {
          await gate;
          return null;
        });
      });
      // The act has flushed toggle's synchronous prologue while the write
      // sits parked on the gate: the stale error is already gone BEFORE the
      // write could report its own outcome.
      expect(result.current.togglingKey).toBe("a");
      expect(result.current.error).toBeNull();
      await act(async () => {
        released();
      });
      expect(result.current.togglingKey).toBeNull();
    });

    it("clears the busy flag even when the write resolves to an error", async () => {
      const { result } = renderPane();
      await act(async () => {
        await result.current.toggle("a", async () => "disk-full");
      });
      expect(result.current.togglingKey).toBeNull();
      expect(result.current.error).toBe("disk-full");
    });
  });

  describe("runConfirm", () => {
    it("gates confirmBusy across the write and returns the error string", async () => {
      const { result } = renderPane();
      let returned: string | null | undefined;
      await act(async () => {
        returned = await result.current.runConfirm(async () => "disk-full");
      });
      expect(result.current.confirmBusy).toBe(false);
      expect(returned).toBe("disk-full");
      expect(result.current.error).toBe("disk-full");
    });

    it("clears a stale error before the write starts (the parked mid-flight face)", async () => {
      const { result } = renderPane();
      await act(async () => {
        result.current.report(new Error("stale"));
      });
      let released!: () => void;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      act(() => {
        void result.current.runConfirm(async () => {
          await gate;
          return null;
        });
      });
      // The act has flushed runConfirm's synchronous prologue while the
      // write sits parked on the gate: the stale error is already gone and
      // the busy lane is up BEFORE the write could report its own outcome.
      expect(result.current.error).toBeNull();
      expect(result.current.confirmBusy).toBe(true);
      await act(async () => {
        released();
      });
      expect(result.current.confirmBusy).toBe(false);
    });
  });

  describe("visible", () => {
    it("projects the combined search-and-enabled-filter predicate", async () => {
      const { result } = renderPane();
      expect(result.current.visible.map((r) => r.key)).toEqual([
        "a",
        "b",
        "g",
      ]);
      act(() => {
        result.current.setSearch("alp");
      });
      expect(result.current.visible.map((r) => r.key)).toEqual(["a"]);
      act(() => {
        result.current.setSearch("");
        result.current.setFilter("disabled");
      });
      expect(result.current.visible.map((r) => r.key)).toEqual(["b"]);
      act(() => {
        result.current.setSearch("gamma");
        result.current.setFilter("enabled");
      });
      expect(result.current.visible.map((r) => r.key)).toEqual(["g"]);
    });
  });
});
