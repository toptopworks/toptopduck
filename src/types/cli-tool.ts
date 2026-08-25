// Registered CLI tool wire contract (issue #671, ADR-0108/0109). Mirrors the
// Rust `cli_tools::config` types verbatim (snake_case field names -- serde
// keeps the Rust names; the same convention `types/mcp.ts` uses).
//
// All values are non-secret by construction: the backend's config read-time
// secret-name scan refuses a secret-named env key exactly as it does for MCP
// server env.

// How one parameter's value reaches the child process, declared per
// parameter at registration (ADR-0108 Decision 4). v1 implements "argv"
// only; "file" / "stdin" land in #672 -- the field rides the wire now so the
// persisted shape needs no migration when they do.
export type CliParamDelivery = "argv" | "file" | "stdin";

// One parameter-table entry: name + description + delivery mode, plus the
// single composite-type exception -- a `string[]` varargs parameter whose
// values append as one block at the argv tail (whole-binary-wrapper
// registrations).
export interface CliToolParam {
  name: string;
  description: string;
  delivery: CliParamDelivery;
  // `true` = the string[] varargs parameter. At most one per entry; it must
  // not appear in the argv template (it rides the tail).
  varargs: boolean;
}

// The entry's source (ADR-0109 Decision 1 serde reservation). v1 writes only
// "user"; the builtin-entry slice auto-registers "builtin" entries with
// identical execution semantics.
export type CliToolSource = "user" | "builtin";

// Baseline-tracking marker (ADR-0109 Decision 2 serde reservation), present
// only on builtin entries. null on user entries.
export type CliBaselineState = "following" | "edited";

export interface CliToolConfig {
  // Kebab-case, <=64 chars, unique, not colliding with a reserved tool name
  // (validated at registration -- the backend returns the refusal as an
  // InvalidCliTool error). The tool-table name the model calls and the
  // anchor the approval trust key carries.
  name: string;
  // Required, LLM-visible (rides the tool definition's description).
  description: string;
  // PATH-resolved name or absolute path. Registration never blocks on it
  // resolving: a missing executable surfaces as a structured tool error at
  // call time and the entry re-arms once it resolves again (probe
  // semantics).
  executable: string;
  // The placeholder argv array: a whole element `{param}` substitutes the
  // parameter's value; every other element passes verbatim.
  argv_template: string[];
  params: CliToolParam[];
  // NON-SECRET literal env values merged over the inherited environment at
  // spawn (registration values win on name clashes).
  env: Record<string, string>;
  // Machine-level persistent enablement (ADR-0106 single axis): enabled =
  // direct-listed into every turn's tool surface; disabled = dormant.
  enabled: boolean;
  source: CliToolSource;
  baseline: CliBaselineState | null;
}

export interface CliToolRegistry {
  tools: CliToolConfig[];
}

// A blank registration for the Add form. `enabled` defaults true (the form's
// save is explicit intent, the MCP row's ADR-0106 precedent); the backend
// fills the serde defaults on the wire shape it accepts.
export function blankCliTool(): CliToolConfig {
  return {
    name: "",
    description: "",
    executable: "",
    argv_template: [],
    params: [],
    env: {},
    enabled: true,
    source: "user",
    baseline: null,
  };
}
