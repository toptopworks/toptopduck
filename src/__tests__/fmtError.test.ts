import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { errorDetail, fmtError } from "../api";
import type { ResumeError, SaveError, SessionError } from "../types";

// An IntlShape carrying the typed-error message ids (mirroring the locale
// files) so fmtError resolves kind -> catalog wording. This pins the kind ->
// message-id mapping and the fallback behavior, not the wording itself.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.dataset.displayTaken": "Display label \"{label}\" is already used by another dataset; pick a different one",
    "error.dataset.invalidContinueWith":
      "\"{name}\" is not among the remaining sources; cannot use it as the continuation (refresh the working set and re-pick)",
    "error.dataset.invalidLabel": "Display label must not be empty or whitespace-only",
    "error.dataset.notActive":
      "\"{name}\" is not the current focus source; use plain delete or refresh the working set and retry",
    "error.dataset.notFound": "No dataset found with reference name \"{name}\"",
    "error.dataset.removeActive":
      "\"{name}\" is the current focus table; pick a continuation from the remaining sources first (or cancel)",
    "error.duck.alreadyOpen": "This .duck is already open in this process",
    "error.duck.loadIo": "Failed to read the .duck file",
    "error.duck.loadParse": "Failed to parse the .duck file",
    "error.duck.migration": "Failed to migrate the .duck file to the current format",
    "error.duck.versionMismatch":
      "This .duck was made by a newer app (format_version={found}); the current app supports only {supported}. Please upgrade the app, then reopen it.",
    "error.resume.aborted": "Resume aborted",
    "error.resume.activeMissing": "The session focus points to an unregistered source \"{name}\"",
    "error.resume.cancelled": "Resume cancelled",
    "error.resume.replay": "Failed to replay \"{name}\"",
    "error.resume.sourceMissing": "Source \"{name}\" not found",
    "error.save.io": "Failed to write the .duck temp file",
    "error.save.rename": "Failed to replace the .duck file",
    "error.save.serialize": "Failed to serialize the .duck file",
    "error.session.engine": "Internal error",
    "error.session.inFlight":
      "A query is already running on this session; cancel it or wait for it to finish",
    "error.session.invalidId": "Invalid session id",
    "error.session.notFound": "Session not found or closed",
    "error.session.renameEmpty": "Session name must not be empty",
    "error.session.resuming": "Session is resuming, please try again shortly",
    "error.turn.execute": "Failed to execute the query",
  },
});

// Wrap a ResumeError as the open_duck reject shape: SessionError::Resume
// (issue #120). open_duck rejects with its ResumeError wrapped in
// SessionError::Resume, so the frontend recurses Resume.data.
function resume(err: ResumeError): SessionError {
  return { kind: "Resume", data: err };
}

describe("fmtError — SessionError", () => {
  it("renders each SessionError kind via the locale catalog, not a backend string", () => {
    const cases: Array<[SessionError, string]> = [
      [{ kind: "InvalidId" }, "Invalid session id"],
      [{ kind: "NotFound" }, "Session not found or closed"],
      [{ kind: "Resuming" }, "Session is resuming, please try again shortly"],
      [
        { kind: "InFlight" },
        "A query is already running on this session; cancel it or wait for it to finish",
      ],
      [{ kind: "Engine", data: "session lock poisoned" }, "Internal error"],
    ];
    for (const [err, expected] of cases) {
      expect(fmtError(err, intl)).toBe(expected);
    }
  });

  it("does not leak the Engine detail into the rendered message (ADR-0029)", () => {
    expect(fmtError({ kind: "Engine", data: "sk-ant-secret" }, intl)).toBe("Internal error");
  });
});

