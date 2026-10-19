// The cold-start guidance banner's two test surfaces (issue #1337):
// 1. The pure trigger matrix, tested per-cell at module level (the
//    first_free_target precedent) -- the render states, the three
//    unresolved-feed gates, the two fault stay-outs (keychain read +
//    keys fetch, issues #275/#1339), and the healthy-posture nulls.
// 2. The component: three gap forms each render their copy + the shared CTA,
//    and the CTA routes through the openSettings channel.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";

import {
  ColdStartGuideBanner,
  deriveColdStartGap,
  type ColdStartGap,
  type ColdStartGapInputs,
} from "../ColdStartGuideBanner";

function adapter(id: string, detected: boolean): ColdStartGapInputs["adapters"] {
  return [
    {
      id,
      display_name: id,
      detected,
      binary_path: detected ? `/bin/${id}` : null,
      stream_format: "acp",
    },
  ];
}

function providerWith(profileCount: number): ColdStartGapInputs["provider"] {
  if (profileCount === 0) return { profiles: [], active_profile: null };
  return {
    profiles: Array.from({ length: profileCount }, (_, i) => ({
      id: `profile-${i}`,
      display_name: `Profile ${i}`,
      protocol: "anthropic" as const,
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
    })),
    active_profile: "profile-0",
  };
}

// The fully-configured baseline: built-in everywhere, one keyed profile, a
// detected table, nothing loading -- the one state that renders NO banner.
function gapInputs(overrides?: Partial<ColdStartGapInputs>): ColdStartGapInputs {
  return {
    defaultRuntime: { kind: "built_in" },
    pendingRuntime: { kind: "built_in" },
    adapters: adapter("qwen-code", true),
    provider: providerWith(1),
    keysLoading: false,
    activeHasKey: true,
    activeKeychainFault: null,
    keysFetchFault: null,
    ...overrides,
  };
}

