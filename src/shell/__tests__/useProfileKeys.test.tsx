// The useProfileKeys fetch-fault flag (issue #1339): an IPC-level reject of
// list_provider_profiles must surface as keysFetchFault -- the banner's
// stay-out input, distinct from the backend-observable activeKeychainFault
// (issue #275) -- without dropping the retained-keys semantics: a failed
// refetch keeps the last-known overlay, and a success (fresh or post-epoch)
// clears the flag.

import { renderHook, waitFor } from "@testing-library/react";
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
});
