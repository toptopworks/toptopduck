//! Tool definitions for the built-in DuckDB tool server (ADR-0076, issue #292).
//!
//! Each built-in tool is a [`ToolDefinition`] -- a name, a human/agent-readable
//! description, and a JSON Schema for its input. The per-session tool table
//! ([`super::builtin_table`]) advertises these to the runtime; the dispatch
//! layer ([`super::dispatch`]) routes a model-emitted [`ToolUse`] to the
//! matching executor by name.
//!
//! The four tools are the MCP gateway's built-in surface (ADR-0077): explore
//! (scratch, turn-local), materialize (promote to `result_N`), describe (schema
//! read), and sample (row read). None exposes raw DDL -- the only path to a
//! working-set object is `materialize`, which goes through the existing
//! [`crate::session::materializer::Materializer`] and so inherits ADR-0022/0024/
//! 0030 numbering + caps for free.

use std::sync::OnceLock;

use crate::approval::OperationKind;
use crate::model::ColumnSchema;
use crate::provider::tool_calling::ToolDefinition;
use serde_json::{json, Value};

/// Canonical names for the four built-in tools. Kept as `pub(crate)` consts so
/// the dispatch `match` and the definition builders reference one source of
/// truth -- a typo in either place would otherwise silently break routing.
pub(crate) const TOOL_EXPLORE: &str = "explore";
pub(crate) const TOOL_MATERIALIZE: &str = "materialize";
pub(crate) const TOOL_DESCRIBE: &str = "describe";
pub(crate) const TOOL_SAMPLE: &str = "sample";

/// The default number of sample rows an `explore` call returns (ADR-0077
/// explore contract). Bounded so a wide result cannot bloat the tool-result
/// payload that rides the LLM context; the caller can raise it up to
/// [`EXPLORE_MAX_SAMPLE_ROWS`] via the `sample_rows` parameter.
pub(crate) const EXPLORE_DEFAULT_SAMPLE_ROWS: i64 = 10;

/// Upper bound on the `explore` tool's `sample_rows` parameter. Keeps the
/// tool-result payload bounded even when the model asks for a large preview --
/// the full result is still materializable via `materialize` if the agent needs
/// the whole table.
pub(crate) const EXPLORE_MAX_SAMPLE_ROWS: i64 = 50;

/// The default page size a `sample` call returns (mirrors the explore default
/// so the two read-shaped tools read consistently).
pub(crate) const SAMPLE_DEFAULT_LIMIT: i64 = 10;

/// Upper bound on the `sample` tool's `limit` parameter. Mirrors the explore
/// cap so neither read-shaped tool can pull an unbounded payload into the LLM
/// context.
pub(crate) const SAMPLE_MAX_LIMIT: i64 = 50;

