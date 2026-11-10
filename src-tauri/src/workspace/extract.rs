//! The workspace memory extraction engine's pure core (issue #1530,
//! ADR-0147 Decision 7): the frozen prompt contract, the guard rails, the
//! model-chain resolution, and the reply parser. No IO, no threads -- the
//! scheduler in [`super::extract_runtime`] owns those halves.
//!
//! The prompt rendering here is a FROZEN TEMPLATE (issue #1530's fixture
//! clause): any wording change is a spec change, pinned by the verbatim
//! golden-output tests at the bottom of this file.

use crate::app_config::AppConfig;
use crate::model::ProviderProfile;
use crate::provider::prompt::ResponseLocale;
use crate::workspace::memory::MemoryType;

/// The reply length cap for the extraction call: a mechanical task with a
/// bounded JSON payload (a handful of entries). Generous on purpose -- a
/// "remember this" turn with several facts must not truncate mid-array.
pub(crate) const EXTRACTION_MAX_TOKENS: u32 = 2048;

/// How much of the turn's response text rides the extraction input. The
/// durable facts live mostly in the user message; the response excerpt only
/// confirms what landed. Clamped at char boundaries by the caller-side
/// render (the same injection-distrust posture as the memory index).
const RESPONSE_EXCERPT_MAX_CHARS: usize = 4000;

/// The extraction system prompt (FROZEN -- verbatim fixture, issue #1530).
/// `{language}` is the only slot; every per-turn variable rides the user
/// message so the frozen half stays maximally stable.
const EXTRACTION_SYSTEM_PROMPT: &str = "你是工作区记忆提取器。任务：从刚完成的一轮对话中识别值得跨会话保留的持久事实，供未来会话自动注入上下文。\n\n只提取持久事实，四类：\n- user：用户的身份、能力背景、稳定偏好\n- feedback：用户对协作方式的纠正与要求\n- project：本工作区的项目约定、背景、约束\n- reference：稳定的参考信息（常用路径、外部资源、术语）\n\n不提取：本轮数据细节、一次性问答内容、临时状态、可从对话轻易重得的推导。\n\n规则（按优先级）：\n1. 用户明确要求记住的内容（如「记住…」「以后都…」）必须提取。\n2. 与既有记忆语义重复的不输出（查重以既有标题列表为准）。\n3. 记忆正文使用{language}撰写。\n4. name 是简短标题（30字以内）；description 是一行钩子（60字以内）；body 是事实正文。\n\n输出协议：只输出一个 JSON 数组作为完整回复，不输出任何其他文本、注释或代码围栏。无可提取内容时输出 []。每条格式：\n{\"name\":\"标题\",\"description\":\"一行钩子\",\"type\":\"user|feedback|project|reference\",\"body\":\"事实正文\"}";

/// Render the frozen system prompt with the locale's language directive
/// (ADR-0147: the memory language follows the user locale).
pub(crate) fn render_extraction_system_prompt(locale: ResponseLocale) -> String {
    let language = match locale {
        ResponseLocale::ZhCN => "中文",
        ResponseLocale::EnUS => "English",
    };
    EXTRACTION_SYSTEM_PROMPT.replace("{language}", language)
}

/// Render the extraction user message: the dedup basis (existing titles),
/// the turn's user message, and a clamped response excerpt. Every per-turn
/// variable lives here -- the frozen half is the system prompt above.
pub(crate) fn render_extraction_user_message(
    question: &str,
    response: &str,
    existing_titles: &[String],
) -> String {
    let mut out = String::from("【既有记忆标题】\n");
    if existing_titles.is_empty() {
        out.push_str("（无）\n");
    } else {
        for title in existing_titles {
            out.push_str(&format!("- {title}\n"));
        }
    }
    out.push_str("\n【本轮用户消息】\n");
    out.push_str(question.trim());
    out.push_str("\n\n【本轮回复摘要】\n");
    let excerpt = clamp_chars(response.trim(), RESPONSE_EXCERPT_MAX_CHARS);
    out.push_str(&excerpt);
    out
}

