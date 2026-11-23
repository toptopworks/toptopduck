import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { ComposerPostureTrigger } from "../ComposerPostureTrigger";
import type { PostureCatalog } from "../ComposerPostureTrigger";
import { TooltipProvider } from "../../ui/tooltip";
import {
  closeAutoFocusCapture,
  openChangeCapture,
  selectPreventDefault,
  subOpenChangeCapture,
} from "./dropdownMenuMock";
import type { BuiltinCatalogModel, CatalogModel } from "../../../types/runtime";

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

// The built-in fixture (issue #1639): an effort-tiered cataloged model, a
// toggle-only uncataloged one (no tiers), and the profile model as the
// effective current.
function builtinModel(
  id: string,
  tiers: string[] = [],
  displayName = id,
): BuiltinCatalogModel {
  return {
    id,
    display_name: displayName,
    supported_reasoning_efforts: tiers,
  };
}

const BUILTIN_CATALOG: PostureCatalog = {
  kind: "builtin",
  models: [
    builtinModel("claude-sonnet-4-5", ["low", "high"], "Claude Sonnet 4.5"),
    builtinModel("custom-deploy-7"),
  ],
  profileModel: "claude-sonnet-4-5",
};

type TriggerOverrides = Partial<Parameters<typeof ComposerPostureTrigger>[0]>;