/// Build the [`ToolDefinition`] for the `explore` tool (ADR-0077 scratch
/// semantics). Explore runs a read-only SQL on a scratch sandbox and returns
/// the result shape (columns + row count + a bounded sample) without
/// persisting anything -- no `result_N`, no working-set mutation, no admin
/// write. The scratch table lives only for the call.
pub(crate) fn explore_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_EXPLORE.to_string(),
        description: "Run a read-only SQL query to explore the working set without \
                      persisting a result. Returns the result's columns, row count, \
                      and a bounded sample of rows. The query runs on a scratch \
                      sandbox -- it produces no result_N and leaves the working set \
                      untouched. Use this to inspect data shape, test expressions, \
                      or debug a query before materializing. Stale result_N \
                      references are refused."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A read-only SQL SELECT query. References working-set \
                                    datasets by their reference name (sources as \
                                    \"<ref>\".data, materialized results as \"<ref>\")."
                },
                "sample_rows": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": EXPLORE_MAX_SAMPLE_ROWS,
                    "default": EXPLORE_DEFAULT_SAMPLE_ROWS,
                    "description": "How many leading rows to return in the sample. \
                                    Defaults to 10; capped at 50."
                }
            },
            "required": ["sql"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `materialize` tool (ADR-0077 explicit
/// promotion). Materialize runs the SQL and promotes its result into the
/// working set as the next `result_N` (ADR-0022 monotonic, never reused),
/// subject to the row-count and result-count caps (ADR-0005/0030). This is the
/// ONLY tool that creates a working-set object -- reuse of the existing
/// [`crate::session::materializer::Materializer`] keeps numbering, caps, and
/// stale-GC identical to the legacy single-SQL path.
pub(crate) fn materialize_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_MATERIALIZE.to_string(),
        description: "Run a SQL query and promote its result into the working set as \
                      the next result_N. The promoted result gets a stable reference \
                      name (result_1, result_2, ... by promotion order, never reused) \
                      that later SQL can reference. Subject to the row-count and \
                      result-count caps. Use this when a result is worth keeping; use \
                      `explore` for throwaway inspection."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A SQL query whose result is promoted. References \
                                    working-set datasets by their reference name \
                                    (sources as \"<ref>\".data, materialized results \
                                    as \"<ref>\")."
                },
                "display_name": {
                    "type": "string",
                    "description": "Optional human-readable label for the promoted \
                                    result. Defaults to the reference name (result_N)."
                }
            },
            "required": ["sql"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `describe` tool. Describe returns a
/// registered dataset's column schema and row count -- the same shape the
/// working set already caches, so no SQL runs. Only registered working-set
/// members can be described; an unknown name returns a tool error the agent
/// can self-correct from (ADR-0077).
pub(crate) fn describe_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_DESCRIBE.to_string(),
        description: "Return the column schema and row count of a registered \
                      working-set dataset (an uploaded source or a materialized \
                      result_N). Use this to recall a dataset's columns before \
                      writing SQL against it. Unknown or stale reference names \
                      return an error."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "reference_name": {
                    "type": "string",
                    "description": "The reference name of the dataset to describe \
                                    (a source name or result_N)."
                }
            },
            "required": ["reference_name"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `sample` tool. Sample returns a bounded
/// page of rows from a registered dataset. Like `read_rows` but exposed as a
/// tool so the agent can inspect actual values. Reads from the working set's
/// authoritative connection; unknown names return a tool error.
pub(crate) fn sample_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_SAMPLE.to_string(),
        description: "Return a bounded page of rows from a registered working-set \
                      dataset. Cells are cast to strings. Use this to inspect actual \
                      values -- e.g. distinct values, ranges, or sample rows the \
                      dataset descriptor's frozen sample does not cover."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "reference_name": {
                    "type": "string",
                    "description": "The reference name of the dataset to sample rows \
                                    from (a source name or result_N)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": SAMPLE_MAX_LIMIT,
                    "default": SAMPLE_DEFAULT_LIMIT,
                    "description": "Maximum rows to return. Defaults to 10; capped at 50."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "default": 0,
                    "description": "Zero-based row offset for pagination."
                }
            },
            "required": ["reference_name"]
        }),
    }
}

/// Static metadata for one built-in tool (issue #336): the schema-layer
/// [`ToolDefinition`] paired with the orchestration-side classification -- the
/// approval-gateway [`OperationKind`] badge and the trace/approval summary key
/// (`summary_field` + its `summary_fallback`). One struct so adding a built-in
/// tool is a single entry in [`builtin_tools`], not four parallel edits across
/// definitions + dispatch + `classify_call` + a side-effect special-case.
///
/// The `Builtin` prefix is deliberate: this is the static, compile-time table
/// for the built-in DuckDB tools. External (MCP) tool metadata is discovered at
/// run time from its server and does not live in this struct.
pub(crate) struct BuiltinToolSpec {
    /// The schema advertised to the runtime (name + description + JSON Schema).
    pub(crate) definition: ToolDefinition,
    /// The approval-gateway operation badge (ADR-0083): Read for the read-shaped
    /// tools, Write for the sole promoting tool.
    pub(crate) operation_kind: OperationKind,
    /// The input field rendered as the call summary (the SQL or reference name).
    pub(crate) summary_field: &'static str,
    /// Best-effort placeholder when `summary_field` is absent on a mis-shaped
    /// call (the executor will itself refuse it).
    pub(crate) summary_fallback: &'static str,
}

