// EngineSection (issue #1583, ADR-0150): the extension-channel tier switch
// pair. The main switch maps off↔core and the community child switch maps
// core↔community; both commit through ONE read-modify-write patch, so the
// pair can never persist two half-states. Pinned for the tiers: the off-tier
// render (child disabled), each tier transition, and the failed-commit face.
// Pinned for the memory limit (#1585): the stored-value parse-back, the
// compose-on-save, and the keep-stored fallbacks (cleared / zero / exponent /
// unpicked unit).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { baseAppConfig } from "../../../test-fixtures";
import type { AppConfig } from "../../../types/app-config";
import { EngineSection } from "../EngineSection";
import { chooseOption, openSelect, renderSettings } from "./helpers";

function renderSection(
  engine: AppConfig["engine"],
  onCommit: Mock = vi.fn().mockResolvedValue(null) as unknown as Mock,
) {
  const appConfig = baseAppConfig({ engine });
  renderSettings(<EngineSection appConfig={appConfig} onCommit={onCommit} />);
  return onCommit;
}

const mainSwitch = () => screen.getByRole("switch", { name: "Extension installs" });
const communitySwitch = () => screen.getByRole("switch", { name: "Community extensions" });
const memoryAmount = () => screen.getByRole("spinbutton", { name: "Memory limit" });
const memoryUnit = () => screen.getByRole("combobox", { name: "Memory limit unit" });

describe("EngineSection memory limit draft (#1585)", () => {
  it("round-trips the stored limit into the amount + unit pair", () => {
    renderSection({ memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off" });
    expect(memoryAmount()).toHaveValue(512);
    expect(memoryUnit()).toHaveTextContent("MB");
  });

  it("composes the structured draft into a well-formed limit on save", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    fireEvent.change(memoryAmount(), { target: { value: "768" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("768MB");
  });

  it("keeps the stored limit when the amount is cleared", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    fireEvent.change(memoryAmount(), { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("512MB");
  });

  // A number input with step="any" delivers exponent notation ("1e3") in
  // target.value; Number() accepts it, but the backend gate splits at the
  // first letter and would reject "1e3MB" -- the composed string must ride
  // the same digit/dot grammar so the silent sanitize revert stays dead.
  it("keeps the stored limit when the amount is exponent notation", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    fireEvent.change(memoryAmount(), { target: { value: "1e3" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("512MB");
  });

  // "0" rides the digit grammar, so the numeric guard is the only thing
  // between a zero amount and the gate-rejected "0MB" the sanitize layer
  // would silently revert at write time.
  it("keeps the stored limit when the amount is zero", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    fireEvent.change(memoryAmount(), { target: { value: "0" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("512MB");
  });

  // The backend accepts nine byte-multiple units; the UI offers MB/GB, so a
  // stored value outside the list (hand-edited "512MiB") is a reachable
  // state. It parses back to a filled amount plus an empty unit pick, and a
  // save from that state keeps the stored value.
  it("degrades a stored non-MB/GB unit to an empty pick that saves as a no-op", async () => {
    const onCommit = renderSection({
      memory_limit: "512MiB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    expect(memoryAmount()).toHaveValue(512);
    expect(memoryUnit()).toHaveTextContent(/^$/);
    fireEvent.change(memoryAmount(), { target: { value: "768" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("512MB");
  });

  it("composes the canonical value when a unit is re-picked over a degraded one", async () => {
    const onCommit = renderSection({
      memory_limit: "512MiB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    openSelect(memoryUnit());
    chooseOption("GB");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    expect(mutate(baseAppConfig()).engine.memory_limit).toBe("512GB");
  });
});

describe("EngineSection extension channel (#1583)", () => {
  it("renders the off tier with the community child inoperable", () => {
    renderSection({ memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off" });
    expect(mainSwitch()).not.toBeChecked();
    expect(communitySwitch()).not.toBeChecked();
    expect(communitySwitch()).toBeDisabled();
  });

  it("flips the main switch from off to core", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off",
    });
    fireEvent.click(mainSwitch());
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    const next = mutate(baseAppConfig());
    expect(next.engine.extension_channel).toBe("core");
  });

  it("keeps the core tier as core until the community child flips it", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "core",
    });
    expect(mainSwitch()).toBeChecked();
    expect(communitySwitch()).not.toBeChecked();
    expect(communitySwitch()).toBeEnabled();

    fireEvent.click(communitySwitch());
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    const next = mutate(baseAppConfig());
    expect(next.engine.extension_channel).toBe("community");
  });

  it("turning the main switch off from community lands on off, not core", async () => {
    const onCommit = renderSection({
      memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "community",
    });
    fireEvent.click(mainSwitch());
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutate = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    const next = mutate(baseAppConfig());
    expect(next.engine.extension_channel).toBe("off");
  });

  it("surfaces a failed commit on the pane's error line", async () => {
    const onCommit = vi.fn().mockResolvedValue("boom") as unknown as Mock;
    renderSection({ memory_limit: "512MB", threads: 1, row_cap: 100, extension_channel: "off" }, onCommit);
    fireEvent.click(mainSwitch());
    expect(await screen.findByText("boom")).toBeVisible();
  });
});
