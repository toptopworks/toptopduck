import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { ComposerPostureTrigger } from "../ComposerPostureTrigger";
import type { PostureCatalog } from "../ComposerPostureTrigger";
import { TooltipProvider } from "../../ui/tooltip";
import { selectPreventDefault } from "./dropdownMenuMock";
import type { CatalogModel } from "../../../types/runtime";

// ComposerPostureTrigger tests (ADR-0099 Decision 3, issues #574/#573): the
// posture button + cascade menu. The label itself is computed by
// the picker; these tests pin the trigger's contract -- static vs
// interactive rendering, the menu's two-level structure, selection /
// clearing / synthetic-row behavior, and the honest fault surfaces.
//
// Radix DropdownMenu's pointer-event handling recurses under jsdom (known
// limitation, cf. SessionHeaderMenu.test.tsx), so the dropdown-menu module
// is mocked as always-open controlled components: the trigger is a plain
// <button> and both the menu and every Sub content always render. The tests
// verify ComposerPostureTrigger's LOGIC, not Radix's portal internals.

vi.mock("@/components/ui/dropdown-menu", async () =>
  (await import("./dropdownMenuMock")).dropdownMenuMockModule,
);

const ACP_CATALOG: PostureCatalog = {
  kind: "acp",
  models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  thoughtLevels: ["low", "high"],
  currentModel: "gemini-2.5-pro",
  currentThoughtLevel: null,
};

function catalogModel(id: string, efforts: string[] = ["low", "high"], isDefault = false): CatalogModel {
  return {
    id,
    display_name: id,
    is_default: isDefault,
    default_reasoning_effort: efforts[0] ?? "",
    supported_reasoning_efforts: efforts,
  };
}

const PER_MODEL_CATALOG: PostureCatalog = {
  kind: "perModel",
  models: [
    catalogModel("gpt-5", ["low", "medium", "high"], true),
    catalogModel("gpt-5-codex", ["low"]),
  ],
};

type TriggerOverrides = Partial<Parameters<typeof ComposerPostureTrigger>[0]>;