function renderTrigger(overrides: TriggerOverrides = {}) {
  const onSelectModel = vi.fn();
  const onSelectThoughtLevel = vi.fn();
  const renderResult = render(
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
  return { ...renderResult, onSelectModel, onSelectThoughtLevel };
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

  it("prevents the close refocus after a pointerdown and not after a keydown", () => {
    // The close-focus gate (usePointerCloseIntent, issue #1309): restoring
    // focus to the Tooltip-wrapped trigger after a pointer close would
    // strand its tooltip with no hover. The always-open mock has no close
    // lifecycle, so the pinned handler is the one it captured at render.
    renderTrigger();
    const gate = closeAutoFocusCapture.handler;
    expect(gate).toBeTypeOf("function");
    fireEvent.pointerDown(document.body);
    const pointerClose = { preventDefault: vi.fn() };
    gate?.(pointerClose);
    expect(pointerClose.preventDefault).toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    const keyboardClose = { preventDefault: vi.fn() };
    gate?.(keyboardClose);
    expect(keyboardClose.preventDefault).not.toHaveBeenCalled();
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

  it("clears the thought level via the leading Default (recommended) row", () => {
    const { onSelectThoughtLevel } = renderTrigger({
      model: "gemini-2.5-flash",
      thoughtLevel: "high",
    });
    // A held model keeps the model list's clearing row un-annotated (the
    // annotation rides only the nothing-held state), so both lists' clearing
    // rows read the same label; the thought-level list is the second Sub.
    // Its clearing row must reach onSelectThoughtLevel(null) through its own
    // gesture path, not only via the codex linkage chain.
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[1]);
    expect(onSelectThoughtLevel).toHaveBeenCalledWith(null);
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

  it("drives the Thinking row from the held model -- the CLI current -- when nothing is selected (issue #1648)", () => {
    // The held chain is selection ?? CLI current: the default model's own
    // efforts seat the strength list without an explicit pick, so the
    // default and an explicit pick of the same id configure strength alike
    // (the #537 disable-while-unselected rule is retired).
    renderTrigger({ catalog: PER_MODEL_CATALOG, model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].getAttribute("aria-disabled")).toBe("false");
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[1].textContent).toContain("low");
    expect(contents[1].textContent).toContain("medium");
    expect(contents[1].textContent).toContain("high");
  });

  it("keeps the Thinking row enabled with an empty list for an explicit pick outside the directory", () => {
    // An explicit not-offered id is still a held id: the pick-a-model hint
    // is reserved for the no-held-id case (an empty directory), so the
    // enabled row seats the held level's own synthetic row if one exists.
    renderTrigger({ catalog: PER_MODEL_CATALOG, model: "claude-x" });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].getAttribute("aria-disabled")).toBe("false");
    expect(rows[1].textContent).not.toContain("Pick a model first.");
  });

  it("disables the Thinking row only when the held model is not in the directory", () => {
    // Empty directory: no current is knowable, so the held value is null
    // and the pick-a-model hint stays honest.
    renderTrigger({ catalog: { kind: "perModel", models: [] }, model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
    expect(rows[1].textContent).toContain("Pick a model first.");
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[1].textContent).toBe("");
  });
});

describe("ComposerPostureTrigger built-in catalog (issue #1639)", () => {
  it("renders cataloged rows under their bare ids, uncataloged alike (issue #1648)", () => {
    renderTrigger({ catalog: BUILTIN_CATALOG });
    expect(
      screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemradio", { name: "custom-deploy-7" }),
    ).toBeTruthy();
  });

  it("selects the model id through onSelectModel", () => {
    const { onSelectModel } = renderTrigger({ catalog: BUILTIN_CATALOG });
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" }),
    );
    expect(onSelectModel).toHaveBeenCalledWith("claude-sonnet-4-5");
  });

  it("carries the pinned default inline when nothing is selected, with no model clearing row (ADR-0154)", () => {
    renderTrigger({ catalog: BUILTIN_CATALOG, model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[0].textContent).toContain("claude-sonnet-4-5");
    // The built-in runtime has no CLI default for "unselected" to mean, so
    // the MODEL list has no clearing row -- the strength list keeps its own.
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[0].textContent).not.toContain("Default (recommended)");
    expect(contents[1].textContent).toContain("Default (recommended)");
  });

  it("offers a pinned default the list does not carry as its own selectable row (ADR-0154)", () => {
    // Probe pending or failed, or a pinned id outside the first-hand list:
    // the pinned model rides a synthetic row labelled as what it is -- never
    // as an id the runtime fails to offer -- and selecting it is the way
    // back to the pinned default.
    const { onSelectModel } = renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: "claude-x" },
    });
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "claude-x" }),
    );
    expect(onSelectModel).toHaveBeenCalledWith("claude-x");
  });

  it("labels a held built-in model outside the list with its bare name, never as a runtime omission (ADR-0154)", () => {
    // The built-in runtime has no CLI to "not offer" anything: a held
    // model missing from the (probe-less) list rides the plain row.
    renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: null },
      model: "claude-x",
    });
    expect(
      screen.getByRole("menuitemradio", { name: "claude-x" }),
    ).toBeTruthy();
  });

  it("renders a bare model list for an unpinned profile with nothing held (ADR-0154)", () => {
    renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: null },
    });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[0].textContent).toBe("Model");
    // The strength row keeps its seat, disabled with the no-levels hint
    // (an unpinned profile with nothing held has no tiers to offer).
    expect(rows.length).toBe(2);
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[0].textContent).toBe("custom-deploy-7");
  });

  it("shows the strength row for a model with effort tiers", () => {
    // The held model (the profile default) carries discrete tiers: the
    // Thinking row seats with its list in the CLI-declared order.
    renderTrigger({ catalog: BUILTIN_CATALOG, model: null });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].textContent).toContain("Thinking");
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[1].textContent).toContain("low");
    expect(contents[1].textContent).toContain("high");
  });

  it("disables the strength row with the no-levels hint for a toggle-only model (issue #1648)", () => {
    // The strength row is a permanent seat: a held model with no discrete
    // tiers reads as the disabled hint, never a vanished row (the old hide
    // flickered after the probe placeholder had seated the row).
    renderTrigger({ catalog: BUILTIN_CATALOG, model: "custom-deploy-7" });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain("Thinking");
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
    expect(rows[1].textContent).toContain("No thinking levels");
  });

  it("keeps the strength row for a held level even when the held model offers no tiers", () => {
    // The honest synthetic mechanism rides over the hide rule: a held
    // level must stay visible (and clearable) even with no directory.
    renderTrigger({
      catalog: BUILTIN_CATALOG,
      model: "custom-deploy-7",
      thoughtLevel: "high",
    });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows[1].textContent).toContain("Thinking");
    expect(
      screen.getByRole("menuitemradio", {
        name: "high (not offered by this runtime)",
      }),
    ).toBeTruthy();
  });

  it("renders the silent fallback shape when the probe answered nothing (probe pending or failed)", () => {
    // The fallback catalog: no models, the profile model as the current.
    // The menu is NOT an error surface -- the pinned model rides the
    // synthetic row; there is no clearing row to carry default copy.
    renderTrigger({
      catalog: { kind: "builtin", models: [], profileModel: "claude-x" },
    });
    expect(
      screen.getByRole("menuitemradio", {
        name: "claude-x",
      }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("sub-content")[0].textContent).not.toContain(
      "Default (recommended)",
    );
    expect(screen.queryByRole("status")).toBeNull();
    // The strength row keeps its seat: the no-levels hint answers instead
    // of the row vanishing in the settled fallback shape.
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows.length).toBe(2);
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
  });

  it("fires onMenuOpen when the menu opens", () => {
    const onMenuOpen = vi.fn();
    renderTrigger({ catalog: BUILTIN_CATALOG, onMenuOpen });
    // The mock's captured open-change handler is the menu's open event.
    openChangeCapture.handler?.(true);
    expect(onMenuOpen).toHaveBeenCalledTimes(1);
    openChangeCapture.handler?.(false);
    expect(onMenuOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerPostureTrigger held-state checkmarks (issue #1648)", () => {
  it("checks the CLI current's row when nothing is selected (acp)", () => {
    renderTrigger({ model: null });
    const pro = screen.getByRole("menuitemradio", { name: "gemini-2.5-pro" });
    expect(pro.getAttribute("aria-checked")).toBe("true");
    const flash = screen.getByRole("menuitemradio", { name: "gemini-2.5-flash" });
    expect(flash.getAttribute("aria-checked")).toBe("false");
  });

  it("checks the pinned default's row when nothing is selected (builtin)", () => {
    renderTrigger({ catalog: BUILTIN_CATALOG, model: null });
    const pinned = screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" });
    expect(pinned.getAttribute("aria-checked")).toBe("true");
  });

  it("checks the pinned synthetic row when the pinned id is outside the directory (builtin)", () => {
    renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: "claude-x" },
    });
    expect(
      screen.getByRole("menuitemradio", { name: "claude-x" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("checks no row for an unpinned profile with nothing selected (builtin, honest empty)", () => {
    renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: null },
    });
    within(screen.getAllByTestId("sub-content")[0])
      .getAllByRole("menuitemradio")
      .forEach((row) => expect(row.getAttribute("aria-checked")).toBe("false"));
  });

  it("checks the strength current's row when nothing is selected (acp)", () => {
    renderTrigger({
      catalog: { ...ACP_CATALOG, currentThoughtLevel: "low" },
      thoughtLevel: null,
    });
    const low = within(screen.getAllByTestId("sub-content")[1])
      .getByRole("menuitemradio", { name: "low" });
    expect(low.getAttribute("aria-checked")).toBe("true");
  });

  it("checks a held strength outside the catalog on its synthetic row (acp)", () => {
    renderTrigger({
      catalog: { ...ACP_CATALOG, thoughtLevels: ["low"], currentThoughtLevel: "ultra" },
      thoughtLevel: null,
    });
    expect(
      within(screen.getAllByTestId("sub-content")[1])
        .getByRole("menuitemradio", { name: "ultra (not offered by this runtime)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("carries the full name in the row title for truncated long ids (issue #1648)", () => {
    renderTrigger({ catalog: BUILTIN_CATALOG });
    const row = screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" });
    expect(row.getAttribute("title")).toBe("claude-sonnet-4-5");
  });

  it("pins the submenu width class on both dimensions (issue #1648)", () => {
    renderTrigger({ catalog: BUILTIN_CATALOG });
    const contents = screen.getAllByTestId("sub-content");
    expect(contents[0].className).toContain("w-72");
    expect(contents[1].className).toContain("w-72");
  });
});

describe("ComposerPostureTrigger model-list filter row (issue #1645)", () => {
  // A gateway-sized list: display names diverge from ids on two rows so the
  // label-vs-id matching halves are exercised separately.
  const LARGE_BUILTIN: PostureCatalog = {
    kind: "builtin",
    models: [
      builtinModel("claude-sonnet-4-5", ["low", "high"], "Claude Sonnet 4.5"),
      builtinModel("gpt-5.1", ["low", "high"], "GPT-5.1"),
      builtinModel("gpt-5.1-codex", [], "GPT-5.1 Codex"),
      builtinModel("custom-deploy-7"),
    ],
    profileModel: "claude-sonnet-4-5",
  };

  it("seats the filter row on the model dimension only", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const contents = screen.getAllByTestId("sub-content");
    expect(within(contents[0]).getByPlaceholderText(/Filter models/)).toBeTruthy();
    expect(within(contents[1]).queryByPlaceholderText("Filter models")).toBeNull();
  });

  it("filters by id only, case-insensitively (issue #1648)", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    const contents = screen.getAllByTestId("sub-content");
    // The display name no longer rides the rows: a space-carrying name
    // matches nothing (the honest empty state answers), while the id half
    // still folds case on the way in.
    fireEvent.change(filter, { target: { value: "Sonnet 4.5" } });
    expect(within(contents[0]).queryAllByRole("menuitemradio")).toEqual([]);
    expect(within(contents[0]).getByText("No matching models")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "CLAUDE-SONNET" } });
    expect(
      within(contents[0]).getAllByRole("menuitemradio").map((r) => r.textContent),
    ).toEqual(["claude-sonnet-4-5"]);
    fireEvent.change(filter, { target: { value: "DEPLOY" } });
    expect(
      within(contents[0]).getAllByRole("menuitemradio").map((r) => r.textContent),
    ).toEqual(["custom-deploy-7"]);
  });

  it("restores the full list when the query is cleared", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: "gpt" } });
    const contents = screen.getAllByTestId("sub-content");
    expect(within(contents[0]).getAllByRole("menuitemradio").length).toBe(2);
    fireEvent.change(filter, { target: { value: "" } });
    expect(within(contents[0]).getAllByRole("menuitemradio").length).toBe(4);
  });

  it("shows the honest empty state when nothing matches, keeping a synthetic row", () => {
    // The held profile default is OUTSIDE the directory: its synthetic row
    // is a state readout, not a catalog entry, so it survives the filter --
    // the empty-state line speaks for the catalog alone.
    const { onSelectModel } = renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: "claude-x" },
    });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(
      within(screen.getAllByTestId("sub-content")[0]).getByText("No matching models"),
    ).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "claude-x" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "custom-deploy-7" })).toBeNull();
    // The synthetic row stays selectable through the filtered view.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "claude-x" }));
    expect(onSelectModel).toHaveBeenCalledWith("claude-x");
  });

  it("seats the filter row on all three catalog families (one implementation)", () => {
    // acp
    const { unmount: unmountAcp } = renderTrigger();
    expect(screen.getByPlaceholderText(/Filter models/)).toBeTruthy();
    unmountAcp();
    // perModel
    const { unmount: unmountPerModel } = renderTrigger({
      catalog: PER_MODEL_CATALOG,
      model: "gpt-5",
    });
    expect(screen.getByPlaceholderText(/Filter models/)).toBeTruthy();
    unmountPerModel();
    // builtin
    renderTrigger({ catalog: LARGE_BUILTIN });
    expect(screen.getByPlaceholderText(/Filter models/)).toBeTruthy();
  });

  it("resets the query when the submenu closes", () => {
    // Single-Sub catalog (toggle-only model hides the strength row) so the
    // mock's single captured handler is the model dimension's own.
    renderTrigger({
      catalog: { kind: "builtin", models: [builtinModel("custom-deploy-7")], profileModel: null },
    });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: "deploy" } });
    expect((filter as HTMLInputElement).value).toBe("deploy");
    // The captured handler runs outside fireEvent's act scope: the reset's
    // state update batches, so the assertion rides an explicit act.
    act(() => subOpenChangeCapture.handler?.(false));
    expect(
      (screen.getByPlaceholderText(/Filter models/) as HTMLInputElement).value,
    ).toBe("");
  });

  it("moves focus into the first menu row on ArrowDown from the filter", () => {
    // No clearing row on the built-in model dimension: the first row is the
    // first catalog entry. The rows are roving-tabindex focusable (tabIndex
    // -1, the real Radix shape) so the gesture can land on them.
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    const first = document.activeElement;
    expect(first?.getAttribute("role")).toBe("menuitemradio");
    expect(first?.textContent).toBe("claude-sonnet-4-5");
  });

  it("keeps the thought-level list outside the model query", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: "sonn" } });
    const contents = screen.getAllByTestId("sub-content");
    expect(within(contents[1]).getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual([
      "low",
      "high",
    ]);
  });

  it("keeps printable keys inside the filter (no typeahead yank)", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    // A keydown that escapes the React root is one the menu content's own
    // handler (Radix's typeahead) would see; the filter's stopPropagation
    // must keep it inside.
    const escaped: string[] = [];
    const onEscape = (e: Event) => escaped.push((e as KeyboardEvent).key);
    document.body.addEventListener("keydown", onEscape);
    try {
      fireEvent.keyDown(filter, { key: "g" });
      expect(escaped).toEqual([]);
    } finally {
      document.body.removeEventListener("keydown", onEscape);
    }
  });

  it("keeps focus in the filter when ArrowDown meets an empty filtered list", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    // The gesture presumes the input holds focus (the user just typed into
    // it); fireEvent does not focus, so the test seats it explicitly.
    filter.focus();
    // React 18+ reports a handler crash via window's error channel instead
    // of throwing through the dispatch, so the dead end's cleanliness is
    // pinned as both "focus held" and "nothing crashed".
    const errors: string[] = [];
    const onError = (e: Event) => errors.push((e as ErrorEvent).message);
    window.addEventListener("error", onError);
    try {
      fireEvent.change(filter, { target: { value: "zzz" } });
      fireEvent.keyDown(filter, { key: "ArrowDown" });
      // No row to land on: the honest dead end holds focus in the input
      // (the empty-state line below explains why) and stays silent.
      expect(errors).toEqual([]);
      expect(document.activeElement).toBe(filter);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("treats a whitespace-only query as the unfiltered list", () => {
    renderTrigger({ catalog: LARGE_BUILTIN });
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: " " } });
    const contents = screen.getAllByTestId("sub-content");
    expect(within(contents[0]).getAllByRole("menuitemradio").length).toBe(4);
    expect(within(contents[0]).queryByText("No matching models")).toBeNull();
  });

  it("keeps the clearing row visible when an acp query matches nothing", () => {
    renderTrigger();
    const filter = screen.getByPlaceholderText(/Filter models/);
    fireEvent.change(filter, { target: { value: "zzz" } });
    const contents = screen.getAllByTestId("sub-content");
    // The clearing row is a state readout, not a catalog entry: it survives
    // the filter alongside the honest empty-state line.
    expect(
      within(contents[0]).getByRole("menuitem", { name: /Default \(recommended\)/ }),
    ).toBeTruthy();
    expect(within(contents[0]).getByText("No matching models")).toBeTruthy();
  });
});

