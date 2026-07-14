import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { engineDetail, fmtError } from "../api";
import type { SessionError } from "../types";

// An IntlShape carrying the five SessionError message ids (mirroring the locale
// files) so fmtError resolves kind -> catalog wording. This pins the kind ->
// message-id mapping and the fallback behavior, not the wording itself.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.session.engine": "Internal error",
    "error.session.inFlight":
      "A query is already running on this session; cancel it or wait for it to finish",
    "error.session.invalidId": "Invalid session id",
    "error.session.notFound": "Session not found or closed",
    "error.session.resuming": "Session is resuming, please try again shortly",
  },
});

describe("fmtError", () => {
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
    // The detail stays in Engine.data; the rendered message is the generic
    // locale string regardless of the payload -- never the raw internal text,
    // never an API key.
    expect(fmtError({ kind: "Engine", data: "sk-ant-secret" }, intl)).toBe("Internal error");
  });

  it("falls back for non-SessionError rejects (JS Error / string / opaque object)", () => {
    expect(fmtError(new Error("boom"), intl)).toBe("boom");
    expect(fmtError("plain string reject", intl)).toBe("plain string reject");
    expect(fmtError({ weird: "shape" }, intl)).toBe("{\"weird\":\"shape\"}");
  });

  it("does not treat an unrecognized kind as a SessionError (defensive narrow)", () => {
    // A malformed object with an unknown / non-string kind stringifies so the
    // user still sees something, instead of rendering a missing-message id.
    expect(fmtError({ kind: "Unknown" }, intl)).toBe("{\"kind\":\"Unknown\"}");
    expect(fmtError({ kind: 42 }, intl)).toBe("{\"kind\":42}");
  });
});

describe("engineDetail", () => {
  it("extracts Engine.data as the technical detail for the collapsed fold", () => {
    expect(engineDetail({ kind: "Engine", data: "session lock poisoned" })).toBe(
      "session lock poisoned",
    );
  });

  it("returns null for non-Engine SessionError kinds", () => {
    expect(engineDetail({ kind: "NotFound" })).toBeNull();
    expect(engineDetail({ kind: "InvalidId" })).toBeNull();
    expect(engineDetail({ kind: "InFlight" })).toBeNull();
  });

  it("returns null for non-SessionError rejects", () => {
    expect(engineDetail(new Error("boom"))).toBeNull();
    expect(engineDetail("plain string reject")).toBeNull();
    expect(engineDetail({ weird: "shape" })).toBeNull();
  });
});