describe("fmtError — SessionError::Resume (open_duck reject)", () => {
  it("renders each ResumeError kind via the locale catalog (issue #120)", () => {
    // open_duck wraps its ResumeError in SessionError::Resume; fmtError
    // recurses Resume.data.kind -> locale. Every kind is pinned to its id.
    const cases: Array<[ResumeError, string]> = [
      [{ kind: "Cancelled" }, "Resume cancelled"],
      [{ kind: "Aborted" }, "Resume aborted"],
      [{ kind: "AlreadyOpen", data: "/x/a.duck" }, "This .duck is already open in this process"],
      [
        { kind: "SourceMissing", data: { reference_name: "people", path: "/x", detail: "d" } },
        "Source \"people\" not found",
      ],
      [
        { kind: "Replay", data: { reference_name: "result_1", detail: "d" } },
        "Failed to replay \"result_1\"",
      ],
      [
        { kind: "ActiveMissing", data: "ghost" },
        "The session focus points to an unregistered source \"ghost\"",
      ],
    ];
    for (const [err, expected] of cases) {
      expect(fmtError(resume(err), intl)).toBe(expected);
    }
  });

  it("recurses ResumeError::Load into the nested DuckLoadError kind", () => {
    // Load delegates to the nested .duck load error so the version-mismatch
    // "please upgrade" hint (with interpolated versions) surfaces, not a
    // generic "resume failed".
    expect(
      fmtError(
        resume({ kind: "Load", data: { kind: "VersionMismatch", data: { found: 3, supported: 1 } } }),
        intl,
      ),
    ).toBe(
      "This .duck was made by a newer app (format_version=3); the current app supports only 1. Please upgrade the app, then reopen it.",
    );
    expect(
      fmtError(resume({ kind: "Load", data: { kind: "Io", data: "io-fail" } }), intl),
    ).toBe("Failed to read the .duck file");
    expect(
      fmtError(resume({ kind: "Load", data: { kind: "Parse", data: "parse-fail" } }), intl),
    ).toBe("Failed to parse the .duck file");
    expect(
      fmtError(
        resume({ kind: "Load", data: { kind: "Migration", data: { kind: "Field", data: "bad" } } }),
        intl,
      ),
    ).toBe("Failed to migrate the .duck file to the current format");
  });

  it("does not leak the SourceMissing detail into the rendered message (ADR-0029)", () => {
    expect(
      fmtError(
        resume({
          kind: "SourceMissing",
          data: { reference_name: "p", path: "/secret", detail: "sk-ant-secret" },
        }),
        intl,
      ),
    ).toBe("Source \"p\" not found");
  });
});

describe("fmtError — SessionError source-management kinds (issue #121)", () => {
  it("renders RemoveSource kinds via the locale catalog", () => {
    // remove_source / remove_active_source wrap RemoveSourceError in
    // SessionError::RemoveSource. NotFound shares the merged notFound id with
    // RenameError::NotFound and TurnError::UnknownDataset.
    const cases: Array<[SessionError, string]> = [
      [
        { kind: "RemoveSource", data: { kind: "NotFound", data: "people" } },
        "No dataset found with reference name \"people\"",
      ],
      [
        {
          kind: "RemoveSource",
          data: { kind: "IsActive", data: { reference_name: "people", display_name: "员工表" } },
        },
        "\"员工表\" is the current focus table; pick a continuation from the remaining sources first (or cancel)",
      ],
      [
        { kind: "RemoveSource", data: { kind: "NotActive", data: "people" } },
        "\"people\" is not the current focus source; use plain delete or refresh the working set and retry",
      ],
      [
        { kind: "RemoveSource", data: { kind: "InvalidContinueWith", data: "ghost" } },
        "\"ghost\" is not among the remaining sources; cannot use it as the continuation (refresh the working set and re-pick)",
      ],
    ];
    for (const [err, expected] of cases) {
      expect(fmtError(err, intl)).toBe(expected);
    }
  });

  it("renders RenameDataset kinds via the locale catalog", () => {
    const cases: Array<[SessionError, string]> = [
      [
        { kind: "RenameDataset", data: { kind: "NotFound", data: "people" } },
        "No dataset found with reference name \"people\"",
      ],
      [
        { kind: "RenameDataset", data: { kind: "DisplayTaken", data: "员工表" } },
        "Display label \"员工表\" is already used by another dataset; pick a different one",
      ],
      [{ kind: "RenameDataset", data: { kind: "InvalidLabel" } }, "Display label must not be empty or whitespace-only"],
    ];
    for (const [err, expected] of cases) {
      expect(fmtError(err, intl)).toBe(expected);
    }
  });

  it("renders RenameSession and Turn kinds via the locale catalog", () => {
    expect(fmtError({ kind: "RenameSession", data: { kind: "EmptyName" } }, intl)).toBe(
      "Session name must not be empty",
    );
    expect(
      fmtError({ kind: "Turn", data: { kind: "UnknownDataset", data: "result_1" } }, intl),
    ).toBe("No dataset found with reference name \"result_1\"");
    // Execute renders a generic message; the engine detail rides the fold.
    expect(fmtError({ kind: "Turn", data: { kind: "Execute", data: "bad column" } }, intl)).toBe(
      "Failed to execute the query",
    );
  });

  it("does not leak the Turn::Execute detail into the rendered message (ADR-0029)", () => {
    expect(fmtError({ kind: "Turn", data: { kind: "Execute", data: "sk-ant-secret" } }, intl)).toBe(
      "Failed to execute the query",
    );
  });
});