describe("deriveColdStartGap (trigger matrix)", () => {
  // --- render states (4) ----------------------------------------------------
  it("flags cli-missing for an external pending whose adapter is undetected", () => {
    expect(
      deriveColdStartGap(
        gapInputs({
          pendingRuntime: { kind: "external", data: "qwen-code" },
          adapters: adapter("qwen-code", false),
        }),
      ),
    ).toBe("cli-missing");
  });

  it("flags cli-missing for an external pending whose id left the table", () => {
    expect(
      deriveColdStartGap(
        gapInputs({
          pendingRuntime: { kind: "external", data: "vanished-cli" },
        }),
      ),
    ).toBe("cli-missing");
  });

  it("flags cli-missing for the degrade (built-in pending over an UNDETECTED external default) before any key posture", () => {
    // The default names an undetected CLI, so the startup resolution degraded
    // the pending to built-in -- the root cause wins even though the keyed
    // baseline would report nothing.
    expect(
      deriveColdStartGap(
        gapInputs({
          defaultRuntime: { kind: "external", data: "qwen-code" },
          adapters: adapter("qwen-code", false),
        }),
      ),
    ).toBe("cli-missing");
  });

  it("treats a detected default under a manual built-in pick as no CLI wall", () => {
    // The user chose built-in over a healthy default CLI -- the degrade
    // clause must NOT fire (the CLI is fine, "was not detected" would be a
    // false statement); the key posture speaks instead.
    expect(
      deriveColdStartGap(
        gapInputs({ defaultRuntime: { kind: "external", data: "qwen-code" } }),
      ),
    ).toBeNull();
    expect(
      deriveColdStartGap(
        gapInputs({
          defaultRuntime: { kind: "external", data: "qwen-code" },
          activeHasKey: false,
        }),
      ),
    ).toBe("key-missing");
  });

  it("flags profile-missing for the zero-profile state", () => {
    expect(deriveColdStartGap(gapInputs({ provider: providerWith(0) }))).toBe(
      "profile-missing",
    );
  });

  it("flags key-missing for a keyed-shape profile without a key", () => {
    expect(deriveColdStartGap(gapInputs({ activeHasKey: false }))).toBe(
      "key-missing",
    );
  });

  // --- suppressed states (5) -------------------------------------------------
  it("renders nothing while the key overlay's first fetch is in flight", () => {
    // Riding a would-render posture (keyless): the gate must hold even when
    // the settled answer would be a banner -- a null-deriving baseline cannot
    // tell the gate from the absence of a gap.
    expect(
      deriveColdStartGap(gapInputs({ keysLoading: true, activeHasKey: false })),
    ).toBeNull();
  });

  it("renders nothing while the adapter table has not loaded", () => {
    // Same discipline: an unloaded table over an undetected external default
    // must not flash the degrade banner before the resolution settles.
    expect(
      deriveColdStartGap(
        gapInputs({
          adapters: undefined,
          defaultRuntime: { kind: "external", data: "qwen-code" },
        }),
      ),
    ).toBeNull();
  });

  it("renders nothing while the provider feed is unresolved", () => {
    // The app-config read pending or failed -- a defer, not a wall: under
    // the old conflation this painted "no provider profile" on a possibly
    // configured machine (a loaded zero-profile config is the wall, and
    // providerWith(0) above pins that side).
    expect(deriveColdStartGap(gapInputs({ provider: null }))).toBeNull();
  });

  it("renders nothing on a keychain fault (the OS answer is unknowable, issue #275)", () => {
    expect(
      deriveColdStartGap(
        gapInputs({ activeHasKey: false, activeKeychainFault: "locked" }),
      ),
    ).toBeNull();
  });

  it("renders nothing when the keys IPC fetch rejected (issue #1339)", () => {
    // Riding the keyless posture: without the stay-out this state falls
    // through to key-missing -- a keyed baseline cell has no discriminative
    // power here (both answers are null).
    expect(
      deriveColdStartGap(
        gapInputs({ activeHasKey: false, keysFetchFault: "ipc down" }),
      ),
    ).toBeNull();
  });

  it("keeps the root-cause walls over a keys fetch fault (issue #1339)", () => {
    // The fetch-fault stay-out sits with the keychain-fault branch (it mutes
    // only the KEY posture): a real CLI wall still speaks. A guard hoisted
    // above the CLI branches would mute the degrade and this cell goes red.
    expect(
      deriveColdStartGap(
        gapInputs({
          defaultRuntime: { kind: "external", data: "qwen-code" },
          adapters: adapter("qwen-code", false),
          keysFetchFault: "ipc down",
        }),
      ),
    ).toBe("cli-missing");
  });

  it("keeps the profile-missing wall over a keys fetch fault (issue #1339)", () => {
    // The other half of the stay-out's precedence: the fault branch mutes
    // only the KEY posture, so a zero-profile config still speaks even with
    // a rejected keys IPC -- hoisting the fault check above the profile
    // branch would mute this wall and the cell goes red. Reachable in the
    // real wiring: the flag survives a profilesLen N-to-0 transition.
    expect(
      deriveColdStartGap(
        gapInputs({ provider: providerWith(0), keysFetchFault: "ipc down" }),
      ),
    ).toBe("profile-missing");
  });

  it("renders nothing for a detected external pending", () => {
    expect(
      deriveColdStartGap(
        gapInputs({
          pendingRuntime: { kind: "external", data: "qwen-code" },
        }),
      ),
    ).toBeNull();
  });

  it("renders nothing for a detected external pending over a keyless profile", () => {
    // The external branch's early return is the only thing keeping the key
    // posture off a healthy external setup -- a CLI runtime consumes no API
    // key, so a reordered derivation would paint a false key wall on the
    // dominant external shape. The keyed-baseline cell above cannot tell.
    expect(
      deriveColdStartGap(
        gapInputs({
          pendingRuntime: { kind: "external", data: "qwen-code" },
          activeHasKey: false,
        }),
      ),
    ).toBeNull();
  });

  it("renders nothing when the built-in posture has its key", () => {
    expect(deriveColdStartGap(gapInputs())).toBeNull();
  });
});

describe("ColdStartGuideBanner (component)", () => {
  function renderBanner(gap: ColdStartGap) {
    const onOpenSettings = vi.fn();
    render(
      <IntlProvider locale="en-US">
        <ColdStartGuideBanner gap={gap} onOpenSettings={onOpenSettings} />
      </IntlProvider>,
    );
    return onOpenSettings;
  }

  it("renders the cli-missing copy with the shared CTA", () => {
    renderBanner("cli-missing");
    const status = screen.getByRole("status");
    expect(
      within(status).getByText(/was not detected/i),
    ).toBeInTheDocument();
    expect(
      within(status).getByRole("button", { name: "Open Settings" }),
    ).toBeInTheDocument();
  });

  it("renders the profile-missing copy", () => {
    renderBanner("profile-missing");
    expect(
      within(screen.getByRole("status")).getByText(
        /No provider profile is configured/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders the key-missing copy", () => {
    renderBanner("key-missing");
    expect(
      within(screen.getByRole("status")).getByText(/has no API key/i),
    ).toBeInTheDocument();
  });

  it("routes the CTA through the openSettings channel exactly once per click", () => {
    const onOpenSettings = renderBanner("key-missing");
    fireEvent.click(
      within(screen.getByRole("status")).getByRole("button", {
        name: "Open Settings",
      }),
    );
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
