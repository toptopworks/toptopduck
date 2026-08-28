//! Builtin skills (issue #677, ADR-0109 Decisions 5/6): the app-authored
//! companion skills that ride the app version, one per builtin CLI
//! registration entry (same name, 1:1).
//!
//! The shipped definition set is a compile-time constant mirroring
//! [`crate::cli_tools::builtin::BUILTIN_DEFINITIONS`]: each entry names its
//! CLI tool through the declarative frontmatter key
//! `metadata.toptopduck_cli_tools` (issue #674) and carries a per-locale
//! (en-US / zh-CN) description + body. The prose is app-curated -- a skill
//! body enters the system prompt, so it is a trust boundary: a third-party
//! `SKILL.md` is never auto-absorbed (the manual import flow stays the only
//! path for those; ADR-0109 Decision 5).
//!
//! Materialization rides the CLI scan window (issue #677): when the matching
//! CLI entry is `Builtin`-sourced and the skill file is missing, the skill is
//! written into the registry under the CURRENT locale and recorded in the
//! app-config side table `builtin_skill_baselines` (`name -> {hash, locale}`).
//! The baseline judgment is pure derivation -- `edited` iff the current
//! file's hash differs from the recorded hash -- so the edit path writes
//! NOTHING to the side table; an unedited skill whose recorded hash left the
//! shipped hash set upgrades silently at the recorded locale, and the
//! explicit restore rewrites at the current locale. A locale switch never
//! rewrites an already-materialized file.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_config::{AppConfig, LocalePreference};

use super::frontmatter;
use super::model::{Acquired, SkillError};
use super::registry;

/// One locale's shipped prose: the spec `description` + the Markdown body
/// (the prompt fragment).
pub(crate) struct BuiltinSkillBody {
    pub description: &'static str,
    pub body: &'static str,
}

/// One shipped builtin skill definition. `name` equals the companion CLI
/// registration's name (the two namespaces are disjoint by construction --
/// a skill name and a CLI name coincide only through these pairs).
pub(crate) struct BuiltinSkillDefinition {
    pub name: &'static str,
    /// locale tag -> prose. Ordered en-US first (the fallback arm of
    /// [`body_for`] takes the first entry, so the ordering is load-bearing).
    pub locales: &'static [(&'static str, BuiltinSkillBody)],
}

impl BuiltinSkillDefinition {
    /// The prose for a locale tag: exact match, else the en-US fallback.
    pub(crate) fn body_for(&self, locale: &str) -> &'static BuiltinSkillBody {
        self.locales
            .iter()
            .find(|(tag, _)| *tag == locale)
            .map(|(_, body)| body)
            .unwrap_or(&self.locales[0].1)
    }

    /// The rendered SKILL.md bytes for a locale: the spec frontmatter
    /// (`name` + `description`) + the declarative CLI reference + the body.
    /// Deterministic by construction (the mapping is built in a fixed order
    /// and serde_yaml preserves insertion order), so hashing the output is
    /// the baseline anchor.
    pub(crate) fn render(&self, locale: &str) -> Result<String, SkillError> {
        let prose = self.body_for(locale);
        let mut fm = serde_yaml::Mapping::new();
        fm.insert(
            serde_yaml::Value::String("name".into()),
            serde_yaml::Value::String(self.name.into()),
        );
        fm.insert(
            serde_yaml::Value::String("description".into()),
            serde_yaml::Value::String(prose.description.into()),
        );
        frontmatter::set_cli_tools(&mut fm, &[self.name.to_string()]);
        frontmatter::render_skill_md(&fm, prose.body)
    }

    /// The hash set of every locale's rendered form -- the current shipped
    /// baseline set. A recorded hash inside this set means "agrees with some
    /// shipped body"; outside it means the app version moved the baseline
    /// (upgrade material).
    pub(crate) fn shipped_hashes(&self) -> Vec<String> {
        self.locales
            .iter()
            .filter_map(|(tag, _)| self.render(tag).ok())
            .map(|content| crate::util::sha256_hex(content.as_bytes()))
            .collect()
    }
}

