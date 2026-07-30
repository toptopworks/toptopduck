// TurnFailure presentation (ADR-0069). A TurnFailure is TurnOutcome::Failed's
// data -- a value returned by a successful ask IPC, not an IPC reject. It is
// grouped with the reject formatters because "backend error -> locale text +
// collapsible detail" is one domain concept; splitting by input type (reject vs
// outcome) rather than by concept would scatter the error wording. Moved
// verbatim from api.ts (issue #225 slice 1).

import type { IntlShape } from "react-intl";
import type { TurnFailure } from "../../types/thread";

// Format a TurnFailure (TurnOutcome::Failed.data, issue #125) through the
// locale catalog. Execute shares the merged `error.turn.execute` id with
// SessionError::Turn::Execute (DRY -- one "query failed" message, not two);
// Resource / NotWired / InvalidConfig / StaleReference each have their own id,
// and StaleReference interpolates the dead reference name. Each formatMessage
// call carries a literal id + defaultMessage so @formatjs extract recovers it.
export function formatTurnFailure(failure: TurnFailure, intl: IntlShape): string {
  switch (failure.kind) {
    case "Execute":
      return intl.formatMessage({
        id: "error.turn.execute",
        defaultMessage: "Failed to execute the query",
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
// a TurnFailure (issue #125). Execute / Resource / InvalidConfig carry the
// detail (engine detail or the configuration diagnosis; audited to hold no API
// key, ADR-0029); NotWired / StaleReference are self-contained (the message
// already names them) -> no fold.
export function turnFailureDetail(failure: TurnFailure): string | null {
  switch (failure.kind) {
    case "Execute":
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
