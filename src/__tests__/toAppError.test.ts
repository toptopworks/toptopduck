import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { catalogFor } from "../i18n";
import { errorDetail, fmtError, toAppError } from "../lib/error-presentation";
import type { AppErrorKind, SessionFlowKind } from "../types/error";

// toAppError is the single kind-driven entry for an IPC reject -> AppError
// (ADR-0069). These tests cover message/detail/kind passthrough + empty
// fallback, the verb-prefix locale consistency (issue #139), the refreshFailed
// prefix, the shell/read bare output, and the exhaustiveness throw guard.

// Build intl from the REAL en-US catalog so the verb + templates track the
// active locale (issue #139): the assertion strings are the catalog values, so
// a regression to a hard-coded verb map wrapped around a catalog message would
// fail here under en-US.
const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

// A typed SessionError::Engine reject (issue #119): fmtError resolves the
// Engine locale message ("Internal error"); errorDetail surfaces Engine.data.
const engineReject = { kind: "Engine", data: "close-wait timed out" } as never;

// The six SessionFlowKind values + their en-US catalog verb (issue #139). Kept
// in one place so the verb-prefix and refreshFailed-prefix tables stay aligned.
const FLOW_KINDS: ReadonlyArray<[SessionFlowKind, string]> = [
  ["load", "Load"],
  ["rename", "Rename"],
  ["replace", "Replace source"],
  ["delete", "Delete source"],
  ["privacy", "Privacy update"],
  ["ask", "Ask"],
];

// toAppError's SessionFlowKind branches (ADR-0069 Decision 3) prepend "{verb}
// failed:" -- both the verb and the failure template render through the active
// catalog, so each banner is the verb value + the template + the bare message.
describe("toAppError (SessionFlowKind verb prefix, issue #139)", () => {
  it.each(FLOW_KINDS)("prepends the %s verb via the active locale", (kind, verb) => {
    const out = toAppError(engineReject, intl, kind);
    expect(out.kind).toBe(kind);
    expect(out.message).toBe(`${verb} failed: Internal error`);
    expect(out.detail).toBe("close-wait timed out");
  });
});

// refreshFailed: the mutation itself succeeded but the post-mutation cache
// refresh rejected. The banner is tagged with the operation kind but worded as
// a refresh failure (ADR-0069 Decision 3).
describe("toAppError (refreshFailed prefix)", () => {
  it.each(FLOW_KINDS)(
    "prepends the %s saved-but-refresh-failed template",
    (kind, verb) => {
      const out = toAppError(engineReject, intl, kind, { refreshFailed: true });
      expect(out.kind).toBe(kind);
      expect(out.message).toBe(
        `${verb} saved, but refreshing the working set failed: Internal error`,
      );
      expect(out.detail).toBe("close-wait timed out");
    },
  );
});

// shell / read render the BARE fmtError message (no verb prefix), with the
// Engine locale message as a never-blank fallback (ADR-0069 Decision 3 -- the
// fallback applies only to these kinds).
describe("toAppError (shell/read bare output)", () => {
  it.each(["shell", "read"] as AppErrorKind[])(
    "renders the bare message + carries the %s kind",
    (kind) => {
      const out = toAppError(engineReject, intl, kind);
      expect(out.kind).toBe(kind);
      expect(out.message).toBe("Internal error");
      expect(out.detail).toBe("close-wait timed out");
    },
  );

  it.each(["shell", "read"] as AppErrorKind[])(
    "falls back to the Engine locale message on %s when fmtError yields empty",
    (kind) => {
      // A bare throw with no message (or a minified error): fmtError returns
      // the empty string via the `e instanceof Error` branch, so toAppError
      // substitutes the Engine locale message on shell/read so the banner is
      // never blank.
      const out = toAppError(new Error(""), intl, kind);
      expect(out.message).toBe("Internal error");
      expect(out.kind).toBe(kind);
    },
  );
});

// message/detail come from fmtError + errorDetail (the format core); toAppError
// composes them with the kind-driven prefix (issue #194).
describe("toAppError (message/detail passthrough)", () => {
  it("Engine message/detail match fmtError + errorDetail on the shell kind", () => {
    const out = toAppError(engineReject, intl, "shell");
    expect(out.message).toBe(fmtError(engineReject, intl));
    expect(out.detail).toBe(errorDetail(engineReject));
  });
});

// The default:never arm is the exhaustiveness guard (issue #139): a runtime
// kind outside AppErrorKind (only reachable via an `as` cast -- the compile-
// time `never` check already flags a missing case) throws instead of rendering
// a malformed banner.
describe("toAppError (exhaustiveness guard)", () => {
  it("throws on an unhandled kind", () => {
    expect(() => toAppError(engineReject, intl, "__unknown__" as AppErrorKind)).toThrow(
      /unhandled AppErrorKind/,
    );
  });
});