/// Char-boundary clamp: never split a CJK glyph (the memory.rs clamp
/// posture). Appends an ellipsis only when a clamp actually happened.
fn clamp_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let clamped: String = text.chars().take(max_chars).collect();
    format!("{clamped}…")
}

/// The minimum independent-user-block size (issue #1530 guard): a turn
/// whose user message carries under 3 non-whitespace characters ("好",
/// "继续") has no independent user content worth extracting. CJK counts
/// per character -- the rule guards against fragment turns, not against
/// Chinese (a 3-char Chinese sentence easily carries a fact).
pub(crate) fn has_independent_user_block(question: &str) -> bool {
    question.chars().filter(|c| !c.is_whitespace()).count() >= 3
}

/// Tool names whose in-turn invocation already writes memory (issue #1530
/// guard): a turn that performed one of these skips extraction -- the write
/// already happened deliberately, a second pass would duplicate it. v1's
/// built-in table advertises none of these; the list is the reserved
/// surface so the guard exists before the future write tool does.
pub(crate) const MEMORY_WRITE_TOOL_NAMES: &[&str] = &["memory_write"];

pub(crate) fn has_memory_write_segment(turn_tool_names: &[String]) -> bool {
    turn_tool_names
        .iter()
        .any(|name| MEMORY_WRITE_TOOL_NAMES.contains(&name.as_str()))
}

/// ADR-0147 Decision 7's model chain: the extraction pointer names a pool
/// profile; when unset (or dangling between normalizes -- matching
/// normalize's null repair) the ACTIVE profile carries the chain. `None`
/// only when neither resolves: the silent-skip posture (write path off,
/// read path unaffected).
pub(crate) fn resolve_extraction_profile(cfg: &AppConfig) -> Option<&ProviderProfile> {
    if let Some(pointer) = &cfg.memory_extraction_profile {
        if let Some(named) = cfg.provider.profiles.iter().find(|p| &p.id == pointer) {
            return Some(named);
        }
    }
    cfg.provider.active()
}

/// One parsed extraction entry (the reply protocol's JSON shape).
#[derive(Debug, PartialEq, serde::Deserialize)]
pub(crate) struct ExtractedMemory {
    pub name: String,
    pub description: String,
    pub r#type: String,
    #[serde(default)]
    pub body: String,
}

impl ExtractedMemory {
    /// The controlled enum projection: an entry whose type is not one of
    /// the four categories is a model malfunction, dropped rather than
    /// mis-filed (stricter than the hand-written file's tolerant parse --
    /// the model had the enum in its prompt).
    pub(crate) fn memory_type(&self) -> Option<MemoryType> {
        match self.r#type.as_str() {
            "user" => Some(MemoryType::User),
            "feedback" => Some(MemoryType::Feedback),
            "project" => Some(MemoryType::Project),
            "reference" => Some(MemoryType::Reference),
            _ => None,
        }
    }

    fn is_well_formed(&self) -> bool {
        !self.name.trim().is_empty() && !self.description.trim().is_empty()
    }
}

/// Parse the model's reply: a JSON array of entries. Tolerant by design --
/// extraction must never turn a malformed reply into user-visible failure:
/// a fenced reply is unwrapped first, and anything still unparsable reads
/// as "no new facts". Per-entry failures drop that entry only.
pub(crate) fn parse_extraction_reply(text: &str) -> Vec<ExtractedMemory> {
    let Some(payload) = json_array_payload(text) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<ExtractedMemory>>(&payload) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| entry.is_well_formed() && entry.memory_type().is_some())
        .collect()
}

