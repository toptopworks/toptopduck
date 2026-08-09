//! The built-in DuckDB tool server (ADR-0076 gateway skeleton, issue #292).
//!
//! This module is the app-side MCP gateway's built-in tool source: the four
//! DuckDB tools (`explore` / `materialize` / `describe` / `sample`) the gateway
//! advertises to a runtime, plus the dispatch that routes a model-emitted
//! [`ToolUse`] to the matching executor. The per-session tool table
//! ([`builtin_table`]) carries exactly these four definitions today; user-
//! configured MCP servers (#301) and skill-declared tools join the same table
//! at the gateway aggregation layer in a later slice.
//!
//! The [`Materializer`] trait the `materialize` tool delegates to is the SAME
//! trait the live-turn agent loop ([`crate::session::agent_loop::AgentLoop`],
//! ADR-0081) and the resume replay drive, so numbering, caps, provenance, and
//! stale-GC are inherited byte-for-byte -- no parallel materialize
//! implementation. The single-SQL turn contract (ADR-0009) was retired by
//! issue #318; tool-calling turns are the sole live path.
//!
//! Namespace isolation (AC #3): only `materialize` creates a working-set object.
//! `explore` runs on a scratch sandbox that is dropped per call, so a scratch
//! table can never reach the working set. There is no raw-DDL tool.

pub mod definitions;
pub mod describe;
pub mod explore;
pub mod materialize;
pub mod read_paths;
pub mod sample;

use crate::cancel::CancelToken;
use crate::model::Promotion;
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::materializer::{Materializer, TurnDeps};
use serde_json::Value;

/// The per-session tool table (ADR-0076): the built-in DuckDB tool definitions
/// the gateway advertises to the runtime. Cloning is cheap (four small owned
/// definitions), so each turn / session that needs the table takes a fresh
/// copy -- no shared mutable state crosses sessions.
///
/// Public (returns only `pub` types) so a future external runtime bridge can
/// read the advertised surface without reaching into the crate.
pub fn builtin_table() -> Vec<ToolDefinition> {
    definitions::builtin_definitions()
}

/// Convert the gateway's namespaced external MCP tool entries (the MCP
/// `tools/list` shape: `{name, description, inputSchema}`, already namespaced
/// to `mcp__<slug>__<tool>` by `McpAggregator::aggregated_tools`) to the
/// provider-facing [`ToolDefinition`] table (ADR-0076, issue #301 slice
/// C-loop). The built-in agent loop merges this alongside [`builtin_table`]
/// so the model sees one tool surface whether the turn runs the built-in loop
/// or the ACP external runtime (the gateway does the same merge on
/// `tools/list`).
///
/// Best-effort over a malformed server entry: a missing `description` becomes
/// an empty string (the model still sees the name + schema); a missing
/// `inputSchema` becomes an empty object so the provider adapter's
/// well-formedness check (object schema) still holds. A missing `name` becomes
/// an empty string -- `namespace_tool_entries` already passes such an entry
/// through unchanged, so the gateway surfaces it honestly rather than
/// silently dropping it; the model gets an unnamed tool it will not call.
pub(crate) fn external_tool_definitions(mcp_entries: &[Value]) -> Vec<ToolDefinition> {
    mcp_entries
        .iter()
        .map(|entry| ToolDefinition {
            name: entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            description: entry
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            input_schema: entry
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
        })
        .collect()
}

/// The executor→dispatch internal contract (issue #336): the JSON content that
/// reaches the model, paired with an optional side effect. Today, only
/// `materialize` fills `promotion` (a typed `Promotion` built from the in-hand
/// `dataset` + `sql`); the read-shaped tools set `promotion: None`. The dispatch
/// wrapper assembles this into a [`ToolOutcome`] for the orchestration layer.
///
/// `pub(super)` because this is the tools-module-internal seam between an
/// executor and [`dispatch`]; the orchestration layer consumes [`ToolOutcome`],
/// not this struct. The field names (`content` / `promotion`) intentionally
/// mirror [`ToolOutcome`] so the wrapper is a plain re-pack.
#[derive(Debug)]
pub(super) struct ToolPayload {
    /// The model-facing JSON payload (serialized to the `ToolResult.content`
    /// string by [`dispatch`]).
    pub content: Value,
    /// A typed side effect the executor already holds (issue #336): a
    /// `materialize` promotion, built from the typed descriptor + sql rather
    /// than re-derived from the serialized content. `None` for the read tools.
    pub promotion: Option<Promotion>,
}