function renderTrigger(overrides: TriggerOverrides = {}) {
  const onSelectModel = vi.fn();
  const onSelectThoughtLevel = vi.fn();
  render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {/* Mirrors the app-wide TooltipProvider the trigger mounts under in
          production (App.tsx) -- like every other tooltip site, the trigger
          mounts bare rather than carrying its own provider. */}
      <TooltipProvider delayDuration={0}>
        <ComposerPostureTrigger
          label="Default (recommended)"
          catalog={ACP_CATALOG}
          liveValue={null}
          model={null}
          thoughtLevel={null}
          onSelectModel={onSelectModel}
          onSelectThoughtLevel={onSelectThoughtLevel}
          configFault={null}
          setFault={null}
          persistFault={null}
          persistSuspended={false}
          catalogNote={null}
          disabled={false}
          {...overrides}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
  return { onSelectModel, onSelectThoughtLevel };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ComposerPostureTrigger static vs interactive rendering (ADR-0099 D3)", () => {
  it("renders a static label (no button, no arrow) when there is no catalog", () => {
    renderTrigger({ catalog: null, label: "Default (recommended)" });
    // Not a button: the static state must not masquerade as clickable.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Default (recommended)")).toBeTruthy();
  });

  it("renders a button with the Model aria label + the label text when a catalog exists", () => {
    renderTrigger({ label: "gpt-5 · high" });
    expect(
      screen.getByRole("button", { name: "Model: gpt-5 · high" }),
    ).toBeTruthy();
    expect(screen.getByText("gpt-5 · high")).toBeTruthy();
  });

  it("disables the button when a write is in flight", () => {
    renderTrigger({ disabled: true });
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the read failure as an inline status line instead of the control", () => {
    renderTrigger({ configFault: new Error("ipc down") });
    expect(screen.getByRole("status").textContent).toContain("ipc down");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ComposerPostureTrigger cascade menu (two-level)", () => {
  it("shows the two first-level rows with the current value inline", () => {
    renderTrigger({ model: "gemini-2.5-flash", thoughtLevel: "high" });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[0].textContent).toContain("Model");
    expect(rows[0].textContent).toContain("gemini-2.5-flash");
    expect(rows[1].textContent).toContain("Thinking");
    expect(rows[1].textContent).toContain("high");
  });

  it("shows the CLI-reported current on the first-level row when nothing is selected", () => {
    renderTrigger({ model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[0].textContent).toContain("gemini-2.5-pro");
  });

  it("offers the catalog models as radio rows with the checked state on the current item", () => {
    renderTrigger({ model: "gemini-2.5-flash" });
    const flash = screen.getByRole("menuitemradio", { name: "gemini-2.5-flash" });
    expect(flash.getAttribute("aria-checked")).toBe("true");
    const pro = screen.getByRole("menuitemradio", { name: "gemini-2.5-pro" });
    expect(pro.getAttribute("aria-checked")).toBe("false");
  });

  it("selects a model through onSelectModel", () => {
    const { onSelectModel } = renderTrigger();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gemini-2.5-flash" }));
    expect(onSelectModel).toHaveBeenCalledWith("gemini-2.5-flash");
  });

  it("selects a thought level through onSelectThoughtLevel", () => {
    const { onSelectThoughtLevel } = renderTrigger();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^low$/ }));
    expect(onSelectThoughtLevel).toHaveBeenCalledWith("low");
  });

  it("keeps the menu open on selection (preventDefault on the item select)", () => {
    // The keep-open contract's only implementation is the e.preventDefault()
    // in the option / clearing item handlers -- assert the mock's injected
    // spy fired for both row kinds (issue #584).
    renderTrigger();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gemini-2.5-flash" }));
    fireEvent.click(screen.getAllByRole("menuitem", { name: "Default (recommended)" })[0]);
    expect(selectPreventDefault).toHaveBeenCalledTimes(2);
  });

  it("clears the dimension via the leading Default (recommended) row", () => {
    const { onSelectModel } = renderTrigger({ model: "gemini-2.5-flash" });
    // Both second-level lists open a clearing row with the same label; the
    // model list is the first Sub in the menu.
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    expect(onSelectModel).toHaveBeenCalledWith(null);
  });

  it("annotates the clearing row with the CLI current when nothing is held", () => {
    renderTrigger({ model: null });
    expect(
      screen.getByRole("menuitem", {
        name: "Default (recommended) (gemini-2.5-pro)",
      }),
    ).toBeTruthy();
  });

  it("renders a synthetic row for a held model the catalog does not offer", () => {
    const { onSelectModel } = renderTrigger({ model: "gemini-1.0-ultra" });
    const synthetic = screen.getByRole("menuitemradio", {
      name: "gemini-1.0-ultra (not offered by this runtime)",
    });
    fireEvent.click(synthetic);
    expect(onSelectModel).toHaveBeenCalledWith("gemini-1.0-ultra");
  });

  it("renders a synthetic row for a CLI current the catalog does not offer (issue #529)", () => {
    // The held chain is selection ?? CLI current: an unselected-but-current
    // value outside the directory still gets its honest row (and is
    // selectable), matching the retired select's fallback behavior.
    const { onSelectModel } = renderTrigger({
      catalog: {
        kind: "acp",
        models: ["gemini-2.5-flash"],
        thoughtLevels: ["low"],
        currentModel: "gemini-2.5-pro",
        currentThoughtLevel: null,
      },
    });
    const synthetic = screen.getByRole("menuitemradio", {
      name: "gemini-2.5-pro (not offered by this runtime)",
    });
    fireEvent.click(synthetic);
    expect(onSelectModel).toHaveBeenCalledWith("gemini-2.5-pro");
  });

  it("renders a synthetic row for a held thought level the catalog does not offer", () => {
    const { onSelectThoughtLevel } = renderTrigger({ thoughtLevel: "ultra" });
    const synthetic = screen.getByRole("menuitemradio", {
      name: "ultra (not offered by this runtime)",
    });
    fireEvent.click(synthetic);
    expect(onSelectThoughtLevel).toHaveBeenCalledWith("ultra");
  });
});

