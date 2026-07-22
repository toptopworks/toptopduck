import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { describeReject, errorDetail, fmtError } from "../api";
import type { AppErrorKind } from "../types/error";

// Issue #194: describeReject returns an AppError tagged with the caller's
// kind. message/detail come from fmtError + errorDetail; the kind is carried
// through unchanged. Two callers: the shell (kind "shell") and the result
// view (kind "read").

const intl = createIntl({
  locale: "en",
  messages: { "error.session.engine": "Internal error" },
});

// A typed SessionError::Engine reject (issue #119): fmtError resolves the
// Engine locale message; errorDetail surfaces Engine.data as the fold detail.
const engineReject = { kind: "Engine", data: "close-wait timed out" } as never;

describe("describeReject (returns AppError, issue #194)", () => {
  it("returns an AppError whose message/detail match fmtError + errorDetail", () => {
    const out = describeReject(engineReject, intl, "shell");
    expect(out.message).toBe(fmtError(engineReject, intl));
    expect(out.detail).toBe(errorDetail(engineReject));
  });

  it("carries the shell kind for a shell-layer reject", () => {
    expect(describeReject(engineReject, intl, "shell").kind).toBe("shell");
  });

  it.each([
    "load",
    "rename",
    "replace",
    "delete",
    "privacy",
    "ask",
    "shell",
    "read",
  ] as AppErrorKind[])("carries the %s kind without altering message/detail", (kind) => {
    const out = describeReject(engineReject, intl, kind);
    expect(out.kind).toBe(kind);
    expect(out.message).toBe("Internal error");
    expect(out.detail).toBe("close-wait timed out");
  });

  it("falls back to the Engine locale message when fmtError yields empty", () => {
    // A bare throw with no message (or a minified error): fmtError returns the
    // empty string via the `e instanceof Error` branch, so describeReject
    // substitutes the Engine locale message so the banner is never blank.
    const out = describeReject(new Error(""), intl, "shell");
    expect(out.message).toBe("Internal error");
    expect(out.kind).toBe("shell");
  });
});