/// The dispatch outcome the orchestration layer consumes (issue #336): the
/// model-facing [`ToolResult`] paired with the side effect the executor
/// reported. Wrapping the `ToolResult` (rather than replacing it) keeps the
/// model envelope byte-identical -- the agent sees the same `content` /
/// `is_error` it always did -- while the typed `promotion` flows to the agent
/// loop without the prior JSON serialize → deserialize round trip.
///
/// No `Builtin` prefix: this is a domain-level seam a future external-runtime
/// bridge can return the same shape against (ADR-0076), not a built-in-only
/// type.
#[derive(Debug)]
pub(crate) struct ToolOutcome {
    /// The model-facing result (success payload or error string). Unchanged in
    /// shape from the pre-refactor `ToolResult`.
    pub result: ToolResult,
    /// The side effect the executor reported (today, `Some` only on a
    /// successful `materialize`). The agent loop pushes it to the turn's
    /// promotion list.
    pub promotion: Option<Promotion>,
}

/// Dispatch a model-emitted tool call to its executor (ADR-0076 gateway routing,
/// issue #292) and surface its side effect as a typed channel (issue #336).
///
/// Routes by the tool name to the matching executor, then wraps the executor's
/// [`ToolPayload`] as a [`ToolOutcome`]: a JSON-serialized [`ToolResult`] on
/// success (with the executor's typed `promotion`, if any) or the error string
/// with `is_error = true` (ADR-0077 -- the agent self-corrects from a tool-level
/// error rather than the turn blindly retrying). An unknown tool name is itself a
/// tool error so the model can stop calling it.
///
/// `pub(crate)` because the signature borrows [`TurnDeps`] and [`Materializer`]
/// (both `pub(crate)`) -- the only consumer today is the in-crate agent loop
/// (#295), which shares the session's materializer through here so a
/// `materialize` call inherits numbering + caps from the legacy single-SQL path.
pub(crate) fn dispatch(
    call: &ToolUse,
    deps: &mut TurnDeps,
    cancel: &CancelToken,
    materializer: &mut dyn Materializer,
) -> ToolOutcome {
    let outcome: Result<ToolPayload, String> = match call.name.as_str() {
        definitions::TOOL_EXPLORE => explore::dispatch(&call.input, deps, cancel),
        definitions::TOOL_MATERIALIZE => {
            materialize::dispatch(&call.input, deps, cancel, materializer)
        }
        definitions::TOOL_DESCRIBE => describe::dispatch(&call.input, deps),
        definitions::TOOL_SAMPLE => sample::dispatch(&call.input, deps),
        other => Err(format!("unknown tool: `{other}`")),
    };
    match outcome {
        Ok(payload) => ToolOutcome {
            result: ToolResult {
                tool_use_id: call.id.clone(),
                content: payload.content.to_string(),
                is_error: false,
            },
            promotion: payload.promotion,
        },
        Err(message) => ToolOutcome {
            result: ToolResult {
                tool_use_id: call.id.clone(),
                content: message,
                is_error: true,
            },
            promotion: None,
        },
    }
}

/// Shared test scaffolding for the built-in tool modules (issue #292).
#[cfg(test)]
pub(crate) mod test_support {
    use crate::session::materializer::TurnDeps;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use std::collections::HashMap;
    use std::path::Path;

