// Facade for the error-presentation deep module (ADR-0069). Re-exports the 5
// public functions: the upper-layer AppError assembler (toAppError), the
// format core (fmtError / errorDetail), and the TurnFailure presenters
// (formatTurnFailure / turnFailureDetail). The 9 type guards, 7 sub-formatters,
// 4 detail extractors, and the verb prefix logic are module-internal. Every
// consumer imports these directly; api.ts stays a pure invoke boundary.

export { errorDetail, fmtError } from "./format";
export { formatTurnFailure, turnFailureDetail } from "./turn-failure";
export { toAppError } from "./app-error";
