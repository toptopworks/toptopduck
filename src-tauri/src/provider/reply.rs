//! Protocol-agnostic reply parsing (ADR-0009): the model is instructed to emit
//! exactly one JSON object carrying the one-SQL / one-text contract, regardless
//! of wire protocol. This module owns that parsing -- the HTTP envelope (request
//! shape, auth, response container) differs per adapter (anthropic / openai),
//! but the text contract the model emits is shared. Each adapter extracts the
//! model's text block its own way, then hands it here.

use crate::model::{ChartKind, TextKind, VizSpec};
use crate::provider::{ProviderError, ProviderReply};

/// Parse the model's reply text into [`ProviderReply`] (ADR-0009 contract). The
/// model is instructed to emit exactly one JSON object; this defensively
/// tolerates surrounding prose / markdown fences and, for reasoning-style
/// models, a leading `{"reasoning": ...}` object, by scanning for the first
/// balanced `{...}` object that carries the `type` field. Any deviation ->
/// [`ProviderError::Unavailable`] (the orchestrator retries, then fails the
/// turn honestly).
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

/// Find the byte index of the `}` that closes the `{` at `start`, honoring
/// string literals (braces inside strings do not affect depth) and `\` escapes
/// (so `\"` does not end a string). Byte-level scan: safe because `{`, `}`,
/// `"`, and `\` are all ASCII (single-byte, on a char boundary); every other
/// byte -- including UTF-8 continuation bytes -- is structurally inert and is
/// skipped without splitting a character. Returns `None` when braces are
/// unbalanced at end-of-input.
fn find_balanced_object_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escape {
                escape = false;
            } else {
                match b {
                    b'\\' => escape = true,
                    b'"' => in_string = false,
                    _ => {}
                }
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
                if depth < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

/// Extract the first balanced `{...}` object in `text` that parses as JSON and
/// carries the ADR-0009 `type` field. Reasoning-style models (DeepSeek-R1,
/// GLM-r, o1-compatible) often emit a leading `{"reasoning": "..."}` object
/// plus prose before the real answer; the old find-`{` / rfind-`}` outermost
/// span crossed both objects + the prose and failed to parse, so ADR-0028's
/// retry kept firing on a recurrent malformed payload. We instead scan each
/// balanced object and skip any candidate without `type`. Returns the
/// inclusive substring, or `None` when no typed object is present.
fn extract_json_object(text: &str) -> Option<&str> {
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find('{') {
        let start = cursor + rel;
        let end = find_balanced_object_end(text, start)?;
        let candidate = &text[start..=end];
        let typed = serde_json::from_str::<serde_json::Value>(candidate)
            .is_ok_and(|v| v.get("type").is_some());
        if typed {
            return Some(candidate);
        }
        cursor = end + 1;
    }
    None
}

/// Truncate a string for an error message (avoid flooding the user / log with a
/// long malformed model reply or upstream HTTP body). Floors to a UTF-8 char
/// boundary: a naive `&s[..LIMIT]` panics when the cut lands mid-character, and
/// model replies / gateway error bodies (and the errors built from them) are
/// routinely CJK -- so this path, of all paths, must not panic on multi-byte
/// text. (`rust-version = 1.77` predates the stable `floor_char_boundary`, so
/// the floor is manual.) Shared across the adapters so both the reply-text path
/// and the HTTP-error-body path stay panic-free from one source.
pub(crate) fn truncate(s: &str) -> String {
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

    /// Test-only raw scanner: the first balanced `{...}` object in `text`
    /// with no `type` filtering. Exercises [`find_balanced_object_end`] in
    /// isolation so fence / prose / in-string-brace coverage is not entangled
    /// with the type-filtering policy of [`extract_json_object`].
    fn find_first_balanced_object(text: &str) -> Option<&str> {
        let start = text.find('{')?;
        let end = find_balanced_object_end(text, start)?;
        Some(&text[start..=end])
    }

    #[test]
    fn find_first_balanced_object_handles_prose_and_fences() {
        // Single balanced object -- the happy path. Migrated from the old
        // extract_json_object assertion: that function now filters by the
        // ADR-0009 `type` field, so raw-scanner coverage of fence / prose /
        // single-JSON inputs lives on the bottom helper.
        assert_eq!(find_first_balanced_object(r#"{"a":1}"#), Some(r#"{"a":1}"#));
        assert_eq!(
            find_first_balanced_object("prefix ```json\n{\"a\":1}\n``` suffix"),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(find_first_balanced_object("no braces here"), None);
    }

    #[test]
    fn find_first_balanced_object_skips_braces_inside_string_literals() {
        // Braces inside a JSON string do not affect depth, so a `}`
        // mid-string does not prematurely close the object.
        assert_eq!(
            find_first_balanced_object(r#"{"sql":"SELECT *} FROM t","type":"sql"}"#),
            Some(r#"{"sql":"SELECT *} FROM t","type":"sql"}"#)
        );
        // An escaped quote does not end the string context -- the brace
        // after it still counts as in-string.
        assert_eq!(
            find_first_balanced_object(r#"{"a":"x\"}y"}"#),
            Some(r#"{"a":"x\"}y"}"#)
        );
    }

    #[test]
    fn extract_json_object_returns_first_typed_object() {
        // Single object carrying the ADR-0009 `type` field -- the happy path.
        assert_eq!(
            extract_json_object(r#"{"type":"sql","sql":"SELECT 1"}"#),
            Some(r#"{"type":"sql","sql":"SELECT 1"}"#)
        );
    }

    #[test]
    fn extract_json_object_skips_reasoning_object_for_typed_answer() {
        // Reasoning-style models (DeepSeek-R1, GLM-r, o1-compatible) emit a
        // leading `{"reasoning": ...}` object plus prose before the real
        // answer. The old find-`{` / rfind-`}` outermost span crossed both
        // objects + prose and failed to parse; we now skip the untyped
        // candidate and return the typed answer (issue #158).
        let text = concat!(
            r#"{"reasoning":"thinking..."}"#,
            "\n",
            "答案：",
            r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#
        );
        assert_eq!(
            extract_json_object(text),
            Some(r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#)
        );
    }

    #[test]
    fn extract_json_object_returns_none_when_no_object_carries_type() {
        // No balanced object carries `type` -> None (parse_reply surfaces
        // Unavailable, which ADR-0028 retries then fails honestly).
        assert_eq!(extract_json_object(r#"{"reasoning":"..."}"#), None);
        assert_eq!(extract_json_object(r#"{"a":1} prose {"b":2}"#), None);
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
