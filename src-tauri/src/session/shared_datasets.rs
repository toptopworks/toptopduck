//! The session-side face of the workspace shared-dataset store (ADR-0141):
//! the sticky attach table (挂名), the lazy first-reference attach, the
//! first-mention-per-turn fingerprint validation (re-attach / retire,
//! frozen within the turn -- D7), and the resume restore. The session NEVER writes the store or the manifest from
//! here -- this module only links (`hard_link`, copy fallback) + attaches
//! READ_ONLY + registers, the exact posture of a private ingest with the
//! store standing in for the source file.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::ingest::schema::attach_sql;
use crate::model::{
    DatasetDescriptor, RectifyProvenance, SharedAttachEvent, StaleAnchor, StaleReason,
};
use crate::session::engine::AdminEngine;
use crate::workingset::WorkingSet;
use crate::workspace::datasets;
use crate::workspace::DatasetEntry;

/// Why a shared-reference resolution refused the call. Maps onto the two
/// gateway-door error kinds the callers already render distinctly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SharedRefError {
    /// The attached source's workspace entry is gone (ADR-0141 D7): the name
    /// (and its cascade) turned stale and may not anchor a new query.
    Stale(String),
    /// Anything else (corrupt manifest, missing store file, attach failure) --
    /// honest runtime text the agent / user can act on (D8).
    Runtime(String),
}

/// One sticky attach record: the manifest entry a 挂名 resolves to, plus the
/// fingerprint at attach time (empty until the first attach lands -- card-time
/// pre-assignments reserve the name before any SQL references it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttachRecord {
    pub entry_name: String,
    pub fingerprint: String,
}

/// The per-session shared attach table (ADR-0141 D6/D9): 挂名 → manifest
/// entry. Sticky by design -- a name SQL has referenced (or a card has shown)
/// never drifts within a session, so recorded SQL keeps answering to it.
#[derive(Debug, Default)]
pub(crate) struct SharedAttaches {
    attaches: HashMap<String, AttachRecord>,
    /// Attach events landed mid-turn, drained onto the timeline at settle (the
    /// dispatch path cannot touch the timeline directly; the turn's record
    /// step flushes these beside the turn entry).
    pending: Vec<SharedAttachEvent>,
    /// Names whose fingerprints were already checked this turn (D7: a turn
    /// serves the world of each name's first mention; mid-turn manifest
    /// changes stay invisible until the next turn's first mention).
    validated: HashSet<String>,
}

impl SharedAttaches {
    /// Events landed since the last drain (the settle step consumes them).
    pub(crate) fn take_pending_events(&mut self) -> Vec<SharedAttachEvent> {
        std::mem::take(&mut self.pending)
    }

    /// ADR-0141 D7 turn boundary: thaw the per-turn validation cache so the
    /// next turn's first mention of each 挂名 re-checks the manifest (a
    /// replace re-attaches, a gone entry retires + cascades as stale).
    pub(crate) fn advance_turn(&mut self) {
        self.validated.clear();
    }

    /// The record behind a 挂名, if attached (or pre-assigned).
    pub(crate) fn record(&self, name: &str) -> Option<&AttachRecord> {
        self.attaches.get(name)
    }

    /// Resolve (or pre-assign) the 挂名 for a manifest entry: a recorded attach
    /// keeps its name; a fresh entry takes its own name when free, else the
    /// first free `name_N` against BOTH the working set and the existing 挂名s
    /// -- the private de-conflict scheme inverted onto the shared vocabulary
    /// (D6: 仅私有既成占用时共享挂消歧名).
    pub(crate) fn resolve_or_assign(&mut self, entry_name: &str, ws: &WorkingSet) -> String {
        if let Some(name) = self
            .attaches
            .iter()
            .find(|(_, rec)| rec.entry_name == entry_name)
            .map(|(name, _)| name.clone())
        {
            return name;
        }
        let taken = |n: &str| ws.taken(n) || self.attaches.contains_key(n);
        let name = if !taken(entry_name) {
            entry_name.to_string()
        } else {
            (2..)
                .map(|n| format!("{entry_name}_{n}"))
                .find(|candidate| !taken(candidate))
                .expect("the numeric suffix space cannot exhaust")
        };
        self.attaches.insert(
            name.clone(),
            AttachRecord {
                entry_name: entry_name.to_string(),
                fingerprint: String::new(),
            },
        );
        name
    }
}

/// ADR-0141 D6 私有让位: the shared vocabulary joins a private
/// registration's de-conflict occupancy -- the bound workspace's manifest
/// entry names plus the session's attach reservations (sticky 挂名s, empty
/// card-time reservations included: a name a card showed must never be lost
/// to a later private registration -- the dead-card rule, D3).
pub(crate) fn deconflict_with_shared(
    candidate: &str,
    working_set: &WorkingSet,
    workspace: Option<&Path>,
    attaches: Option<&SharedAttaches>,
) -> String {
    let mut reserved: HashSet<String> = HashSet::new();
    if let Some(table) = attaches {
        reserved.extend(table.attaches.keys().cloned());
    }
    if let Some(dir) = workspace {
        match datasets::load_entries(dir) {
            Ok(entries) => reserved.extend(entries.into_iter().map(|e| e.reference_name)),
            Err(e) => log::warn!(
                target: "toptopduck::session",
                "shared name reservation degraded (manifest unreadable): {e}"
            ),
        }
    }
    working_set.deconflict_with(candidate, &reserved)
}

