// The useProfileKeys fetch-fault flag (issue #1339): an IPC-level reject of
// list_provider_profiles must surface as keysFetchFault -- the banner's
// stay-out input, distinct from the backend-observable activeKeychainFault
// (issue #275) -- without dropping the retained-keys semantics: a failed
// refetch keeps the last-known overlay, and a success (fresh or post-epoch)
// clears the flag.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listProviderProfiles } from "../../api";
import type { ProviderConfig } from "../../types/provider";
import { useProfileKeys } from "../useProfileKeys";

vi.mock("../../api", () => ({ listProviderProfiles: vi.fn() }));

function provider(): ProviderConfig {
  return {
    profiles: [
      {
        id: "default",
        display_name: "Anthropic",
        protocol: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
      },
    ],
    active_profile: "default",
  };
}

describe("useProfileKeys keysFetchFault (issue #1339)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets the flag on a first-mount reject (keyless, loading settled)", async () => {
    vi.mocked(listProviderProfiles).mockRejectedValue(new Error("ipc down"));
    const { result } = renderHook(() => useProfileKeys(provider(), 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Pinned to the literal (not expect.any(String)): the test must tell the
    // e.message normalization apart from a String(e) / truncated variant.
    expect(result.current.keysFetchFault).toBe("ipc down");
    // The conservative gate posture is untouched: the reject still lands on
    // the keyless overlay, and no backend keychain fault is implied.
    expect(result.current.activeHasKey).toBe(false);
    expect(result.current.activeKeychainFault).toBeNull();
  });

  it("keeps the flag null on success", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true, keychain_fault: null },
    ]);
    const { result } = renderHook(() => useProfileKeys(provider(), 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.keysFetchFault).toBeNull();
    expect(result.current.activeHasKey).toBe(true);
  });

  it("retains prior keys and flags the fault when a refetch rejects", async () => {
    vi.mocked(listProviderProfiles)
      .mockResolvedValueOnce([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ])
      .mockRejectedValueOnce(new Error("ipc down"));
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useProfileKeys(provider(), epoch),
      { initialProps: { epoch: 0 } },
    );
    await waitFor(() => expect(result.current.activeHasKey).toBe(true));
    rerender({ epoch: 1 });
    await waitFor(() => expect(result.current.keysFetchFault).toBe("ipc down"));
    // The file-header honesty note: the failed refetch keeps the last-known
    // has_key instead of blanking the overlay.
    expect(result.current.activeHasKey).toBe(true);
  });

  it("clears the flag when a post-fault refetch succeeds", async () => {
    vi.mocked(listProviderProfiles)
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useProfileKeys(provider(), epoch),
      { initialProps: { epoch: 0 } },
    );
    await waitFor(() => expect(result.current.keysFetchFault).toBe("ipc down"));
    rerender({ epoch: 1 });
    await waitFor(() => expect(result.current.keysFetchFault).toBeNull());
    expect(result.current.activeHasKey).toBe(true);
  });

  it("ignores a late reject from a superseded epoch", async () => {
    // The cancelled guard around the fault write: the mount-time fetch stays
    // parked while the epoch bumps, the new fetch succeeds, and only THEN
    // does the parked reject land -- it must not stamp a stale fault over
    // the new epoch's answer (the reject has no DOM marker, so the settle is
    // flushed with the same two microtask hops as the App wiring pin).
    let rejectOld!: (e: unknown) => void;
    vi.mocked(listProviderProfiles)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useProfileKeys(provider(), epoch),
      { initialProps: { epoch: 0 } },
    );
    rerender({ epoch: 1 });
    await waitFor(() => expect(result.current.activeHasKey).toBe(true));
    await act(async () => {
      rejectOld(new Error("late ipc down"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.keysFetchFault).toBeNull();
    expect(result.current.activeHasKey).toBe(true);
  });

  it("normalizes a non-Error reject through String", async () => {
    // The String(e) arm of the boundary normalization: a bare-string reject
    // surfaces as itself, distinct from the Error arm's e.message read (a
    // hardcoded fallback instead of String(e) would turn this red).
    vi.mocked(listProviderProfiles).mockRejectedValue("raw string");
    const { result } = renderHook(() => useProfileKeys(provider(), 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.keysFetchFault).toBe("raw string");
  });
});
