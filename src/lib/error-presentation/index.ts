// Facade for the error-presentation deep module (ADR-0069). Re-exports the 7
// public functions: the upper-layer AppError assembler (toAppError), the
// "{verb} failed" banner composer (flowFailedMessage, for App.test's prefix
// pin -- issue #1100), the format core (fmtError / errorDetail), the
// TurnFailure presenters (formatTurnFailure / turnFailureDetail), and the
// full-pull guardrail classifier (classifyFullPullRejection, issue #779). The
// 9 type guards, 7 sub-formatters, 4 detail extractors, and the verb mapping
// are module-internal. Every consumer imports these directly; api.ts stays a
// pure invoke boundary.

export { errorDetail, fmtError } from "./format";
export { classifyFullPullRejection } from "./guards";
export { formatTurnFailure, turnFailureDetail } from "./turn-failure";
export { flowFailedMessage, toAppError } from "./app-error";
