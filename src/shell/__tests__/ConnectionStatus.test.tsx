import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ConnectionStatus } from "../ConnectionStatus";
import type { KeyStatus, ProviderConfig } from "../../types/provider";

// Empty-catalog English IntlProvider so formatMessage resolves to its
// defaultMessage (the canonical English source, ADR-0052). onError is silenced
// -- the ids intentionally resolve via defaultMessage, not the empty catalog.
// TooltipProvider mirrors the App ancestor (the dual-state gear carries a
// Tooltip). Named renderRow to mirror the shell-test renderShell pattern.
function renderRow(ui: ReactElement) {
  return render(
    <TooltipProvider>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        {ui}
      </IntlProvider>
    </TooltipProvider>,
  );
}

// A single-profile provider fixture (ADR-0064): the active profile is "default"
// / "Anthropic". Tests override display_name / active_profile to exercise the
// name derivation + dot-state branches.
function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    profiles: [
      {
        id: "default",
        display_name: "Anthropic",
        protocol: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-sonnet",
      },
    ],
    active_profile: "default",
    ...over,
  };
}

// The status dot's color rides the ADR-0050 semantic tokens; data-slot anchors
// it without depending on the generic .rounded-full utility (issue #282).
function dotClasses(container: HTMLElement): string[] {
  const dot = container.querySelector("[data-slot='connection-dot']") as HTMLElement;
  return dot.className.split(/\s+/);
}

describe("ConnectionStatus (shared footer, issue #282)", () => {
  // The SAME component renders at both left columns' bottoms (workspace sidebar
  // + settings rail). The caller supplies the dual-state gear's view-specific
  // half via gearLabel + the two callbacks; the connection row + dot states are
  // shared. This suite covers the rail-side gear semantics (previously only the
  // workspace copy was tested) + the fourth dot state (no active profile).

  function renderStatus(over: {
    provider?: ProviderConfig;
    keyStatus?: KeyStatus;
    gearLabel?: string;
    onGearClick?: () => void;
    onRowClick?: () => void;
  } = {}) {
    const onGearClick = over.onGearClick ?? vi.fn();
    const onRowClick = over.onRowClick ?? vi.fn();
    const result = renderRow(
      <ConnectionStatus
        provider={over.provider ?? provider()}
        keyStatus={over.keyStatus ?? { has_key: true, keychain_fault: null }}
        gearLabel={over.gearLabel ?? "Settings"}
        onGearClick={onGearClick}
        onRowClick={onRowClick}
      />,
    );
    return { ...result, onGearClick, onRowClick };
  }

  it("renders the active profile name + Connected label on the primary dot", () => {
    const { container } = renderStatus();
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();
    expect(within(row).getByText("Connected")).toBeInTheDocument();
    expect(dotClasses(container)).toContain("bg-primary");
  });

  it("surfaces the workspace gear label as the gear's accessible name (open-settings half)", () => {
    const { getByRole } = renderStatus({ gearLabel: "Settings" });
    expect(getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("surfaces the rail gear label as the gear's accessible name (back-to-workspace half)", () => {
    // The rail-side half of the dual-state semantic was previously untested
    // (only the workspace sidebar copy exercised this component). The SAME gear
    // slot carries the caller-supplied label -- "Back to workspace" here.
    const { getByRole } = renderStatus({ gearLabel: "Back to workspace" });
    expect(getByRole("button", { name: "Back to workspace" })).toBeInTheDocument();
  });

  it("the gear fires onGearClick and leaves onRowClick untouched", () => {
    const { getByRole, onGearClick, onRowClick } = renderStatus();
    fireEvent.click(getByRole("button", { name: "Settings" }));
    expect(onGearClick).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("the whole-row click fires onRowClick and leaves the gear untouched", () => {
    const { container, onGearClick, onRowClick } = renderStatus();
    fireEvent.click(container.querySelector(".connection-row") as HTMLElement);
    expect(onRowClick).toHaveBeenCalledOnce();
    expect(onGearClick).not.toHaveBeenCalled();
  });

  it("reads No key + the warning dot when the active profile has no key", () => {
    const { container } = renderStatus({
      keyStatus: { has_key: false, keychain_fault: null },
    });
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(within(row).getByText("No key")).toBeInTheDocument();
    expect(dotClasses(container)).toContain("bg-warning");
  });

  it("reads Keychain unavailable + the destructive dot on a keychain fault", () => {
    const { container } = renderStatus({
      keyStatus: { has_key: false, keychain_fault: "locked" },
    });
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(within(row).getByText("Keychain unavailable")).toBeInTheDocument();
    expect(dotClasses(container)).toContain("bg-destructive");
  });

  it("falls back to Not configured + the muted dot when active_profile is missing", () => {
    // The fourth dot state: active_profile points at no profile in the list
    // (e.g. a profile was deleted while the row is mounted). The name falls
    // back to "Not configured" and the dot to the muted token -- a reachable
    // branch that was previously untested.
    const { container } = renderStatus({
      provider: provider({ active_profile: "missing" }),
      keyStatus: { has_key: false, keychain_fault: null },
    });
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(within(row).getByText("Not configured")).toBeInTheDocument();
    expect(dotClasses(container)).toContain("bg-muted-foreground/40");
  });

  it("falls back to Unnamed profile for a blank display name", () => {
    const { container } = renderStatus({
      provider: provider({
        profiles: [
          {
            id: "default",
            display_name: "   ",
            protocol: "anthropic",
            base_url: "https://api.anthropic.com",
            model: "claude-sonnet",
          },
        ],
      }),
    });
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(within(row).getByText("Unnamed profile")).toBeInTheDocument();
  });
});
