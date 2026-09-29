import { describe, expect, it } from "vitest";

import {
  derivePostureCatalog,
  EMPTY_POSTURE,
  type PostureCatalogReads,
} from "../posture-catalog";
import type {
  AdapterCatalogEntry,
  AdapterEntry,
  CatalogModel,
  DiscoveredRuntime,
} from "../../../types/runtime";

// posture-catalog tests (ADR-0096 D6 priority chain, ADR-0100 live currents,
// issue #529 provenance): the pure projection behind the composer's posture
// surface -- which catalog the cascade menu offers, which provenance note the
// trigger renders, and which turn-end live currents the tooltip carries.
// Function-level here so the picker's component tests only carry the UI face.

// The shared ACP handshake catalog fixture (issue #527), stamped by the
// engine (issue #529) -- `adapter_id` is the provenance stamp.
const STAMPED_CATALOG: DiscoveredRuntime = {
  models: ["fake-opus", "fake-sonnet"],
  current_model: "fake-opus",
  thought_levels: ["low", "medium", "high"],
  current_thought_level: "medium",
  adapter_id: "qwen-code",
};

// The pre-stamp catalog shape (persisted before the provenance field
// existed): same facts, no adapter_id -- unattributable, not stale.
const PRE_STAMP_CATALOG: DiscoveredRuntime = {
  models: ["fake-opus", "fake-sonnet"],
  current_model: "fake-opus",
  thought_levels: ["low", "medium", "high"],
  current_thought_level: "medium",
};

function adapter(
  id: string,
  stream_format: AdapterEntry["stream_format"] = "acp",
): AdapterEntry {
  return {
    id,
    display_name: id,
    detected: true,
    binary_path: `/usr/local/bin/${id}`,
    stream_format,
  };
}

const ACP_PROBE_ENTRY: AdapterCatalogEntry = {
  probe_kind: "acp",
  outcome: {
    acp: { discovered: { ...STAMPED_CATALOG, adapter_id: "qwen-code" } },
  },
  probed_at_millis: 0,
};

const CODEX_MODELS: CatalogModel[] = [
  {
    id: "gpt-5",
    display_name: "GPT-5",
    is_default: true,
    default_reasoning_effort: "medium",
    supported_reasoning_efforts: ["low", "medium", "high"],
  },
];

const CODEX_PROBE_ENTRY: AdapterCatalogEntry = {
  probe_kind: "codex_event_stream",
  outcome: { codex_event_stream: { models: CODEX_MODELS } },
  probed_at_millis: 0,
};

// The default reads: the external ACP runtime with its own stamped session
// discovery -- the settled in-session surface.
function reads(overrides: Partial<PostureCatalogReads> = {}): PostureCatalogReads {
  return {
    isExternal: true,
    activeAdapterId: "qwen-code",
    activeAdapter: adapter("qwen-code"),
    discovered: STAMPED_CATALOG,
    probeEntry: null,
    posture: EMPTY_POSTURE,
    ...overrides,
  };
}

describe("posture catalog priority chain (ADR-0096 D6)", () => {
  it("yields no catalog on the built-in runtime (static label)", () => {
    const out = derivePostureCatalog(
      reads({ isExternal: false, activeAdapter: null, discovered: null }),
    );
    expect(out.catalog).toBeNull();
    expect(out.note).toBeNull();
    expect(out.liveDiscovered).toBeNull();
  });

  it("prefers the session's stamped discovery as the ACP catalog verbatim", () => {
    const out = derivePostureCatalog(reads({ probeEntry: ACP_PROBE_ENTRY }));
    expect(out.catalog).toEqual({
      kind: "acp",
      models: STAMPED_CATALOG.models,
      thoughtLevels: STAMPED_CATALOG.thought_levels,
      currentModel: "fake-opus",
      currentThoughtLevel: "medium",
    });
    // Session-owned discovery outranks the probe cache: no note.
    expect(out.note).toBeNull();
  });

  it("seeds the ACP catalog from the probe entry when the session has none, with the from-probe note", () => {
    const out = derivePostureCatalog(
      reads({ discovered: null, probeEntry: ACP_PROBE_ENTRY }),
    );
    expect(out.catalog).not.toBeNull();
    expect(out.catalog?.kind).toBe("acp");
    expect(out.note).toBe("from-probe");
  });

  it("renders no catalog when neither source exists for an ACP runtime", () => {
    const out = derivePostureCatalog(reads({ discovered: null }));
    expect(out.catalog).toBeNull();
    expect(out.note).toBeNull();
  });

  it("renders the per-model catalog from a per-model probe entry", () => {
    const out = derivePostureCatalog(
      reads({
        activeAdapter: adapter("codex", "codex_event_stream"),
        activeAdapterId: "codex",
        discovered: null,
        probeEntry: CODEX_PROBE_ENTRY,
      }),
    );
    expect(out.catalog).toEqual({ kind: "perModel", models: CODEX_MODELS });
    expect(out.note).toBeNull();
  });

  it("renders no catalog for a per-model adapter holding only an acp-kind probe entry", () => {
    // The probe-kind / stream-format dispatch must agree: a leftover acp
    // entry (probed before a format change) never feeds the per-model menu.
    const out = derivePostureCatalog(
      reads({
        activeAdapter: adapter("codex", "codex_event_stream"),
        activeAdapterId: "codex",
        discovered: null,
        probeEntry: ACP_PROBE_ENTRY,
      }),
    );
    expect(out.catalog).toBeNull();
  });
});