describe("ComposerPostureTrigger probe-pending placeholder (issue #1648)", () => {
  it("renders the loading placeholder in both dimensions while the probe is in flight", () => {
    renderTrigger({
      catalog: { kind: "builtin", models: [], profileModel: "claude-x", loading: true },
    });
    // Both dimension lists seat the disabled placeholder row; the pinned
    // synthetic row stays selectable beside it.
    expect(screen.getAllByText("Fetching model list…").length).toBe(2);
    expect(
      screen.getByRole("menuitemradio", { name: "claude-x" }),
    ).toBeTruthy();
  });

  it("seats the strength row while loading even with no knowable tiers", () => {
    renderTrigger({
      catalog: { kind: "builtin", models: [], profileModel: "claude-x", loading: true },
    });
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain("Thinking");
  });

  it("keeps the fallback shape silent once loading is over", () => {
    // loading=false (the default): the settled/failed shape keeps its
    // contract -- no placeholder, no error surface; the strength row keeps
    // its seat with the disabled no-levels hint.
    renderTrigger({
      catalog: { kind: "builtin", models: [], profileModel: "claude-x" },
    });
    expect(screen.queryByText("Fetching model list…")).toBeNull();
    const rows = screen.getAllByTestId("sub-trigger");
    expect(rows.length).toBe(2);
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
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
    expect(screen.getByText(/Selection not saved: Couldn't save the data file/)).toBeTruthy();
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
    // The tooltip is a display-layer mark: the menu's rows and clearing
    // rows are exactly the unselected state's. The checkmark names the
    // HELD value (issue #1648) -- the CLI current the live tooltip also
    // names -- so the current's row is the checked one.
    renderTrigger({ liveValue: "gemini-2.5-pro" });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.length).toBeGreaterThan(0);
    const checked = items.filter((item) => item.getAttribute("aria-checked") === "true");
    expect(checked.map((item) => item.textContent)).toEqual(["gemini-2.5-pro"]);
  });
});