/// Link the store file into the session tree (hard link preferred -- the
/// link count IS the reference count, D2's lifecycle outsourcing; a copy
/// stands in when the volumes refuse to link, trading disk for correctness).
fn link_into_tree(store: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        // A shared attach may be the tree's FIRST snapshot (no private ingest
        // has run) -- the snapshots dir does not exist yet.
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::remove_file(dest);
    if fs::hard_link(store, dest).is_ok() {
        return Ok(());
    }
    fs::copy(store, dest).map(|_| ()).map_err(|e| {
        format!(
            "store link failed ({} -> {}): {e}",
            store.display(),
            dest.display()
        )
    })
}

/// Attach one shared dataset into the session: link + ATTACH READ_ONLY +
/// register (active pointer preserved -- a lazy attach is not a user upload).
fn attach_shared(
    engine: &AdminEngine,
    source_files: &mut HashMap<String, PathBuf>,
    working_set: &mut WorkingSet,
    snapshot_dir: &Path,
    workspace: &Path,
    name: &str,
    entry: &DatasetEntry,
) -> Result<(), String> {
    let store = datasets::store_file(workspace, &entry.fingerprint);
    if !store.exists() {
        return Err(format!(
            "共享数据集「{name}」的存储文件缺失（工作区清单条目 {entry}）；请在工作区管理面板重新添加该数据集",
            entry = entry.reference_name
        ));
    }
    let dest = snapshot_dir.join(format!("{name}.duckdb"));
    link_into_tree(&store, &dest)?;
    if let Err(e) = engine.execute_batch(&attach_sql(&dest.to_string_lossy(), name)) {
        let _ = fs::remove_file(&dest);
        return Err(format!("failed to attach shared dataset {name}: {e}"));
    }
    source_files.insert(name.to_string(), dest);
    let descriptor = attached_descriptor(name, entry, None);
    let prev_active = working_set.active_name().map(str::to_string);
    if working_set.taken(name) {
        // A re-attach swaps the content under the held name -- replace the
        // descriptor, never a second registration (a duplicate entry would
        // shadow the fresh one in get()/list()).
        working_set.replace(descriptor);
    } else {
        working_set.register(descriptor);
    }
    working_set.set_active_source(prev_active.as_deref());
    Ok(())
}

/// The working-set descriptor for a shared attach. `fingerprint` rides the
/// manifest's content key (the resume/validate identity, D9) -- not a derived
/// table hash. `stale` carries the resume-miss anchor (D9: a mismatched or
/// gone entry registers the name stale so replay SQL refuses honestly).
fn attached_descriptor(
    name: &str,
    entry: &DatasetEntry,
    stale: Option<StaleAnchor>,
) -> DatasetDescriptor {
    DatasetDescriptor {
        reference_name: name.to_string(),
        // The readable label is the manifest entry's display label -- the
        // user-renamable name, stable across sessions even when the 挂名
        // de-conflicted.
        display_name: entry.display_name.clone(),
        source_path: entry.source_path.clone(),
        columns: entry.columns.clone(),
        row_count: entry.row_count,
        sample: entry.sample.clone(),
        fingerprint: entry.fingerprint.clone(),
        size_bytes: entry.size_bytes,
        rectify: RectifyProvenance::NotApplicable,
        privacy: entry.privacy.clone(),
        stale,
    }
}