/// Extract the JSON array payload: strip a markdown code fence when
/// present, then take the outermost `[`..`]` span. `None` when no array
/// span exists at all.
fn json_array_payload(text: &str) -> Option<String> {
    let unfenced = text.trim().trim_matches('`');
    let start = unfenced.find('[')?;
    let end = unfenced.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(unfenced[start..=end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ProfileId, ProviderConfig};

    /// The frozen system prompt's zh rendering (verbatim fixture, issue
    /// #1530): every wording change is a spec change -- this test is the
    /// tripwire.
    #[test]
    fn zh_system_prompt_is_the_frozen_template() {
        let prompt = render_extraction_system_prompt(ResponseLocale::ZhCN);
        let expected = "你是工作区记忆提取器。任务：从刚完成的一轮对话中识别值得跨会话保留的持久事实，供未来会话自动注入上下文。\n\n只提取持久事实，四类：\n- user：用户的身份、能力背景、稳定偏好\n- feedback：用户对协作方式的纠正与要求\n- project：本工作区的项目约定、背景、约束\n- reference：稳定的参考信息（常用路径、外部资源、术语）\n\n不提取：本轮数据细节、一次性问答内容、临时状态、可从对话轻易重得的推导。\n\n规则（按优先级）：\n1. 用户明确要求记住的内容（如「记住…」「以后都…」）必须提取。\n2. 与既有记忆语义重复的不输出（查重以既有标题列表为准）。\n3. 记忆正文使用中文撰写。\n4. name 是简短标题（30字以内）；description 是一行钩子（60字以内）；body 是事实正文。\n\n输出协议：只输出一个 JSON 数组作为完整回复，不输出任何其他文本、注释或代码围栏。无可提取内容时输出 []。每条格式：\n{\"name\":\"标题\",\"description\":\"一行钩子\",\"type\":\"user|feedback|project|reference\",\"body\":\"事实正文\"}";
        assert_eq!(prompt, expected);
    }

    /// The en rendering swaps exactly the language slot (the only slot).
    #[test]
    fn en_system_prompt_swaps_only_the_language_slot() {
        let prompt = render_extraction_system_prompt(ResponseLocale::EnUS);
        assert!(prompt.contains("记忆正文使用English撰写。"));
        assert!(!prompt.contains("{language}"), "no slot may leak");
    }

    /// The user message's frozen assembly (verbatim fixture): the dedup
    /// basis, the question, and the response excerpt in that order.
    #[test]
    fn user_message_assembles_the_frozen_shape() {
        let msg = render_extraction_user_message(
            "记住用中文回复",
            "好的，以后都用中文。",
            &["偏好中文回复".to_string(), "季度数据用中文列名".to_string()],
        );
        let expected = "【既有记忆标题】\n- 偏好中文回复\n- 季度数据用中文列名\n\n【本轮用户消息】\n记住用中文回复\n\n【本轮回复摘要】\n好的，以后都用中文。";
        assert_eq!(msg, expected);
        // The empty-titles arm renders the explicit (无) marker.
        let bare = render_extraction_user_message("q", "r", &[]);
        assert!(bare.contains("【既有记忆标题】\n（无）\n"), "{bare}");
    }

    /// The response excerpt clamps at a char boundary (never mid-CJK-glyph)
    /// and marks the clamp.
    #[test]
    fn response_excerpt_clamps_on_a_char_boundary() {
        let long = "数".repeat(RESPONSE_EXCERPT_MAX_CHARS + 10);
        let msg = render_extraction_user_message("q", &long, &[]);
        let excerpt = msg
            .split("【本轮回复摘要】\n")
            .nth(1)
            .expect("excerpt tail");
        assert!(excerpt.ends_with('…'));
        assert_eq!(
            excerpt.chars().count(),
            RESPONSE_EXCERPT_MAX_CHARS + 1,
            "clamped body + the ellipsis marker"
        );
    }

    /// Guard 1: the independent-user-block minimum. Fragment turns ("好",
    /// "继续", whitespace) skip; a 3-char CJK message carries.
    #[test]
    fn fragment_user_blocks_fail_the_independence_guard() {
        assert!(!has_independent_user_block("好"));
        assert!(!has_independent_user_block(" 继 续 "));
        assert!(!has_independent_user_block(""));
        assert!(has_independent_user_block("记住这偏好"));
        assert!(has_independent_user_block("remember this"));
    }

    /// Guard 2: a turn that already invoked a memory-write tool skips. v1's
    /// built-in table never carries one -- the reserved-name check is the
    /// pin that the guard fires the moment the tool exists.
    #[test]
    fn a_memory_write_tool_segment_trips_the_guard() {
        assert!(has_memory_write_segment(&["memory_write".to_string()]));
        assert!(!has_memory_write_segment(&[
            "explore".to_string(),
            "sql".to_string()
        ]));
        assert!(!has_memory_write_segment(&[]));
    }

    /// The model chain (ADR-0147 Decision 7): pointer wins, unset falls
    /// back to active, dangling falls back to active (normalize's repair
    /// posture), and an empty pool resolves None (the silent skip).
    #[test]
    fn the_chain_resolves_pointer_fallback_active_then_none() {
        let mut cfg = AppConfig::defaults();
        assert_eq!(resolve_extraction_profile(&cfg), None, "empty pool skips");
        let cheap = ProviderProfile {
            id: ProfileId("cheap".into()),
            display_name: "Cheap".into(),
            protocol: crate::model::Protocol::Anthropic,
            base_url: "https://cheap.test".into(),
            model: "haiku".into(),
        };
        cfg.provider = ProviderConfig {
            active_profile: Some(ProfileId("main".into())),
            profiles: vec![
                ProviderProfile {
                    id: ProfileId("main".into()),
                    display_name: "Main".into(),
                    protocol: crate::model::Protocol::Anthropic,
                    base_url: "https://main.test".into(),
                    model: "sonnet".into(),
                },
                cheap,
            ],
        };
        assert_eq!(
            resolve_extraction_profile(&cfg).map(|p| p.id.as_str()),
            Some("main"),
            "unset pointer falls back to the active profile"
        );
        cfg.memory_extraction_profile = Some(ProfileId("cheap".into()));
        assert_eq!(
            resolve_extraction_profile(&cfg).map(|p| p.id.as_str()),
            Some("cheap"),
            "a set pointer wins"
        );
        cfg.memory_extraction_profile = Some(ProfileId("ghost".into()));
        assert_eq!(
            resolve_extraction_profile(&cfg).map(|p| p.id.as_str()),
            Some("main"),
            "a dangling pointer falls back to active (pre-normalize hand-edit)"
        );
        cfg.provider.active_profile = None;
        assert_eq!(
            resolve_extraction_profile(&cfg),
            None,
            "no pointer and no active resolves None"
        );
    }

    /// The reply parser's tolerance ladder: plain array, fenced array,
    /// prose-wrapped array all parse; garbage and empty array read as no
    /// new facts; malformed entries drop individually.
    #[test]
    fn the_reply_parser_is_tolerant_per_entry() {
        let plain = r#"[{"name":"偏好中文","description":"回复用中文","type":"feedback","body":"用户要求中文回复"}]"#;
        assert_eq!(parse_extraction_reply(plain).len(), 1);
        let fenced = format!("```json\n{plain}\n```");
        assert_eq!(parse_extraction_reply(&fenced).len(), 1, "fence unwrapped");
        let chatty = format!("以下是提取结果：\n{plain}\n以上。");
        assert_eq!(parse_extraction_reply(&chatty).len(), 1, "prose tolerated");
        assert!(parse_extraction_reply("[]").is_empty());
        assert!(parse_extraction_reply("Nothing to save.").is_empty());
        assert!(parse_extraction_reply("").is_empty());
        // A bad type drops the entry; a blank name drops it; the healthy
        // sibling survives.
        let mixed = r#"[
            {"name":"好条目","description":"钩子","type":"user","body":"正文"},
            {"name":"坏类型","description":"钩子","type":"vibe","body":"正文"},
            {"name":"  ","description":"钩子","type":"user","body":"正文"}
        ]"#;
        let parsed = parse_extraction_reply(mixed);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "好条目");
        assert_eq!(parsed[0].memory_type(), Some(MemoryType::User));
    }
}
