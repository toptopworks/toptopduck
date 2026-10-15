// TurnFailure presentation (ADR-0069). A TurnFailure is TurnOutcome::Failed's
// data -- a value returned by a successful ask IPC, not an IPC reject. It is
// grouped with the reject formatters because "backend error -> locale text +
// collapsible detail" is one domain concept; splitting by input type (reject vs
// outcome) rather than by concept would scatter the error wording. Moved
// verbatim from api.ts (issue #225 slice 1).

import type { IntlShape } from "react-intl";
import type { TurnFailure } from "../../types/thread";

// Format a TurnFailure (TurnOutcome::Failed.data, issue #125) through the
// locale catalog. Execute renders the neutral `error.turn.execution` (issue
// #852 -- a turn may be a pure conversation, so "query" prejudges the
// context); the query-worded `error.turn.execute` stays with
// RowReadError::Execute in format.ts, where the wording is accurate. Runtime
// (issue #852) points the user at the external runtime, not the SQL.
// Resource / NotWired / InvalidConfig / StaleReference each have their own
// id, and StaleReference interpolates the dead reference name. Each
// formatMessage call carries a literal id + defaultMessage so @formatjs
// extract recovers it.
export function formatTurnFailure(failure: TurnFailure, intl: IntlShape): string {
  switch (failure.kind) {
    case "Execute":
      return intl.formatMessage({
        id: "error.turn.execution",
        defaultMessage: "Execution failed",
      });
    case "Runtime":
      return intl.formatMessage({
        id: "error.turn.runtime",
        defaultMessage: "Failed to connect to the external runtime",
      });
    case "Resource":
      return intl.formatMessage({
        id: "error.turn.resource",
        defaultMessage: "A resource limit was reached",
      });
    case "NotWired":
      return intl.formatMessage({
        id: "error.turn.notWired",
        defaultMessage: "No LLM provider is configured",
      });
    case "InvalidConfig":
      return intl.formatMessage({
        id: "error.turn.invalidConfig",
        defaultMessage: "The provider configuration is invalid",
      });
    case "StaleReference":
      return intl.formatMessage(
        {
          id: "error.turn.stale",
          defaultMessage: "References a stale result \"{name}\"",
        },
        { name: failure.data.reference_name },
      );
    default: {
      // Exhaustiveness guard: a future TurnFailure kind trips the compiler
      // here, mirroring the Rust match and the `never` guards in fmtError.
      const unhandled: never = failure;
      throw new Error(`unhandled TurnFailure kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Extract the technical detail for the collapsed "Technical details" fold from
// a TurnFailure (issue #125). Execute / Runtime / Resource / InvalidConfig
// carry the detail (engine detail, the runtime diagnostic, or the
// configuration diagnosis; audited to hold no API key, ADR-0029); NotWired /
// StaleReference are self-contained (the message already names them) -> no
// fold.
export function turnFailureDetail(failure: TurnFailure): string | null {
  switch (failure.kind) {
    case "Execute":
    case "Runtime":
    case "Resource":
    case "InvalidConfig":
      return failure.data.detail;
    case "NotWired":
    case "StaleReference":
      return null;
    default: {
      const unhandled: never = failure;
      throw new Error(`unhandled TurnFailure kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