    /// A throwaway [`TurnDeps`] over locally-owned conn + sources + working set,
    /// with inert cap defaults and `temp_path = "."`. Suitable for tool executors
    /// that never touch the filesystem (explore / describe / sample). Centralized
    /// so the four-tool dispatch tests cannot drift apart on the cap defaults
    /// (DRY); the materialize tests use [`inert_deps_with_temp`] for a real
    /// `TempDir` without re-spelling the caps.
    pub fn inert_deps<'a>(
        conn: &'a Connection,
        ws: &'a mut WorkingSet,
        sources: &'a mut HashMap<String, std::path::PathBuf>,
        tool_output_refs: &'a mut HashMap<String, crate::session::materializer::CachedDerivedRef>,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: Path::new("."),
            tool_output_refs,
        }
    }

    /// Same inert cap defaults as [`inert_deps`] but with a caller-owned
    /// `temp_path` for the executors that touch disk (the real materializer needs
    /// a `TempDir`). The caller retains ownership of the temp dir and passes a
    /// borrow in -- this covers the materialize tests without duplicating the
    /// cap literals, so a future production-cap change tracks one site.
    pub fn inert_deps_with_temp<'a>(
        conn: &'a Connection,
        ws: &'a mut WorkingSet,
        sources: &'a mut HashMap<String, std::path::PathBuf>,
        temp_path: &'a Path,
        tool_output_refs: &'a mut HashMap<String, crate::session::materializer::CachedDerivedRef>,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path,
            tool_output_refs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DatasetDescriptor;
    use crate::provider::tool_calling::ToolUse;
    use crate::session::materializer::FakeMaterializer;
    use crate::tools::test_support::inert_deps;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use serde_json::json;
    use std::collections::HashMap;

    /// The advertised tool table contains exactly the four canonical tools, by
    /// name -- the contract the agent loop (and external runtimes, via the
    /// gateway bridge) will rely on.
    #[test]
    fn builtin_table_advertises_four_tools() {
        let names: Vec<String> = builtin_table().into_iter().map(|d| d.name).collect();
        assert_eq!(
            names,
            vec![
                "explore".to_string(),
                "materialize".to_string(),
                "describe".to_string(),
                "sample".to_string(),
            ]
        );
    }

    /// The MCP `tools/list` entries (already namespaced by the aggregator)
    /// convert to the provider-facing `ToolDefinition` table (issue #301 slice
    /// C-loop): name + description + inputSchema ride through verbatim.
    #[test]
    fn external_tool_definitions_converts_namespaced_entries() {
        let entries = vec![
            json!({
                "name": "mcp__github__search",
                "description": "search repos",
                "inputSchema": {
                    "type": "object",
                    "properties": {"q": {"type": "string"}}
                }
            }),
            json!({
                "name": "mcp__github__fetch",
                "description": "fetch a repo",
                "inputSchema": {"type": "object"}
            }),
        ];
        let defs = external_tool_definitions(&entries);
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].name, "mcp__github__search");
        assert_eq!(defs[0].description, "search repos");
        assert_eq!(defs[0].input_schema["type"], "object");
        assert_eq!(defs[0].input_schema["properties"]["q"]["type"], "string");
        assert_eq!(defs[1].name, "mcp__github__fetch");
    }

    /// A malformed entry (missing description + inputSchema) still yields a
    /// well-formed `ToolDefinition` (issue #301 slice C-loop): empty
    /// description + empty-object schema, so the provider adapter's
    /// object-schema well-formedness check still holds and the model gets an
    /// honest (if sparse) entry rather than a silently-dropped tool.
    #[test]
    fn external_tool_definitions_falls_back_for_malformed_entries() {
        let entries = vec![json!({"name": "mcp__srv__minimal"})];
        let defs = external_tool_definitions(&entries);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "mcp__srv__minimal");
        assert_eq!(defs[0].description, "");
        assert!(defs[0].input_schema.is_object());
    }

    /// An empty entry slice yields an empty definition table (issue #301 slice
    /// C-loop): the no-servers case is a no-op merge, not a sentinel or error.
    #[test]
    fn external_tool_definitions_empty_slice_yields_empty_table() {
        let defs = external_tool_definitions(&[]);
        assert!(defs.is_empty());
    }

    /// An unknown tool name returns a tool error (is_error = true) naming the
    /// tool -- the model gets actionable feedback to stop calling it. No
    /// executor runs, so no DuckDB / working-set side effect.
    #[test]
    fn unknown_tool_name_is_a_tool_error() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let cancel = CancelToken::new();
        let mut materializer = FakeMaterializer::new(vec![]);
        let call = ToolUse {
            id: "tu_1".into(),
            name: "not_a_real_tool".into(),
            input: json!({}),
        };
        let result = dispatch(&call, &mut deps, &cancel, &mut materializer).result;
        assert_eq!(result.tool_use_id, "tu_1");
        assert!(result.is_error, "unknown tool must be an error");
        assert!(
            result.content.contains("unknown tool"),
            "error names the tool: {}",
            result.content
        );
        assert!(
            result.content.contains("not_a_real_tool"),
            "error names the tool: {}",
            result.content
        );
    }

    /// A successful executor outcome is serialized to the ToolResult content
    /// string with is_error = false. Uses describe (the cheapest executor -- no
    /// SQL) against a registered dataset, and pins the full round-trip: the
    /// payload the executor built is what reaches the wire (modulo JSON
    /// serialization).
    #[test]
    fn success_outcome_serializes_as_non_error_content() {
        use crate::model::{ColumnSchema, DatasetPrivacy, RectifyProvenance};
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        ws.register(DatasetDescriptor {
            reference_name: "people".into(),
            display_name: "people".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "id".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 5,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let cancel = CancelToken::new();
        let mut materializer = FakeMaterializer::new(vec![]);
        let call = ToolUse {
            id: "tu_2".into(),
            name: "describe".into(),
            input: json!({"reference_name": "people"}),
        };
        let result = dispatch(&call, &mut deps, &cancel, &mut materializer).result;
        assert_eq!(result.tool_use_id, "tu_2");
        assert!(
            !result.is_error,
            "describe on a registered dataset is success"
        );
        // The content is the JSON payload the describe executor produced --
        // round-tripped through serde_json so the wire string is valid JSON
        // whose fields the agent can read.
        let parsed: Value = serde_json::from_str(&result.content).expect("content is JSON");
        assert_eq!(parsed["reference_name"], "people");
        assert_eq!(parsed["row_count"], 5);
        assert_eq!(parsed["columns"][0]["name"], "id");
    }

    /// A tool-level executor error (unknown dataset for describe) reaches the
    /// wire as is_error = true with the executor's message in content. This is
    /// the ADR-0077 self-correction path: the agent reads the error and adjusts.
    #[test]
    fn executor_error_reaches_wire_as_tool_error() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let cancel = CancelToken::new();
        let mut materializer = FakeMaterializer::new(vec![]);
        let call = ToolUse {
            id: "tu_3".into(),
            name: "describe".into(),
            input: json!({"reference_name": "ghost"}),
        };
        let result = dispatch(&call, &mut deps, &cancel, &mut materializer).result;
        assert!(result.is_error, "unknown dataset is a tool error");
        assert!(
            result.content.contains("unknown dataset"),
            "{}",
            result.content
        );
        assert!(result.content.contains("ghost"), "{}", result.content);
    }

    /// The top-level `dispatch` routes explore / sample / materialize by name,
    /// not just describe. Each routed tool echoes its `tool_use_id` with a
    /// non-error outcome on a happy input -- pinning the three remaining match
    /// arms (TOOL_EXPLORE / TOOL_SAMPLE / TOOL_MATERIALIZE) so a const typo or a
    /// stale name cannot silently break routing at the gateway boundary.
    #[test]
    fn dispatch_routes_explore_sample_and_materialize() {
        use crate::model::{ColumnSchema, DatasetPrivacy, RectifyProvenance};
        use crate::session::materializer::RealMaterializer;
        use crate::tools::test_support::inert_deps_with_temp;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE result_1 (id INTEGER)")
            .unwrap();
        conn.execute_batch("INSERT INTO result_1 VALUES (1), (2)")
            .unwrap();
        let mut ws = WorkingSet::default();
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "id".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 2,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;

        // explore routes + succeeds (read-only on the mirrored result_1).
        let explore = dispatch(
            &ToolUse {
                id: "e1".into(),
                name: "explore".into(),
                input: json!({"sql": "SELECT * FROM result_1"}),
            },
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .result;
        assert_eq!(explore.tool_use_id, "e1");
        assert!(
            !explore.is_error,
            "explore routes + succeeds: {}",
            explore.content
        );

        // sample routes + succeeds (bounded rows from the registered result_1).
        let sample = dispatch(
            &ToolUse {
                id: "s1".into(),
                name: "sample".into(),
                input: json!({"reference_name": "result_1"}),
            },
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .result;
        assert_eq!(sample.tool_use_id, "s1");
        assert!(
            !sample.is_error,
            "sample routes + succeeds: {}",
            sample.content
        );

        // materialize routes + succeeds (promotes the next result_N) and the
        // dispatch wrapper passes the executor's typed promotion through to the
        // orchestration layer (issue #336).
        let materialize_outcome = dispatch(
            &ToolUse {
                id: "m1".into(),
                name: "materialize".into(),
                input: json!({"sql": "SELECT * FROM result_1"}),
            },
            &mut deps,
            &cancel,
            &mut materializer,
        );
        assert_eq!(materialize_outcome.result.tool_use_id, "m1");
        assert!(
            !materialize_outcome.result.is_error,
            "materialize routes + succeeds: {}",
            materialize_outcome.result.content
        );
        assert!(
            materialize_outcome.promotion.is_some(),
            "materialize outcome carries the promotion through the wrapper"
        );
    }
}
