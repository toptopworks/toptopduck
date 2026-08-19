import { describe, expect, it } from "vitest";

import { findActiveProfile } from "../findActiveProfile";
import type { ProviderConfig, ProviderProfile } from "../../types/provider";

// Minimal profile fixture: only the id matters to the resolution (the other
// fields ride along verbatim).
function profile(id: string): ProviderProfile {
  return {
    id,
    display_name: id,
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
  };
}

function config(
  profiles: ProviderProfile[],
  active_profile: string | null,
): ProviderConfig {
  return { profiles, active_profile };
}

// Pins the resolution semantics shared with the Rust `ProviderConfig::active()`
// (issue #576): a null pointer never matches any id, and a pointer that matches
// no profile resolves to undefined -- never a silent fallback to the first
// profile (that would point the live provider and the keychain read at the
// wrong slot; the Rust normalize nulls a dangling pointer instead).
describe("findActiveProfile", () => {
  it("returns the profile whose id matches the active pointer", () => {
    const a = profile("a");
    const b = profile("b");
    expect(findActiveProfile(config([a, b], "b"))).toBe(b);
  });

  it("returns undefined for the zero-profile state (empty set, null pointer)", () => {
    expect(findActiveProfile(config([], null))).toBeUndefined();
  });

  it("returns undefined when the pointer is null over a non-empty set", () => {
    const a = profile("a");
    expect(findActiveProfile(config([a], null))).toBeUndefined();
  });

  it("returns undefined when the pointer dangles (matches no profile)", () => {
    const a = profile("a");
    expect(findActiveProfile(config([a], "no-such-profile"))).toBeUndefined();
  });
});
