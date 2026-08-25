//! The CLI tool registry data model (ADR-0108 Decision 2, ADR-0109 Decision 9).
//!
//! The registry lives in app-config next to the MCP registry. A registration
//! entry is the tool's whole definition: the kebab-case `name` is the stable
//! identity (tool-table name, approval trust key anchor, collision anchor),
//! `description` is LLM-visible, `executable` resolves on PATH or by absolute
//! path, the argv template is a placeholder string array, the parameter table
//! declares each value's name / description / delivery mode, and `env` carries
//! non-secret literal values merged over the inherited environment at spawn.
//!
//! Serde reserves the ADR-0109 shape now (`source` dichotomy + `baseline`
//! marker) so the builtin-entry slice (#675/#676) is additive, not a migration.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::provider::tool_calling::ToolDefinition;

/// Maximum registration-name length (ADR-0108 Decision 2).
pub const NAME_MAX_LEN: usize = 64;

/// The one template placeholder form: a template element that is exactly
/// `{param_name}` is replaced by that parameter's value at call time
/// (ADR-0108 Decision 4 -- the value directly replaces the argv element).
/// A partial-occurrence placeholder (e.g. `--flag={x}`) is NOT substituted;
/// it passes through verbatim. Whole-element substitution keeps the argv
/// boundary the injection boundary: a value can never split into two
/// arguments or leak shell syntax into a flag.
fn placeholder(param: &str) -> String {
    format!("{{{param}}}")
}

/// How one parameter's value reaches the child (ADR-0108 Decision 4,
/// per-parameter, declared at registration): inline on the command line
/// ([`Self::Argv`]), through a temp file whose path rides the command line
/// ([`Self::File`], at most bounded by the temp-dir lifetime), or through
/// the child's stdin ([`Self::Stdin`], at most one parameter per entry).
/// A call against a shape registration validation would refuse (a
/// hand-edited config) fails as a structured tool error at call time, never
/// by silently falling back to another mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CliParamDelivery {
    #[default]
    Argv,
    File,
    Stdin,
}

/// One parameter-table entry (ADR-0108 Decision 2): name + description +
/// delivery mode, plus the single composite-type exception -- a `string[]`
/// varargs parameter whose values append as one block at the argv tail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliToolParam {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub delivery: CliParamDelivery,
    /// `true` = the `string[]` varargs parameter (ADR-0108 Decision 4): the
    /// call supplies an array of strings, appended whole at the argv tail.
    /// At most one parameter per entry may set this (append order would
    /// otherwise be ambiguous); a varargs parameter must not also appear in
    /// the argv template (it rides the tail, not a placeholder).
    #[serde(default)]
    pub varargs: bool,
}

/// The registration entry's source (ADR-0109 Decision 1, serde reservation).
/// v1 writes only [`Self::User`]; the builtin-entry slice auto-registers
/// [`Self::Builtin`] entries with identical execution semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CliToolSource {
    #[default]
    User,
    Builtin,
}

/// Baseline-tracking marker (ADR-0109 Decision 2, serde reservation):
/// `Some(Following)` = the builtin entry matches the shipped definition and
/// upgrades silently on app update; `Some(Edited)` = the user's edits win and
/// the app never overwrites them. `None` on user entries (no baseline
/// exists). The tracking mechanics land in #676; the persisted shape is
/// reserved here so that slice is additive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliBaselineState {
    Following,
    Edited,
}

/// One user-registered CLI tool (ADR-0108 Decision 2). All values are
/// non-secret by construction: the config read-time secret-name scan refuses
/// a secret-named env key exactly as it does for MCP server env.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliToolConfig {
    /// Kebab-case, <= [`NAME_MAX_LEN`], unique in the registry, and not
    /// colliding with the reserved names (see [`validate`]). The tool-table
    /// name the model calls, and the anchor the approval trust key carries.
    pub name: String,
    /// Required, LLM-visible (rides the tool definition's description).
    pub description: String,
    /// PATH-resolved name or absolute path. Registration never blocks on it
    /// resolving (probe semantics, ADR-0108 Decision 2): a missing
    /// executable surfaces as a structured tool error at call time, the
    /// entry stays, and it re-arms once the executable resolves again.
    pub executable: String,
    /// The placeholder argv array between the executable and the varargs
    /// tail. Whole-element `{param}` placeholders substitute; other elements
    /// pass verbatim. `#[serde(default)]` so a hand-edit that drops it gets
    /// an executable-only invocation (valid: a tool may take only varargs).
    #[serde(default)]
    pub argv_template: Vec<String>,
    /// The parameter table (see [`CliToolParam`]). `#[serde(default)]` for
    /// the same honest-degrade reason.
    #[serde(default)]
    pub params: Vec<CliToolParam>,
    /// NON-SECRET literal env values, merged over the inherited environment
    /// at spawn (registration values override same-name inherited values).
    /// `BTreeMap` for deterministic serialization (the `McpServerConfig.env`
    /// precedent).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Machine-level persistent enablement (ADR-0106 single axis): enabled =
    /// direct-listed into every turn's tool surface; disabled = dormant (no
    /// table entry, no spawn). Disabled is absolute.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// ADR-0109 serde reservation (see [`CliToolSource`]).
    #[serde(default)]
    pub source: CliToolSource,
    /// ADR-0109 serde reservation (see [`CliBaselineState`]). Omitted on the
    /// wire for user entries so their JSON is unchanged by the reservation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<CliBaselineState>,
}

