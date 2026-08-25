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
/// per-parameter, declared at registration). v1 implements [`Self::Argv]
/// only; `file` / `stdin` land in #672 -- the field exists so the persisted
/// shape needs no migration when they do. A call against an unimplemented
/// mode fails as a structured tool error at call time (honest degrade for a
/// hand-edited config), never by silently falling back to another mode.
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
        // Template/param-table consistency: every placeholder must name a
        // declared parameter (catches registration-time typos), a varargs
        // parameter must NOT appear in the template (it rides the tail), and
        // every non-varargs parameter must appear exactly once (an
        // unreferenced argv parameter could never receive its value).
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
                    Some(_) => {}
                }
            }
        }
        for p in &self.params {
            if !p.varargs
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

/// Render the call's argv (ADR-0108 Decision 3/4): substitute whole-element
/// `{param}` placeholders with the call's string values, pass other elements
/// verbatim, then append the varargs block at the tail. Returns the argv
/// AFTER the executable (the caller prepends it), or a structured error
/// naming the first problem (missing parameter, non-string value, or an
/// unimplemented delivery mode) -- the call-time degrade path for a
/// hand-edited config.
pub fn render_argv(tool: &CliToolConfig, input: &Value) -> Result<Vec<String>, String> {
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
    let mut argv = Vec::with_capacity(tool.argv_template.len());
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
                CliParamDelivery::Argv => argv.push(value(name)?),
                CliParamDelivery::File | CliParamDelivery::Stdin => {
                    return Err(format!(
                        "delivery mode `{}` for parameter `{name}` is not yet \
                         supported (ADR-0108 Decision 4 lands it in a later slice)",
                        match param.delivery {
                            CliParamDelivery::File => "file",
                            _ => "stdin",
                        }
                    ));
                }
            }
        } else {
            argv.push(element.clone());
        }
    }
    if let Some(varargs) = tool.params.iter().find(|p| p.varargs) {
        match input.get(&varargs.name) {
            Some(Value::Array(items)) => {
                for item in items {
                    match item {
                        Value::String(s) => argv.push(s.clone()),
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
    Ok(argv)
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
    fn render_argv_substitutes_placeholders_and_verbatim_elements() {
        let mut t = tool("pandoc");
        t.argv_template = vec![
            "convert".to_string(),
            placeholder("input"),
            "-o".to_string(),
            placeholder("output"),
        ];
        t.params = vec![param("input"), param("output")];
        let input = json!({"input": "in.docx", "output": "out.pdf"});
        assert_eq!(
            render_argv(&t, &input).unwrap(),
            vec!["convert", "in.docx", "-o", "out.pdf"]
        );
    }

    #[test]
    fn render_argv_appends_varargs_at_the_tail() {
        let mut t = tool("officecli");
        t.argv_template = vec![placeholder("verb")];
        t.params = vec![param("verb"), varargs("args")];
        let input = json!({"verb": "run", "args": ["--verbose", "a.docx", "b.docx"]});
        assert_eq!(
            render_argv(&t, &input).unwrap(),
            vec!["run", "--verbose", "a.docx", "b.docx"]
        );
    }

    #[test]
    fn render_argv_errors_on_missing_non_string_and_unimplemented_delivery() {
        let t = tool("pandoc");
        assert!(
            render_argv(&t, &json!({})).is_err(),
            "missing parameter errors"
        );
        assert!(
            render_argv(&t, &json!({"input": 42})).is_err(),
            "non-string value errors"
        );

        let mut t = tool("pandoc");
        t.params[0].delivery = CliParamDelivery::File;
        assert!(
            render_argv(&t, &json!({"input": "x"})).is_err(),
            "unimplemented delivery mode errors honestly"
        );
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