/// Resolve the SQL's shared references at dispatch time (ADR-0141 D3/D7),
/// BEFORE the gateway door: validate each referenced attach at its first
/// mention of the turn (a fingerprint change re_attaches the new content; a
/// gone entry retires the name + cascade and refuses as stale), then lazily
/// attach every first-mentioned shared name. Mid-turn manifest changes stay
/// invisible to the running turn (D7: the hard link keeps the old physical
/// file answerable; the next turn's first mention picks up the change).
/// Zero new synchronization -- all checks ride the reference itself.
pub(crate) fn resolve_refs(
    sql: &str,
    engine: &AdminEngine,
    source_files: &mut HashMap<String, PathBuf>,
    working_set: &mut WorkingSet,
    snapshot_dir: &Path,
    workspace: &Path,
    attaches: &mut SharedAttaches,
) -> Result<(), SharedRefError> {
    let Some(refs) = crate::provenance::extract_references(sql) else {
        return Ok(()); // unparseable: the conservative fallback owns it
    };
    let entries =
        datasets::load_entries(workspace).map_err(|e| SharedRefError::Runtime(e.to_string()))?;
    // Linear find over the manifest (a workspace holds dozens of entries at
    // most); avoids the Option<&&T> double-reference a map get produces.
    let entry_by_name = |n: &str| entries.iter().find(|e| e.reference_name == n);

    // 1) Validate referenced attaches (records with a landed fingerprint only --
    //    empty-fingerprint records are card-time name reservations the lazy
    //    arm below materializes).
    let referenced_attaches: Vec<String> = refs
        .iter()
        .filter(|r| {
            attaches
                .record(r)
                .is_some_and(|rec| !rec.fingerprint.is_empty())
                && !attaches.validated.contains(*r)
        })
        .cloned()
        .collect();
    for name in referenced_attaches {
        let record = attaches.record(&name).expect("checked above").clone();
        match entry_by_name(&record.entry_name) {
            None => {
                // D7 delete: the entry is gone. Retire the name + cascade,
                // refuse the call as stale (the agent sees what died).
                let anchor = StaleAnchor {
                    reference_name: record.entry_name.clone(),
                    display_name: record.entry_name.clone(),
                    reason: StaleReason::Deleted,
                };
                let reach = working_set.retire_shared_source(&name, anchor);
                log::info!(
                    target: "toptopduck::session",
                    "shared dataset {name} retired (entry {} gone); stale cascade: {reach:?}",
                    record.entry_name
                );
                return Err(SharedRefError::Stale(name));
            }
            Some(entry) if *entry.fingerprint != record.fingerprint => {
                // D3/D7 replace: re-attach the new content under the same name.
                // Same cascade posture as a private re-upload (ADR-0025) --
                // dependents turn stale, the name itself stays live.
                detach(engine, &name);
                if let Err(detail) = attach_shared(
                    engine,
                    source_files,
                    working_set,
                    snapshot_dir,
                    workspace,
                    &name,
                    entry,
                ) {
                    return Err(SharedRefError::Runtime(detail));
                }
                if let Some(rec) = attaches.attaches.get_mut(&name) {
                    rec.fingerprint = entry.fingerprint.clone();
                }
                let anchor = StaleAnchor {
                    reference_name: record.entry_name.clone(),
                    display_name: record.entry_name.clone(),
                    reason: StaleReason::Replaced,
                };
                working_set.retire_shared_source(&name, anchor);
                // retire marked the fresh descriptor stale -- undo that half:
                // the cascade (dependents) keeps, the name itself is live.
                // (retire_shared_source is the shared engine for both halves;
                // a re-attach is a delete+add under one name.)
                unmark(working_set, &name);
                // D9: the re-attach lands a FRESH history event -- the recipe
                // must record the fingerprint the session now serves, or a
                // resume matches the stale triple and breaks replay.
                attaches.pending.push(SharedAttachEvent {
                    reference_name: name.clone(),
                    entry_name: entry.reference_name.clone(),
                    fingerprint: entry.fingerprint.clone(),
                });
            }
            Some(_) => {} // fresh: nothing to do
        }
        // First mention this turn: the check above (or the re-attach it
        // performed) is this turn's truth -- later mentions skip it (D7).
        attaches.validated.insert(name);
    }

    // 2) Lazy attach: a reference matching a manifest entry (or a card-time
    //    reservation for one) that the working set does not already hold.
    let mut reference_list: Vec<&String> = refs.iter().collect();
    reference_list.sort(); // deterministic attach order
    for name in reference_list {
        if working_set.taken(name) {
            continue; // a private source or a attached shared source owns it
        }
        // Direct entry-name match, or a reserved 挂名 standing in for one.
        let entry: Option<&DatasetEntry> = entry_by_name(name).or_else(|| {
            attaches
                .record(name)
                .filter(|rec| rec.fingerprint.is_empty())
                .and_then(|rec| entry_by_name(&rec.entry_name))
        });
        let Some(entry) = entry else { continue };
        if let Err(detail) = attach_shared(
            engine,
            source_files,
            working_set,
            snapshot_dir,
            workspace,
            name,
            entry,
        ) {
            return Err(SharedRefError::Runtime(detail));
        }
        attaches.attaches.insert(
            name.clone(),
            AttachRecord {
                entry_name: entry.reference_name.clone(),
                fingerprint: entry.fingerprint.clone(),
            },
        );
        // The attach read the manifest just now: this turn's mentions of the
        // name are settled (D7 freeze).
        attaches.validated.insert(name.clone());
        attaches.pending.push(SharedAttachEvent {
            reference_name: name.clone(),
            entry_name: entry.reference_name.clone(),
            fingerprint: entry.fingerprint.clone(),
        });
    }
    Ok(())
}

/// DETACH a attach's catalog (best-effort; the tree link stays until the
/// session tree is torn down or a re-attach replaces it).
fn detach(engine: &AdminEngine, name: &str) {
    let escaped = name.replace('"', "\"\"");
    if let Err(e) = engine.execute_batch(&format!("DETACH \"{escaped}\";")) {
        log::warn!(
            target: "toptopduck::session",
            "DETACH failed for shared attach {name}: {e}"
        );
    }
}