describe("ComposerPostureTrigger per-model catalog (issue #537)", () => {
  it("lists the selected model's supported efforts in the CLI's declared order", () => {
    renderTrigger({ catalog: PER_MODEL_CATALOG, model: "gpt-5-codex" });
    const contents = screen.getAllByTestId("sub-content");
    const levelContent = contents[1];
    expect(levelContent.textContent).toContain("low");
    expect(levelContent.textContent).not.toContain("high");
  });

  it("disables the Thinking row with the pick-a-model hint when no model is held", () => {
    renderTrigger({ catalog: PER_MODEL_CATALOG, model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
    expect(rows[1].textContent).toContain("Pick a model first.");
  });

  it("offers no level rows while the Thinking row is unavailable", () => {
    renderTrigger({ catalog: PER_MODEL_CATALOG, model: null });
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[1].textContent).toBe("");
  });
});

describe("ComposerPostureTrigger honest fault surfaces (issue #529)", () => {
  it("renders the stale note inline with no probe icon", () => {
    renderTrigger({ catalogNote: "stale-runtime" });
    // The stale-catalog warning stays an inline line inside the menu; the
    // probe-fed icon must not appear for a session-owned discovery.
    expect(screen.getByText(/discovered on a different runtime/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Catalog source explanation" }),
    ).toBeNull();
  });

  it("keeps the probe-catalog note in a tooltip behind the info icon", async () => {
    renderTrigger({ catalogNote: "from-probe" });
    // The informational probe-catalog note collapses into a hover tooltip
    // behind an info icon, and the stale warning does not render.
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).toBeNull();
    // Radix Tooltip's trigger opens on pointerMove (not pointerEnter), so the
    // hover is simulated with a pointer move over the info button.
    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Catalog source explanation" }),
    );
    expect(
      await screen.findByText(/Options from your last settings test/),
    ).toBeTruthy();
  });

  it("renders the set failure, persist fault, and suspension lines", () => {
    renderTrigger({
      setFault: new Error("write failed"),
      persistFault: { kind: "Io", data: "disk full" },
      persistSuspended: true,
    });
    expect(screen.getByText(/Could not apply the selection/)).toBeTruthy();
    expect(screen.getByText(/Selection not saved: Failed to write/)).toBeTruthy();
    expect(screen.getByText(/autosave is paused/)).toBeTruthy();
  });
});

describe("ComposerPostureTrigger live readout tooltip (issue #586)", () => {
  const LIVE_TOOLTIP = /\(last turn\)/;

  it("carries the turn's actual value in the tooltip while the label keeps its default copy", async () => {
    // The live currents never touch the label: the unselected label keeps
    // "Default (recommended)" verbatim and the tooltip is the live
    // readout's only surface.
    renderTrigger({ liveValue: "gemini-2.5-pro" });
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    fireEvent.pointerMove(trigger);
    expect(
      await screen.findByText("gemini-2.5-pro (last turn)"),
    ).toBeTruthy();
  });

  it("carries no live tooltip outside the live state", () => {
    // The absence assertions open via focus: Radix opens the tooltip
    // synchronously on focus, while a pointerMove defers the open to a
    // macrotask -- a synchronous absence query after it would pass
    // vacuously.
    renderTrigger();
    fireEvent.focus(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    );
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
  });

  it("keeps the cascade menu intact in the live state (still unselected)", () => {
    // The tooltip is a display-layer mark: the menu's check positions and
    // clearing rows are exactly the unselected state's.
    renderTrigger({ liveValue: "gemini-2.5-pro" });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute("aria-checked")).not.toBe("true");
    }
  });
});