fn default_enabled() -> bool {
    true
}

impl CliToolConfig {
    /// Validate the entry against the registration invariants (ADR-0108
    /// Decision 2): name shape + reserved-name collisions, required
    /// description, template/parameter-table consistency, and the varargs
    /// single-instance rule. Returns the first violation as a user-facing
    /// English detail (the command layer folds it into its error variant).
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("name must not be empty".to_string());
        }
        if self.name.len() > NAME_MAX_LEN {
            return Err(format!(
                "name exceeds {NAME_MAX_LEN} characters: {}",
                self.name
            ));
        }
        let kebab = !self.name.starts_with('-')
            && !self.name.ends_with('-')
            && !self.name.contains("--")
            && self
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !kebab {
            return Err(format!(
                "name must be kebab-case (lowercase letters, digits, single hyphens): {}",
                self.name
            ));
        }
        if is_reserved_name(&self.name) {
            return Err(format!(
                "name `{}` collides with a reserved tool name (built-in tool, \
                 `mcp__` handle prefix, or meta tool)",
                self.name
            ));
        }
        if self.description.trim().is_empty() {
            return Err("description must not be empty".to_string());
        }
        if self.executable.trim().is_empty() {
            return Err("executable must not be empty".to_string());
        }
        // Env values are non-secret by construction (the `McpServerConfig.env`
        // posture, ADR-0029): refuse here exactly what the read-time
        // secret-name scan would reject the entire config file for -- a
        // secret-named key written through registration would degrade every
        // setting to defaults on the next load.
        for key in self.env.keys() {
            if crate::app_config::io::is_secret_name(key) {
                return Err(format!(
                    "env key `{key}` looks secret-named; store secrets \
                     outside the registration (the config file refuses \
                     secret-named keys)"
                ));
            }
        }
        // Parameter names must be distinct, non-empty identifiers; they are
        // JSON object keys in the tool schema and placeholder keys in the
        // template, so the kebab rule is not required -- only uniqueness and
        // non-emptiness (the schema, not the convention, is the contract).
        let mut seen = std::collections::HashSet::new();
        for p in &self.params {
            if p.name.is_empty() {
                return Err("parameter names must not be empty".to_string());
            }
            if !seen.insert(p.name.as_str()) {
                return Err(format!("duplicate parameter name: {}", p.name));
            }
        }
        // At most one varargs parameter (ADR-0108 Decision 4): append order
        // across two varargs blocks would be ambiguous.
        if self.params.iter().filter(|p| p.varargs).count() > 1 {
            return Err("at most one parameter may be the string[] varargs".to_string());
        }
        // At most one stdin parameter (issue #672, ADR-0108 Decision 4): the
        // channel is a single pipe -- two writers would interleave.
        if self
            .params
            .iter()
            .filter(|p| p.delivery == CliParamDelivery::Stdin)
            .count()
            > 1
        {
            return Err("at most one parameter may use stdin delivery".to_string());
        }
        // The varargs block is an argv-tail construct (issue #672): file /
        // stdin delivery for it has no meaning, so registration refuses the
        // combination outright.
        if let Some(p) = self
            .params
            .iter()
            .find(|p| p.varargs && p.delivery != CliParamDelivery::Argv)
        {
            return Err(format!(
                "the string[] parameter `{}` must use argv delivery (its \
                 values append at the argv tail)",
                p.name
            ));
        }
        // Two file-channel parameters whose names fold to the same sanitized
        // temp-path segment would share one temp file: the second write
        // silently overwrites the first (sanitize_segment is not injective --
        // `input.1` and `input_1` both fold to `input_1`). Refuse at
        // registration; the render-side degrade twin catches hand edits.
        let mut file_segments = std::collections::HashMap::new();
        for p in self
            .params
            .iter()
            .filter(|p| p.delivery == CliParamDelivery::File)
        {
            if let Some(first) = file_segments.insert(sanitize_segment(&p.name), p.name.as_str()) {
                return Err(format!(
                    "file-delivery parameters `{first}` and `{}` fold to the \
                     same temp-file name; rename one",
                    p.name
                ));
            }
        }
        // Template/param-table consistency: every placeholder must name a
        // declared parameter (catches registration-time typos), a varargs
        // parameter must NOT appear in the template (it rides the tail), a
        // stdin parameter must NOT appear either (its value rides the pipe),
        // and every other parameter must appear at least once (an
        // unreferenced argv parameter could never receive its value; a
        // repeated placeholder renders its value twice, which is the
        // registration's own doing, not a hazard).
        let param = |name: &str| self.params.iter().find(|p| p.name == name);
        for element in &self.argv_template {
            if let Some(name) = element
                .strip_prefix('{')
                .and_then(|rest| rest.strip_suffix('}'))
            {
                match param(name) {
                    None => {
                        return Err(format!(
                            "argv template placeholder `{element}` names no declared parameter"
                        ));
                    }
                    Some(p) if p.varargs => {
                        return Err(format!(
                            "varargs parameter `{name}` must not appear in the argv \
                             template; its values append at the argv tail"
                        ));
                    }
                    Some(p) if p.delivery == CliParamDelivery::Stdin => {
                        return Err(format!(
                            "stdin parameter `{name}` must not appear in the argv \
                             template; its value is written to the child's stdin"
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        for p in &self.params {
            if !p.varargs
                && p.delivery != CliParamDelivery::Stdin
                && !self
                    .argv_template
                    .iter()
                    .any(|e| e == &placeholder(&p.name))
            {
                return Err(format!(
                    "parameter `{}` is declared but the argv template never \
                     references it",
                    p.name
                ));
            }
        }
        Ok(())
    }
}

/// The reserved-name check (ADR-0108 Decision 2): a registration name may
/// not collide with a built-in DuckDB tool name, the `mcp__` namespaced
/// handle prefix, or a meta-tool name. Checks the live tables (not literal
/// copies) so a future built-in / meta tool extends the reservation for
/// free. The builtin-CLI-entry-name class (ADR-0109 Decision 7) joins here
/// when those entries exist (#675). Also the read-side filter's authority:
/// `enabled_cli_tools` drops a reserved-named entry a hand-edited file
/// smuggled past the upsert boundary.
pub(crate) fn is_reserved_name(name: &str) -> bool {
    name.starts_with("mcp__")
        || crate::tools::definitions::builtin_metadata(name).is_some()
        || name == crate::mcp::meta_tools::META_LIST_SERVERS
        || name == crate::mcp::meta_tools::META_SEARCH_TOOLS
        || name == crate::mcp::meta_tools::META_INVOKE
}

/// The registry (the app-config carrier, ADR-0109 Decision 9). Default is
/// empty -- the app ships with nothing registered (ADR-0108 Decision 1);
/// the legal empty set is the default state, not a malformed gap.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CliToolRegistry {
    /// The entries in the order the user added them (the settings UI renders
    /// this order; upsert preserves it).
    #[serde(default)]
    pub tools: Vec<CliToolConfig>,
}

impl CliToolRegistry {
    /// Enforce the registry invariant: unique names. A hand-edited file with
    /// duplicate names keeps the FIRST occurrence and drops the rest
    /// (the `McpServerRegistry::normalize` honest-degrade precedent). Called
    /// by [`crate::app_config::AppConfig::normalize`] on every write.
    pub fn normalize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.tools.retain(|t| seen.insert(t.name.clone()));
    }

    /// Look up an entry by name.
    pub fn get(&self, name: &str) -> Option<&CliToolConfig> {
        self.tools.iter().find(|t| t.name == name)
    }

    /// Validate + upsert one entry: replace the existing entry with the same
    /// name or append. Returns the finalized entry (validation runs first, so
    /// an invalid entry never touches the registry).
    pub fn upsert(&mut self, tool: CliToolConfig) -> Result<CliToolConfig, String> {
        tool.validate()?;
        match self.tools.iter_mut().find(|t| t.name == tool.name) {
            Some(slot) => *slot = tool.clone(),
            None => self.tools.push(tool.clone()),
        }
        Ok(tool)
    }

    /// Remove one entry by name. `true` when an entry was removed. v1 has
    /// only user entries (all removable); the builtin-entry undeletable rule
    /// (ADR-0109 Decision 2) is #676's slice, enforced where the source
    /// dichotomy exists.
    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.tools.len();
        self.tools.retain(|t| t.name != name);
        before != self.tools.len()
    }
}

/// One `file`-channel value's destination: the parameter it carries, the
/// value's bytes, and the deterministic temp path they are written to at
/// execution -- the same path the approval card shows (issue #672,
/// ADR-0108 Decision 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedFileValue {
    pub param: String,
    pub content: String,
    pub path: PathBuf,
}

