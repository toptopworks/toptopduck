import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { ColdStartHero } from "../ColdStartHero";
import { listProviderProfiles } from "../../api";
import type { ProviderConfig, ProviderProfile } from "../../types/provider";

// ColdStartHero fetches the per-profile has_key overlay on mount via the SAME
// IPC ProfilesSection uses (issue #239 AC). Mock it so the
// view never hits Tauri (ADR-0029 one-shot keychain surface; jsdom has no IPC).
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
  };
});

// Silence the log sink: the error-path test triggers log.warn, which routes to
// @tauri-apps/plugin-log and rejects under jsdom. The real log.ts swallows the
// rejection (fire-and-forget), but the dev-mode console mirror would noise up
// test output; the no-op mock keeps assertions clean without changing behavior.
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Empty-catalog English IntlProvider so FormattedMessage resolves to its
// defaultMessage (the canonical English source, ADR-0052). onError is silenced
// -- the ids intentionally resolve via defaultMessage, not the empty catalog.
// Mirrors the settings/component-test helper pattern.
function renderShell(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

// A single-profile anthropic provider; the active id is parameterized so the
// no-key / ready tests can vary has_key against a known active profile.
function makeProvider(activeId: string = "p1", profiles: ProviderProfile[] = []): ProviderConfig {
  return {
    profiles:
      profiles.length > 0
        ? profiles
        : [
            {
              id: activeId,
              display_name: "Anthropic",
              protocol: "anthropic",
              base_url: "https://api.anthropic.com",
              model: "claude-sonnet-4-6",
            },
          ],
    active_profile: activeId,
  };
}

describe("ColdStartHero three-state guide (issue #239)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
  });

  it("no-profile: renders setup CTA and skips the key fetch", async () => {
    const onNew = vi.fn();
    const onOpenSettingsProfiles = vi.fn<(editProfileId?: string) => void>();
    renderShell(
      <ColdStartHero
        disabled={false}
        provider={{ profiles: [], active_profile: "none" }}
        profileKeyEpoch={0}
        onNew={onNew}
        onOpenSettingsProfiles={onOpenSettingsProfiles}
      />,
    );
    // mode = "no-profile" fires on the FIRST render (profiles.length === 0
    // short-circuits before the overlay resolves), so the heading is present
    // synchronously; findByRole is used for uniformity with the async cases.
    expect(await screen.findByRole("heading", { name: "Set up a provider profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    // No fetch is issued: with zero profiles the mode is "no-profile" regardless
    // of key status, so the effect short-circuits (one less cold-start IPC).
    expect(listProviderProfiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettingsProfiles).toHaveBeenCalledTimes(1);
    // Called with NO editProfileId (there is no profile to pre-select).
    expect(onOpenSettingsProfiles.mock.calls[0][0]).toBeUndefined();
    expect(onNew).not.toHaveBeenCalled();
  });

  it("no-key: renders key CTA -> onOpenSettingsProfiles(activeId)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: false },
    ]);
    const onNew = vi.fn();
    const onOpenSettingsProfiles = vi.fn<(editProfileId?: string) => void>();
    renderShell(
      <ColdStartHero
        disabled={false}
        provider={makeProvider()}
        profileKeyEpoch={0}
        onNew={onNew}
        onOpenSettingsProfiles={onOpenSettingsProfiles}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Add an API key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(listProviderProfiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettingsProfiles).toHaveBeenCalledTimes(1);
    // The active profile id is forwarded so Settings lands on its edit form.
    expect(onOpenSettingsProfiles.mock.calls[0][0]).toBe("p1");
    expect(onNew).not.toHaveBeenCalled();
  });

  it("ready: renders the legacy new-session CTA -> onNew", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: true },
    ]);
    const onNew = vi.fn();
    const onOpenSettingsProfiles = vi.fn<(editProfileId?: string) => void>();
    renderShell(
      <ColdStartHero
        disabled={false}
        provider={makeProvider()}
        profileKeyEpoch={0}
        onNew={onNew}
        onOpenSettingsProfiles={onOpenSettingsProfiles}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Start an analysis" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onOpenSettingsProfiles).not.toHaveBeenCalled();
  });

  it("ready CTA is disabled when the busy gate is set", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: true },
    ]);
    renderShell(
      <ColdStartHero
        disabled={true}
        provider={makeProvider()}
        profileKeyEpoch={0}
        onNew={vi.fn()}
        onOpenSettingsProfiles={vi.fn()}
      />,
    );
    // Wait for the overlay to resolve so the assertion sees the steady state,
    // not the loading appearance (which also renders the ready copy).
    const cta = await screen.findByRole("button", { name: "New session" });
    expect(cta).toBeDisabled();
  });

  it("listProviderProfiles rejection falls through to the no-key CTA (conservative)", async () => {
    vi.mocked(listProviderProfiles).mockRejectedValue(new Error("keychain down"));
    renderShell(
      <ColdStartHero
        disabled={false}
        provider={makeProvider()}
        profileKeyEpoch={0}
        onNew={vi.fn()}
        onOpenSettingsProfiles={vi.fn()}
      />,
    );
    // First-mount failure: no prior snapshot, so the empty overlay yields
    // has_key=false -> "no-key" (the spec's "don't pretend ready" conservative
    // direction, issue #239). Settings surfaces the real key status on click.
    expect(await screen.findByRole("heading", { name: "Add an API key" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Start an analysis" })).not.toBeInTheDocument();
  });

  it("profileKeyEpoch bump refetches the overlay (settings-close invalidation)", async () => {
    // First render: active profile has no key -> "no-key".
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: false },
    ]);
    const onNew = vi.fn();
    const onOpenSettingsProfiles = vi.fn<(editProfileId?: string) => void>();
    const { rerender } = renderShell(
      <ColdStartHero
        disabled={false}
        provider={makeProvider()}
        profileKeyEpoch={0}
        onNew={onNew}
        onOpenSettingsProfiles={onOpenSettingsProfiles}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Add an API key" })).toBeInTheDocument();
    expect(listProviderProfiles).toHaveBeenCalledTimes(1);

    // Settings round-trip: App bumps the epoch; the user configured a key.
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: true },
    ]);
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ColdStartHero
          disabled={false}
          provider={makeProvider()}
          profileKeyEpoch={1}
          onNew={onNew}
          onOpenSettingsProfiles={onOpenSettingsProfiles}
        />
      </IntlProvider>,
    );
    // The epoch bump refetches; the hero transitions to "ready" (no stale
    // "no-key" lingering after the user just configured a key, ADR-0019).
    expect(await screen.findByRole("heading", { name: "Start an analysis" })).toBeInTheDocument();
    expect(listProviderProfiles).toHaveBeenCalledTimes(2);
  });

  it("null provider -> resolved refetches the overlay (app-config async resolve)", async () => {
    // App mounts ColdStartHero while app-config is still loading
    // (useAppConfigState resolves it via an async getAppConfig IPC), so the hero
    // often first renders with provider=null. The overlay MUST refetch once
    // provider resolves, or the hero stays stuck on the "ready" appearance even
    // when the active profile has no key -- defeating the issue #239 honest-gate
    // AC (the whole point of the three-state refactor).
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "p1", has_key: false },
    ]);
    const onNew = vi.fn();
    const onOpenSettingsProfiles = vi.fn<(editProfileId?: string) => void>();
    const { rerender } = renderShell(
      <ColdStartHero
        disabled={false}
        provider={null}
        profileKeyEpoch={0}
        onNew={onNew}
        onOpenSettingsProfiles={onOpenSettingsProfiles}
      />,
    );
    // provider null -> effect short-circuits (no fetch); mode renders "ready".
    expect(screen.getByRole("heading", { name: "Start an analysis" })).toBeInTheDocument();
    expect(listProviderProfiles).not.toHaveBeenCalled();

    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ColdStartHero
          disabled={false}
          provider={makeProvider()}
          profileKeyEpoch={0}
          onNew={onNew}
          onOpenSettingsProfiles={onOpenSettingsProfiles}
        />
      </IntlProvider>,
    );
    // provider resolved -> overlay refetches -> active profile has no key ->
    // "no-key" CTA (not stuck on "ready").
    expect(await screen.findByRole("heading", { name: "Add an API key" })).toBeInTheDocument();
    expect(listProviderProfiles).toHaveBeenCalledTimes(1);
    expect(onNew).not.toHaveBeenCalled();
  });
});