describe("fmtError — SaveError", () => {
  it("renders each SaveError kind via the locale catalog (issue #120)", () => {
    // take_persist_error returns a typed SaveError; the banner renders the kind
    // through the catalog. AlreadyOpen shares the merged error.duck.alreadyOpen
    // id with ResumeError::AlreadyOpen.
    const cases: Array<[SaveError, string]> = [
      [{ kind: "Serialize", data: "ser-fail" }, "Failed to serialize the .duck file"],
      [{ kind: "Io", data: "io-fail" }, "Failed to write the .duck temp file"],
      [{ kind: "Rename", data: "rename-fail" }, "Failed to replace the .duck file"],
      [{ kind: "AlreadyOpen", data: "/x/a.duck" }, "This .duck is already open in this process"],
    ];
    for (const [err, expected] of cases) {
      expect(fmtError(err, intl)).toBe(expected);
    }
  });

  it("does not leak the Serialize/Io/Rename detail into the rendered message (ADR-0029)", () => {
    expect(fmtError({ kind: "Serialize", data: "sk-ant-secret" }, intl)).toBe(
      "Failed to serialize the .duck file",
    );
    expect(fmtError({ kind: "Io", data: "sk-ant-secret" }, intl)).toBe(
      "Failed to write the .duck temp file",
    );
    expect(fmtError({ kind: "Rename", data: "sk-ant-secret" }, intl)).toBe(
      "Failed to replace the .duck file",
    );
  });
});

describe("fmtError — fallback", () => {
  it("falls back for non-typed rejects (JS Error / string / opaque object)", () => {
    expect(fmtError(new Error("boom"), intl)).toBe("boom");
    expect(fmtError("plain string reject", intl)).toBe("plain string reject");
    expect(fmtError({ weird: "shape" }, intl)).toBe("{\"weird\":\"shape\"}");
  });

  it("does not treat an unrecognized kind as a typed error (defensive narrow)", () => {
    // A malformed object with an unknown / non-string kind stringifies so the
    // user still sees something, instead of rendering a missing-message id.
    expect(fmtError({ kind: "Unknown" }, intl)).toBe("{\"kind\":\"Unknown\"}");
    expect(fmtError({ kind: 42 }, intl)).toBe("{\"kind\":42}");
  });

  it("does not treat an Engine payload with non-string data as a SessionError (guard L1)", () => {
    expect(fmtError({ kind: "Engine" }, intl)).toBe("{\"kind\":\"Engine\"}");
    expect(fmtError({ kind: "Engine", data: 42 }, intl)).toBe("{\"kind\":\"Engine\",\"data\":42}");
  });
});

