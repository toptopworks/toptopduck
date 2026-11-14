import { describe, expect, it } from "vitest";
import { catalogIntl } from "../components/common/__tests__/helpers";
import { toAppError } from "../lib/error-presentation";
import type { AppErrorKind, SessionFlowKind } from "../types/error";

// toAppError is the single kind-driven entry for an IPC reject -> AppError
// (ADR-0069). These tests cover empty fallback, the verb-prefix locale
// consistency (issue #139), the refreshFailed
// prefix, the read bare output, the shell neutral-verb prefix (issue #1563),
// and the exhaustiveness throw guard.

// Real-catalog en-US intl from the shared i18n test seam so the verb +
// templates track the active locale (issue #139): the assertion strings are
// the catalog values, so a regression to a hard-coded verb map wrapped around
// a catalog message would fail here under en-US.
const intl = catalogIntl("en-US");

// A SessionError::Engine reject (issue #119): fmtError resolves the
// Engine locale message ("Internal error"); errorDetail surfaces Engine.data.
const engineReject = { kind: "Engine", data: "close-wait timed out" };

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

// read renders the BARE fmtError message (no verb prefix), with the Engine
// locale message as a never-blank fallback (ADR-0069 Decision 3 -- the
// fallback's only remaining home now that shell carries the #1563 verb).
describe("toAppError (read bare output)", () => {
  it("renders the bare message + carries the read kind", () => {
    const out = toAppError(engineReject, intl, "read");
    expect(out.kind).toBe("read");
    expect(out.message).toBe("Internal error");
    expect(out.detail).toBe("close-wait timed out");
  });

  it("falls back to the Engine locale message when fmtError yields empty", () => {
    // A bare throw with no message (or a minified error): fmtError returns
    // the empty string via the `e instanceof Error` branch, so toAppError
    // substitutes the Engine locale message on read so the banner is never
    // blank.
    const out = toAppError(new Error(""), intl, "read");
    expect(out.message).toBe("Internal error");
    expect(out.kind).toBe("read");
  });
});

// shell carries the neutral "Operation" verb through the same "{verb} failed:"
// composer as the session flows (issue #1563): a shell reject is a shell-level
// action refusal (open / create / profile switch / file ops), and the bare
// message read as a verdict on whatever surface the banner sits above. The
// template guarantees a non-empty banner, so the Engine fallback no longer
// applies to shell -- an empty bare renders "Operation failed:" (the
// SessionFlowKind precedent).
describe("toAppError (shell verb prefix, issue #1563)", () => {
  it("prepends the shell verb via the active locale", () => {
    const out = toAppError(engineReject, intl, "shell");
    expect(out.kind).toBe("shell");
    expect(out.message).toBe("Operation failed: Internal error");
    expect(out.detail).toBe("close-wait timed out");
  });

  it("renders the bare template on an empty fmtError (no Engine fallback)", () => {
    // The template keeps its inter-placeholder space, exactly as the
    // SessionFlowKind empty-bare output does (the App.test prefix regexes
    // are built from this same composer + empty message).
    const out = toAppError(new Error(""), intl, "shell");
    expect(out.message).toBe("Operation failed: ");
    expect(out.kind).toBe("shell");
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
