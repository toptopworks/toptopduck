import { describe, expect, it } from "vitest";

import { catalogFor } from "../../../i18n";
import { catalogIntl } from "../../../components/common/__tests__/helpers";
import { formatTurnFailure, turnFailureDetail } from "../turn-failure";
import type { TurnFailure } from "../../../types/thread";

// Real-catalog en-US intl from the shared i18n test seam (issue #1100):
// formatTurnFailure resolves kind -> catalog wording through the actual
// catalog, and the assertions follow the catalog keys -- the id-level kind ->
// message-id binding is pinned HERE with compile-checked literal keys,
// replacing the retired hand-copied mirror, whose wording could silently
// drift (it stayed green through the #1096/#1098 rewrites). StaleReference
// keeps a literal expected string: its {name} substitution is the pin. The
// detail (engine diagnosis, the runtime diagnostic, or the configuration
// policy reason) never enters the primary message -- it rides the fold below.
const intl = catalogIntl("en-US");
const en = catalogFor("en-US");

describe("formatTurnFailure", () => {
  // In production each TurnFailure kind renders through its own catalog id
  // (issue #125), not a backend string; this suite pins the kind -> id
  // binding through the real catalog. The detail (engine diagnosis, the
  // runtime diagnostic, or the configuration policy reason) never enters the
  // primary message -- it rides the fold below.
  // Issue #852: turn-level Execute renders the neutral `error.turn.execution`
  // (a turn may be a pure conversation, so "query" prejudges the context);
  // external-runtime failures render `error.turn.runtime`. The query-worded
  // `error.turn.execute` is RowReadError::Execute's id (format.ts), pinned
  // there.
  it("maps each TurnFailure kind to its catalog id", () => {
    const cases: Array<[TurnFailure, string]> = [
      [{ kind: "Execute", data: { detail: "bad column" } }, en["error.turn.execution"]],
      [
        { kind: "Runtime", data: { detail: "external runtime `cli-a` not found on PATH" } },
        en["error.turn.runtime"],
      ],
      [{ kind: "Resource", data: { detail: "timeout" } }, en["error.turn.resource"]],
      [{ kind: "NotWired" }, en["error.turn.notWired"]],
      [
        { kind: "InvalidConfig", data: { detail: "scheme `file` is not http/https" } },
        en["error.turn.invalidConfig"],
      ],
      [
        { kind: "StaleReference", data: { reference_name: "result_1" } },
        "References a stale result \"result_1\"",
      ],
    ];
    for (const [failure, expected] of cases) {
      expect(formatTurnFailure(failure, intl), failure.kind).toBe(expected);
    }
  });
});

describe("turnFailureDetail", () => {
  // Execute / Resource / InvalidConfig / Runtime carry the audited technical
  // detail for the collapsed fold (ADR-0029 -- no API key); NotWired /
  // StaleReference are self-contained (the locale message already names them)
  // -> no fold. The InvalidConfig case (issue #277) is the one this suite was
  // added to pin: the configuration policy reason must reach the fold, not be
  // dropped. Runtime (issue #852) likewise: the runtime diagnostic must reach
  // the fold.
  it("returns the detail for the fold-carrying kinds", () => {
    const withDetail: Array<[TurnFailure, string]> = [
      [{ kind: "Execute", data: { detail: "bad column" } }, "bad column"],
      [
        { kind: "Runtime", data: { detail: "external runtime `cli-a` not found on PATH" } },
        "external runtime `cli-a` not found on PATH",
      ],
      [{ kind: "Resource", data: { detail: "timeout" } }, "timeout"],
      [
        { kind: "InvalidConfig", data: { detail: "scheme `file` is not http/https" } },
        "scheme `file` is not http/https",
      ],
    ];
    for (const [failure, expected] of withDetail) {
      expect(turnFailureDetail(failure), failure.kind).toBe(expected);
    }
  });

  it("returns null for the self-contained kinds", () => {
    const selfContained: TurnFailure[] = [
      { kind: "NotWired" },
      { kind: "StaleReference", data: { reference_name: "result_1" } },
    ];
    for (const failure of selfContained) {
      expect(turnFailureDetail(failure), failure.kind).toBeNull();
    }
  });
});