/// A fully rendered call (ADR-0108 Decision 4): the argv after the
/// executable, the single stdin parameter's value, and the file-channel
/// values' planned temp files. Pure -- writing the files is the executor's
/// job, so the approval summary and the execution render the same argv from
/// the same inputs.
#[derive(Debug, Default)]
pub struct RenderedCall {
    pub argv: Vec<String>,
    pub stdin: Option<String>,
    pub files: Vec<RenderedFileValue>,
}

/// Render one call against its registration (ADR-0108 Decision 3/4):
/// substitute whole-element `{param}` placeholders per the parameter's
/// declared delivery -- argv values inline, file values as deterministic
/// temp paths under `temp_dir` (issue #672) -- pass other elements verbatim,
/// append the varargs block at the tail, and collect the stdin parameter's
/// value out of band. `call_id` keys the temp-file names: the approval card
/// (rendered pre-gate) and the execution (post-gate) share one (tool, param,
/// call) triple, so the approver signs exactly the path the child receives.
/// Returns a structured error naming the first problem (missing parameter,
/// non-string value, or a delivery/template shape a hand-edited config broke
/// -- the call-time degrade path).
pub fn render_call(
    tool: &CliToolConfig,
    input: &Value,
    temp_dir: &Path,
    call_id: &str,
) -> Result<RenderedCall, String> {
    let value = |name: &str| -> Result<String, String> {
        match input.get(name) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(other) => Err(format!("parameter `{name}` must be a string, got: {other}")),
            None => Err(format!(
                "missing required parameter `{name}` for tool `{}`",
                tool.name
            )),
        }
    };
    let mut rendered = RenderedCall {
        argv: Vec::with_capacity(tool.argv_template.len()),
        stdin: None,
        files: Vec::new(),
    };
    for element in &tool.argv_template {
        if let Some(name) = element
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
        {
            let param = tool
                .params
                .iter()
                .find(|p| p.name == name)
                // Validation guarantees template placeholders name declared
                // params; a hand-edited config that broke it degrades here.
                .ok_or_else(|| {
                    format!("argv template placeholder `{element}` names no declared parameter")
                })?;
            match param.delivery {
                CliParamDelivery::Argv => rendered.argv.push(value(name)?),
                CliParamDelivery::File => {
                    let content = value(name)?;
                    let path = file_value_path(temp_dir, &tool.name, name, call_id);
                    rendered.argv.push(path.display().to_string());
                    rendered.files.push(RenderedFileValue {
                        param: name.to_string(),
                        content,
                        path,
                    });
                }
                // Validation refuses a stdin parameter in the template (its
                // value rides the pipe, not the command line); a hand-edited
                // config that broke it degrades here.
                CliParamDelivery::Stdin => {
                    return Err(format!(
                        "stdin parameter `{name}` must not appear in the argv \
                         template; its value is written to the child's stdin"
                    ));
                }
            }
        } else {
            rendered.argv.push(element.clone());
        }
    }
    // Validation refuses two file parameters that fold to the same sanitized
    // segment; a hand-edited config that broke it degrades here rather than
    // letting the second temp write silently overwrite the first value.
    let mut file_paths = std::collections::HashMap::new();
    for file in &rendered.files {
        if let Some(first) = file_paths.insert(file.path.as_path(), file.param.as_str()) {
            return Err(format!(
                "file-delivery parameters `{first}` and `{}` render the same \
                 temp file; rename one",
                file.param
            ));
        }
    }
    if let Some(varargs) = tool.params.iter().find(|p| p.varargs) {
        // Validation pins the varargs block to argv delivery (the tail is a
        // command-line construct); a hand-edited config degrades here.
        if varargs.delivery != CliParamDelivery::Argv {
            return Err(format!(
                "the string[] parameter `{}` must use argv delivery",
                varargs.name
            ));
        }
        match input.get(&varargs.name) {
            Some(Value::Array(items)) => {
                for item in items {
                    match item {
                        Value::String(s) => rendered.argv.push(s.clone()),
                        other => {
                            return Err(format!(
                                "varargs parameter `{}` must be an array of \
                                 strings, found element: {other}",
                                varargs.name
                            ));
                        }
                    }
                }
            }
            Some(other) => {
                return Err(format!(
                    "varargs parameter `{}` must be an array of strings, got: {other}",
                    varargs.name
                ));
            }
            None => {
                return Err(format!(
                    "missing required parameter `{}` for tool `{}`",
                    varargs.name, tool.name
                ));
            }
        }
    }
    // The stdin parameter rides the pipe, not the command line. Validation
    // caps it at one; a hand-edited config with two degrades here instead of
    // interleaving two writers into one pipe.
    let mut stdin_params = tool
        .params
        .iter()
        .filter(|p| p.delivery == CliParamDelivery::Stdin);
    if let (Some(first), Some(second)) = (stdin_params.next(), stdin_params.next()) {
        return Err(format!(
            "at most one parameter may use stdin delivery (found `{}` and `{}`)",
            first.name, second.name
        ));
    }
    if let Some(p) = tool
        .params
        .iter()
        .find(|p| p.delivery == CliParamDelivery::Stdin)
    {
        rendered.stdin = Some(value(&p.name)?);
    }
    // Validation requires every argv/file parameter to appear in the
    // template; a hand-edited config can still smuggle an unreferenced one
    // past the upsert boundary, and the loop above cannot notice (it only
    // walks the template). Refuse here rather than silently dropping the
    // value -- the same honest-degrade posture as the checks above.
    for p in &tool.params {
        if !p.varargs
            && p.delivery != CliParamDelivery::Stdin
            && !tool
                .argv_template
                .iter()
                .any(|e| e == &placeholder(&p.name))
        {
            return Err(format!(
                "parameter `{}` is declared but the argv template never \
                 references it",
                p.name
            ));
        }
    }
    Ok(rendered)
}

