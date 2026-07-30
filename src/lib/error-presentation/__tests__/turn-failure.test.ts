import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { formatTurnFailure, turnFailureDetail } from "../turn-failure";
import type { TurnFailure } from "../../../types/thread";

// An IntlShape carrying the TurnFailure message ids (mirroring en-US.json) so
// formatTurnFailure resolves kind -> catalog wording. The wording lives once in
// the locale files; this pins the kind -> id mapping and the detail-fold
// routing, not the wording itself.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.turn.execute": "Failed to execute the query",
    "error.turn.resource": "A resource limit was reached",
    "error.turn.notWired": "No LLM provider is configured",
    "error.turn.invalidConfig": "The provider configuration is invalid",
    "error.turn.stale": "References a stale result \"{name}\"",
  },
});

describe("formatTurnFailure", () => {
  // Each TurnFailure kind renders through its own catalog id (issue #125), not
  // a backend string. The detail (engine diagnosis or the configuration policy
  // reason) never enters the primary message -- it rides the fold below.
  it("renders each TurnFailure kind via the locale catalog", () => {
    const cases: Array<[TurnFailure, string]> = [
      [{ kind: "Execute", data: { detail: "bad column" } }, "Failed to execute the query"],
      [{ kind: "Resource", data: { detail: "timeout" } }, "A resource limit was reached"],
      [{ kind: "NotWired" }, "No LLM provider is configured"],
      [
        { kind: "InvalidConfig", data: { detail: "scheme `file` is not http/https" } },
        "The provider configuration is invalid",
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
  // Execute / Resource / InvalidConfig carry the audited technical detail for
  // the collapsed fold (ADR-0029 -- no API key); NotWired / StaleReference are
  // self-contained (the locale message already names them) -> no fold. The
  // InvalidConfig case (issue #277) is the one this suite was added to pin:
  // the configuration policy reason must reach the fold, not be dropped.
  it("returns the detail for the fold-carrying kinds", () => {
    const withDetail: Array<[TurnFailure, string]> = [
      [{ kind: "Execute", data: { detail: "bad column" } }, "bad column"],
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
