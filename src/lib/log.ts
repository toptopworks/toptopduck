import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

// Structured frontend log sink (issue #98, ADR-0029 invariant 2). Routes
// through @tauri-apps/plugin-log so frontend logs land in the SAME file the
// Rust `log` facade writes to -- tauri-plugin-log unifies format
// (DATE[TARGET][LEVEL] MESSAGE) and destination (app_log_dir, the
// Tauri-recommended log directory) for both ends. The plugin's JS bindings
// accept a single string, so a scope prefix is prepended and any extra
// context is stringified into the message.
//
// ADR-0029 invariant 2 (diagnostic logs): never log source data values --
// prompt content, sample rows, result rows, or SQL text. Only operation
// semantics and error classes belong here. Callers must pre-redact any
// sensitive context before passing it as an extra.
//
// Fire-and-forget: the plugin-log IPC returns a Promise that is not awaited
// (log calls must never block the UI). A rejected IPC -- e.g. the plugin is
// not registered under a unit test's jsdom -- is swallowed so a log failure
// can never crash the app. In dev the message is also mirrored to console so
// devtools stays usable; production writes only to the file sink.

type LogFn = "trace" | "debug" | "info" | "warn" | "error";

const pluginFns: Record<LogFn, (message: string) => Promise<void>> = {
  trace,
  debug,
  info,
  warn,
  error,
};

// Map each log level to the console method used for the dev mirror. `trace`
// has no direct console equivalent (`console.trace` dumps a stack -- too
// noisy for a plain message mirror), so it falls back to `console.log`.
const consoleLevelFor: Record<LogFn, "log" | "debug" | "info" | "warn" | "error"> = {
  trace: "log",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

/** Coerce an unknown extra to a short redacted string for log context. Errors
 *  collapse to their message (stack is kept out of the file sink); objects are
 *  JSON-stringified, falling back to String if that throws (circular refs). */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function format(scope: string, message: string, extras: unknown[]): string {
  const head = `[${scope}] ${message}`;
  if (extras.length === 0) return head;
  return `${head} ${extras.map(describe).join(" ")}`;
}

function emit(fn: LogFn, scope: string, message: string, extras: unknown[]): void {
  const line = format(scope, message, extras);
  pluginFns[fn](line).catch(() => {
    // IPC failed (plugin not registered, e.g. jsdom unit test). Swallow --
    // a log failure must never crash the app (ADR-0029 honest-degrade).
  });
  if (import.meta.env.DEV) {
    console[consoleLevelFor[fn]](line);
  }
}

export const log = {
  trace: (scope: string, message: string, ...extras: unknown[]): void =>
    emit("trace", scope, message, extras),
  debug: (scope: string, message: string, ...extras: unknown[]): void =>
    emit("debug", scope, message, extras),
  info: (scope: string, message: string, ...extras: unknown[]): void =>
    emit("info", scope, message, extras),
  warn: (scope: string, message: string, ...extras: unknown[]): void =>
    emit("warn", scope, message, extras),
  error: (scope: string, message: string, ...extras: unknown[]): void =>
    emit("error", scope, message, extras),
} as const;
