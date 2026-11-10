//! Workspace memory store (issue #1529): the workspace's persistent memory
//! layer under `.toptopduck/memory/` -- one `<type>-<slug>.md` file per fact
//! (flat `key: value` frontmatter + free-text body) plus the derived
//! `MEMORY.md` index. The FILES are the source of truth; the index is a
//! projection reconciled on every read (a hand-edited or drifted index is
//! rewritten from the files, never the other way around).
//!
//! Posture mirrors the dataset store's neighbors: reads are tolerant (a
//! missing directory reads as empty -- the zero-footprint fresh workspace;
//! a corrupt file is skipped + logged, never fatal), writes are honest
//! (the index cap REFUSES a new entry instead of silently truncating), and
//! the directory family is created lazily on the first write only.

use std::path::{Path, PathBuf};

use crate::persistence::io::{write_str_atomic, WritePerms};

/// The memory subdirectory inside the workspace state directory.
const MEMORY_DIR_NAME: &str = "memory";
/// The derived index file inside the memory directory.
const MEMORY_INDEX_NAME: &str = "MEMORY.md";
/// The frontmatter fence line.
const FENCE: &str = "---";

/// Index capacity (issue #1529): at most 200 rows ...
const INDEX_MAX_ROWS: usize = 200;
/// ... and 25,000 bytes. Over either cap a write REFUSES the new entry
/// (never a silent truncation, never a head cut that would drop old rows).
const INDEX_MAX_BYTES: usize = 25_000;
/// Slug ceiling in chars (the cleaned slug is ASCII, so chars == bytes).
const SLUG_MAX_CHARS: usize = 48;
/// One index row's hook clamp, in CHARS -- every truncation path walks char
/// boundaries so a CJK glyph is never split at its midpoint. Also the
/// memory title's clamp budget (both ride [`clamp_injection_line`]).
pub(crate) const HOOK_MAX_CHARS: usize = 120;

/// The four memory categories (issue #1529 storage protocol). Serialized
/// lowercase in frontmatter and on the IPC face; an unknown frontmatter
/// value degrades to [`MemoryType::Reference`] (tolerant parse -- a
/// hand-edited file never crashes the read).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryType {
    /// The filename segment (the `<type>-<slug>.md` convention).
    fn as_segment(self) -> &'static str {
        match self {
            MemoryType::User => "user",
            MemoryType::Feedback => "feedback",
            MemoryType::Project => "project",
            MemoryType::Reference => "reference",
        }
    }
}

/// How a memory landed (the frontmatter `source` field): extracted from a
/// session by the host (#1530) or hand-written. Default `Manual` -- a
/// hand-edited file without the field reads as hand-written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemorySource {
    Extract,
    #[default]
    Manual,
}

/// One memory's frontmatter (issue #1529): the full protocol field set.
/// `name` doubles as the index title and the slug source; `description` is
/// the index hook; `saved_at` is an absolute date (the host stamps it --
/// a memory must not float on relative dates). Never serialized: the IPC
/// face is [`ListedMemory`]; the on-disk codec is the hand-written
/// frontmatter pair below.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    pub name: String,
    pub description: String,
    pub r#type: MemoryType,
    pub origin_session: Option<String>,
    pub saved_at: String,
    pub source: MemorySource,
}

/// One index row -- the injection + panel face. `title` and `hook` are RAW
/// stored text: every single-line surface must clamp at render time
/// ([`clamp_injection_line`] -- `render_index` and the prompt-side memory
/// block both do; the panel truncates with CSS over the raw text).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MemoryIndexRow {
    pub title: String,
    pub file: String,
    pub hook: String,
}

/// The panel's IPC face: the index row plus the typed category and the
/// ABSOLUTE file path (the reveal-in-folder target).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ListedMemory {
    #[serde(flatten)]
    pub row: MemoryIndexRow,
    pub r#type: MemoryType,
    /// The absolute path of the memory file (reveal target).
    pub file_path: String,
}

/// The panel's one-shot read (issue #1530): the rows plus the index usage
/// percentage the color scale renders, and (issue #1538) the names of
/// `.md` files that carry no frontmatter fence -- a hand-written file that
/// would otherwise vanish silently from the panel.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ListedMemorySection {
    pub rows: Vec<ListedMemory>,
    pub usage_percent: u8,
    pub unreadable: Vec<String>,
}

/// Why a memory operation failed. `IndexFull` carries the actionable cap
/// detail (the panel's own sentence); `Invalid` is the boundary guard's
/// reject (a blank title); `Io` is the infrastructure echo.
#[derive(Debug, Clone, PartialEq)]
pub enum MemoryError {
    /// The write would push the index past its row or byte cap: refused,
    /// nothing landed (never a silent truncation).
    IndexFull {
        detail: String,
    },
    /// The input itself is unusable (a blank title): refused, nothing
    /// landed.
    Invalid {
        detail: String,
    },
    Io {
        detail: String,
    },
}

