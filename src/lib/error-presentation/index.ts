// Facade for the error-presentation deep module (ADR-0069). Re-exports the 5
// public functions: the upper-layer AppError assembler (toAppError), the
// format core (fmtError / errorDetail), and the TurnFailure presenters
// (formatTurnFailure / turnFailureDetail). The 9 type guards, 7 sub-formatters,
// 4 detail extractors, and the verb prefix logic are module-internal. Every
// consumer imports these directly (issue #226 tore down api.ts's re-export
// bridge and deleted the describeReject / appErrorFrom shims; api.ts is now a
// pure invoke boundary).

export { errorDetail, fmtError } from "./format";
export { formatTurnFailure, turnFailureDetail } from "./turn-failure";
export { toAppError } from "./app-error";