/// The single-point built-in tool table (issue #336): the built-in DuckDB tools
/// the gateway advertises, each with its schema + classification in one entry.
/// Held in a process-level [`OnceLock`] (MSRV 1.77 -- `LazyLock` needs 1.80) so
/// the table is built once and read by both [`builtin_definitions`] (schema view)
/// and [`builtin_metadata`] (classification view) without re-spelling them.
///
/// User-configured MCP servers (#301) and skill-declared tools join the
/// advertised surface at the gateway aggregation layer in a later slice; this
/// table is the built-in-only foundation.
pub(crate) fn builtin_tools() -> &'static [BuiltinToolSpec] {
    static TOOLS: OnceLock<Vec<BuiltinToolSpec>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        vec![
            BuiltinToolSpec {
                definition: explore_definition(),
                operation_kind: OperationKind::Read,
                summary_field: "sql",
                summary_fallback: "<no sql>",
            },
            BuiltinToolSpec {
                definition: materialize_definition(),
                operation_kind: OperationKind::Write,
                summary_field: "sql",
                summary_fallback: "<no sql>",
            },
            BuiltinToolSpec {
                definition: describe_definition(),
                operation_kind: OperationKind::Read,
                summary_field: "reference_name",
                summary_fallback: "<no reference_name>",
            },
            BuiltinToolSpec {
                definition: sample_definition(),
                operation_kind: OperationKind::Read,
                summary_field: "reference_name",
                summary_fallback: "<no reference_name>",
            },
        ]
    })
}

/// Look up a built-in tool's metadata by name (issue #336). Returns `None` for
/// an unknown name so the caller (the agent-loop `classify_call`) can fall
/// through to its external-tool arm. The borrow is `&'static` because
/// [`builtin_tools`] lives in a process-level `OnceLock`.
pub(crate) fn builtin_metadata(name: &str) -> Option<&'static BuiltinToolSpec> {
    builtin_tools()
        .iter()
        .find(|spec| spec.definition.name == name)
}

/// The full built-in tool table as advertised to the runtime (ADR-0076): the
/// schema view derived from [`builtin_tools`]. Cloning the small definitions per
/// call matches the prior freshly-constructed-vec cost; callers
/// (the per-turn/per-session tool table) take a fresh copy with no shared
/// mutable state crossing sessions.
pub(crate) fn builtin_definitions() -> Vec<ToolDefinition> {
    builtin_tools()
        .iter()
        .map(|spec| spec.definition.clone())
        .collect()
}

/// Parse a JSON-typed string parameter out of a tool input value, returning a
/// helpful error string on a missing field or a type mismatch. Shared by the
/// per-tool dispatchers so the error shape ("parameter `<name>`: <reason>")
/// reads consistently across tools -- the agent sees one format when it
/// mis-uses any tool.
pub(crate) fn get_str(input: &Value, field: &str) -> Result<String, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("parameter `{field}`: expected a string"))
}

