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
// (log calls must never block the UI). A rejected IPC -- a unit test's
// jsdom, OR a production failure (disk full, plugin misregistered,
// capability missing) -- is swallowed so a log failure can never crash the
// app. To keep a PERMANENTLY dead sink observable (not just a transient
// blip), the first rejection also surfaces on the console once; further
// rejections stay silent to avoid spam. In dev the message is mirrored to
// console on every call so devtools stays usable; production relies on the
// file sink (plus that one-shot fallback if the sink is dead).

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

// Cap the JSON-stringified form of an object extra. A huge object (a full
// result set, a large prompt) would otherwise write a MiB line into the 5MB
// KeepOne sink and evict rotation history on the very call. Error stacks
// (the describe Error branch) are left uncapped -- they are naturally
// bounded and are the diagnostic the sink exists for.
const MAX_EXTRA_LENGTH = 512;

// Latches true on the first rejected plugin-log IPC so a permanently dead
// sink is reported once (then stays quiet). Module-level because a dead sink
// is a process-lifetime condition, not a per-call one.
let sinkReportedDead = false;

/** Coerce an unknown extra to a short redacted string for log context. An
 *  Error collapses to its stack (the throw-site backtrace is the diagnostic
 *  the sink exists for -- ADR-0029 restricts source DATA values, not stacks;
 *  .message is the fallback when no stack is present). Objects are
 *  JSON-stringified and capped at MAX_EXTRA_LENGTH; if stringify throws
 *  (circular refs), fall back to String so the call never crashes the app. */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value).slice(0, MAX_EXTRA_LENGTH);
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
    // IPC failed (jsdom test, OR a real production failure: disk full, plugin
    // misregistered, capability missing). Swallow so a log failure never
    // crashes the app, but surface a permanently dead sink ONCE so it is not
    // invisible (ADR-0029 honest-degrade). A single transient blip is silent;
    // a broken sink in production is reported, then quiet to avoid spam.
    if (!sinkReportedDead) {
      sinkReportedDead = true;
      console.error("[log] plugin-log sink rejected; further log failures will be silent");
    }
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