describe("errorDetail", () => {
  it("extracts SessionError::Engine.data as the technical detail", () => {
    expect(errorDetail({ kind: "Engine", data: "session lock poisoned" })).toBe(
      "session lock poisoned",
    );
  });

  it("recurses SessionError::Resume into the nested ResumeError detail (issue #120)", () => {
    expect(errorDetail(resume({ kind: "Load", data: { kind: "Io", data: "io-fail" } }))).toBe(
      "io-fail",
    );
    // VersionMismatch is self-contained (versions in the message) -> no fold.
    expect(
      errorDetail(
        resume({ kind: "Load", data: { kind: "VersionMismatch", data: { found: 3, supported: 1 } } }),
      ),
    ).toBeNull();
    // Migration recurses into MigrationError (Field detail).
    expect(
      errorDetail(
        resume({ kind: "Load", data: { kind: "Migration", data: { kind: "Field", data: "missing x" } } }),
      ),
    ).toBe("missing x");
    // NoTransform composes a version-gap string on the frontend side.
    expect(
      errorDetail(
        resume({
          kind: "Load",
          data: { kind: "Migration", data: { kind: "NoTransform", data: { from: 0, supported: 1 } } },
        }),
      ),
    ).toBe("format_version=0 (supported: 1)");
    expect(
      errorDetail(
        resume({
          kind: "SourceMissing",
          data: { reference_name: "p", path: "/x", detail: "traversal refused" },
        }),
      ),
    ).toBe("traversal refused");
    expect(errorDetail(resume({ kind: "AlreadyOpen", data: "/x/a.duck" }))).toBe("/x/a.duck");
  });

  it("returns null for self-contained ResumeError kinds (via SessionError::Resume)", () => {
    expect(errorDetail(resume({ kind: "Cancelled" }))).toBeNull();
    expect(errorDetail(resume({ kind: "Aborted" }))).toBeNull();
    expect(errorDetail(resume({ kind: "ActiveMissing", data: "ghost" }))).toBeNull();
  });

  it("extracts SaveError detail for the fold (issue #120)", () => {
    expect(errorDetail({ kind: "Serialize", data: "ser-fail" })).toBe("ser-fail");
    expect(errorDetail({ kind: "Io", data: "io-fail" })).toBe("io-fail");
    expect(errorDetail({ kind: "Rename", data: "rename-fail" })).toBe("rename-fail");
    expect(errorDetail({ kind: "AlreadyOpen", data: "/x/a.duck" })).toBe("/x/a.duck");
  });

  it("extracts SessionError::Turn::Execute detail and nulls UnknownDataset (issue #121)", () => {
    expect(errorDetail({ kind: "Turn", data: { kind: "Execute", data: "bad column" } })).toBe(
      "bad column",
    );
    expect(
      errorDetail({ kind: "Turn", data: { kind: "UnknownDataset", data: "result_1" } }),
    ).toBeNull();
  });

  it("returns null for self-contained source-management SessionError kinds (issue #121)", () => {
    expect(
      errorDetail({ kind: "RemoveSource", data: { kind: "NotFound", data: "people" } }),
    ).toBeNull();
    expect(
      errorDetail({ kind: "RenameDataset", data: { kind: "DisplayTaken", data: "x" } }),
    ).toBeNull();
    expect(errorDetail({ kind: "RenameSession", data: { kind: "EmptyName" } })).toBeNull();
  });

  it("returns null for non-Engine SessionError kinds", () => {
    expect(errorDetail({ kind: "NotFound" })).toBeNull();
    expect(errorDetail({ kind: "InvalidId" })).toBeNull();
    expect(errorDetail({ kind: "InFlight" })).toBeNull();
  });

  it("returns null for non-typed rejects", () => {
    expect(errorDetail(new Error("boom"))).toBeNull();
    expect(errorDetail("plain string reject")).toBeNull();
    expect(errorDetail({ weird: "shape" })).toBeNull();
  });

  it("returns null for an Engine payload with non-string data (guard L1)", () => {
    expect(errorDetail({ kind: "Engine" })).toBeNull();
    expect(errorDetail({ kind: "Engine", data: 42 })).toBeNull();
  });
});