impl MemoryError {
    fn io(e: impl std::fmt::Display) -> Self {
        MemoryError::Io {
            detail: e.to_string(),
        }
    }
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryError::IndexFull { detail } => {
                write!(f, "workspace memory index is at its cap: {detail}")
            }
            MemoryError::Invalid { detail } => write!(f, "invalid memory input: {detail}"),
            MemoryError::Io { detail } => write!(f, "{detail}"),
        }
    }
}

/// The memory directory for a workspace root (sibling of the datasets
/// manifest inside `.toptopduck/`).
fn memory_dir(workspace: &Path) -> PathBuf {
    workspace.join(".toptopduck").join(MEMORY_DIR_NAME)
}

/// The derived index path.
fn index_path(workspace: &Path) -> PathBuf {
    memory_dir(workspace).join(MEMORY_INDEX_NAME)
}

/// FNV-1a 32-bit (the pure-CJK slug fallback): tiny, dependency-free, and
/// collision-far-enough for human-scale title sets -- two distinct pure
/// Chinese titles land distinct file names.
fn fnv1a32(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The slug for a title: lowercase ASCII alphanumerics + hyphens, runs of
/// anything else collapsing to one hyphen, trimmed, capped at
/// [`SLUG_MAX_CHARS`]. A title that cleans to nothing (pure CJK, pure
/// punctuation) falls back to the title's FNV-1a hash as `n<hash>` so two
/// pure-Chinese titles never collide on the same file.
fn slug_for(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_hyphen = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            pending_hyphen = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    if slug.chars().count() > SLUG_MAX_CHARS {
        slug = slug.chars().take(SLUG_MAX_CHARS).collect();
        // A cap landing mid-word keeps no trailing hyphen.
        while slug.ends_with('-') {
            slug.pop();
        }
    }
    if slug.is_empty() {
        format!("n{:x}", fnv1a32(title))
    } else {
        slug
    }
}

/// The injection-side single-line clamp shared by BOTH index surfaces
/// (#1019's posture: stored text is distrusted at injection): fold
/// `\r`/`\n`/`\t` to one space first (a hostile or hand-edited entry cannot
/// forge extra rows or a fake section header inside an injected block),
/// then clamp at `max_chars` CHARS with an ellipsis tail -- char
/// boundaries only, a CJK glyph is never split. The memory index calls it
/// with [`HOOK_MAX_CHARS`] (titles + hooks); the skill index calls it with
/// its own description budget on the prompt side.
pub(crate) fn clamp_injection_line(text: &str, max_chars: usize) -> String {
    let folded = fold_line(text);
    if folded.chars().count() <= max_chars {
        return folded;
    }
    let mut clamped: String = folded.chars().take(max_chars - 1).collect();
    clamped.push('…');
    clamped
}

/// Fold the characters a single-line surface cannot carry (`\r`, `\n`,
/// `\t`) to one space. Shared by the injection clamp and the frontmatter
/// writer: a raw multi-line value inside the fence would forge extra
/// `key:` lines that a re-parse then reads as fields.
fn fold_line(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\r' | '\n' | '\t' => ' ',
            c => c,
        })
        .collect()
}

/// Render the index document from rows: the header + one
/// `- [title](file) — hook` line per row.
fn render_index(rows: &[MemoryIndexRow]) -> String {
    let mut out = String::from("# Memory Index\n\n");
    for row in rows {
        out.push_str(&format!(
            "- [{}]({}) — {}\n",
            clamp_injection_line(&row.title, HOOK_MAX_CHARS),
            row.file,
            clamp_injection_line(&row.hook, HOOK_MAX_CHARS)
        ));
    }
    out
}

/// Parse one memory file's frontmatter. Tolerant (issue #1529): a missing
/// field falls back (name <- file stem, description <- empty, type <-
/// reference, source <- manual, stamps <- empty) and extra fields are
/// ignored; `None` only when the text has no frontmatter fence at all (not
/// a memory file -- the caller skips it).
fn parse_frontmatter(text: &str, file_stem: &str) -> Option<MemoryEntry> {
    let mut lines = text.lines();
    if lines.next()?.trim() != FENCE {
        return None;
    }
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut kind: Option<MemoryType> = None;
    let mut origin_session: Option<String> = None;
    let mut saved_at: Option<String> = None;
    let mut source: Option<MemorySource> = None;
    for line in lines.by_ref() {
        if line.trim() == FENCE {
            return Some(MemoryEntry {
                name: name.unwrap_or_else(|| file_stem.to_string()),
                description: description.unwrap_or_default(),
                r#type: kind.unwrap_or(MemoryType::Reference),
                origin_session,
                saved_at: saved_at.unwrap_or_default(),
                source: source.unwrap_or(MemorySource::Manual),
            });
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "name" => name = Some(value.to_string()),
            "description" => description = Some(value.to_string()),
            "type" => {
                kind = match value {
                    "user" => Some(MemoryType::User),
                    "feedback" => Some(MemoryType::Feedback),
                    "project" => Some(MemoryType::Project),
                    "reference" => Some(MemoryType::Reference),
                    _ => None,
                };
            }
            "origin_session" if !value.is_empty() => origin_session = Some(value.to_string()),
            "saved_at" => saved_at = Some(value.to_string()),
            "source" => {
                source = match value {
                    "extract" => Some(MemorySource::Extract),
                    _ => Some(MemorySource::Manual),
                };
            }
            _ => {}
        }
    }
    None
}

