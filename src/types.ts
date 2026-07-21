// Re-export barrel for the split type modules (issue #197). Domain types live
// in ./types/<domain>.ts; this preserves the existing `from "./types"` /
// `from "../types"` import paths during the transition -- later slices may point
// imports directly at types/<domain>. Mirrors the Rust model types (serde
// adjacently-/externally-tagged enums that cross IPC). Pure re-export, zero
// behavior, zero runtime code.

export type {
  SessionError,
  RemoveSourceError,
  RenameError,
  RenameSessionError,
  TurnError,
  MigrationError,
  DuckLoadError,
  ResumeError,
  SaveError,
  StoreCommandError,
  ResumeEvent,
  ResumeProgress,
  TurnPhase,
  TurnProgress,
  SourceSummary,
  SessionMetadata,
} from "./types/session";

export type {
  ColumnSchema,
  DatasetPrivacy,
  SheetRectify,
  RectifyProvenance,
  DatasetDescriptor,
  StaleReason,
  StaleAnchor,
  LoadError,
  GuidanceSheet,
  GuidanceRequest,
  SheetGuidance,
  LoadOutcome,
  RowPage,
} from "./types/dataset";

export type {
  TextKind,
  ChartKind,
  VizSpec,
  TurnFailure,
  TurnOutcome,
  TurnRecord,
  ThreadEntry,
} from "./types/thread";

// Source lifecycle shared kernel (issue #200): both dataset (StaleReason) and
// thread (timeline entries) consume these names, so they live in their own leaf.
export type {
  SourceLifecycleKind,
  SourceLifecycleEvent,
} from "./types/lifecycle";

export type {
  Protocol,
  ProviderProfile,
  ProviderConfig,
  ProviderConfigView,
  ProfileKeyStatus,
} from "./types/provider";

export type {
  Theme,
  LocalePreference,
  WindowGeometry,
  EngineDefaults,
  PrivacyDefaults,
  ExportDefaults,
  Tunables,
  ShellPrefs,
  AppConfig,
} from "./types/app-config";

// The merged frontend error model (issue #194): the shell, session, and result
// view all render IPC rejects through one AppError shape.
export type { AppError, AppErrorKind, SessionFlowKind } from "./types/error";