describe("posture catalog provenance note (issue #529)", () => {
  it("flags a session discovery stamped by a different adapter as stale-runtime", () => {
    const out = derivePostureCatalog(
      reads({
        activeAdapterId: "codex",
        activeAdapter: adapter("codex"),
        discovered: { ...STAMPED_CATALOG, adapter_id: "qwen-code" },
      }),
    );
    expect(out.note).toBe("stale-runtime");
  });

  it("does not flag a discovery stamped by the active adapter itself", () => {
    const out = derivePostureCatalog(reads());
    expect(out.note).toBeNull();
  });

  it("does not flag a pre-stamp discovery with no adapter_id (unattributable, not stale)", () => {
    const out = derivePostureCatalog(reads({ discovered: PRE_STAMP_CATALOG }));
    expect(out.note).toBeNull();
  });

  it("never flags a per-model adapter (its turns never replace the discovery cache)", () => {
    const out = derivePostureCatalog(
      reads({
        activeAdapter: adapter("codex", "codex_event_stream"),
        activeAdapterId: "codex",
        discovered: { ...STAMPED_CATALOG, adapter_id: "qwen-code" },
        probeEntry: CODEX_PROBE_ENTRY,
      }),
    );
    expect(out.note).toBeNull();
  });

  it("resolves the stale note over from-probe when both predicates could fire", () => {
    // The two are complementary over `discovered` in practice (stale needs a
    // session discovery, from-probe needs none), but a stale stamp must never
    // degrade into the from-probe note.
    const out = derivePostureCatalog(
      reads({
        activeAdapterId: "codex",
        activeAdapter: adapter("codex"),
        discovered: { ...STAMPED_CATALOG, adapter_id: "qwen-code" },
        probeEntry: ACP_PROBE_ENTRY,
      }),
    );
    expect(out.note).toBe("stale-runtime");
  });
});

describe("turn-end live currents gate (issue #586, ADR-0100)", () => {
  it("admits only a discovery stamped by the active adapter as live", () => {
    expect(derivePostureCatalog(reads()).liveDiscovered).toBe(STAMPED_CATALOG);
    expect(
      derivePostureCatalog(
        reads({
          discovered: { ...STAMPED_CATALOG, adapter_id: "other-cli" },
        }),
      ).liveDiscovered,
    ).toBeNull();
  });

  it("does not admit a pre-stamp discovery as live (unattributable)", () => {
    expect(
      derivePostureCatalog(reads({ discovered: PRE_STAMP_CATALOG }))
        .liveDiscovered,
    ).toBeNull();
  });

  it("carries the turn's pair in liveValue only while nothing is held", () => {
    expect(derivePostureCatalog(reads()).liveValue).toBe("fake-opus · medium");
    expect(
      derivePostureCatalog(
        reads({ posture: { model: "fake-sonnet", thought_level: null } }),
      ).liveValue,
    ).toBeNull();
  });

  it("drops empty-string held fields like the menu guards (hand-edited blanks)", () => {
    expect(
      derivePostureCatalog(
        reads({ posture: { model: "", thought_level: "" } }),
      ).liveValue,
    ).toBe("fake-opus · medium");
  });

  it("renders the lone live dimension when the cache carries one side only (claude shape)", () => {
    expect(
      derivePostureCatalog(
        reads({
          discovered: {
            ...STAMPED_CATALOG,
            current_model: "opus",
            current_thought_level: null,
          },
        }),
      ).liveValue,
    ).toBe("opus");
    expect(
      derivePostureCatalog(
        reads({
          discovered: { ...STAMPED_CATALOG, current_model: null },
        }),
      ).liveValue,
    ).toBe("medium");
  });

  it("holds the live read back when no catalog seats the menu", () => {
    // claude stamps the session cache but its per-model catalog exists only
    // after a settings probe; without one the trigger is the static label and
    // no live value may half-render.
    const out = derivePostureCatalog(
      reads({
        activeAdapter: adapter("claude-code", "claude_stream_json"),
        activeAdapterId: "claude-code",
        discovered: {
          models: [],
          current_model: "opus",
          thought_levels: [],
          current_thought_level: null,
          adapter_id: "claude-code",
        },
        probeEntry: null,
      }),
    );
    expect(out.catalog).toBeNull();
    expect(out.liveValue).toBeNull();
  });

  it("emits no liveValue when the live currents are all empty", () => {
    const out = derivePostureCatalog(
      reads({
        discovered: {
          ...STAMPED_CATALOG,
          current_model: null,
          current_thought_level: null,
        },
      }),
    );
    // The catalog still seats the menu; the tooltip alone has nothing.
    expect(out.catalog).not.toBeNull();
    expect(out.liveValue).toBeNull();
  });
});
