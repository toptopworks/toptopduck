//! Scripted provider stand-in (ADR-0007): maps a question verbatim to a preset
//! reply, so the turn orchestrator is testable offline, deterministically, with
//! no network and no real LLM. This is the v1 shared test base -- every later
//! query-loop slice tests against a scripted fake rather than the real client.

use std::collections::HashMap;

use super::{Provider, ProviderError, ProviderReply, ProviderRequest};

/// A provider that returns preset replies keyed by the exact question text.
/// An unscripted question yields NotWired -- the fake never invents SQL,
/// preserving "the orchestrator only ever runs provider-supplied SQL" for every
/// test (no hidden default that could mask a wiring bug).
pub struct FakeProvider {
    scripts: HashMap<String, ProviderReply>,
}

impl Default for FakeProvider {
    /// An empty script map -- every question is refused. Tests build it up with
    /// FakeProvider::scripted.
    fn default() -> Self {
        Self {
            scripts: HashMap::new(),
        }
    }
}

impl FakeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a preset reply for a question. Builder-style so a test reads
    /// top-to-bottom: FakeProvider::new().scripted("count rows", reply(...)).
    pub fn scripted(mut self, question: &str, reply: ProviderReply) -> Self {
        self.scripts.insert(question.to_string(), reply);
        self
    }
}

impl Provider for FakeProvider {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
        self.scripts
            .get(request.question.as_str())
            .cloned()
            .ok_or(ProviderError::NotWired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ColumnSchema;
    use crate::provider::DatasetRef;

    fn request(question: &str) -> ProviderRequest {
        ProviderRequest {
            question: question.to_string(),
            datasets: vec![DatasetRef {
                reference_name: "people".into(),
                sql_ref: r#""people".data"#.into(),
                columns: vec![ColumnSchema {
                    name: "id".into(),
                    canonical_type: "BIGINT".into(),
                }],
                row_count: 5,
            }],
            active: Some("people".into()),
        }
    }

    fn reply(sql: &str) -> ProviderReply {
        ProviderReply {
            sql: sql.to_string(),
            viz: None,
            assumption: None,
        }
    }

    #[test]
    fn scripted_question_returns_its_reply() {
        let provider = FakeProvider::new().scripted("how many rows", reply("SELECT COUNT(*) AS n"));
        let got = provider
            .generate(&request("how many rows"))
            .expect("scripted");
        assert_eq!(got.sql, "SELECT COUNT(*) AS n");
    }

    #[test]
    fn carries_viz_and_assumption_through_verbatim() {
        // The full ADR-0009 contract shape round-trips through the fake, so a
        // later slice test can script a viz/assumption without changing types.
        let provider = FakeProvider::new().scripted(
            "plot it",
            ProviderReply {
                sql: "SELECT 1".into(),
                viz: Some("vega-lite-spec".into()),
                assumption: Some("treated id as a key".into()),
            },
        );
        let got = provider.generate(&request("plot it")).expect("scripted");
        assert_eq!(got.viz.as_deref(), Some("vega-lite-spec"));
        assert_eq!(got.assumption.as_deref(), Some("treated id as a key"));
    }

    #[test]
    fn unscripted_question_is_refused_not_invented() {
        // The fake never invents SQL: a question without a script is refused,
        // so a test cannot accidentally pass against a hidden default.
        let provider = FakeProvider::new().scripted("a", reply("SELECT 1"));
        assert_eq!(
            provider.generate(&request("b")).unwrap_err(),
            ProviderError::NotWired
        );
    }
}