/// Deterministic path for one file-channel value:
/// `cli-<tool>-<param>-<call>.tmp` under the session temp dir. The same
/// (tool, param, call) triple renders the same path on the approval card and
/// at execution, so a denied call leaves nothing behind (the file is only
/// ever written when the call dispatches).
fn file_value_path(temp_dir: &Path, tool: &str, param: &str, call_id: &str) -> PathBuf {
    temp_dir.join(format!(
        "cli-{}-{}-{}.tmp",
        sanitize_segment(tool),
        sanitize_segment(param),
        sanitize_segment(call_id)
    ))
}

/// Keep one path segment filesystem-safe AND bounded: the call id is
/// model-emitted (untrusted) and a hand-edited param name escapes
/// validation's charset/length guarantees, so anything outside
/// `[A-Za-z0-9_-]` folds to `_` (which also neutralizes `.`/`..` traversal
/// forms), an empty segment stays a literal placeholder rather than
/// vanishing from the name, and the segment truncates to
/// [`SEGMENT_MAX_LEN`] so a long id cannot push the temp path past the
/// platform path limit (calls run sequentially within a turn, so two long
/// ids sharing a 40-char prefix cannot collide concurrently).
const SEGMENT_MAX_LEN: usize = 40;

fn sanitize_segment(segment: &str) -> String {
    let sanitized: String = segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(SEGMENT_MAX_LEN)
        .collect();
    if sanitized.is_empty() {
        "_".to_string()
    } else {
        sanitized
    }
}

