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
    "error.duck.alreadyOpen": "This .duck is already open in this process",
    "error.duck.loadIo": "Failed to read the .duck file",
    "error.duck.loadParse": "Failed to parse the .duck file",
    "error.duck.migration": "Failed to migrate the .duck file to the current format",
    "error.duck.versionMismatch":
      "This .duck was made by a newer app (format_version={found}); the current app supports only {supported}. Please upgrade the app, then reopen it.",
    "error.resume.aborted": "Resume aborted",
    "error.resume.activeMissing": "The session focus points to an unregistered source \"{name}\"",
    "error.resume.cancelled": "Resume cancelled",
    "error.resume.engine": "Internal error",
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
    "error.session.resuming": "Session is resuming, please try again shortly",
  },
});

describe("fmtError — SessionError", () => {
  it("renders each SessionError kind via the locale catalog, not a backend string", () => {
    // The backend Chinese wording no longer crosses IPC (issue #119): a typed
    // SessionError reject is narrowed to its kind and rendered through the
    // catalog. Every kind is pinned to its message id.
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

describe("fmtError — ResumeError", () => {
  it("renders each ResumeError kind via the locale catalog (issue #120)", () => {
    // open_duck now rejects with the typed ResumeError instead of flattening
    // through SessionError::Engine(string). Every kind is pinned to its id.
    const cases: Array<[ResumeError, string]> = [
      [{ kind: "Cancelled" }, "Resume cancelled"],
      [{ kind: "Aborted" }, "Resume aborted"],
      [
        { kind: "AlreadyOpen", data: "/x/a.duck" },
        "This .duck is already open in this process",
      ],
      [{ kind: "Engine", data: "join error" }, "Internal error"],
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
      expect(fmtError(err, intl)).toBe(expected);
    }
  });

  it("recurses ResumeError::Load into the nested DuckLoadError kind", () => {
    // Load delegates to the nested .duck load error so the version-mismatch
    // "please upgrade" hint (with interpolated versions) surfaces, not a
    // generic "resume failed".
    expect(
      fmtError(
        { kind: "Load", data: { kind: "VersionMismatch", data: { found: 3, supported: 1 } } },
        intl,
      ),
    ).toBe(
      "This .duck was made by a newer app (format_version=3); the current app supports only 1. Please upgrade the app, then reopen it.",
    );
    expect(fmtError({ kind: "Load", data: { kind: "Io", data: "io-fail" } }, intl)).toBe(
      "Failed to read the .duck file",
    );
    expect(fmtError({ kind: "Load", data: { kind: "Parse", data: "parse-fail" } }, intl)).toBe(
      "Failed to parse the .duck file",
    );
    expect(
      fmtError(
        { kind: "Load", data: { kind: "Migration", data: { kind: "Field", data: "bad" } } },
        intl,
      ),
    ).toBe("Failed to migrate the .duck file to the current format");
  });

  it("does not leak the Engine / SourceMissing detail into the rendered message (ADR-0029)", () => {
    expect(fmtError({ kind: "Engine", data: "sk-ant-secret" }, intl)).toBe("Internal error");
    expect(
      fmtError(
        {
          kind: "SourceMissing",
          data: { reference_name: "p", path: "/secret", detail: "sk-ant-secret" },
        },
        intl,
      ),
    ).toBe("Source \"p\" not found");
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

  it("extracts ResumeError detail for the fold (issue #120)", () => {
    expect(errorDetail({ kind: "Engine", data: "join error" })).toBe("join error");
    expect(
      errorDetail({
        kind: "SourceMissing",
        data: { reference_name: "p", path: "/x", detail: "traversal refused" },
      }),
    ).toBe("traversal refused");
    expect(
      errorDetail({ kind: "Replay", data: { reference_name: "r", detail: "bad sql" } }),
    ).toBe("bad sql");
    expect(errorDetail({ kind: "AlreadyOpen", data: "/x/a.duck" })).toBe("/x/a.duck");
  });

  it("recurses ResumeError::Load into the nested DuckLoadError detail", () => {
    expect(errorDetail({ kind: "Load", data: { kind: "Io", data: "io-fail" } })).toBe("io-fail");
    // VersionMismatch is self-contained (versions in the message) -> no fold.
    expect(
      errorDetail({
        kind: "Load",
        data: { kind: "VersionMismatch", data: { found: 3, supported: 1 } },
      }),
    ).toBeNull();
    // Migration recurses into MigrationError (Field detail).
    expect(
      errorDetail({
        kind: "Load",
        data: { kind: "Migration", data: { kind: "Field", data: "missing x" } },
      }),
    ).toBe("missing x");
  });

  it("returns null for self-contained ResumeError kinds", () => {
    expect(errorDetail({ kind: "Cancelled" })).toBeNull();
    expect(errorDetail({ kind: "Aborted" })).toBeNull();
    expect(errorDetail({ kind: "ActiveMissing", data: "ghost" })).toBeNull();
  });

  it("extracts SaveError detail for the fold (issue #120)", () => {
    expect(errorDetail({ kind: "Serialize", data: "ser-fail" })).toBe("ser-fail");
    expect(errorDetail({ kind: "Io", data: "io-fail" })).toBe("io-fail");
    expect(errorDetail({ kind: "Rename", data: "rename-fail" })).toBe("rename-fail");
    expect(errorDetail({ kind: "AlreadyOpen", data: "/x/a.duck" })).toBe("/x/a.duck");
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