/// The v1 companion set, 1:1 with the builtin CLI definitions (pandoc,
/// python, office-cli). Additive evolution mirrors the CLI set: new entries
/// pass the same curation screen.
pub(crate) static BUILTIN_SKILL_DEFINITIONS: &[BuiltinSkillDefinition] = &[
    BuiltinSkillDefinition {
        name: "pandoc",
        locales: &[
            (
                "en-US",
                BuiltinSkillBody {
                    description: "Convert existing documents between formats with the local \
                                  pandoc — render Markdown to DOCX/HTML/PDF for delivery, or \
                                  read DOCX/EPUB into Markdown for analysis. Authoring or \
                                  manipulating Office-file content (tables, templates, \
                                  reports) belongs to office-cli.",
                    body: "Use the `pandoc` tool whenever a task needs a document converted \
between formats -- rendering Markdown as DOCX/HTML/PDF for delivery, or reading a \
DOCX/EPUB source into Markdown for analysis.\n\
\n\
Call `pandoc` with `input` (path to the source document) and `output` (path to write \
the converted document to); the extension of each path selects the format. Pandoc's \
own options are NOT part of the tool's parameter table -- when a conversion needs \
flags (e.g. a template or a standalone flag), say so in the reply instead of \
improvising arguments.\n",
                },
            ),
            (
                "zh-CN",
                BuiltinSkillBody {
                    description: "用本机 pandoc 在格式之间转换既有文档——把 Markdown 渲染为 \
                                  DOCX/HTML/PDF 交付，或把 DOCX/EPUB 整篇读成 Markdown 分析。\
                                  撰写或操作 Office 文件内容（表格、模板、报告）属于 \
                                  office-cli。",
                    body: "任务需要在文档格式之间转换时使用 `pandoc` 工具——把 Markdown 渲染成 \
DOCX/HTML/PDF 交付，或把 DOCX/EPUB 源读成 Markdown 分析。\n\
\n\
调用 `pandoc` 时给出 `input`（源文档路径）与 `output`（转换后写入的路径），两个路径的\
扩展名决定格式。pandoc 自身的选项不在该工具的参数表内——转换需要额外标志（如模板或 \
standalone）时，在回复中说明，而不是自行拼凑参数。\n",
                },
            ),
        ],
    },
    BuiltinSkillDefinition {
        name: "python",
        locales: &[
            (
                "en-US",
                BuiltinSkillBody {
                    description: "Clean and transform data with a Python script on the local \
                                  interpreter (stdlib always; user-installed packages usable) \
                                  — reach for it when the logic is procedural: reshaping, \
                                  regex massaging, unit fixing, multi-step row logic. Plain \
                                  projection, filtering, and aggregation belong to SQL.",
                    body: "Use the `python` tool for data cleaning and transformation that SQL \
alone makes awkward -- melting/pivoting, regex massaging, unit fixing, multi-step \
row logic. Prefer SQL for plain projection/filter/aggregation; reach for Python \
when the logic is genuinely procedural.\n\
\n\
Pass the full script source as `script`; it runs against the interpreter installed \
on this machine; the stdlib is always available, and packages the user has \
installed themselves import normally -- nothing is bundled with the app, so do \
not assume a package exists without checking or asking. Read inputs and write \
outputs through files the script can address by path, and print results or \
write an output file the next step consumes.\n",
                },
            ),
            (
                "zh-CN",
                BuiltinSkillBody {
                    description: "用本机解释器运行 Python 脚本做数据清洗与转换（标准库恒可\
                                  用；用户自装的包也可导入）——逻辑过程化时用它：重塑、正则\
                                  整理、单位修正、多步行级处理。单纯的投影、过滤、聚合属于 \
                                  SQL。",
                    body: "SQL 表达起来别扭的数据清洗与转换用 `python` 工具——逆透视/透视、正则\
批量整理、单位修正、多步行级逻辑。单纯的投影/过滤/聚合仍优先 SQL；逻辑真正过程化时才\
用 Python。\n\
\n\
把完整脚本源码作为 `script` 传入；脚本在本机已安装的解释器上运行，标准库恒可用，用户\
自行安装的包也能正常导入——app 不随版捆绑任何库生态，因此不要未经确认就假设某个包存\
在。输入输出都通过脚本可按路径寻址的文件读写，打印结果或写出供下一步消费的输出文件。\n",
                },
            ),
        ],
    },
    BuiltinSkillDefinition {
        name: "office-cli",
        locales: &[
            (
                "en-US",
                BuiltinSkillBody {
                    description: "Work directly on Office-file content with the local \
                                  OfficeCLI (Word, Excel, PowerPoint): extract text and \
                                  tables, edit, fill templates, or author a document from \
                                  scratch. Converting a document that already exists between \
                                  formats belongs to pandoc.",
                    body: "Use the `office-cli` tool for direct Office document work -- reading \
or editing DOCX/XLSX/PPTX content, extracting text and tables, filling templates, or \
generating Office files from scratch. It is the agent-oriented path when the task is \
about the Office file itself rather than about converting it (conversion between \
document formats belongs to `pandoc`).\n\
\n\
Pass the subcommand and its arguments as the `args` list, one argument per element \
(do not pre-join them into a single shell-style string). OfficeCLI's own help output \
is the authority on subcommand names -- when unsure of a subcommand's exact shape, \
say so rather than guessing flags.\n",
                },
            ),
            (
                "zh-CN",
                BuiltinSkillBody {
                    description: "用本机 OfficeCLI 直接操作 Office 文件内容（Word、Excel、\
                                  PowerPoint）：抽取文本与表格、编辑、填充模板、从零撰写文\
                                  档。既有文档的格式间转换属于 pandoc。",
                    body: "直接操作 Office 文档时使用 `office-cli` 工具——读取或编辑 \
DOCX/XLSX/PPTX 内容、抽取文本与表格、填充模板、从零生成 Office 文件。任务围绕 Office \
文件本身时走它；文档格式之间的转换属于 `pandoc`。\n\
\n\
子命令及其参数以 `args` 列表传入，一个参数一个元素（不要预先拼成 shell 风格的单一字符\
串）。子命令名称以 OfficeCLI 自身的帮助输出为准——拿不准子命令形态时说明情况，而不是\
猜测标志。\n",
                },
            ),
        ],
    },
];

/// The reserved-name class for the SKILLS namespace (ADR-0109 Decision 7
/// mirrored on the skill side): static full-set membership, independent of
/// detection or materialization. Create / import / rename refuse these
/// names with the dedicated typed error so the refusal reads as "reserved
/// for a builtin", not "already taken".
pub(crate) fn is_reserved_skill_name(name: &str) -> bool {
    find_skill_definition(name).is_some()
}

