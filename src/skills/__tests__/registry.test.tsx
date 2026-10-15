import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  enabledRoster,
  invalidateSkills,
  skillIndex,
  useSkillsRegistry,
} from "../registry";
import {
  deleteSkill,
  importSkills,
  listSkills,
  setSkillEnabled,
} from "../../api";
import { skillKeys } from "../../session/queryKeys";
import { baseAppConfig, skillEntry } from "../../test-fixtures";
import type { SkillListing } from "../../types/skills";

// The registry seam's two test layers (issue #1077): the pure projections
// render-free, and the hook layer pinning the invalidation set + the
// onAppConfigSync injection -- the cache knowledge the component tests used
// to pin as listSkills call counts.

vi.mock("../../api", () => ({
  listSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
  importSkills: vi.fn(),
}));

const onSkill = skillEntry("pdf-tools", { description: "Work with PDFs." });
const offSkill = { ...skillEntry("vega-chart"), enabled: false };

function listingOf(skills: SkillListing["skills"]): SkillListing {
  return { skills, ignored: [], root_error: null };
}

// A per-test client (retry: false) so reject-driven assertions stay off the
// retry path, mirroring the component-test provider posture.
function makeHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

describe("skills registry pure projections", () => {
  it("reads an unanswered listing as an empty roster and keeps only enabled skills", () => {
    expect(enabledRoster(undefined)).toEqual([]);
    expect(enabledRoster(listingOf([onSkill, offSkill]))).toEqual([onSkill]);
  });

  it("stays an undefined index until an answer lands, then keys by spec name", () => {
    expect(skillIndex(undefined)).toBeUndefined();
    const index = skillIndex(listingOf([onSkill, offSkill]));
    expect(index?.get("pdf-tools")).toBe(onSkill);
    expect(index?.get("vega-chart")).toBe(offSkill);
    expect(index?.get("nope")).toBeUndefined();
  });
});

describe("useSkillsRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue(listingOf([onSkill, offSkill]));
    vi.mocked(setSkillEnabled).mockResolvedValue(baseAppConfig());
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    vi.mocked(importSkills).mockResolvedValue([]);
  });

  it("pairs the one listing read on the shared all() key", async () => {
    const { wrapper, queryClient } = makeHarness();
    const { result } = renderHook(() => useSkillsRegistry(), { wrapper });
    await waitFor(() => expect(result.current.listing).toBeDefined());
    // The shared-key posture: the picker / rail / settings dedupe onto this
    // one cache entry, never their own keys.
    expect(queryClient.getQueryState(skillKeys.all())).not.toBeNull();
    expect(listSkills).toHaveBeenCalledTimes(1);
    // The projection outputs, asserted non-empty here: every consumer suite
    // mocks an empty listing, so this is the seam's own window on the
    // roster / index wiring.
    expect(result.current.enabledRoster).toEqual([onSkill]);
    expect(result.current.skillIndex?.get("vega-chart")).toBe(offSkill);
  });

  it("gates the listing IPC behind enabled: false", async () => {
    const { wrapper } = makeHarness();
    renderHook(() => useSkillsRegistry({ enabled: false }), { wrapper });
    // The picker's surface-off posture: no observer fetch fires (a microtask
    // flush would surface any un-gated IPC).
    await act(async () => {
      await Promise.resolve();
    });
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("forwards a toggle's returned config to the injected sync and invalidates", async () => {
    const onAppConfigSync = vi.fn();
    const synced = baseAppConfig({ disabled_skills: ["pdf-tools"] });
    vi.mocked(setSkillEnabled).mockResolvedValue(synced);
    const { wrapper } = makeHarness();
    const { result } = renderHook(
      () => useSkillsRegistry({ onAppConfigSync }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.listing).toBeDefined());
    act(() => {
      result.current.setSkillEnabledMutation.mutate({
        name: "pdf-tools",
        enabled: false,
      });
    });
    await waitFor(() => expect(onAppConfigSync).toHaveBeenCalledWith(synced));
    // The invalidation half: the active listing refetches.
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("keeps a rejected write from syncing the config or invalidating", async () => {
    const onAppConfigSync = vi.fn();
    vi.mocked(setSkillEnabled).mockRejectedValue(new Error("ipc down"));
    const { wrapper } = makeHarness();
    const { result } = renderHook(
      () => useSkillsRegistry({ onAppConfigSync }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.listing).toBeDefined());
    act(() => {
      result.current.setSkillEnabledMutation.mutate({
        name: "pdf-tools",
        enabled: false,
      });
    });
    await waitFor(() =>
      expect(result.current.setSkillEnabledMutation.isError).toBe(true),
    );
    // The contract's failure half: a rejected write syncs no config and
    // invalidates nothing (the listing fetch stays at its one mount call).
    expect(onAppConfigSync).not.toHaveBeenCalled();
    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  it("invalidates the listing after a delete", async () => {
    const { wrapper } = makeHarness();
    const { result } = renderHook(() => useSkillsRegistry(), { wrapper });
    await waitFor(() => expect(result.current.listing).toBeDefined());
    act(() => {
      result.current.deleteSkillMutation.mutate("pdf-tools");
    });
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("pdf-tools"));
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  it("cascades an import's invalidation to the sources discovery reads", async () => {
    const { wrapper, queryClient } = makeHarness();
    // Seed an INACTIVE sources entry (no observer attached): the only
    // witness the cascade reaches it is its invalidated state.
    queryClient.setQueryData(skillKeys.sources([]), []);
    const { result } = renderHook(() => useSkillsRegistry(), { wrapper });
    await waitFor(() => expect(result.current.listing).toBeDefined());
    act(() => {
      result.current.importSkillsMutation.mutate({
        items: [{ source_dir: "/home/u/.claude/skills/alpha" }],
        mode: "link",
      });
    });
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    // The cascade contract's test pin: one invalidate, the sources family
    // invalidated with it.
    expect(
      queryClient.getQueryState(skillKeys.sources([]))?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates the listing and the sources family from the exported entry alone", async () => {
    const { wrapper, queryClient } = makeHarness();
    queryClient.setQueryData(skillKeys.sources(["/custom/lib"]), []);
    const { result } = renderHook(() => useSkillsRegistry(), { wrapper });
    await waitFor(() => expect(result.current.listing).toBeDefined());
    act(() => {
      invalidateSkills(queryClient);
    });
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    expect(
      queryClient.getQueryState(skillKeys.sources(["/custom/lib"]))
        ?.isInvalidated,
    ).toBe(true);
  });
});