/// The memory file name's type segment, parsed back (`user-foo.md` ->
/// `user`). Tolerant: anything unparsable yields `None` (the row then
/// carries the frontmatter's own type).
fn type_from_file_name(name: &str) -> Option<MemoryType> {
    let stem = name.strip_suffix(".md")?;
    let head = stem.split('-').next()?;
    match head {
        "user" => Some(MemoryType::User),
        "feedback" => Some(MemoryType::Feedback),
        "project" => Some(MemoryType::Project),
        "reference" => Some(MemoryType::Reference),
        _ => None,
    }
}

/// Read the memory index rows (issue #1529 read path): scan the memory
/// directory's `.md` files (the source of truth), derive one row per
/// parseable file, then reconcile `MEMORY.md` -- rewritten when missing or
/// drifted. NEVER fails and never creates the DIRECTORY family: a missing
/// directory is the empty set and stays missing (zero footprint), a
/// corrupt file is skipped + logged. The index reconcile is the one write
/// a read performs, and only when the memory directory already exists.
pub fn load_rows(workspace: &Path) -> Vec<MemoryIndexRow> {
    let (rows, _unreadable) = scan_and_reconcile(workspace);
    rows
}

/// Scan the memory directory's files: the parsed rows plus the names that
/// LOOK like memories (`.md`, not the index) but carry no frontmatter
/// fence or are unreadable -- the panel's unreadable list (#1538: a
/// hand-written file with a missing fence must never vanish silently).
/// `MEMORY.md` and non-`.md` files are not memories and never surface.
fn scan_memory_files(workspace: &Path) -> (Vec<MemoryIndexRow>, Vec<String>) {
    let dir = memory_dir(workspace);
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return (Vec::new(), Vec::new());
    };
    let mut rows = Vec::new();
    let mut unreadable = Vec::new();
    for entry_path in read_dir.flatten() {
        let path = entry_path.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let name = name.to_string();
        if path.is_dir() || name == MEMORY_INDEX_NAME || !name.ends_with(".md") {
            continue;
        }
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse_frontmatter(&text, name.strip_suffix(".md").unwrap_or(&name)));
        let Some(parsed) = parsed else {
            log::warn!(
                target: "toptopduck::workspace_memory",
                "memory file without frontmatter skipped: {}",
                path.display()
            );
            unreadable.push(name);
            continue;
        };
        rows.push(MemoryIndexRow {
            title: parsed.name,
            file: name,
            hook: parsed.description,
        });
    }
    rows.sort_by(|a, b| a.file.cmp(&b.file));
    unreadable.sort();
    (rows, unreadable)
}

/// The read-path scan: the files' rows + the unreadable names, with the
/// derived index reconciled from the files (the one read that writes).
fn scan_and_reconcile(workspace: &Path) -> (Vec<MemoryIndexRow>, Vec<String>) {
    let (rows, unreadable) = scan_memory_files(workspace);
    reconcile_index(workspace, &rows);
    (rows, unreadable)
}

/// The index usage ratio (issue #1530): the WORSE of the two capacity hats
/// as a percentage, clamped to 100. Drives the panel's color scale (80
/// yellow / 95 red) and the red-cap extraction pause. Computed from the
/// same render the write path refuses on, so the percentage the panel
/// shows is the percentage the cap enforces.
pub(crate) fn index_usage_percent(rows: &[MemoryIndexRow]) -> u8 {
    let row_pct = rows.len().saturating_mul(100) / INDEX_MAX_ROWS;
    let byte_pct = render_index(rows).len().saturating_mul(100) / INDEX_MAX_BYTES;
    row_pct.max(byte_pct).min(100) as u8
}

/// The panel's full read (issue #1530's calibration): the list rows plus
/// the index usage percentage, from ONE directory scan. The percentage is
/// the same ratio the write path's caps enforce, so the panel's color
/// scale never disagrees with the refusal. The unreadable list (#1538)
/// names the fence-less `.md` files the panel surfaces separately.
pub fn list_section(workspace: &Path) -> ListedMemorySection {
    let (rows, unreadable) = scan_and_reconcile(workspace);
    let usage_percent = index_usage_percent(&rows);
    let memories = rows
        .into_iter()
        .map(|row| {
            let kind = type_from_file_name(&row.file).unwrap_or(MemoryType::Reference);
            let file_path = memory_dir(workspace)
                .join(&row.file)
                .to_string_lossy()
                .into_owned();
            ListedMemory {
                r#type: kind,
                file_path,
                row,
            }
        })
        .collect();
    ListedMemorySection {
        rows: memories,
        usage_percent,
        unreadable,
    }
}