/// One column's JSON for a tool payload: `{ "name", "type" }`. The field is
/// `type` (not the wire [`ColumnSchema`] field name `canonical_type`) because the
/// tool layer owns this presentation rename for the LLM-facing payload, while the
/// IPC `ColumnSchema` field name stays for the frontend. Shared by every built-in
/// tool that echoes a column schema (explore / describe / sample / materialize)
/// so the shape is identical across payloads.
pub(crate) fn column_json(c: &ColumnSchema) -> Value {
    json!({ "name": c.name, "type": c.canonical_type })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each definition carries its canonical name and a non-empty description +
    /// object schema -- the contract the provider adapters rely on (anthropic
    /// `input_schema` / openai `parameters` pass the schema through verbatim).
    #[test]
    fn each_builtin_definition_is_well_formed() {
        for def in builtin_definitions() {
            assert!(!def.name.is_empty(), "tool name must not be empty");
            assert!(!def.description.is_empty(), "{} description", def.name);
            assert!(
                def.input_schema.is_object(),
                "{} input_schema must be a JSON object",
                def.name
            );
            assert_eq!(
                def.input_schema["type"], "object",
                "{} input_schema must declare type=object",
                def.name
            );
        }
    }

    /// The four tool names are distinct -- a duplicate would let the dispatch
    /// `match` shadow one tool silently.
    #[test]
    fn builtin_tool_names_are_distinct() {
        let defs = builtin_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(names.len(), unique.len(), "duplicate tool names: {names:?}");
        assert_eq!(names.len(), 4);
    }

    /// The metadata table ([`builtin_tools`]) and the schema view
    /// ([`builtin_definitions`]) name the SAME four tools (issue #336). A drift
    /// -- a tool in one but not the other -- would mean a tool the gateway
    /// advertises but `classify_call` cannot classify (or vice versa), so the
    /// approval card / trace would fall through to the external arm for a
    /// built-in. Pinned so a future fifth tool added to only one table fails
    /// here, not in a live mis-classified approval card.
    #[test]
    fn builtin_tools_table_matches_definitions_table() {
        let spec_names: std::collections::HashSet<&str> = builtin_tools()
            .iter()
            .map(|s| s.definition.name.as_str())
            .collect();
        let defs = builtin_definitions();
        let def_names: std::collections::HashSet<&str> =
            defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            spec_names, def_names,
            "metadata table and schema view must advertise the same tool set"
        );
        // No count pin here: the cross-table name-set equality above + the
        // distinctness test (`builtin_tool_names_are_distinct`) already guard a
        // dropped/added tool. Hardcoding the count would fight this table's own
        // reason to exist (a future fifth tool should land as one entry, not
        // trip a count assertion).
    }

    /// `builtin_metadata` resolves each advertised name to its spec, and `None`
    /// for an unknown name (the external-tool fall-through contract,
    /// `classify_call` relies on).
    #[test]
    fn builtin_metadata_resolves_known_and_rejects_unknown() {
        for def in builtin_definitions() {
            assert!(
                builtin_metadata(&def.name).is_some(),
                "metadata lookup must resolve advertised tool `{}`",
                def.name
            );
        }
        assert!(
            builtin_metadata("not_a_builtin_tool").is_none(),
            "unknown name must miss so classify_call falls through to external"
        );
    }

    /// `sql` is required on explore + materialize; `reference_name` on describe
    /// and sample. Pinning the `required` arrays keeps the schema honest about
    /// what the executor will refuse to run without.
    #[test]
    fn required_fields_are_declared() {
        let defs: std::collections::HashMap<String, ToolDefinition> = builtin_definitions()
            .into_iter()
            .map(|d| (d.name.clone(), d))
            .collect();
        let explore_required = defs[TOOL_EXPLORE].input_schema["required"]
            .as_array()
            .expect("explore required is an array");
        assert!(
            explore_required.iter().any(|v| v == "sql"),
            "explore must require sql"
        );
        let materialize_required = defs[TOOL_MATERIALIZE].input_schema["required"]
            .as_array()
            .expect("materialize required is an array");
        assert!(
            materialize_required.iter().any(|v| v == "sql"),
            "materialize must require sql"
        );
        let describe_required = defs[TOOL_DESCRIBE].input_schema["required"]
            .as_array()
            .expect("describe required is an array");
        assert!(
            describe_required.iter().any(|v| v == "reference_name"),
            "describe must require reference_name"
        );
        let sample_required = defs[TOOL_SAMPLE].input_schema["required"]
            .as_array()
            .expect("sample required is an array");
        assert!(
            sample_required.iter().any(|v| v == "reference_name"),
            "sample must require reference_name"
        );
    }

    /// `get_str` returns the field value when present, and a consistent error
    /// string naming the missing field when absent or wrongly typed. The error
    /// is what the agent reads to self-correct (ADR-0077 tool-level error).
    #[test]
    fn get_str_returns_value_or_field_named_error() {
        let input = json!({"sql": "SELECT 1"});
        assert_eq!(get_str(&input, "sql").unwrap(), "SELECT 1");

        let missing = get_str(&input, "missing").unwrap_err();
        assert!(
            missing.contains("`missing`"),
            "error names the field: {missing}"
        );

        let wrong_type = json!({"sql": 42});
        let err = get_str(&wrong_type, "sql").unwrap_err();
        assert!(err.contains("`sql`"), "error names the field: {err}");
    }
}
