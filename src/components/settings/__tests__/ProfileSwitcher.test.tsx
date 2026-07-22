import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ProfileSwitcher } from "../ProfileSwitcher";
import { listProviderProfiles } from "../../../api";
import type { ProviderConfig } from "../../../types/provider";
import { renderSettings } from "./helpers";

// ProfileSwitcher fetches the per-profile key overlay once on mount; mock the
// fetch so the view never hits Tauri (ADR-0029 one-shot keychain surface).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
  };
});

describe("ProfileSwitcher shell-skeleton visuals (ADR-0067, issue #171)", () => {
  // A two-profile ProviderConfig for the switcher tests: the active profile is
  // parameterized so the aria-checked test can seed any active id.
  function switcherProvider(activeId: string = "anthropic"): ProviderConfig {
    return {
      profiles: [
        {
          id: "anthropic",
          display_name: "Anthropic",
          protocol: "anthropic",
          base_url: "https://api.anthropic.com",
          model: "claude-sonnet-4-6",
        },
        {
          id: "glm",
          display_name: "GLM",
          protocol: "openai",
          base_url: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-4",
        },
      ],
      active_profile: activeId,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
  });

  it("profile-switcher-trigger carries hover:bg-muted + max-w-56 + bg-card", () => {
    const { container } = renderSettings(
      <ProfileSwitcher provider={switcherProvider()} onSwitchActive={() => {}} />,
    );
    const trigger = container.querySelector(".profile-switcher-trigger");
    expect(trigger).not.toBeNull();
    const classes = trigger?.className.split(/\s+/);
    expect(classes).toContain("hover:bg-muted");
    expect(classes).toContain("max-w-56");
    expect(classes).toContain("bg-card");
  });

  it("profile-switcher-menu carries absolute + shadow + z-50", () => {
    const { container } = renderSettings(
      <ProfileSwitcher provider={switcherProvider()} onSwitchActive={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Active profile:/ }));
    const menu = container.querySelector(".profile-switcher-menu");
    expect(menu).not.toBeNull();
    const classes = menu?.className.split(/\s+/);
    expect(classes).toContain("absolute");
    expect(classes).toContain("z-50");
    expect(classes).toContain("shadow-md");
  });

  it("profile-switcher-item aria-checked lifts font-semibold", () => {
    const { container } = renderSettings(
      <ProfileSwitcher provider={switcherProvider()} onSwitchActive={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Active profile:/ }));
    const active = container.querySelector(`.profile-switcher-item[aria-checked="true"]`);
    expect(active).not.toBeNull();
    expect(active?.className.split(/\s+/)).toContain("font-semibold");
    const inactive = container.querySelector(`.profile-switcher-item:not([aria-checked="true"])`);
    expect(inactive).not.toBeNull();
    expect(inactive?.className.split(/\s+/)).not.toContain("font-semibold");
  });

  it("profile-switcher-item carries enabled:hover:bg-muted + disabled dim", () => {
    const { container } = renderSettings(
      <ProfileSwitcher provider={switcherProvider()} onSwitchActive={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Active profile:/ }));
    const item = container.querySelector(".profile-switcher-item");
    expect(item).not.toBeNull();
    const classes = item?.className.split(/\s+/);
    expect(classes).toContain("enabled:hover:bg-muted");
    expect(classes).toContain("disabled:opacity-50");
    expect(classes).toContain("disabled:cursor-not-allowed");
  });
});