/// The panel's list face: rows plus typed category + absolute path.
/// (Retained for the test suites' direct row fixtures; the command layer
/// reads [`list_section`], and this delegates to it so the row mapping
/// lives once.)
pub fn list(workspace: &Path) -> Vec<ListedMemory> {
    list_section(workspace).rows
}

/// Rewrite the derived index when it has drifted from the files (the files
/// win, issue #1529). Best-effort + logged: a failed reconcile leaves the
/// stale index on disk -- the in-memory rows are already the truth the
/// callers use, and the next successful read retries the rewrite.
fn reconcile_index(workspace: &Path, rows: &[MemoryIndexRow]) {
    let rendered = render_index(rows);
    let path = index_path(workspace);
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current == rendered {
        return;
    }
    if let Err(e) = write_str_atomic(&path, &rendered, WritePerms::Default) {
        log::warn!(
            target: "toptopduck::workspace_memory",
            "memory index reconcile failed for {}: {e}",
            path.display()
        );
    }
}

/// Serialize one entry's frontmatter block + body (the storage protocol's
/// write shape; the field order is the canonical on-disk order).
fn render_memory_file(entry: &MemoryEntry, body: &str) -> String {
    let mut out = String::new();
    out.push_str(FENCE);
    out.push('\n');
    out.push_str(&format!("name: {}\n", fold_line(&entry.name)));
    out.push_str(&format!("description: {}\n", fold_line(&entry.description)));
    out.push_str(&format!("type: {}\n", entry.r#type.as_segment()));
    if let Some(session) = &entry.origin_session {
        out.push_str(&format!("origin_session: {session}\n"));
    }
    out.push_str(&format!("saved_at: {}\n", entry.saved_at));
    out.push_str(&format!(
        "source: {}\n",
        match entry.source {
            MemorySource::Extract => "extract",
            MemorySource::Manual => "manual",
        }
    ));
    out.push_str(FENCE);
    out.push('\n');
    out.push_str(body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// The unique file name for a new entry: `<type>-<slug>.md`, de-conflicted
/// against the taken names with a `-2`, `-3`, ... suffix.
fn unique_file_name(taken: &std::collections::HashSet<String>, entry: &MemoryEntry) -> String {
    let base = format!("{}-{}", entry.r#type.as_segment(), slug_for(&entry.name));
    let mut candidate = format!("{base}.md");
    let mut counter = 2;
    while taken.contains(&candidate) {
        candidate = format!("{base}-{counter}.md");
        counter += 1;
    }
    candidate
}

/// The index-full refusal's warning face (issue #1529: refuse AND warn --
/// never a silent refusal). Every `IndexFull` return logs the cap it hit.
fn warn_index_full(workspace: &Path, detail: String) {
    log::warn!(
        target: "toptopduck::workspace_memory",
        "memory index at its cap for {} -- entry refused ({detail})",
        workspace.display()
    );
}

/// Save a new memory entry (the write primitive; the host extraction path
/// (#1530) and tests are the callers): creates the memory directory family
/// lazily on this FIRST write only, lands the file atomically, and rewrites
/// the derived index. The capacity caps REFUSE the entry before anything
/// lands -- never a silent truncation, never a head cut. Landing order:
/// the memory file write precedes the index write, so an index-write
/// failure returns `Err` with the fact already persisted -- the next read
/// reconciles the index from the files, and a caller must not read that
/// error as the entry being absent.
/// Serializes every workspace's [`save_entry`] against the concurrent
/// unique-file-name race (issue #1530 review): two sessions extracting
/// into one workspace can both load the taken set before either writes,
/// minting the same file name and overwriting each other's memory file.
/// One global lock is correct at extraction's write rate (one call per
/// turn); per-workspace locks only if cross-workspace contention ever
/// matters.
static SAVE_ENTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn save_entry(
    workspace: &Path,
    entry: &MemoryEntry,
    body: &str,
) -> Result<MemoryIndexRow, MemoryError> {
    let _guard = SAVE_ENTRY_LOCK.lock().expect("memory save lock poisoned");
    let rows = load_rows(workspace);
    if rows.len() >= INDEX_MAX_ROWS {
        warn_index_full(workspace, format!("{INDEX_MAX_ROWS} rows"));
        return Err(MemoryError::IndexFull {
            detail: format!("{INDEX_MAX_ROWS} rows"),
        });
    }
    let taken: std::collections::HashSet<String> = rows.iter().map(|r| r.file.clone()).collect();
    let file = unique_file_name(&taken, entry);
    let row = MemoryIndexRow {
        title: entry.name.clone(),
        hook: entry.description.clone(),
        file: file.clone(),
    };
    let mut next_rows = rows;
    next_rows.push(row.clone());
    next_rows.sort_by(|a, b| a.file.cmp(&b.file));
    let rendered = render_index(&next_rows);
    if rendered.len() > INDEX_MAX_BYTES {
        warn_index_full(workspace, format!("{INDEX_MAX_BYTES} bytes"));
        return Err(MemoryError::IndexFull {
            detail: format!("{INDEX_MAX_BYTES} bytes"),
        });
    }
    std::fs::create_dir_all(memory_dir(workspace)).map_err(MemoryError::io)?;
    let file_path = memory_dir(workspace).join(&file);
    write_str_atomic(
        &file_path,
        &render_memory_file(entry, body),
        WritePerms::Default,
    )
    .map_err(MemoryError::io)?;
    write_str_atomic(&index_path(workspace), &rendered, WritePerms::Default)
        .map_err(MemoryError::io)?;
    Ok(row)
}

/// Create a memory from the panel's form (issue #1538): the host stamps
/// `source: manual` + today's absolute date + no origin session, and the
/// body carries the description (the form's one-liner). The blank-title
/// guard lives HERE, not in the UI alone -- every future caller of the
/// store inherits it. Rides [`save_entry`], so the caps, the global save
/// lock, and the index reconcile all apply unchanged.
pub fn create_entry(
    workspace: &Path,
    title: &str,
    description: &str,
    r#type: MemoryType,
) -> Result<MemoryIndexRow, MemoryError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(MemoryError::Invalid {
            detail: "title is blank".to_string(),
        });
    }
    let description = description.trim();
    let entry = MemoryEntry {
        name: title.to_string(),
        description: description.to_string(),
        r#type,
        origin_session: None,
        saved_at: chrono::Local::now().format("%Y-%m-%d").to_string(),
        source: MemorySource::Manual,
    };
    save_entry(workspace, &entry, description)
}

/// The folder-open primitive (issue #1538): create the directory family on
/// demand and return its path -- the one sanctioned eager mkdir, so the
/// panel's "open memory folder" works on the zero-footprint fresh
/// workspace too (the read path stays lazy). Idempotent.
pub fn ensure_memory_dir(workspace: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(memory_dir(workspace))?;
    Ok(memory_dir(workspace))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The usage ratio drives the panel color scale + the red-cap pause
    /// (issue #1530): it reports the WORSE hat, clamped at 100.
    #[test]
    fn usage_percent_reports_the_worse_hat_clamped() {
        fn row(title: &str) -> MemoryIndexRow {
            MemoryIndexRow {
                title: title.to_string(),
                file: format!("feedback-{title}.md"),
                hook: "hook".to_string(),
            }
        }
        assert_eq!(index_usage_percent(&[]), 0);
        // 190/200 rows = 95% with bytes far under the byte hat.
        let rows_190: Vec<MemoryIndexRow> = (0..190).map(|i| row(&format!("f{i}"))).collect();
        assert_eq!(index_usage_percent(&rows_190), 95);
        // 200 rows = the row hat at 100.
        let rows_200: Vec<MemoryIndexRow> = (0..200).map(|i| row(&format!("f{i}"))).collect();
        assert_eq!(index_usage_percent(&rows_200), 100);
        // A hand-stuffed pile beyond the cap clamps at 100, never overflows.
        let rows_300: Vec<MemoryIndexRow> = (0..300).map(|i| row(&format!("f{i}"))).collect();
        assert_eq!(index_usage_percent(&rows_300), 100);
    }

    fn ws() -> tempfile::TempDir {
        tempfile::tempdir().expect("workspace dir")
    }

    fn entry(name: &str) -> MemoryEntry {
        MemoryEntry {
            name: name.to_string(),
            description: "one-line hook".to_string(),
            r#type: MemoryType::Feedback,
            origin_session: Some("s-1".to_string()),
            saved_at: "2026-11-09".to_string(),
            source: MemorySource::Manual,
        }
    }

    /// The full round trip: save lands file + index, and the read path
    /// recovers the row from the FILE side (frontmatter is the truth).
    #[test]
    fn save_then_load_round_trips_the_row() {
        let workspace = ws();
        let row = save_entry(workspace.path(), &entry("reply in chinese"), "body\n").expect("save");
        assert_eq!(row.file, "feedback-reply-in-chinese.md");
        let rows = load_rows(workspace.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "reply in chinese");
        assert_eq!(rows[0].hook, "one-line hook");
        assert_eq!(rows[0].file, "feedback-reply-in-chinese.md");
        // The index landed on disk in the protocol's line shape.
        let index = std::fs::read_to_string(index_path(workspace.path())).unwrap();
        assert!(
            index.contains("- [reply in chinese](feedback-reply-in-chinese.md) — one-line hook\n")
        );
    }

    /// The frontmatter serializer + parser round-trip every field.
    #[test]
    fn frontmatter_round_trips_all_fields() {
        let e = entry("full fields");
        let text = render_memory_file(&e, "why + how\n");
        let parsed = parse_frontmatter(&text, "ignored-stem").expect("parses");
        assert_eq!(parsed, e);
    }

    /// A multi-line description (the panel's textarea allows it) folds to
    /// ONE frontmatter line -- a raw newline inside the fence would forge
    /// `key:` lines a re-parse would read as fields -- while the body keeps
    /// its newlines verbatim.
    #[test]
    fn multiline_description_folds_in_frontmatter_body_stays_verbatim() {
        let mut e = entry("multiline");
        e.description = "first line\ntype: user\nthird".to_string();
        let text = render_memory_file(&e, "body line one\nbody line two\n");
        let parsed = parse_frontmatter(&text, "ignored-stem").expect("parses");
        assert_eq!(parsed.description, "first line type: user third");
        assert_eq!(parsed.r#type, e.r#type);
        assert!(text.contains("body line one\nbody line two\n"));
    }

    /// Tolerant parse: a missing field never crashes -- name falls back to
    /// the file stem, the type to reference, source to manual; an unknown
    /// type value degrades to reference; extra fields are ignored.
    #[test]
    fn missing_and_extra_fields_parse_tolerantly() {
        let minimal = "---\nname: keeps\nunknown: junk\n---\nbody\n";
        let parsed = parse_frontmatter(minimal, "stem-fallback").expect("parses");
        assert_eq!(parsed.name, "keeps");
        assert_eq!(parsed.description, "");
        assert_eq!(parsed.r#type, MemoryType::Reference);
        assert_eq!(parsed.source, MemorySource::Manual);
        assert_eq!(parsed.saved_at, "");
        let no_name = "---\ntype: project\n---\n";
        let parsed = parse_frontmatter(no_name, "stem-fallback").expect("parses");
        assert_eq!(parsed.name, "stem-fallback");
        assert_eq!(parsed.r#type, MemoryType::Project);
        let unknown_type = "---\nname: x\ntype: diary\n---\n";
        let parsed = parse_frontmatter(unknown_type, "s").expect("parses");
        assert_eq!(parsed.r#type, MemoryType::Reference);
        // No fence at all: not a memory file.
        assert!(parse_frontmatter("plain prose\n", "s").is_none());
    }

    /// Two pure-Chinese titles never collide: each cleans to the empty
    /// slug, so each lands its FNV-1a hash file name (the 中文必走路径).
    #[test]
    fn pure_cjk_titles_do_not_collide() {
        let a = slug_for("偏好中文回复");
        let b = slug_for("季度数据用中文列名");
        assert_ne!(a, b, "distinct titles hash to distinct slugs");
        assert!(
            a.starts_with('n') && b.starts_with('n'),
            "hash fallback shape"
        );
        let workspace = ws();
        let row_a = save_entry(workspace.path(), &entry("偏好中文回复"), "a\n").expect("a");
        let row_b = save_entry(workspace.path(), &entry("季度数据用中文列名"), "b\n").expect("b");
        assert_ne!(row_a.file, row_b.file);
        assert_eq!(load_rows(workspace.path()).len(), 2);
    }

    /// The slug rules: lowercase, collapse separators, trim, cap at 48.
    #[test]
    fn slug_cleans_and_caps() {
        assert_eq!(slug_for("  Hello -- World!  "), "hello-world");
        assert_eq!(slug_for("A"), "a");
        let long = "a".repeat(80);
        assert_eq!(slug_for(&long).chars().count(), SLUG_MAX_CHARS);
        let mixed = "Data 集分析 Report";
        assert_eq!(slug_for(mixed), "data-report");
    }

    /// Two same-title saves de-conflict with a -2 suffix (no overwrite).
    #[test]
    fn same_title_saves_deconflict() {
        let workspace = ws();
        let first = save_entry(workspace.path(), &entry("dup"), "1\n").expect("first");
        let second = save_entry(workspace.path(), &entry("dup"), "2\n").expect("second");
        assert_eq!(first.file, "feedback-dup.md");
        assert_eq!(second.file, "feedback-dup-2.md");
        assert_eq!(load_rows(workspace.path()).len(), 2);
    }

    /// The concurrent face of the de-conflict contract (issue #1530
    /// review): same-title saves racing from several threads must all
    /// land -- the save lock serializes the read-modify-write, so no
    /// thread's file silently overwrites another's.
    #[test]
    fn concurrent_same_title_saves_keep_every_file() {
        let workspace = ws();
        let path = workspace.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    save_entry(&path, &entry("race"), &format!("body {i}\n")).expect("save");
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread panicked");
        }
        assert_eq!(load_rows(workspace.path()).len(), 8);
    }

    /// The row cap refuses BEFORE anything lands: 200 rows is the ceiling,
    /// the 201st save is an IndexFull and the disk state is untouched.
    #[test]
    fn row_cap_refuses_the_201st_entry() {
        let workspace = ws();
        for i in 0..INDEX_MAX_ROWS {
            save_entry(workspace.path(), &entry(&format!("fact {i}")), "b\n").expect("save");
        }
        let before = load_rows(workspace.path());
        let err = save_entry(workspace.path(), &entry("one too many"), "b\n").expect_err("refused");
        assert!(matches!(err, MemoryError::IndexFull { .. }), "{err:?}");
        assert_eq!(load_rows(workspace.path()).len(), before.len());
    }

    /// The byte cap refuses too: the cap reads the RENDERED index (hooks and
    /// titles already at their clamp), so it trips on row COUNT x line size
    /// -- long-title entries accumulate until the next save would pass
    /// 25,000 bytes, and that save is refused whole: never a silent
    /// truncation, never a head cut of old rows, the on-disk index stays
    /// under the cap.
    #[test]
    fn byte_cap_refuses_without_truncation() {
        let workspace = ws();
        // A title at the clamp ceiling: each rendered line is ~360 bytes of
        // CJK, so the cap trips well before the 200-row ceiling.
        let long_title = "题".repeat(HOOK_MAX_CHARS);
        let mut landed = 0;
        let mut refused = None;
        for i in 0..80 {
            let mut e = entry(&format!("{long_title}{i}"));
            e.description = String::new();
            match save_entry(workspace.path(), &e, "b\n") {
                Ok(_) => landed += 1,
                Err(err) => {
                    refused = Some(err);
                    break;
                }
            }
        }
        let err = refused.expect("the byte cap trips inside 80 long rows");
        assert!(matches!(err, MemoryError::IndexFull { .. }), "{err:?}");
        // The refused entry landed nothing: the rows on disk are exactly the
        // successful saves, and the index never crossed the cap.
        assert_eq!(load_rows(workspace.path()).len(), landed);
        let index = std::fs::read_to_string(index_path(workspace.path())).unwrap();
        assert!(index.len() <= INDEX_MAX_BYTES, "{}", index.len());
        assert!(landed < 80, "the cap actually tripped");
    }

    /// Every truncation path walks char boundaries: a CJK-heavy hook
    /// clamps at HOOK_MAX_CHARS visible chars, never splitting a glyph.
    #[test]
    fn hook_clamp_never_splits_a_cjk_glyph() {
        let clamped = clamp_injection_line(&"汉".repeat(HOOK_MAX_CHARS + 10), HOOK_MAX_CHARS);
        assert_eq!(clamped.chars().count(), HOOK_MAX_CHARS);
        assert!(clamped.ends_with('…'));
        assert!(clamped.chars().all(|c| c == '汉' || c == '…'));
        // Layout folding: no \r \n \t survives into an index line (each
        // control char folds to its own space -- the #1019 precedent).
        let folded = clamp_injection_line("a\r\nb\tc", HOOK_MAX_CHARS);
        assert_eq!(folded, "a  b c");
        // Under the cap: verbatim.
        assert_eq!(clamp_injection_line("short", HOOK_MAX_CHARS), "short");
    }

    /// Zero footprint: a read on a fresh workspace creates NOTHING, and
    /// the first save creates the directory family + index.
    #[test]
    fn read_creates_nothing_and_first_save_creates_the_family() {
        let workspace = ws();
        assert!(load_rows(workspace.path()).is_empty());
        assert!(
            !memory_dir(workspace.path()).exists(),
            "no directory minted"
        );
        save_entry(workspace.path(), &entry("first"), "b\n").expect("save");
        assert!(memory_dir(workspace.path()).is_dir());
        assert!(index_path(workspace.path()).is_file());
    }

    /// The index is derived: a hand-edited (or deleted) MEMORY.md is
    /// rewritten from the files on the next read -- the files win.
    #[test]
    fn drifted_index_is_rewritten_from_the_files() {
        let workspace = ws();
        save_entry(workspace.path(), &entry("fact a"), "b\n").expect("save");
        // Hand-vandalize the index.
        std::fs::write(index_path(workspace.path()), "garbage").unwrap();
        let rows = load_rows(workspace.path());
        assert_eq!(rows.len(), 1, "rows come from the files, not the index");
        let index = std::fs::read_to_string(index_path(workspace.path())).unwrap();
        assert!(index.contains("- [fact a]"), "index reconciled: {index}");
        // A deleted index is also rebuilt.
        std::fs::remove_file(index_path(workspace.path())).unwrap();
        load_rows(workspace.path());
        assert!(index_path(workspace.path()).is_file());
    }

    /// A corrupt file (unreadable UTF-8 / no frontmatter) is skipped +
    /// never crashes the read; healthy siblings still surface.
    #[test]
    fn corrupt_file_is_skipped_and_siblings_survive() {
        let workspace = ws();
        save_entry(workspace.path(), &entry("healthy"), "b\n").expect("save");
        std::fs::write(memory_dir(workspace.path()).join("broken.md"), "no fence\n").unwrap();
        let rows = load_rows(workspace.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "healthy");
    }

    /// The panel face: typed category off the file name, absolute path for
    /// the reveal target.
    #[test]
    fn list_face_carries_type_and_absolute_path() {
        let workspace = ws();
        save_entry(workspace.path(), &entry("fact a"), "b\n").expect("save");
        let listed = list(workspace.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].r#type, MemoryType::Feedback);
        assert!(listed[0].file_path.contains("feedback-fact-a.md"));
        assert!(Path::new(&listed[0].file_path).is_absolute());
    }

    // ---- The #1538 write-path faces: manual create, folder open,
    // unreadable visibility. ----

    /// The manual create stamps the host fields (`source: manual`, today's
    /// absolute date, no origin session) and lands the file + index row;
    /// the body carries the description (the form's one-liner).
    #[test]
    fn create_entry_stamps_manual_source_and_today() {
        let workspace = ws();
        let row = create_entry(
            workspace.path(),
            "reply in chinese",
            "always zh",
            MemoryType::User,
        )
        .expect("create");
        assert_eq!(row.file, "user-reply-in-chinese.md");
        let listed = list_section(workspace.path());
        assert_eq!(listed.rows.len(), 1);
        assert_eq!(listed.rows[0].row.title, "reply in chinese");
        let text = std::fs::read_to_string(memory_dir(workspace.path()).join(&row.file)).unwrap();
        let parsed = parse_frontmatter(&text, "s").expect("parses");
        assert_eq!(parsed.source, MemorySource::Manual);
        assert_eq!(parsed.origin_session, None);
        // The stamp is an absolute date -- pinned by SHAPE, not by comparing
        // two live `now()` evaluations (a midnight-crossing race would make
        // a same-expression compare flake).
        assert!(
            chrono::NaiveDate::parse_from_str(&parsed.saved_at, "%Y-%m-%d").is_ok(),
            "saved_at is an absolute date: {}",
            parsed.saved_at
        );
        assert!(text.contains("always zh"), "body carries the one-liner");
        let index = std::fs::read_to_string(index_path(workspace.path())).unwrap();
        assert!(
            index.contains("- [reply in chinese](user-reply-in-chinese.md) — always zh\n"),
            "{index}"
        );
    }

    /// A blank title is refused before anything lands -- the required-field
    /// guard lives in the store, not the UI alone, and the fresh workspace
    /// mints nothing.
    #[test]
    fn create_entry_refuses_a_blank_title() {
        let workspace = ws();
        let err =
            create_entry(workspace.path(), "   ", "d", MemoryType::Reference).expect_err("refused");
        assert!(matches!(err, MemoryError::Invalid { .. }), "{err:?}");
        assert!(!memory_dir(workspace.path()).exists(), "nothing minted");
    }

    /// Fence-less .md files surface as unreadable in the section; the index
    /// and non-.md files never do; healthy rows are untouched.
    #[test]
    fn unreadable_files_surface_in_the_section() {
        let workspace = ws();
        save_entry(workspace.path(), &entry("healthy"), "b\n").expect("save");
        let dir = memory_dir(workspace.path());
        std::fs::write(dir.join("broken.md"), "no fence\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "plain\n").unwrap();
        let listed = list_section(workspace.path());
        assert_eq!(listed.rows.len(), 1);
        assert_eq!(listed.rows[0].row.title, "healthy");
        assert_eq!(listed.unreadable, vec!["broken.md".to_string()]);
    }

    /// The folder-open primitive: creates the directory family on demand
    /// (the one sanctioned eager mkdir) and is idempotent.
    #[test]
    fn ensure_memory_dir_creates_the_family() {
        let workspace = ws();
        assert!(!memory_dir(workspace.path()).exists());
        let dir = ensure_memory_dir(workspace.path()).expect("ensure");
        assert!(dir.is_dir());
        assert!(dir.ends_with("memory"));
        ensure_memory_dir(workspace.path()).expect("again");
    }

    /// The pure-CJK title rides the same slug protocol through create_entry
    /// (the FNV-1a hash fallback -- the 中文必走路径, pinned on the new
    /// command per #1538's acceptance row).
    #[test]
    fn create_entry_pure_cjk_title_hashes_the_slug() {
        let workspace = ws();
        let row = create_entry(
            workspace.path(),
            "偏好中文回复",
            "always zh",
            MemoryType::User,
        )
        .expect("create");
        assert!(row.file.starts_with("user-n"), "hash shape: {}", row.file);
        assert_eq!(load_rows(workspace.path()).len(), 1);
    }
}
