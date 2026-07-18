//! Protocol-agnostic reply parsing (ADR-0009): the model is instructed to emit
//! exactly one JSON object carrying the one-SQL / one-text contract, regardless
//! of wire protocol. This module owns that parsing -- the HTTP envelope (request
//! shape, auth, response container) differs per adapter (anthropic / openai),
//! but the text contract the model emits is shared. Each adapter extracts the
//! model's text block its own way, then hands it here.
//!
//! Extracted from the anthropic adapter (issue #152, ADR-0064) so the openai
//! adapter reuses the identical parse path -- "复用 parse_reply" -- without the
//! two adapters drifting on what counts as a contract violation. The anthropic
//! adapter's behavior is unchanged: the same text in yields the same
//! [`ProviderReply`] (or [`ProviderError::Unavailable`]) out.

use crate::model::{ChartKind, TextKind, VizSpec};
use crate::provider::{ProviderError, ProviderReply};

/// Parse the model's reply text into [`ProviderReply`] (ADR-0009 contract). The
/// model is instructed to emit exactly one JSON object; this defensively
/// tolerates surrounding prose / markdown fences by extracting the outermost
/// `{...}` span first. Any deviation -> [`ProviderError::Unavailable`] (the
/// orchestrator retries, then fails the turn honestly).
pub fn parse_reply(text: &str) -> Result<ProviderReply, ProviderError> {
    let json_str = extract_json_object(text).ok_or_else(|| {
        ProviderError::Unavailable(format!(
            "LLM response is not a JSON object: {}",
            truncate(text)
        ))
    })?;
    let val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| ProviderError::Unavailable(format!("JSON parse failed: {e}")))?;
    let kind = val
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ProviderError::Unavailable("LLM response missing type field".into()))?;
    match kind {
        "sql" => {
            let sql = val.get("sql").and_then(|v| v.as_str()).ok_or_else(|| {
                ProviderError::Unavailable("sql response missing sql field".into())
            })?;
            let viz = parse_viz(val.get("viz"))?;
            let assumption = val
                .get("assumption")
                .and_then(|v| v.as_str())
                .map(String::from);
            Ok(ProviderReply::Sql {
                sql: sql.to_string(),
                viz,
                assumption,
            })
        }
        "text" => {
            let body = val.get("body").and_then(|v| v.as_str()).ok_or_else(|| {
                ProviderError::Unavailable("text response missing body field".into())
            })?;
            let kind_str = val.get("kind").and_then(|v| v.as_str()).ok_or_else(|| {
                ProviderError::Unavailable("text response missing kind field".into())
            })?;
            let text_kind = match kind_str {
                "clarify" => TextKind::Clarify,
                "refuse" => TextKind::Refuse,
                other => {
                    return Err(ProviderError::Unavailable(format!(
                        "unknown text kind: {other}"
                    )));
                }
            };
            let assumption = val
                .get("assumption")
                .and_then(|v| v.as_str())
                .map(String::from);
            Ok(ProviderReply::Text {
                kind: text_kind,
                body: body.to_string(),
                assumption,
            })
        }
        other => Err(ProviderError::Unavailable(format!(
            "unknown response type: {other}"
        ))),
    }
}

/// Parse the optional viz field (`{"kind":..., "spec":...}`) into [`VizSpec`].
/// A non-whitelisted kind is a contract violation (retried), matching the
/// engine-side whitelist enforcement (ADR-0016/0033).
fn parse_viz(v: Option<&serde_json::Value>) -> Result<Option<VizSpec>, ProviderError> {
    let Some(v) = v else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let kind_str = v
        .get("kind")
        .and_then(|x| x.as_str())
        .ok_or_else(|| ProviderError::Unavailable("viz missing kind field".into()))?;
    let kind = match kind_str {
        "bar" => ChartKind::Bar,
        "line" => ChartKind::Line,
        "scatter" => ChartKind::Scatter,
        "area" => ChartKind::Area,
        "pie" => ChartKind::Pie,
        "table" => ChartKind::Table,
        other => {
            return Err(ProviderError::Unavailable(format!(
                "unknown chart kind: {other}"
            )));
        }
    };
    let spec = v
        .get("spec")
        .and_then(|x| x.as_str())
        .ok_or_else(|| ProviderError::Unavailable("viz missing spec field".into()))?;
    Ok(Some(VizSpec {
        kind,
        spec: spec.to_string(),
    }))
}

/// Extract the outermost `{...}` span from `text`, tolerating markdown fences
/// or surrounding prose. Returns the inclusive substring, or `None` when no
/// brace pair is present.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end >= start {
        Some(&text[start..=end])
    } else {
        None
    }
}

/// Truncate a string for an error message (avoid flooding the user / log with a
/// long malformed model reply). Floors to a UTF-8 char boundary: a naive
/// `&s[..LIMIT]` panics when the cut lands mid-character, and model replies (and
/// the errors built from them) are routinely CJK -- so this path, of all paths,
/// must not panic on multi-byte text. (`rust-version = 1.77` predates the
/// stable `floor_char_boundary`, so the floor is manual.)
fn truncate(s: &str) -> String {
    const LIMIT: usize = 200;
    if s.len() <= LIMIT {
        return s.to_string();
    }
    let mut end = LIMIT;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_object_handles_prose_and_fences() {
        assert_eq!(extract_json_object(r#"{"a":1}"#), Some(r#"{"a":1}"#));
        assert_eq!(
            extract_json_object("prefix ```json\n{\"a\":1}\n``` suffix"),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(extract_json_object("no braces here"), None);
    }

    #[test]
    fn truncate_floors_to_char_boundary_for_cjk_replies() {
        // 120 CJK chars = 360 bytes; byte 200 (the LIMIT) lands mid-character.
        // A naive `&s[..200]` would panic on the char boundary; truncate floors.
        let reply = "中".repeat(120);
        let out = truncate(&reply);
        assert!(
            out.ends_with('…'),
            "truncated output should end with ellipsis"
        );
        // The head must hold only whole '中' chars -- the floor dropped no halves.
        let head: String = out.chars().filter(|&c| c != '…').collect();
        assert!(head.chars().all(|c| c == '中'));
        assert!(head.chars().count() < 120);

        // Short input passes through verbatim (no ellipsis added).
        assert_eq!(truncate("短回复"), "短回复");
        assert_eq!(truncate(""), "");
    }

    #[test]
    fn parse_reply_sql_round_trip() {
        let reply = parse_reply(r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#)
            .expect("sql reply");
        match reply {
            ProviderReply::Sql {
                sql,
                viz,
                assumption,
            } => {
                assert_eq!(sql, "SELECT 1");
                assert!(viz.is_none());
                assert!(assumption.is_none());
            }
            other => panic!("expected Sql, got {other:?}"),
        }
    }

    #[test]
    fn parse_reply_text_round_trip() {
        let reply = parse_reply(
            r#"{"type":"text","kind":"clarify","body":"按哪个维度？","assumption":null}"#,
        )
        .expect("text reply");
        match reply {
            ProviderReply::Text {
                kind,
                body,
                assumption,
            } => {
                assert_eq!(kind, TextKind::Clarify);
                assert_eq!(body, "按哪个维度？");
                assert!(assumption.is_none());
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn parse_reply_rejects_non_json() {
        assert!(matches!(
            parse_reply("这不是 JSON"),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn parse_reply_rejects_unknown_type() {
        assert!(matches!(
            parse_reply(r#"{"type":"prediction","sql":"--"}"#),
            Err(ProviderError::Unavailable(_))
        ));
    }
}
