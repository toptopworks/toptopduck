// EngineSection (issue #1583, ADR-0150): the extension-channel tier switch
// pair. The main switch maps off↔core and the community child switch maps
// core↔community; both commit through ONE read-modify-write patch, so the
// pair can never persist two half-states. Pinned here: the off-tier render
// (child disabled), each tier transition, and the failed-commit face.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { baseAppConfig } from "../../../test-fixtures";
import type { AppConfig } from "../../../types/app-config";
import { EngineSection } from "../EngineSection";
import { renderSettings } from "./helpers";

function renderSection(
  engine: AppConfig["engine"],
  onCommit: Mock = vi.fn().mockResolvedValue(null) as unknown as Mock,
) {
  const appConfig = baseAppConfig({ engine });
  renderSettings(<EngineSection appConfig={appConfig} onCommit={onCommit} />);
  return onCommit;
}

const mainSwitch = () => screen.getByRole("switch", { name: "Extension channel:" });
const communitySwitch = () => screen.getByRole("switch", { name: "Community extensions:" });

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