/// Build the direct-listed tool-table definitions (ADR-0108 Decision 6):
/// one `ToolDefinition` per entry, named by the registration name, described
/// by the registration description, with a JSON Schema derived from the
/// parameter table (string, or `string[]` array for the varargs parameter;
/// every parameter required -- a call is complete or the executor refuses
/// it with the parameter's name).
pub fn tool_definitions(tools: &[CliToolConfig]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|tool| {
            let properties = tool
                .params
                .iter()
                .map(|p| {
                    let schema = if p.varargs {
                        json!({
                            "type": "array",
                            "items": { "type": "string" },
                            "description": p.description,
                        })
                    } else {
                        json!({ "type": "string", "description": p.description })
                    };
                    (p.name.clone(), schema)
                })
                .collect::<serde_json::Map<_, _>>();
            let required = tool
                .params
                .iter()
                .map(|p| Value::String(p.name.clone()))
                .collect::<Vec<_>>();
            ToolDefinition {
                name: tool.name.clone(),
                description: tool.description.clone(),
                input_schema: json!({
                    "type": "object",
                    "properties": properties,
                    "required": required,
                }),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn param(name: &str) -> CliToolParam {
        CliToolParam {
            name: name.to_string(),
            description: format!("{name} value"),
            delivery: CliParamDelivery::Argv,
            varargs: false,
        }
    }

    fn varargs(name: &str) -> CliToolParam {
        CliToolParam {
            name: name.to_string(),
            description: format!("{name} values"),
            delivery: CliParamDelivery::Argv,
            varargs: true,
        }
    }

    fn tool(name: &str) -> CliToolConfig {
        CliToolConfig {
            name: name.to_string(),
            description: "does a thing".to_string(),
            executable: "/bin/tool".to_string(),
            argv_template: vec!["convert".to_string(), placeholder("input")],
            params: vec![param("input")],
            env: BTreeMap::new(),
            enabled: true,
            source: CliToolSource::User,
            baseline: None,
        }
    }

    // --- name validation ----------------------------------------------------

    #[test]
    fn validate_accepts_kebab_case_names() {
        assert!(tool("pandoc").validate().is_ok());
        assert!(tool("pdf-to-text").validate().is_ok());
        assert!(tool("tool2").validate().is_ok());
    }

    #[test]
    fn validate_rejects_non_kebab_names() {
        for bad in ["Pandoc", "pdf_to_text", "-lead", "trail-", "dou--ble", ""] {
            let mut t = tool("pandoc");
            t.name = bad.to_string();
            assert!(t.validate().is_err(), "name `{bad}` must be rejected");
        }
    }

    #[test]
    fn validate_rejects_over_long_names() {
        let mut t = tool("pandoc");
        t.name = "a".repeat(NAME_MAX_LEN + 1);
        assert!(t.validate().is_err());
        t.name = "a".repeat(NAME_MAX_LEN);
        assert!(t.validate().is_ok());
    }

    #[test]
    fn validate_rejects_reserved_names() {
        for reserved in ["explore", "materialize", "mcp__srv__tool", "mcp_invoke"] {
            let mut t = tool("pandoc");
            t.name = reserved.to_string();
            assert!(t.validate().is_err(), "`{reserved}` must be reserved");
        }
    }

    #[test]
    fn validate_requires_description_and_executable() {
        let mut t = tool("pandoc");
        t.description = "  ".to_string();
        assert!(t.validate().is_err());
        let mut t = tool("pandoc");
        t.executable = String::new();
        assert!(t.validate().is_err());
    }

    #[test]
    fn validate_refuses_a_secret_named_env_key() {
        // The registration-time twin of the config read-time scan: a
        // secret-named key accepted here would take the whole file down to
        // defaults on the next load.
        let mut t = tool("pandoc");
        t.env
            .insert("MY_API_KEY".to_string(), "sk-test".to_string());
        let err = t.validate().unwrap_err();
        assert!(
            err.contains("MY_API_KEY"),
            "the refusal names the key: {err}"
        );
        // A benign key passes: the refusal is shape-based, not a blanket ban.
        let mut t = tool("pandoc");
        t.env
            .insert("PANDOC_MODE".to_string(), "strict".to_string());
        assert!(t.validate().is_ok());
    }

    #[test]
    fn validate_rejects_unknown_and_varargs_placeholders() {
        let mut t = tool("pandoc");
        t.argv_template = vec!["{nope}".to_string()];
        assert!(
            t.validate().is_err(),
            "unknown placeholder must be rejected"
        );

        let mut t = tool("pandoc");
        t.argv_template = vec!["convert".to_string(), "{rest}".to_string()];
        t.params = vec![param("unused"), varargs("rest")];
        assert!(
            t.validate().is_err(),
            "varargs in the template must be rejected"
        );
    }

    #[test]
    fn validate_rejects_second_varargs_and_unreferenced_param() {
        let mut t = tool("pandoc");
        t.params = vec![param("input"), varargs("a"), varargs("b")];
        t.argv_template = vec![placeholder("input")];
        assert!(
            t.validate().is_err(),
            "two varargs parameters must be rejected"
        );

        let mut t = tool("pandoc");
        t.params = vec![param("input"), param("orphan")];
        t.argv_template = vec![placeholder("input")];
        assert!(
            t.validate().is_err(),
            "an unreferenced argv parameter must be rejected"
        );
    }

    #[test]
    fn validate_allows_executable_only_invocation() {
        // A tool may take only varargs (whole-binary wrapper registration,
        // ADR-0108 Decision 4): empty template + one varargs parameter.
        let mut t = tool("pandoc");
        t.argv_template = Vec::new();
        t.params = vec![varargs("args")];
        assert!(t.validate().is_ok());
    }

    // --- serde ---------------------------------------------------------------

    #[test]
    fn partial_entry_fills_defaults() {
        let raw = json!({
            "name": "pandoc",
            "description": "convert documents",
            "executable": "pandoc"
        });
        let entry: CliToolConfig = serde_json::from_value(raw).unwrap();
        assert!(entry.argv_template.is_empty());
        assert!(entry.params.is_empty());
        assert!(entry.env.is_empty());
        assert!(entry.enabled, "enabled defaults true (ADR-0106 Decision 4)");
        assert_eq!(entry.source, CliToolSource::User);
        assert_eq!(entry.baseline, None);
    }

    #[test]
    fn user_entry_round_trips_with_explicit_source_and_no_baseline() {
        let json = serde_json::to_value(tool("pandoc")).unwrap();
        assert_eq!(json["source"], "user", "source always serializes");
        assert!(
            json.get("baseline").is_none(),
            "baseline is skipped when None"
        );
        let back: CliToolConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, tool("pandoc"));
    }

    #[test]
    fn builtin_reservation_round_trips() {
        let mut t = tool("pandoc");
        t.source = CliToolSource::Builtin;
        t.baseline = Some(CliBaselineState::Edited);
        let back: CliToolConfig =
            serde_json::from_value(serde_json::to_value(t.clone()).unwrap()).unwrap();
        assert_eq!(back, t);
    }

    // --- registry ------------------------------------------------------------

    #[test]
    fn registry_upsert_validates_replaces_and_appends() {
        let mut reg = CliToolRegistry::default();
        reg.upsert(tool("pandoc")).unwrap();
        let mut edited = tool("pandoc");
        edited.description = "v2".to_string();
        reg.upsert(edited.clone()).unwrap();
        assert_eq!(reg.tools.len(), 1, "same-name upsert replaces in place");
        assert_eq!(reg.get("pandoc"), Some(&edited));

        let mut invalid = tool("UPPER");
        invalid.name = "UPPER".to_string();
        assert!(reg.upsert(invalid).is_err(), "invalid entry never lands");
        assert_eq!(reg.tools.len(), 1);
    }

    #[test]
    fn registry_normalize_dedupes_by_name_keeping_first() {
        let mut reg = CliToolRegistry::default();
        reg.tools.push(tool("pandoc"));
        let mut second = tool("pandoc");
        second.description = "duplicate".to_string();
        reg.tools.push(second);
        reg.normalize();
        assert_eq!(reg.tools.len(), 1);
        assert_eq!(reg.tools[0].description, "does a thing");
    }

    #[test]
    fn registry_remove_reports_whether_an_entry_was_removed() {
        let mut reg = CliToolRegistry::default();
        reg.upsert(tool("pandoc")).unwrap();
        assert!(reg.remove("pandoc"));
        assert!(!reg.remove("pandoc"));
    }

    // --- argv rendering --------------------------------------------------------

    #[test]
    fn render_call_substitutes_placeholders_and_verbatim_elements() {
        let mut t = tool("pandoc");
        t.argv_template = vec![
            "convert".to_string(),
            placeholder("input"),
            "-o".to_string(),
            placeholder("output"),
        ];
        t.params = vec![param("input"), param("output")];
        let input = json!({"input": "in.docx", "output": "out.pdf"});
        let rendered = render_call(&t, &input, Path::new("/tmp"), "tu_1").unwrap();
        assert_eq!(rendered.argv, vec!["convert", "in.docx", "-o", "out.pdf"]);
        assert!(rendered.stdin.is_none());
        assert!(rendered.files.is_empty());
    }

    #[test]
    fn render_call_appends_varargs_at_the_tail() {
        let mut t = tool("officecli");
        t.argv_template = vec![placeholder("verb")];
        t.params = vec![param("verb"), varargs("args")];
        let input = json!({"verb": "run", "args": ["--verbose", "a.docx", "b.docx"]});
        let rendered = render_call(&t, &input, Path::new("/tmp"), "tu_1").unwrap();
        assert_eq!(rendered.argv, vec!["run", "--verbose", "a.docx", "b.docx"]);
    }

    #[test]
    fn render_call_routes_file_values_through_deterministic_temp_paths() {
        // The argv element is the temp path (not the value); the files plan
        // carries the same path so the executor writes to what the approval
        // card showed.
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("code")];
        t.params = vec![param("code")];
        t.params[0].delivery = CliParamDelivery::File;
        let dir = Path::new("/session/tmp");
        let rendered = render_call(&t, &json!({"code": "print(1)"}), dir, "tu_9").unwrap();
        assert_eq!(rendered.files.len(), 1);
        assert_eq!(rendered.files[0].param, "code");
        assert_eq!(rendered.files[0].content, "print(1)");
        let path = rendered.files[0].path.display().to_string();
        assert_eq!(rendered.argv, vec![path.as_str()]);
        assert!(
            path.replace('\\', "/")
                .ends_with("/cli-code-runner-code-tu_9.tmp"),
            "the path names tool, param, and call: {path}"
        );
        assert!(rendered.stdin.is_none());
    }

    #[test]
    fn render_call_temp_paths_are_stable_and_call_scoped() {
        // Same (tool, param, call) -> same path (approval card and execution
        // agree); a different call -> a different path (no cross-call reuse).
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("code")];
        t.params = vec![param("code")];
        t.params[0].delivery = CliParamDelivery::File;
        let input = json!({"code": "x"});
        let first = render_call(&t, &input, Path::new("/tmp"), "tu_1").unwrap();
        let again = render_call(&t, &input, Path::new("/tmp"), "tu_1").unwrap();
        let second = render_call(&t, &input, Path::new("/tmp"), "tu_2").unwrap();
        assert_eq!(first.files[0].path, again.files[0].path);
        assert_ne!(first.files[0].path, second.files[0].path);
    }

    #[test]
    fn render_call_routes_the_stdin_parameter_out_of_band() {
        let mut t = tool("stdin-tool");
        t.argv_template = vec!["run".to_string()];
        t.params = vec![param("payload")];
        t.params[0].delivery = CliParamDelivery::Stdin;
        let rendered =
            render_call(&t, &json!({"payload": "body"}), Path::new("/tmp"), "tu_1").unwrap();
        assert_eq!(rendered.argv, vec!["run"]);
        assert_eq!(rendered.stdin.as_deref(), Some("body"));
        assert!(rendered.files.is_empty());
    }

    #[test]
    fn render_call_sanitizes_untrusted_path_segments() {
        // The call id is model-emitted; a hand-edited param name can carry
        // anything. Neither may escape the temp dir nor blow the path limit.
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("code")];
        t.params[0].delivery = CliParamDelivery::File;
        t.params[0].name = "../esc\\ape".to_string();
        t.argv_template = vec![placeholder("../esc\\ape")];
        let rendered =
            render_call(&t, &json!({"../esc\\ape": "x"}), Path::new("/tmp"), "a/b").unwrap();
        let name = rendered.files[0]
            .path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(
            name, "cli-code-runner-___esc_ape-a_b.tmp",
            "every unsafe char folds to `_`: {name}"
        );

        // An unbounded model-emitted call id truncates per segment, keeping
        // the full path inside the platform limits.
        let long_id = "tu_".to_string() + &"x".repeat(200);
        let rendered = render_call(
            &t,
            &json!({"../esc\\ape": "x"}),
            Path::new("/tmp"),
            &long_id,
        )
        .unwrap();
        assert!(
            rendered.files[0]
                .path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .len()
                < 100,
            "long segments truncate: {:?}",
            rendered.files[0].path
        );
    }

    #[test]
    fn render_call_errors_on_missing_non_string_and_broken_shapes() {
        let t = tool("pandoc");
        assert!(
            render_call(&t, &json!({}), Path::new("/tmp"), "tu_1").is_err(),
            "missing parameter errors"
        );
        assert!(
            render_call(&t, &json!({"input": 42}), Path::new("/tmp"), "tu_1").is_err(),
            "non-string value errors"
        );

        // Hand-edited degrade paths: a stdin parameter smuggled into the
        // template, and two stdin parameters past the single-pipe cap.
        let mut t = tool("pandoc");
        t.argv_template = vec!["run".to_string(), placeholder("payload")];
        t.params = vec![param("payload")];
        t.params[0].delivery = CliParamDelivery::Stdin;
        let err = render_call(&t, &json!({"payload": "x"}), Path::new("/tmp"), "tu_1").unwrap_err();
        assert!(
            err.contains("must not appear in the argv template"),
            "{err}"
        );

        let mut t = tool("stdin-tool");
        t.argv_template = vec!["run".to_string()];
        t.params = vec![param("a"), param("b")];
        t.params[0].delivery = CliParamDelivery::Stdin;
        t.params[1].delivery = CliParamDelivery::Stdin;
        let err =
            render_call(&t, &json!({"a": "x", "b": "y"}), Path::new("/tmp"), "tu_1").unwrap_err();
        assert!(err.contains("at most one"), "{err}");

        // A hand-edited file parameter the template never references: the
        // value is refused, not silently dropped (the read-side filter does
        // not re-run full validation, so this shape can reach render).
        let mut t = tool("code-runner");
        t.argv_template = vec!["run".to_string()];
        t.params = vec![param("code")];
        t.params[0].delivery = CliParamDelivery::File;
        let err = render_call(&t, &json!({"code": "x"}), Path::new("/tmp"), "tu_1").unwrap_err();
        assert!(
            err.contains("never references it"),
            "an unreferenced parameter degrades honestly: {err}"
        );
    }

    #[test]
    fn render_call_errors_when_file_params_fold_to_the_same_temp_file() {
        // The render-side degrade twin of validate's collision refusal: a
        // hand-edited config smuggled past the upsert boundary must refuse,
        // not let the second temp write overwrite the first value.
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("input.1"), placeholder("input_1")];
        t.params = vec![param("input.1"), param("input_1")];
        t.params[0].delivery = CliParamDelivery::File;
        t.params[1].delivery = CliParamDelivery::File;
        let err = render_call(
            &t,
            &json!({"input.1": "a", "input_1": "b"}),
            Path::new("/tmp"),
            "tu_1",
        )
        .unwrap_err();
        assert!(
            err.contains("render the same temp file"),
            "the degrade names both parameters: {err}"
        );
    }

    // --- delivery validation ---------------------------------------------------

    #[test]
    fn validate_accepts_file_and_stdin_delivery_shapes() {
        // file stays in the template (the placeholder receives the temp
        // path); stdin stays out of it (the value rides the pipe).
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("code")];
        t.params = vec![param("code")];
        t.params[0].delivery = CliParamDelivery::File;
        assert!(t.validate().is_ok());

        let mut t = tool("stdin-tool");
        t.argv_template = vec!["run".to_string()];
        t.params[0].delivery = CliParamDelivery::Stdin;
        assert!(t.validate().is_ok());
    }

    #[test]
    fn validate_rejects_a_second_stdin_parameter() {
        let mut t = tool("stdin-tool");
        t.argv_template = vec!["run".to_string()];
        t.params = vec![param("a"), param("b")];
        t.params[0].delivery = CliParamDelivery::Stdin;
        t.params[1].delivery = CliParamDelivery::Stdin;
        let err = t.validate().unwrap_err();
        assert!(err.contains("at most one parameter may use stdin"), "{err}");
    }

    #[test]
    fn validate_rejects_stdin_parameter_in_the_argv_template() {
        let mut t = tool("stdin-tool");
        t.argv_template = vec![placeholder("payload")];
        t.params = vec![param("payload")];
        t.params[0].delivery = CliParamDelivery::Stdin;
        let err = t.validate().unwrap_err();
        assert!(
            err.contains("must not appear in the argv template"),
            "{err}"
        );
    }

    #[test]
    fn validate_rejects_non_argv_varargs_delivery() {
        for delivery in [CliParamDelivery::File, CliParamDelivery::Stdin] {
            let mut t = tool("officecli");
            t.argv_template = vec![placeholder("verb")];
            t.params = vec![param("verb"), varargs("args")];
            t.params[1].delivery = delivery;
            let err = t.validate().unwrap_err();
            assert!(
                err.contains("must use argv delivery"),
                "{delivery:?}: {err}"
            );
        }
    }

    #[test]
    fn validate_rejects_file_params_that_fold_to_the_same_temp_segment() {
        // `input.1` and `input_1` sanitize to the same segment: both file
        // channels would target one temp file, the second write silently
        // overwriting the first -- refuse at registration.
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("input.1"), placeholder("input_1")];
        t.params = vec![param("input.1"), param("input_1")];
        t.params[0].delivery = CliParamDelivery::File;
        t.params[1].delivery = CliParamDelivery::File;
        let err = t.validate().unwrap_err();
        assert!(
            err.contains("fold to the same temp-file name"),
            "the refusal names the collision: {err}"
        );

        // Distinct sanitized segments pass (argv delivery ignores the fold).
        let mut t = tool("code-runner");
        t.argv_template = vec![placeholder("input"), placeholder("config")];
        t.params = vec![param("input"), param("config")];
        t.params[0].delivery = CliParamDelivery::File;
        t.params[1].delivery = CliParamDelivery::File;
        assert!(t.validate().is_ok());
    }

    // --- tool definitions ------------------------------------------------------

    #[test]
    fn tool_definitions_build_the_schema_from_the_param_table() {
        let mut t = tool("officecli");
        t.argv_template = vec![placeholder("verb")];
        t.params = vec![param("verb"), varargs("args")];
        let defs = tool_definitions(&[t]);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "officecli");
        assert_eq!(defs[0].description, "does a thing");
        let schema = &defs[0].input_schema;
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["properties"]["verb"]["type"], "string");
        assert_eq!(schema["properties"]["args"]["type"], "array");
        assert_eq!(schema["properties"]["args"]["items"]["type"], "string");
        assert_eq!(
            schema["required"],
            json!(["verb", "args"]),
            "every parameter is required"
        );
    }
}