/// Clear a descriptor's stale anchor (the re-attach path: the cascade's
/// dependents keep their anchors, the name itself is live again).
fn unmark(working_set: &mut WorkingSet, name: &str) {
    // set_privacy's slot lookup pattern; direct field clear through replace.
    if let Some(d) = working_set.get(name).cloned() {
        let mut fresh = d;
        fresh.stale = None;
        let prev_active = working_set.active_name().map(str::to_string);
        working_set.replace(fresh);
        working_set.set_active_source(prev_active.as_deref());
    }
}

impl super::Session {
    /// ADR-0141 D3/D10: the turn-injection cards for the bound workspace's
    /// shared datasets. Attached entries ride the working set (their privacy
    /// refreshed from the manifest so a panel edit applies next turn); only
    /// un-attached entries return here -- the caller appends them beside the
    /// working-set cards. A manifest that fails to read degrades to no cards
    /// (the SQL path reports the honest error; the card face never blocks a
    /// turn).
    pub(super) fn shared_cards(&mut self) -> Vec<crate::provider::DatasetRef> {
        let Some(workspace) = self.runtime_facts.workspace.clone() else {
            return Vec::new();
        };
        let entries = match datasets::load_entries(&workspace) {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!(
                    target: "toptopduck::session",
                    "shared dataset cards degraded (manifest unreadable): {e}"
                );
                return Vec::new();
            }
        };
        let mut cards = Vec::new();
        for entry in &entries {
            let name = self
                .shared_attaches
                .resolve_or_assign(&entry.reference_name, &self.working_set);
            if self.working_set.taken(&name) {
                // Attached: refresh the descriptor from the manifest (D10
                // 即时生效 -- the panel edit lands on this very turn): the
                // privacy, and the display label with it -- a panel rename
                // reaches the attached row the same way. A label some other
                // working-set member already holds is refused (display-layer
                // uniqueness), so the label refresh is best-effort.
                self.working_set.set_privacy(&name, entry.privacy.clone());
                if let Err(e) = self.working_set.rename_display(&name, &entry.display_name) {
                    log::debug!(
                        target: "toptopduck::session",
                        "shared label refresh skipped for {name}: {e}"
                    );
                }
                continue;
            }
            cards.push(crate::turn_window::shared_card(&name, entry));
        }
        cards
    }

    /// ADR-0141 D9: restore the recorded shared attaches at resume, before
    /// replay. The LAST recorded event per attach name is the truth (a
    /// mid-session replace lands a fresh triple). A fingerprint match
    /// re-attaches from the store (zero conversion); a miss, a gone entry,
    /// or a failed re-attach registers the 挂名 stale so the replayed SQL
    /// refuses as a stale reference instead of an unknown name or a
    /// misleading DuckDB catalog error.
    /// Idempotent against the companion hit path (an already-attached 挂名
    /// only records its table entry).
    pub(super) fn restore_shared_attaches(
        &mut self,
        history: &[crate::persistence::recipe::RecipeEntry],
    ) {
        let Some(workspace) = self.runtime_facts.workspace.clone() else {
            return;
        };
        let entries = match datasets::load_entries(&workspace) {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!(
                    target: "toptopduck::session",
                    "shared attach restore degraded (manifest unreadable): {e}"
                );
                Vec::new()
            }
        };
        let entry_by_name = |n: &str| entries.iter().find(|e| e.reference_name == n);
        let snapshot_dir = self.snapshot_dir();
        let events: Vec<&SharedAttachEvent> = history
            .iter()
            .filter_map(|e| match e {
                crate::persistence::recipe::RecipeEntry::SharedAttach(ev) => Some(ev),
                _ => None,
            })
            .collect();
        // The LAST event per attach name is the truth: a mid-session panel
        // replace re-attaches under the same name and lands a fresh triple
        // (the validation arm pushes one), so an earlier event's stale
        // registration must not shadow the latest state.
        let mut latest: Vec<&SharedAttachEvent> = Vec::new();
        for event in events {
            match latest
                .iter()
                .position(|e| e.reference_name == event.reference_name)
            {
                Some(i) => latest[i] = event,
                None => latest.push(event),
            }
        }
        for event in latest {
            self.shared_attaches.attaches.insert(
                event.reference_name.clone(),
                AttachRecord {
                    entry_name: event.entry_name.clone(),
                    fingerprint: event.fingerprint.clone(),
                },
            );
            if self.working_set.taken(&event.reference_name) {
                continue; // companion hit already attached this attach
            }
            match entry_by_name(&event.entry_name)
                .filter(|entry| entry.fingerprint == event.fingerprint)
            {
                Some(entry) => {
                    if let Err(detail) = attach_shared(
                        &self.admin_engine,
                        &mut self.source_files,
                        &mut self.working_set,
                        &snapshot_dir,
                        &workspace,
                        &event.reference_name,
                        entry,
                    ) {
                        log::warn!(
                            target: "toptopduck::session",
                            "shared attach {} restore failed: {detail}",
                            event.reference_name
                        );
                        // D9 honesty: the triple must not vanish silently.
                        // Register the 挂名 stale-anchored so the replayed
                        // SQL refuses at the gate with the stale wording
                        // instead of passing preflight and dying at DuckDB
                        // execution under a misleading catalog error; a
                        // panel re-add or replace revives the name.
                        let anchor = StaleAnchor {
                            reference_name: entry.reference_name.clone(),
                            display_name: entry.display_name.clone(),
                            reason: StaleReason::Replaced,
                        };
                        let placeholder =
                            attached_descriptor(&event.reference_name, entry, Some(anchor));
                        let prev_active = self.working_set.active_name().map(str::to_string);
                        self.working_set.register(placeholder);
                        self.working_set.set_active_source(prev_active.as_deref());
                    }
                }
                None => {
                    // Mismatch or gone: register the 挂名 with a stale anchor
                    // so its SQL refuses honestly (D9).
                    let gone = entry_by_name(&event.entry_name).is_none();
                    let anchor = StaleAnchor {
                        reference_name: event.entry_name.clone(),
                        display_name: event.entry_name.clone(),
                        reason: if gone {
                            StaleReason::Deleted
                        } else {
                            StaleReason::Replaced
                        },
                    };
                    let placeholder = attached_descriptor(
                        &event.reference_name,
                        {
                            // No entry to mirror: a minimal shape carrying the
                            // recorded identity fields.
                            &DatasetEntry {
                                reference_name: event.entry_name.clone(),
                                display_name: event.entry_name.clone(),
                                fingerprint: event.fingerprint.clone(),
                                size_bytes: 0,
                                columns: Vec::new(),
                                row_count: 0,
                                sample: Vec::new(),
                                privacy: Default::default(),
                                source_path: String::new(),
                            }
                        },
                        Some(anchor),
                    );
                    let prev_active = self.working_set.active_name().map(str::to_string);
                    self.working_set.register(placeholder);
                    self.working_set.set_active_source(prev_active.as_deref());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, tempfile::TempDir) {
        (
            tempfile::tempdir().expect("workspace"),
            tempfile::tempdir().expect("tree"),
        )
    }

    fn add_people(workspace: &Path) -> DatasetEntry {
        let src_dir = tempfile::tempdir().expect("sources");
        let src = src_dir.path().join("people.csv");
        std::fs::write(&src, "name,score\nAda,9\n").expect("write");
        datasets::add(workspace, &src).expect("add")
    }

    /// A first reference lazily attaches: working-set member, source_files
    /// entry, tree hard link, sticky record, and a pending event -- and the
    /// active pointer does NOT move (a attach is not a user upload).
    #[test]
    fn first_reference_lazily_attaches() {
        let (workspace, tree) = ws();
        let entry = add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        working_set.register(DatasetDescriptor {
            reference_name: "private".into(),
            display_name: "private".into(),
            source_path: String::new(),
            columns: vec![],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            size_bytes: 0,
            stale: None,
        });
        let prev_active = working_set.active_name().map(str::to_string);

        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        let snapshots = tree.path().join("snapshots");

        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("resolve");

        assert!(working_set.taken("people"), "attached into the working set");
        assert!(source_files.contains_key("people"));
        assert!(snapshots.join("people.duckdb").exists(), "tree link landed");
        assert_eq!(working_set.active_name(), prev_active.as_deref());
        assert_eq!(
            attaches.take_pending_events(),
            vec![SharedAttachEvent {
                reference_name: "people".into(),
                entry_name: "people".into(),
                fingerprint: entry.fingerprint,
            }]
        );
    }

    /// An unbound reference is untouched: a SQL naming no shared dataset
    /// attaches nothing (the unknown-name error stays the engine's).
    #[test]
    fn unknown_reference_attaches_nothing() {
        let (workspace, tree) = ws();
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        resolve_refs(
            "SELECT 1 AS x",
            &engine,
            &mut source_files,
            &mut working_set,
            tree.path(),
            workspace.path(),
            &mut attaches,
        )
        .expect("resolve");
        assert!(source_files.is_empty());
        assert!(attaches.take_pending_events().is_empty());
    }

    /// A workspace delete after attach retires the name: the next TURN's
    /// reference refuses as stale and the working-set member carries the
    /// anchor.
    #[test]
    fn deleted_entry_refuses_as_stale() {
        let (workspace, tree) = ws();
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        let snapshots = tree.path().join("snapshots");
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("first resolve");

        datasets::remove(workspace.path(), "people").expect("remove");
        attaches.advance_turn(); // the delete lands between turns (D7)
        let err = resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect_err("refused");
        assert_eq!(err, SharedRefError::Stale("people".to_string()));
        assert!(working_set.is_stale("people"), "the attach turned stale");
    }

    /// A workspace replace after attach re_attaches on the next TURN's first
    /// reference: the name stays live, the descriptor follows the new content.
    #[test]
    fn replaced_entry_re_attaches_under_the_same_name() {
        let (workspace, tree) = ws();
        let sources = tempfile::tempdir().expect("sources");
        let src = sources.path().join("people.csv");
        std::fs::write(&src, "name,score\nAda,9\n").expect("write v1");
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        let snapshots = tree.path().join("snapshots");
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("first resolve");
        let v1 = working_set
            .get("people")
            .expect("attached")
            .fingerprint
            .clone();

        let v2 = sources.path().join("people_v2.csv");
        std::fs::write(&v2, "name,score\nAda,9\nLin,8\n").expect("write v2");
        datasets::replace(workspace.path(), "people", &v2).expect("replace");
        attaches.advance_turn(); // the swap lands between turns (D7)

        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("re-attach resolve");
        let descriptor = working_set.get("people").expect("still attached");
        assert!(descriptor.stale.is_none(), "the name stays live");
        let record = attaches.record("people").expect("record kept");
        assert_eq!(record.fingerprint, descriptor.fingerprint);
        assert_ne!(record.fingerprint, v1, "the new content landed");
        // The re-attach lands a fresh history event carrying the served
        // fingerprint -- the resume triple must not stay at v1.
        assert_eq!(
            attaches.pending.len(),
            2,
            "the first attach and the re-attach each push"
        );
        let latest_event = attaches.pending.last().expect("two events");
        assert_eq!(latest_event.reference_name, "people");
        assert_eq!(latest_event.fingerprint, record.fingerprint);
    }

    /// D7 freeze: a panel replace mid-turn does NOT re-attach inside the
    /// running turn -- the same turn's later mentions keep the first
    /// mention's world (the hard link holds the old physical file); the next
    /// turn's first mention picks up the new content.
    #[test]
    fn mid_turn_replace_keeps_the_turns_world() {
        let (workspace, tree) = ws();
        let sources = tempfile::tempdir().expect("sources");
        let src = sources.path().join("people.csv");
        std::fs::write(&src, "name,score\nAda,9\n").expect("write v1");
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        let snapshots = tree.path().join("snapshots");
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("first resolve");
        let before = working_set
            .get("people")
            .expect("attached")
            .fingerprint
            .clone();

        let v2 = sources.path().join("people_v2.csv");
        std::fs::write(&v2, "name,score\nAda,9\nLin,8\n").expect("write v2");
        datasets::replace(workspace.path(), "people", &v2).expect("replace");

        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("same-turn resolve");
        let held = working_set.get("people").expect("still attached");
        assert_eq!(held.fingerprint, before, "the turn keeps its world");

        attaches.advance_turn();
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("next-turn resolve");
        let swapped = working_set.get("people").expect("re-attached");
        assert_ne!(swapped.fingerprint, before, "the swap lands next turn");
        assert!(swapped.stale.is_none(), "the name stays live");
    }

    /// D7 freeze: a panel delete mid-turn leaves the running turn untouched
    /// (no refusal, no cascade); the NEXT turn's first mention retires the
    /// name + cascade and refuses as stale.
    #[test]
    fn mid_turn_delete_leaves_the_turn_undisturbed() {
        let (workspace, tree) = ws();
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        let snapshots = tree.path().join("snapshots");
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("first resolve");

        datasets::remove(workspace.path(), "people").expect("remove");

        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("same-turn resolve keeps serving");
        assert!(!working_set.is_stale("people"), "no mid-turn cascade");

        attaches.advance_turn();
        let err = resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect_err("refused at the next turn");
        assert_eq!(err, SharedRefError::Stale("people".to_string()));
        assert!(working_set.is_stale("people"), "the attach turned stale");
    }

    /// D6 私有让位: with the workspace manifest holding `people`, a private
    /// registration's de-conflict yields -- the candidate takes people_2 and
    /// the shared face keeps its vocabulary name.
    #[test]
    fn private_registration_yields_to_the_shared_vocabulary() {
        let (workspace, _tree) = ws();
        add_people(workspace.path());
        let working_set = WorkingSet::default();
        let mut attaches = SharedAttaches::default();
        // Card-time reservation of the shared name (as shared_cards would).
        attaches.resolve_or_assign("people", &working_set);
        let name = deconflict_with_shared(
            "people",
            &working_set,
            Some(workspace.path()),
            Some(&attaches),
        );
        assert_eq!(name, "people_2", "private yields, shared keeps");
        // The manifest occupancy stands on its own -- no attach reservation
        // needed (pin: a candidate colliding with a manifest entry yields
        // even when the attaches table is empty).
        let manifest_only = deconflict_with_shared(
            "people",
            &WorkingSet::default(),
            Some(workspace.path()),
            None,
        );
        assert_eq!(
            manifest_only, "people_2",
            "manifest names occupy on their own"
        );
        // Unbound: the occupancy is the working set alone (private face
        // unchanged, AC「私有面行为零变化」).
        let unbound = deconflict_with_shared("people", &working_set, None, None);
        assert_eq!(unbound, "people", "no workspace, no shared occupancy");
    }

    /// D9 resume restore: a fingerprint-matching event re-attaches from the
    /// store (working-set member + tree link), and a fingerprint-mismatched
    /// event registers the 挂名 stale.
    #[test]
    fn resume_restore_reattaches_on_match_and_stales_on_miss() {
        let (workspace, _tree) = ws();
        let entry = add_people(workspace.path());
        let mut session = crate::session::Session::with_provider(Box::new(
            crate::provider::fake::FakeProvider::new(),
        ))
        .expect("session");
        session.set_workspace(std::fs::canonicalize(workspace.path()).expect("canonical"));
        let matched = crate::persistence::recipe::RecipeEntry::SharedAttach(SharedAttachEvent {
            reference_name: "people".into(),
            entry_name: "people".into(),
            fingerprint: entry.fingerprint,
        });
        session.restore_shared_attaches(&[matched]);
        assert!(session.list().iter().any(|d| d.reference_name == "people"));

        let mismatched = crate::persistence::recipe::RecipeEntry::SharedAttach(SharedAttachEvent {
            reference_name: "orders".into(),
            entry_name: "orders".into(),
            fingerprint: "deadbeef".into(),
        });
        session.restore_shared_attaches(&[mismatched]);
        assert!(
            session
                .list()
                .iter()
                .any(|d| d.reference_name == "orders" && d.stale.is_some()),
            "a miss registers the name stale"
        );

        // A LIVE entry under a different fingerprint (the panel replaced it
        // while the session was closed) registers Replaced-stale -- it must
        // not silently re-attach the new content under the stale triple.
        let sales_src = tempfile::tempdir().expect("sales");
        let sales = sales_src.path().join("sales.csv");
        std::fs::write(&sales, "sku,n\nA,1\n").expect("write sales");
        datasets::add(workspace.path(), &sales).expect("add sales");
        let live_mismatch =
            crate::persistence::recipe::RecipeEntry::SharedAttach(SharedAttachEvent {
                reference_name: "sales".into(),
                entry_name: "sales".into(),
                fingerprint: "deadbeef".into(),
            });
        session.restore_shared_attaches(&[live_mismatch]);
        let sales_list = session.list();
        let sales_descriptor = sales_list
            .iter()
            .find(|d| d.reference_name == "sales")
            .expect("sales registered");
        let anchor = sales_descriptor
            .stale
            .as_ref()
            .expect("stale, not attached");
        assert_eq!(
            anchor.reason,
            StaleReason::Replaced,
            "a live entry mismatching the fingerprint is Replaced, not Deleted"
        );
    }

    /// D9: a mid-session panel replace lands a SECOND event under the same
    /// 挂名; restore must take the latest triple -- the manifest's live
    /// fingerprint re-attaches and the older event does not shadow it stale.
    #[test]
    fn restore_uses_the_latest_event_per_name() {
        let (workspace, _tree) = ws();
        let entry_v1 = add_people(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let v2 = sources.path().join("people_v2.csv");
        std::fs::write(&v2, "name,score\nAda,9\nLin,8\n").expect("write v2");
        let entry_v2 = datasets::replace(workspace.path(), "people", &v2).expect("replace");
        assert_ne!(entry_v1.fingerprint, entry_v2.fingerprint);
        let mut session = crate::session::Session::with_provider(Box::new(
            crate::provider::fake::FakeProvider::new(),
        ))
        .expect("session");
        session.set_workspace(std::fs::canonicalize(workspace.path()).expect("canonical"));
        let event = |fingerprint: String| {
            crate::persistence::recipe::RecipeEntry::SharedAttach(SharedAttachEvent {
                reference_name: "people".into(),
                entry_name: "people".into(),
                fingerprint,
            })
        };
        session.restore_shared_attaches(&[
            event(entry_v1.fingerprint),
            event(entry_v2.fingerprint.clone()),
        ]);
        let list = session.list();
        let descriptor = list
            .iter()
            .find(|d| d.reference_name == "people")
            .expect("restored");
        assert!(descriptor.stale.is_none(), "the latest event attaches");
        assert_eq!(descriptor.fingerprint, entry_v2.fingerprint);
    }

    /// D3 card face: an un-attached manifest entry returns a card named by
    /// its 挂名; once attached, the entry rides the working set (no card) --
    /// the visible-and-queryable invariant's two halves.
    #[test]
    fn shared_cards_face_lists_unattached_and_drops_attached() {
        let (workspace, _tree) = ws();
        let entry = add_people(workspace.path());
        let mut session = crate::session::Session::with_provider(Box::new(
            crate::provider::fake::FakeProvider::new(),
        ))
        .expect("session");
        session.set_workspace(std::fs::canonicalize(workspace.path()).expect("canonical"));
        let cards = session.shared_cards();
        assert_eq!(cards.len(), 1, "one un-attached entry, one card");
        assert_eq!(cards[0].reference_name, "people");
        assert!(
            cards[0].sql_ref.contains("\"people\".data"),
            "the card's SQL fragment names the attach: {}",
            cards[0].sql_ref
        );

        session.restore_shared_attaches(&[crate::persistence::recipe::RecipeEntry::SharedAttach(
            SharedAttachEvent {
                reference_name: "people".into(),
                entry_name: "people".into(),
                fingerprint: entry.fingerprint,
            },
        )]);
        let cards = session.shared_cards();
        assert!(cards.is_empty(), "attached entries ride the working set");
    }

    /// A panel rename before the attach rides in: the attached descriptor's
    /// label is the manifest's display name, not the 挂名.
    #[test]
    fn attach_carries_the_renamed_display_label() {
        let (workspace, tree) = ws();
        add_people(workspace.path());
        datasets::rename(workspace.path(), "people", "Folks").expect("rename");
        let mut working_set = WorkingSet::default();
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let mut attaches = SharedAttaches::default();
        resolve_refs(
            "SELECT * FROM \"people\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &tree.path().join("snapshots"),
            workspace.path(),
            &mut attaches,
        )
        .expect("resolve");
        let d = working_set.get("people").expect("attached");
        assert_eq!(d.display_name, "Folks");
    }

    /// A panel rename after the attach lands on the attached row on the very
    /// next card pass (the D10 refresh, the label riding with the privacy).
    #[test]
    fn shared_cards_refreshes_an_attached_label_after_a_panel_rename() {
        let (workspace, _tree) = ws();
        let entry = add_people(workspace.path());
        let mut session = crate::session::Session::with_provider(Box::new(
            crate::provider::fake::FakeProvider::new(),
        ))
        .expect("session");
        session.set_workspace(std::fs::canonicalize(workspace.path()).expect("canonical"));
        session.restore_shared_attaches(&[crate::persistence::recipe::RecipeEntry::SharedAttach(
            SharedAttachEvent {
                reference_name: "people".into(),
                entry_name: "people".into(),
                fingerprint: entry.fingerprint,
            },
        )]);
        datasets::rename(workspace.path(), "people", "Folks").expect("rename");
        let cards = session.shared_cards();
        assert!(cards.is_empty(), "still attached, no card");
        let d = session.working_set.get("people").expect("attached");
        assert_eq!(
            d.display_name, "Folks",
            "the rename reached the attached row"
        );
    }

    /// D6 reserved 挂名: a card-time reservation (de-conflicted because a
    /// private source squats the entry name) attaches on the SQL's first
    /// mention of the reserved name -- the card the agent saw must answer.
    #[test]
    fn a_reserved_card_name_attaches_on_first_mention() {
        let (workspace, tree) = ws();
        let entry = add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        working_set.register(DatasetDescriptor {
            reference_name: "people".into(),
            display_name: "people".into(),
            source_path: String::new(),
            columns: vec![],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            size_bytes: 0,
            stale: None,
        });
        let mut attaches = SharedAttaches::default();
        // Card time: the manifest's people reserves people_2 under the
        // private squat (the shared_cards flow).
        let reserved = attaches.resolve_or_assign("people", &working_set);
        assert_eq!(reserved, "people_2");

        let engine = crate::session::engine::AdminEngine::materialized();
        let mut source_files = HashMap::new();
        let snapshots = tree.path().join("snapshots");
        resolve_refs(
            "SELECT * FROM \"people_2\".data",
            &engine,
            &mut source_files,
            &mut working_set,
            &snapshots,
            workspace.path(),
            &mut attaches,
        )
        .expect("the reserved name attaches");
        let descriptor = working_set
            .get("people_2")
            .expect("attached under the reserved name");
        assert!(descriptor.stale.is_none());
        assert_eq!(descriptor.fingerprint, entry.fingerprint);
        let record = attaches.record("people_2").expect("record landed");
        assert_eq!(record.entry_name, "people");
        assert_eq!(record.fingerprint, entry.fingerprint);
    }

    /// 挂名 stickiness: a private member squatting the entry name pushes the
    /// attach to a de-conflicted name, and that name stays stable.
    #[test]
    fn name_deconflicts_against_private_occupancy() {
        let (workspace, _tree) = ws();
        add_people(workspace.path());
        let mut working_set = WorkingSet::default();
        working_set.register(DatasetDescriptor {
            reference_name: "people".into(),
            display_name: "people".into(),
            source_path: String::new(),
            columns: vec![],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            size_bytes: 0,
            stale: None,
        });
        let mut attaches = SharedAttaches::default();
        let first = attaches.resolve_or_assign("people", &working_set);
        assert_eq!(first, "people_2", "squatting private name is avoided");
        let again = attaches.resolve_or_assign("people", &working_set);
        assert_eq!(again, "people_2", "the assigned name is sticky");
    }
}