/// Find the shipped skill definition a name belongs to. `None` = not in the
/// curated set.
pub(crate) fn find_skill_definition(name: &str) -> Option<&'static BuiltinSkillDefinition> {
    BUILTIN_SKILL_DEFINITIONS.iter().find(|d| d.name == name)
}

/// Resolve the materialization locale off the persisted preference:
/// explicit overrides map directly; `system` reads the OS locale fresh (the
/// same philosophy as the provider-locale resolution in
/// `LiveProviderConfig::locale` -- no caching, a language switch lands on
/// the next scan). Any zh* tag maps zh-CN; everything else en-US.
pub(crate) fn resolve_materialization_locale(pref: LocalePreference) -> &'static str {
    match pref {
        LocalePreference::ZhCN => "zh-CN",
        LocalePreference::EnUS => "en-US",
        LocalePreference::System => {
            let tag = sys_locale::get_locale().unwrap_or_default();
            if tag.to_ascii_lowercase().starts_with("zh") {
                "zh-CN"
            } else {
                "en-US"
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The baseline side table (app-config, ADR-0109 Decision 6 / issue #677)

/// One `builtin_skill_baselines` record: the hash of the SKILL.md bytes as
/// materialized (the recorded baseline) + the locale it was rendered in (the
/// upgrade re-renders at THIS locale; the explicit restore uses the current
/// one; a locale switch never rewrites).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltinSkillBaseline {
    pub hash: String,
    pub locale: String,
}

/// The runtime face of the side table the registry needs: WHICH names are
/// materialized builtin skills. Loader-side `Acquired::Builtin` marking keys
/// on this (not on the static set) so a user's pre-existing same-named skill
/// -- the reverse-conflict window -- keeps reading as their own `local`
/// skill, editable and deletable, until they dispose of it.
#[derive(Debug, Default)]
pub struct BuiltinSkillMark {
    names: std::collections::BTreeSet<String>,
}

impl BuiltinSkillMark {
    /// A mark carrying exactly the given names (tests pin the materialized
    /// posture without an app-config fixture).
    #[cfg(test)]
    pub(crate) fn of(names: &[&str]) -> Self {
        Self {
            names: names.iter().map(|n| n.to_string()).collect(),
        }
    }

    pub fn from_config(cfg: &AppConfig) -> Self {
        // Only shipped names can be materialized builtin skills: a stale or
        // hand-edited record outside the static set must not promote a user
        // skill to the builtin posture (undeletable, name-locked). The
        // scan-window retain drops such records from disk; this filter keeps
        // the runtime view consistent until it does.
        Self {
            names: cfg
                .builtin_skill_baselines
                .keys()
                .filter(|n| find_skill_definition(n).is_some())
                .cloned()
                .collect(),
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    /// The `Acquired` value for a loaded skill directory: a materialized
    /// builtin outranks the real-directory default (`Linked` stays --
    /// materialization only ever creates real directories, so the two never
    /// collide in practice; the check order keeps the precedence explicit).
    pub fn acquired(&self, name: &str, fs_acquired: Acquired) -> Acquired {
        if fs_acquired != Acquired::Linked && self.contains(name) {
            Acquired::Builtin
        } else {
            fs_acquired
        }
    }
}

// ---------------------------------------------------------------------------
// Reconciliation (rides the CLI scan window, issue #677)

/// Materialize / upgrade / clean the builtin skills against the CURRENT CLI
/// registry, mutating the side table in place. Returns whether the side
/// table changed (the caller folds that into its persist decision).
///
/// Per definition: a `Builtin`-sourced CLI entry with a missing skill file
/// materializes the file at `locale` and records the baseline (a dormant or
/// conflict-postured entry materializes nothing -- the skill enters the
/// library only when the tool is registered). An existing file with NO
/// record is the reverse-conflict posture (a user skill owns the name): the
/// scan warns and skips, and the next scan after the user renames or removes
/// theirs materializes (mirrors the CLI-side `Conflict` semantics). An
/// existing file WITH a record: hash-different = edited, preserved verbatim;
/// hash-agreeing but outside the shipped hash set = silently upgraded at the
/// RECORDED locale and re-recorded. Finally, records whose name left the
/// shipped set, or whose file AND CLI entry are both gone, are dropped.
///
/// Filesystem failures degrade per-skill with a warn (the scan window must
/// not fail the whole read-modify-write); the settings-page rescan retries.
pub(crate) fn reconcile(
    root: &Path,
    locale: &str,
    cli: &crate::cli_tools::config::CliToolRegistry,
    baselines: &mut BTreeMap<String, BuiltinSkillBaseline>,
) -> bool {
    let mut dirty = false;
    for def in BUILTIN_SKILL_DEFINITIONS {
        let entry_is_builtin = cli.tools.iter().any(|t| {
            t.name == def.name && t.source == crate::cli_tools::config::CliToolSource::Builtin
        });
        if !entry_is_builtin {
            continue;
        }
        let dir = root.join(def.name);
        let md_path = dir.join("SKILL.md");
        if !md_path.exists() {
            match materialize(def, root, locale) {
                Ok(record) => {
                    baselines.insert(def.name.to_string(), record);
                    dirty = true;
                    log::info!(
                        target: "skills",
                        "builtin skill `{}` materialized into the registry", def.name
                    );
                }
                Err(e) => {
                    log::warn!(
                        target: "skills",
                        "builtin skill `{}` failed to materialize (the next scan retries): {e}",
                        def.name
                    );
                }
            }
            continue;
        }
        let bytes = match std::fs::read(&md_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!(
                    target: "skills",
                    "builtin skill `{}` hash read failed (the next scan retries): {e}",
                    def.name
                );
                continue;
            }
        };
        let current = crate::util::sha256_hex(&bytes);
        let Some(record) = baselines.get(def.name).cloned() else {
            // An existing file with no record is either the reverse-conflict
            // posture (a user skill owns the name) or the interrupted-persist
            // half state (the file landed, the side-table store did not).
            // Content tells them apart: a shipped render is ours by
            // construction, so it is adopted as the record -- the self-heal,
            // no rewrite (the bytes already agree), the locale is the
            // render's own. Anything else is the user's -- defer.
            let adopted_locale = def.locales.iter().find_map(|(tag, _)| {
                def.render(tag)
                    .ok()
                    .filter(|content| crate::util::sha256_hex(content.as_bytes()) == current)
                    .map(|_| *tag)
            });
            if let Some(tag) = adopted_locale {
                baselines.insert(
                    def.name.to_string(),
                    BuiltinSkillBaseline {
                        hash: current,
                        locale: tag.to_string(),
                    },
                );
                dirty = true;
                log::info!(
                    target: "skills",
                    "builtin skill `{}` adopted a shipped-render file with no \
                     record (self-heal after an interrupted persist)",
                    def.name
                );
            } else {
                log::warn!(
                    target: "skills",
                    "builtin skill `{}` deferred: a user skill owns the name; it \
                     materializes once the user renames or removes it",
                    def.name
                );
            }
            continue;
        };
        if current != record.hash {
            continue; // Edited (in-app or by an external editor): preserved.
        }
        if def.shipped_hashes().contains(&record.hash) {
            continue; // Agrees with the shipped baseline: nothing to do.
        }
        // Baseline moved by the app version: upgrade at the recorded locale.
        match materialize(def, root, &record.locale) {
            Ok(new_record) => {
                baselines.insert(def.name.to_string(), new_record);
                dirty = true;
                log::info!(
                    target: "skills",
                    "builtin skill `{}` upgraded to the shipped definition (unedited)",
                    def.name
                );
            }
            Err(e) => {
                log::warn!(
                    target: "skills",
                    "builtin skill `{}` failed to upgrade (the next scan retries): {e}",
                    def.name
                );
            }
        }
    }
    // Side-table cleanup: a record is stale when its name left the shipped
    // set (the curation moved on; the file stays in the library as a plain
    // local skill), or when neither the file nor a Builtin CLI entry anchors
    // it anymore (dormant + hand-deleted file -- a future detection starts
    // fresh at the then-current locale).
    let before = baselines.len();
    baselines.retain(|name, _| {
        if find_skill_definition(name).is_none() {
            return false;
        }
        if root.join(name).join("SKILL.md").exists() {
            return true;
        }
        cli.tools.iter().any(|t| {
            t.name == *name && t.source == crate::cli_tools::config::CliToolSource::Builtin
        })
    });
    // A dropped record is a side-table change like an insert: without this
    // the cleanup is the one mutation the caller's persist-skip branch
    // swallows, and a retired name's stale record would survive on disk
    // forever -- pinning the user's same-named skill into the undeletable
    // builtin posture with no self-service exit.
    dirty |= baselines.len() != before;
    dirty
}

/// Write the definition's SKILL.md at `locale` and produce the record for
/// the side table. The registry root is minted lazily (a never-created
/// registry materializes on the first detection), and the write is the
/// registry's own atomic replace.
fn materialize(
    def: &BuiltinSkillDefinition,
    root: &Path,
    locale: &str,
) -> Result<BuiltinSkillBaseline, SkillError> {
    let dir = root.join(def.name);
    std::fs::create_dir_all(&dir).map_err(|e| {
        SkillError::FsFailure(format!(
            "create builtin skill directory `{}` failed: {e}",
            dir.display()
        ))
    })?;
    let content = def.render(locale)?;
    registry::write_skill_md(&dir, &content)?;
    Ok(BuiltinSkillBaseline {
        hash: crate::util::sha256_hex(content.as_bytes()),
        locale: locale.to_string(),
    })
}

/// The explicit restore (issue #677): rewrite the file at the CURRENT locale
/// and re-record, returning the session to the shipped baseline (future
/// upgrades follow again). The name must address a materialized builtin
/// skill; anything else is the typed refusal (an unknown name, or a user
/// skill that happens to share a reserved name, must not be overwritten).
pub(crate) fn restore(
    root: &Path,
    locale: &str,
    name: &str,
    baselines: &mut BTreeMap<String, BuiltinSkillBaseline>,
) -> Result<(), SkillError> {
    let Some(def) = find_skill_definition(name) else {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    };
    if !baselines.contains_key(name) {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    let record = materialize(def, root, locale)?;
    baselines.insert(name.to_string(), record);
    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-include (ADR-0109 Decision 6: the folded initial set)

/// The builtin skill names a NEW session auto-includes: the companion CLI
/// entry is `Builtin`-sourced AND enabled, the skill is MATERIALIZED (a
/// side-table record -- the same anchor the frontend's `acquired: builtin`
/// derives from, so the chip count and the seeded set agree even in the
/// reverse-conflict window, where the file exists but is the user's), and
/// the skill file exists (a materialized skill whose CLI entry went missing
/// kept its file -- but with no entry there is nothing to detect+enable, so
/// it stays out). Computed fresh at session creation and at resume (never
/// persisted, never an event); a disabled tool drops out on the next
/// recomputation.
pub(crate) fn auto_included_names(
    cli: &[crate::cli_tools::config::CliToolConfig],
    mark: &BuiltinSkillMark,
    skills_root: &Path,
) -> Vec<String> {
    BUILTIN_SKILL_DEFINITIONS
        .iter()
        .filter(|def| {
            cli.iter().any(|t| {
                t.name == def.name
                    && t.source == crate::cli_tools::config::CliToolSource::Builtin
                    && t.enabled
            }) && mark.contains(def.name)
                && skills_root.join(def.name).join("SKILL.md").exists()
        })
        .map(|def| def.name.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_tools::config::{CliToolConfig, CliToolSource};

    /// A registry builder for the reconcile scenarios.
    fn registry_with(tools: Vec<CliToolConfig>) -> crate::cli_tools::config::CliToolRegistry {
        crate::cli_tools::config::CliToolRegistry { tools }
    }

    /// A Builtin-sourced pandoc registration (enabled by default).
    fn builtin_pandoc(enabled: bool) -> CliToolConfig {
        CliToolConfig {
            name: "pandoc".to_string(),
            description: String::new(),
            executable: "pandoc".to_string(),
            argv_template: Vec::new(),
            params: Vec::new(),
            env: Default::default(),
            enabled,
            source: CliToolSource::Builtin,
            baseline: None,
        }
    }

    fn pandoc_def() -> &'static BuiltinSkillDefinition {
        find_skill_definition("pandoc").expect("pandoc skill definition")
    }

    // --- shipped set --------------------------------------------------------

    #[test]
    fn every_definition_carries_en_us_first_and_renders_a_valid_skill_md() {
        for def in BUILTIN_SKILL_DEFINITIONS {
            assert_eq!(
                def.locales[0].0, "en-US",
                "{} must lead with en-US",
                def.name
            );
            for (tag, _) in def.locales {
                let content = def.render(tag).expect("render");
                let parsed = frontmatter::parse_skill_md(&content).expect("parse");
                assert_eq!(
                    frontmatter::get_string(&parsed.frontmatter, "name").unwrap(),
                    def.name
                );
                assert_eq!(
                    frontmatter::cli_tools(&parsed.frontmatter),
                    vec![def.name.to_string()]
                );
                assert!(!parsed.body.trim().is_empty(), "body must be non-blank");
            }
        }
    }

    #[test]
    fn render_is_deterministic_so_the_hash_is_stable() {
        let def = pandoc_def();
        let a = def.render("en-US").unwrap();
        let b = def.render("en-US").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, def.render("zh-CN").unwrap());
    }

    #[test]
    fn body_for_falls_back_to_en_us_for_an_unknown_locale() {
        let def = pandoc_def();
        assert_eq!(
            def.body_for("fr-FR").description,
            def.body_for("en-US").description
        );
    }

    #[test]
    fn explicit_locale_preferences_map_directly() {
        assert_eq!(
            resolve_materialization_locale(LocalePreference::ZhCN),
            "zh-CN"
        );
        assert_eq!(
            resolve_materialization_locale(LocalePreference::EnUS),
            "en-US"
        );
    }

    // --- curated trigger copy (issue #703) -------------------------------

    /// The locked trigger copy (curation brief, verbatim): sentence 1 is
    /// capability + trigger timing, sentence 2 the neighbor-tool boundary.
    /// With progressive disclosure the metadata index is the only discovery
    /// surface, so the wording itself is load-bearing -- pinned byte for
    /// byte.
    #[test]
    fn descriptions_carry_the_locked_trigger_copy() {
        let expected: &[(&str, &str, &str)] = &[
            (
                "pandoc",
                "Convert existing documents between formats with the local \
                 pandoc — render Markdown to DOCX/HTML/PDF for delivery, or \
                 read DOCX/EPUB into Markdown for analysis. Authoring or \
                 manipulating Office-file content (tables, templates, \
                 reports) belongs to office-cli.",
                "用本机 pandoc 在格式之间转换既有文档——把 Markdown 渲染为 \
                 DOCX/HTML/PDF 交付，或把 DOCX/EPUB 整篇读成 Markdown 分析。\
                 撰写或操作 Office 文件内容（表格、模板、报告）属于 \
                 office-cli。",
            ),
            (
                "office-cli",
                "Work directly on Office-file content with the local \
                 OfficeCLI (Word, Excel, PowerPoint): extract text and \
                 tables, edit, fill templates, or author a document from \
                 scratch. Converting a document that already exists between \
                 formats belongs to pandoc.",
                "用本机 OfficeCLI 直接操作 Office 文件内容（Word、Excel、\
                 PowerPoint）：抽取文本与表格、编辑、填充模板、从零撰写文\
                 档。既有文档的格式间转换属于 pandoc。",
            ),
            (
                "python",
                "Clean and transform data with a Python script on the local \
                 interpreter (stdlib always; user-installed packages usable) \
                 — reach for it when the logic is procedural: reshaping, \
                 regex massaging, unit fixing, multi-step row logic. Plain \
                 projection, filtering, and aggregation belong to SQL.",
                "用本机解释器运行 Python 脚本做数据清洗与转换（标准库恒可\
                 用；用户自装的包也可导入）——逻辑过程化时用它：重塑、正则\
                 整理、单位修正、多步行级处理。单纯的投影、过滤、聚合属于 \
                 SQL。",
            ),
        ];
        for (name, en, zh) in expected {
            let def = find_skill_definition(name).expect("definition");
            assert_eq!(def.body_for("en-US").description, *en, "{name} en-US");
            assert_eq!(def.body_for("zh-CN").description, *zh, "{name} zh-CN");
        }
    }

    /// The index entry a model reads is the YAML round-trip of the render,
    /// not the struct field -- the long prose (em dashes, colons,
    /// parentheticals) must survive serialization unharmed.
    #[test]
    fn render_round_trips_the_curated_descriptions_verbatim() {
        for def in BUILTIN_SKILL_DEFINITIONS {
            for (tag, _) in def.locales {
                let parsed =
                    frontmatter::parse_skill_md(&def.render(tag).expect("render")).expect("parse");
                assert_eq!(
                    frontmatter::get_string(&parsed.frontmatter, "description")
                        .expect("description"),
                    def.body_for(tag).description,
                    "{} {} description survives the render round-trip",
                    def.name,
                    tag
                );
            }
        }
    }

    /// The format/content split is cross-referenced symmetrically ("belongs
    /// to X"): pandoc points at office-cli, office-cli at pandoc, python at
    /// SQL. The index shows all entries at once, so the boundary sentence is
    /// what disambiguates them.
    #[test]
    fn boundary_sentences_cross_reference_the_neighbor() {
        let pairs: &[(&str, &str)] = &[
            ("pandoc", "office-cli"),
            ("office-cli", "pandoc"),
            ("python", "SQL"),
        ];
        for (name, neighbor) in pairs {
            let def = find_skill_definition(name).expect("definition");
            for tag in ["en-US", "zh-CN"] {
                assert!(
                    def.body_for(tag).description.contains(neighbor),
                    "{} {tag} description must name {neighbor}",
                    def.name
                );
            }
        }
    }

    /// Python library semantics erratum: "nothing bundled with the app" is
    /// not "stdlib only" -- user-installed packages import normally, and the
    /// description's parenthetical and the body must agree on that.
    #[test]
    fn python_copy_states_library_semantics_accurately() {
        let def = find_skill_definition("python").expect("definition");
        // The stale absolute claim, per locale, must be gone from both the
        // description and the body.
        let stale_claims: &[(&str, &str)] = &[("en-US", "stdlib only"), ("zh-CN", "只用标准库")];
        for (tag, claim) in stale_claims {
            let prose = def.body_for(tag);
            assert!(
                !prose.description.contains(claim),
                "{tag} description must not claim {claim:?}"
            );
            assert!(
                !prose.body.contains(claim),
                "{tag} body must not claim {claim:?}"
            );
        }
        assert!(def
            .body_for("en-US")
            .body
            .contains("packages the user has installed themselves import normally"));
        assert!(def
            .body_for("zh-CN")
            .body
            .contains("用户自行安装的包也能正常导入"));
    }

    /// Length discipline (curation brief): every en-US description fits two
    /// sentences and roughly 40 words -- the index is re-read every turn, so
    /// length is a recurring token cost. The bound is deliberately loose
    /// (an upper limit, not an exact count).
    #[test]
    fn en_us_descriptions_stay_within_the_curated_length_budget() {
        const MAX_WORDS: usize = 45;
        for def in BUILTIN_SKILL_DEFINITIONS {
            let en = def.body_for("en-US").description;
            let words = en.split_whitespace().count();
            assert!(
                words <= MAX_WORDS,
                "{} en-US description is {words} words (budget {MAX_WORDS})",
                def.name
            );
            let sentences = en.matches(". ").count() + 1;
            assert!(
                sentences <= 2,
                "{} en-US description has {sentences} sentences",
                def.name
            );
        }
    }

    // --- reconcile ----------------------------------------------------------

    #[test]
    fn reconcile_materializes_the_file_and_records_the_baseline() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let dirty = reconcile(
            root.path(),
            "en-US",
            &registry_with(vec![builtin_pandoc(true)]),
            &mut baselines,
        );
        assert!(dirty);
        let content = std::fs::read_to_string(root.path().join("pandoc/SKILL.md")).expect("file");
        assert_eq!(content, pandoc_def().render("en-US").unwrap());
        let record = &baselines["pandoc"];
        assert_eq!(record.locale, "en-US");
        assert_eq!(record.hash, crate::util::sha256_hex(content.as_bytes()));
    }

    #[test]
    fn reconcile_is_idempotent_when_the_file_agrees_with_the_record() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "en-US", &cli, &mut baselines);
        let dirty = reconcile(root.path(), "zh-CN", &cli, &mut baselines);
        assert!(!dirty, "an agreeing file is not rewritten (locale switch)");
        // The recorded locale survives a switch: no rewrite, no re-record.
        assert_eq!(baselines["pandoc"].locale, "en-US");
    }

    #[test]
    fn reconcile_skips_dormant_and_user_sourced_entries() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let mut user = builtin_pandoc(true);
        user.source = CliToolSource::User;
        let dirty = reconcile(
            root.path(),
            "en-US",
            &registry_with(vec![user]),
            &mut baselines,
        );
        assert!(!dirty);
        assert!(!root.path().join("pandoc/SKILL.md").exists());
        assert!(baselines.is_empty());
    }

    #[test]
    fn reconcile_defers_when_a_user_skill_owns_the_name() {
        // Reverse conflict: a directory we never wrote occupies the name.
        let root = tempfile::tempdir().expect("root");
        let user_file = "---\nname: pandoc\ndescription: owned\n---\nBody.\n";
        std::fs::create_dir_all(root.path().join("pandoc")).expect("mkdir");
        std::fs::write(root.path().join("pandoc/SKILL.md"), user_file).expect("write");
        let mut baselines = BTreeMap::new();
        let dirty = reconcile(
            root.path(),
            "en-US",
            &registry_with(vec![builtin_pandoc(true)]),
            &mut baselines,
        );
        assert!(!dirty);
        assert!(baselines.is_empty(), "no record: the file is not ours");
        assert_eq!(
            std::fs::read_to_string(root.path().join("pandoc/SKILL.md")).unwrap(),
            user_file,
            "the user file is preserved"
        );
    }

    #[test]
    fn reconcile_adopts_a_shipped_render_file_with_no_record() {
        // The interrupted-persist half state (the file landed, the side-table
        // store did not): content identifies the file as ours -- adopted as
        // the record without a rewrite, at the render's own locale. The
        // user-file deference is pinned by the test above.
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("pandoc")).expect("mkdir");
        std::fs::write(
            root.path().join("pandoc/SKILL.md"),
            pandoc_def().render("zh-CN").unwrap(),
        )
        .expect("write shipped render");
        let mut baselines = BTreeMap::new();
        let dirty = reconcile(
            root.path(),
            "en-US",
            &registry_with(vec![builtin_pandoc(true)]),
            &mut baselines,
        );
        assert!(dirty);
        assert_eq!(
            std::fs::read_to_string(root.path().join("pandoc/SKILL.md")).unwrap(),
            pandoc_def().render("zh-CN").unwrap(),
            "no rewrite: the bytes already agree"
        );
        let record = &baselines["pandoc"];
        assert_eq!(
            record.locale, "zh-CN",
            "the adopt records the render's locale"
        );
        assert_eq!(
            record.hash,
            crate::util::sha256_hex(pandoc_def().render("zh-CN").unwrap().as_bytes())
        );
    }

    #[test]
    fn reconcile_preserves_an_edited_file() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "en-US", &cli, &mut baselines);
        let file = root.path().join("pandoc/SKILL.md");
        let edited = "---\nname: pandoc\ndescription: edited\n---\nEdited body.\n";
        std::fs::write(&file, edited).expect("edit");
        let dirty = reconcile(root.path(), "en-US", &cli, &mut baselines);
        assert!(!dirty);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), edited);
    }

    #[test]
    fn reconcile_upgrades_an_unedited_file_whose_record_left_the_shipped_set() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "zh-CN", &cli, &mut baselines);
        let file = root.path().join("pandoc/SKILL.md");
        // Simulate the app version moving the baseline: the on-disk file is
        // an OLDER shipped body (recorded as-is), so file == record (the
        // unedited posture) but the record hash matches no CURRENT shipped
        // render. Reachable in production by a version whose prose evolved.
        let stale = format!(
            "---\nname: pandoc\ndescription: {}\nmetadata:\n  toptopduck_cli_tools: pandoc\n---\nOld body.\n",
            "older description"
        );
        std::fs::write(&file, &stale).expect("write stale body");
        baselines.get_mut("pandoc").unwrap().hash = crate::util::sha256_hex(stale.as_bytes());
        let dirty = reconcile(root.path(), "en-US", &cli, &mut baselines);
        assert!(dirty);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            pandoc_def().render("zh-CN").unwrap(),
            "the upgrade re-renders at the recorded locale, not the current one"
        );
        assert_eq!(baselines["pandoc"].hash, pandoc_def().shipped_hashes()[1]);
    }

    #[test]
    fn reconcile_rematerializes_a_hand_deleted_file() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "en-US", &cli, &mut baselines);
        std::fs::remove_file(root.path().join("pandoc/SKILL.md")).expect("delete");
        let dirty = reconcile(root.path(), "zh-CN", &cli, &mut baselines);
        assert!(dirty, "the re-materialization re-records");
        assert!(root.path().join("pandoc/SKILL.md").exists());
        assert_eq!(baselines["pandoc"].locale, "zh-CN");
    }

    #[test]
    fn reconcile_drops_records_with_no_anchor() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        baselines.insert(
            "pandoc".to_string(),
            BuiltinSkillBaseline {
                hash: "h".to_string(),
                locale: "en-US".to_string(),
            },
        );
        baselines.insert(
            "retired-skill".to_string(),
            BuiltinSkillBaseline {
                hash: "h".to_string(),
                locale: "en-US".to_string(),
            },
        );
        // No file, no Builtin CLI entry -> dropped; unknown name -> dropped.
        // The drops report dirty: a cleanup-only scan still persists (the
        // skip-write branch must not swallow a side-table shrink).
        let dirty = reconcile(root.path(), "en-US", &registry_with(vec![]), &mut baselines);
        assert!(baselines.is_empty());
        assert!(dirty, "a dropped record is a side-table change");
    }

    #[test]
    fn reconcile_keeps_the_record_of_a_dangling_file() {
        // The CLI entry persists after an uninstall (probe semantics) and so
        // does the file; the record must survive so edited-derivation stays
        // truthful.
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "en-US", &cli, &mut baselines);
        let dirty = reconcile(root.path(), "en-US", &cli, &mut baselines);
        assert!(!dirty);
        assert!(baselines.contains_key("pandoc"));
    }

    // --- restore --------------------------------------------------------

    #[test]
    fn restore_rewrites_at_the_current_locale_and_rerecords() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        let cli = registry_with(vec![builtin_pandoc(true)]);
        reconcile(root.path(), "en-US", &cli, &mut baselines);
        std::fs::write(
            root.path().join("pandoc/SKILL.md"),
            "---\nname: pandoc\ndescription: edited\n---\nEdited.\n",
        )
        .expect("edit");
        restore(root.path(), "zh-CN", "pandoc", &mut baselines).expect("restore");
        assert_eq!(
            std::fs::read_to_string(root.path().join("pandoc/SKILL.md")).unwrap(),
            pandoc_def().render("zh-CN").unwrap()
        );
        assert_eq!(baselines["pandoc"].locale, "zh-CN");
    }

    #[test]
    fn restore_refuses_unknown_and_unmaterialized_names() {
        let root = tempfile::tempdir().expect("root");
        let mut baselines = BTreeMap::new();
        assert_eq!(
            restore(root.path(), "en-US", "no-such-skill", &mut baselines),
            Err(SkillError::NoSuchSkill("no-such-skill".to_string()))
        );
        // A curated name with no record (the conflict window) is not ours.
        assert_eq!(
            restore(root.path(), "en-US", "pandoc", &mut baselines),
            Err(SkillError::NoSuchSkill("pandoc".to_string()))
        );
    }

    // --- auto-include ---------------------------------------------------

    #[test]
    fn auto_included_names_gates_on_source_enabled_materialization_and_file_presence() {
        let root = tempfile::tempdir().expect("root");
        let marked = BuiltinSkillMark::of(&["pandoc"]);
        // No file yet: nothing auto-included even with an enabled entry.
        assert!(auto_included_names(&[builtin_pandoc(true)], &marked, root.path()).is_empty());
        std::fs::create_dir_all(root.path().join("pandoc")).expect("mkdir");
        std::fs::write(
            root.path().join("pandoc/SKILL.md"),
            "---\nname: pandoc\ndescription: d\n---\nBody.\n",
        )
        .expect("write");
        assert_eq!(
            auto_included_names(&[builtin_pandoc(true)], &marked, root.path()),
            vec!["pandoc".to_string()]
        );
        // Not materialized (no side-table record) drops out -- the
        // reverse-conflict window: the file exists but is the user's, and
        // the frontend chip (acquired: builtin) does not count it either.
        assert!(auto_included_names(
            &[builtin_pandoc(true)],
            &BuiltinSkillMark::default(),
            root.path()
        )
        .is_empty());
        // Disabled drops out; a user-sourced entry of the same name is not
        // an auto-include anchor.
        assert!(auto_included_names(&[builtin_pandoc(false)], &marked, root.path()).is_empty());
        let mut user = builtin_pandoc(true);
        user.source = CliToolSource::User;
        assert!(auto_included_names(&[user], &marked, root.path()).is_empty());
    }

    // --- the registry mark -------------------------------------------------

    #[test]
    fn the_mark_promotes_a_materialized_name_and_leaves_others_alone() {
        let cfg = AppConfig::defaults();
        let unmarked = BuiltinSkillMark::from_config(&cfg);
        assert!(!unmarked.contains("pandoc"));
        assert_eq!(
            unmarked.acquired("pandoc", Acquired::Local),
            Acquired::Local
        );
        let with = BuiltinSkillMark::of(&["pandoc"]);
        assert_eq!(with.acquired("pandoc", Acquired::Local), Acquired::Builtin);
        // A linked directory outranks the mark (the read-only posture is
        // the safer reading of a hand-mangled state).
        assert_eq!(with.acquired("pandoc", Acquired::Linked), Acquired::Linked);
    }

    #[test]
    fn from_config_ignores_records_outside_the_shipped_set() {
        // A hand-edited or stale record for a non-shipped name must not
        // promote a user skill to the builtin posture; the scan-window
        // retain drops the record from disk on its next pass.
        let mut cfg = AppConfig::defaults();
        cfg.builtin_skill_baselines.insert(
            "ghost".to_string(),
            BuiltinSkillBaseline {
                hash: "h".to_string(),
                locale: "en-US".to_string(),
            },
        );
        let mark = BuiltinSkillMark::from_config(&cfg);
        assert!(!mark.contains("ghost"));
        assert_eq!(mark.acquired("ghost", Acquired::Local), Acquired::Local);
    }
}
