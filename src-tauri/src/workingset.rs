//! Working set registry (ADR-0022 / ADR-0037). Tracks loaded source Datasets,
//! de-conflicts reference names, and holds the active-dataset pointer (= the
//! most recently uploaded source).

use std::collections::{HashMap, HashSet};

use crate::model::{DatasetDescriptor, DatasetPrivacy, RenameError, StaleAnchor};

/// Hard ceiling on the number of registered `result_N` (ADR-0013 M=100). When
/// a freshly materialized result pushes the count over the cap, the oldest
/// stale results are auto-reclaimed; active results are never auto-deleted.
/// Tunable via [`crate::session::Session::set_result_count_cap`] (tests lower
/// it for a fast, deterministic GC trigger -- mirroring the row-cap twin).
pub const DEFAULT_RESULT_COUNT_CAP: usize = 100;

#[derive(Debug, Default)]
pub struct WorkingSet {
    datasets: Vec<DatasetDescriptor>,
    active: Option<String>, // reference name (stable)
    /// Reference names that are materialized turn results (main-DB physical
    /// tables, ADR-0024) vs uploaded sources (attached read-only catalogs,
    /// ADR-0012). Drives the FROM form in SQL and row reads, and lets
    /// [`Self::next_result_number`] scan only results. Tracked explicitly (not
    /// by name pattern) so a source whose sanitized name happens to look like
    /// `result_N` can never be mistaken for a derived result.
    results: HashSet<String>,
    /// 血缘图（issue #40, ADR-0025/0040）：result_N → 它依赖的上游引用名
    /// 集合（源 + 其他 result_N）。在 result 物化时记录（provenance 解析
    /// provider SQL 的 FROM/JOIN），供删源时的 stale 级联传递闭包使用。保守
    /// 兜底（解析失败）记全部当时成员，保证"宁可多失效不漏失效"（issue #40）。
    /// 仅内存，不跨 IPC / 不进 recipe（持久化 PRD 的职责）。
    provenance: HashMap<String, HashSet<String>>,
}

impl WorkingSet {
    /// De-conflict a candidate reference name: name, name_2, name_3, ...
    /// returns the first unused (ADR-0022 tool-side de-conflict).
    pub fn deconflict(&self, candidate: &str) -> String {
        self.deconflict_with(candidate, &HashSet::new())
    }

    /// De-conflict a candidate against both the working set and an extra reserved
    /// set -- used when reserving several names in one batch (e.g. an Excel
    /// workbook's sheets) before any are registered, so two sheets that sanitize
    /// to the same name don't collide at ATTACH time.
    pub fn deconflict_with(&self, candidate: &str, reserved: &HashSet<String>) -> String {
        let taken = |n: &str| self.taken(n) || reserved.contains(n);
        self.deconflict_loop(candidate, taken, |c, n| format!("{c}_{n}"))
    }

    fn taken(&self, name: &str) -> bool {
        self.datasets.iter().any(|d| d.reference_name == name)
    }

    /// De-conflict a candidate display label at the display layer (ADR-0037):
    /// returns the first label not already shown by another dataset. Format:
    /// `label`, `label (2)`, `label (3)`, ... -- human-readable, distinct from
    /// the SQL-safe `_2` suffix used for reference names (which the user never
    /// sees in SQL-free flows). Keeps the UI free of two identical labels.
    pub fn deconflict_display(&self, candidate: &str) -> String {
        self.deconflict_display_with(candidate, &HashSet::new())
    }

    /// De-conflict a candidate display label against both the working set and an
    /// extra reserved set -- the display-layer twin of [`Self::deconflict_with`],
    /// used when reserving several labels in one batch (e.g. an Excel workbook's
    /// sheets) before any are registered, so two sheets sharing a name don't both
    /// show the same label.
    pub fn deconflict_display_with(&self, candidate: &str, reserved: &HashSet<String>) -> String {
        let taken = |n: &str| self.display_taken(n) || reserved.contains(n);
        self.deconflict_loop(candidate, taken, |c, n| format!("{c} ({n})"))
    }

    fn display_taken(&self, display: &str) -> bool {
        self.datasets.iter().any(|d| d.display_name == display)
    }

    /// Shared de-conflict walk for both reference names (`_2` suffix) and display
    /// labels (` (2)` suffix). The two layers differ only in the taken-test and
    /// the suffix format, so the candidate walk is identical -- extracted here to
    /// keep the twins from drifting (DRY). Tries the candidate as-is, then appends
    /// successive suffixes from 2 until `is_taken` is satisfied.
    fn deconflict_loop(
        &self,
        candidate: &str,
        is_taken: impl Fn(&str) -> bool,
        suffix: impl Fn(&str, usize) -> String,
    ) -> String {
        if !is_taken(candidate) {
            return candidate.to_string();
        }
        let mut n = 2;
        loop {
            let candidate = suffix(candidate, n);
            if !is_taken(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }

    /// Register a dataset and point active at it (ADR-0022: active = most recent).
    pub fn register(&mut self, dataset: DatasetDescriptor) {
        let reference_name = dataset.reference_name.clone();
        self.datasets.push(dataset);
        self.active = Some(reference_name);
    }

    /// Replace a dataset's snapshot in place under the same reference name
    /// (ADR-0042, issue #11 slice 4b). The reference name is stable, so every
    /// existing reference (SQL FROM, the recipe chain, the active pointer) now
    /// resolves to the new snapshot's data -- only the dataset body changes
    /// (columns / row count / sample / fingerprint / source path / rectify); the
    /// display label comes from the incoming descriptor (a user rename is meant
    /// to survive a replace). A replace is a fresh upload onto this name, so it
    /// also becomes the active dataset ("most recent upload = active",
    /// ADR-0022) -- the active pointer is keyed by reference name, so it still
    /// resolves correctly. Returns `false` (a logic bug, not a user error) when
    /// the name isn't registered; callers check first.
    pub fn replace(&mut self, descriptor: DatasetDescriptor) -> bool {
        let reference_name = descriptor.reference_name.clone();
        let Some(slot) = self
            .datasets
            .iter_mut()
            .find(|d| d.reference_name == reference_name)
        else {
            return false;
        };
        *slot = descriptor;
        self.active = Some(reference_name);
        true
    }

    pub fn list(&self) -> &[DatasetDescriptor] {
        &self.datasets
    }

    pub fn active(&self) -> Option<&DatasetDescriptor> {
        self.active.as_ref().and_then(|r| self.get(r))
    }

    /// Repoint the active source pointer at an existing source (ADR-0035,
    /// issue #39): used only by `remove_active_source` to honor a user's
    /// explicit continuation choice after deleting the current focus. Unlike
    /// `register`/`replace` (which set active as a side of adding data), this
    /// is a pure pointer move -- no dataset is added or swapped.
    ///
    /// Returns `false` (a logic bug, not a user error) when `reference_name` is
    /// not a registered non-result source, leaving `active` unchanged. The
    /// session's `remove_active_source` gates this call on those conditions, so
    /// a `false` here signals a stale view raced a concurrent mutation; the
    /// caller refuses honestly rather than silently writing a dangling pointer.
    /// `result_N` names are rejected so the active pointer never aliases a
    /// materialized result (resolve_active handles results separately, ADR-0022).
    pub fn set_active(&mut self, reference_name: &str) -> bool {
        let is_source = self
            .get(reference_name)
            .map(|d| !self.results.contains(&d.reference_name))
            .unwrap_or(false);
        if !is_source {
            return false;
        }
        self.active = Some(reference_name.to_string());
        true
    }

    pub fn get(&self, reference_name: &str) -> Option<&DatasetDescriptor> {
        self.datasets
            .iter()
            .find(|d| d.reference_name == reference_name)
    }

    /// Resolve a registered dataset a read-shaped tool may reference, refusing an
    /// unknown name or a stale `result_N` anchor (ADR-0013 invariant 2). Shared by
    /// the `describe` + `sample` tools so the unknown + stale refusal wording is
    /// identical across them -- the agent reads one consistent error shape and can
    /// self-correct (ADR-0077). `verb` is the action the caller was about to take
    /// ("referenced" / "read"), phrased to fit "... may not be {verb}".
    pub fn resolve_readable(
        &self,
        reference_name: &str,
        verb: &str,
    ) -> Result<&DatasetDescriptor, String> {
        let descriptor = self.get(reference_name).ok_or_else(|| {
            format!("unknown dataset: `{reference_name}` is not in the working set")
        })?;
        if let Some(anchor) = &descriptor.stale {
            return Err(format!(
                "stale dataset: `{reference_name}` was invalidated by `{}` and may not be {verb}",
                anchor.reference_name
            ));
        }
        Ok(descriptor)
    }

    /// Rename a dataset's display label (ADR-0037): changes **only** the display
    /// name, never the reference name -- so every existing reference (SQL FROM,
    /// the recipe chain, the active pointer) stays valid, and no dependency is
    /// rewritten or propagated. The new label must be unique at the display
    /// layer; a collision with *another* dataset's label is rejected (a rename is
    /// an explicit user action, so silent de-conflict would surprise). Renaming
    /// to the dataset's own current label is a no-op and allowed. The label is
    /// trimmed; a blank result is rejected. Returns the updated descriptor.
    pub fn rename_display(
        &mut self,
        reference_name: &str,
        new_display: &str,
    ) -> Result<DatasetDescriptor, RenameError> {
        let idx = self
            .datasets
            .iter()
            .position(|d| d.reference_name == reference_name)
            .ok_or_else(|| RenameError::NotFound(reference_name.to_string()))?;
        // Trim before any check: surrounding whitespace must not perturb
        // display-layer uniqueness, and a blank label is rejected (ADR-0037).
        let label = new_display.trim();
        if label.is_empty() {
            return Err(RenameError::InvalidLabel);
        }
        // Collision is against OTHER datasets only -- a no-op rename to this
        // dataset's own current label is allowed (it changes nothing).
        let taken_by_other = self
            .datasets
            .iter()
            .enumerate()
            .any(|(i, d)| i != idx && d.display_name == label);
        if taken_by_other {
            return Err(RenameError::DisplayTaken(label.to_string()));
        }
        self.datasets[idx].display_name = label.to_string();
        Ok(self.datasets[idx].clone())
    }

    /// Set a dataset's privacy controls. See [`crate::session::Session::set_privacy`]
    /// -- this is the storage-layer implementation. Returns the updated
    /// descriptor, or `None` when the reference name isn't registered (the
    /// command maps that to a typed `RemoveSourceError::NotFound`, issue #127).
    pub fn set_privacy(
        &mut self,
        reference_name: &str,
        privacy: DatasetPrivacy,
    ) -> Option<DatasetDescriptor> {
        let slot = self
            .datasets
            .iter_mut()
            .find(|d| d.reference_name == reference_name)?;
        // Normalize: dedup + sort for deterministic storage (set semantics at the
        // type-usage level; Vec is kept for serde compatibility).
        let mut cols = privacy.type_only_columns;
        cols.retain(|c| !c.trim().is_empty());
        cols.sort();
        cols.dedup();
        slot.privacy = DatasetPrivacy {
            type_only_columns: cols,
            ..privacy
        };
        Some(slot.clone())
    }

    /// Register a materialized turn result (ADR-0003/0024): a Dataset that
    /// lives as a main-DB physical table (not an attached snapshot). Unlike
    /// [`Self::register`] (a source upload), registering a result does NOT move
    /// the active pointer -- active tracks the most-recently-uploaded *source*
    /// (ADR-0022). The resolved "current table" (most recent result, else the
    /// source) is computed from the thread by [`crate::window::resolve_active`]
    /// (issue #27), not stored here. The result is referenceable like any source
    /// (shared FROM namespace), and its name is recorded in `results` so
    /// [`Self::sql_from`] picks the main-table form (`"<ref>"`) over the
    /// source-attached form (`"<ref>".data`).
    pub fn register_result(&mut self, dataset: DatasetDescriptor) {
        let reference_name = dataset.reference_name.clone();
        self.datasets.push(dataset);
        self.results.insert(reference_name);
    }

    /// The next result number: one past the max existing `result_N`, starting
    /// at 1 (ADR-0022 monotonic, never reused -- deleted results leave gaps, the
    /// next takes max+1, never back-filling). Scans only names recorded in
    /// `results`, so a source named `result_1.csv` (sanitized to `result_1` but
    /// NOT a derived result) never inflates the counter.
    pub fn next_result_number(&self) -> u64 {
        self.datasets
            .iter()
            .filter(|d| self.results.contains(&d.reference_name))
            .filter_map(|d| d.reference_name.strip_prefix("result_"))
            .filter_map(|suffix| suffix.parse::<u64>().ok())
            .max()
            .map_or(1, |n| n + 1)
    }

    /// Whether `reference_name` is a materialized turn result (main-DB table)
    /// vs an uploaded source (attached read-only catalog).
    pub fn is_result(&self, reference_name: &str) -> bool {
        self.results.contains(reference_name)
    }

    /// The verbatim SQL FROM fragment for a dataset, or `None` if it isn't
    /// registered. A source is an attached read-only catalog, referenced as
    /// `"<ref>".data` (ADR-0012); a derived result is a main-DB physical table,
    /// referenced as `"<ref>"` (ADR-0024). The identifier is tool-generated
    /// (sanitized reference name / `result_N`), so quoting it is safe.
    pub fn sql_from(&self, reference_name: &str) -> Option<String> {
        if !self.taken(reference_name) {
            return None;
        }
        let quoted = quote_reference(reference_name);
        if self.is_result(reference_name) {
            Some(quoted)
        } else {
            Some(format!("{quoted}.data"))
        }
    }

    /// Remove a dataset from the working set by reference name, returning the
    /// removed descriptor (or `None` when the name isn't registered). Used by the
    /// delete-source path (issues #38/#40): the descriptor's display label rides
    /// the `Deleted` source lifecycle event so the thread can still name what was
    /// removed after the dataset is gone. Clears the active pointer when it
    /// pointed at the removed name, drops any `result_N` membership entry, and
    /// drops the provenance graph edge -- all defensive bookkeeping: the
    /// session's `commit_removal` runs the stale-cascade first, so a delete may
    /// well leave dependent (now-stale) results registered, but the removed
    /// name's own entries are cleared here so nothing dangles. The active-clear
    /// branch does not fire on the live path (`remove_source` refuses the active
    /// source; `remove_active_source` repoints active first), but the working
    /// set stays correct if that ever changes.
    pub fn remove(&mut self, reference_name: &str) -> Option<DatasetDescriptor> {
        let idx = self
            .datasets
            .iter()
            .position(|d| d.reference_name == reference_name)?;
        let removed = self.datasets.remove(idx);
        self.results.remove(reference_name);
        self.provenance.remove(reference_name);
        if self.active.as_deref() == Some(reference_name) {
            self.active = None;
        }
        Some(removed)
    }

    pub fn len(&self) -> usize {
        self.datasets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.datasets.is_empty()
    }

    /// Update a source's `source_path` in place (issue #433: bind_duck migrates
    /// derived sources from `temp_path/derived/` to `<duck_stem>.assets/`).
    /// Returns `false` if the reference name isn't registered (a stale view
    /// racing a concurrent mutation). The path is stored verbatim — the caller
    /// ensures it is the persistent (post-migration) location.
    pub fn update_source_path(&mut self, reference_name: &str, new_path: &str) -> bool {
        if let Some(slot) = self
            .datasets
            .iter_mut()
            .find(|d| d.reference_name == reference_name)
        {
            slot.source_path = new_path.to_string();
            true
        } else {
            false
        }
    }

    // --- Stale cascade (issue #40, ADR-0013/0025/0040) ----------------------
    //
    // Dependent result_N are soft-invalidated when an upstream source is
    // removed: the cascade walks the provenance graph transitively, marking
    // each dependent's descriptor with the StaleAnchor of the Deleted source
    // event. A stale result stays registered (visible: read_rows / thread) but
    // is excluded from the LLM working set and refused as a new SQL reference
    // (ADR-0013 three invariants).

    /// Whether `reference_name` is a stale result (ADR-0013). A source is never
    /// stale (sources are removed outright, not soft-invalidated); a result_N
    /// is stale once the cascade marked its descriptor.
    pub fn is_stale(&self, reference_name: &str) -> bool {
        self.get(reference_name)
            .map(|d| d.stale.is_some())
            .unwrap_or(false)
    }

    /// Reference names of every stale result currently registered (ADR-0013).
    /// Used by the sandbox mirror + window assembler to exclude stale results
    /// from the LLM-visible working set.
    pub fn stale_results(&self) -> Vec<String> {
        self.datasets
            .iter()
            .filter(|d| self.results.contains(&d.reference_name) && d.stale.is_some())
            .map(|d| d.reference_name.clone())
            .collect()
    }

    /// The reference names of stale results to reclaim when the result_N count
    /// exceeds `cap` (ADR-0013, issue #42). Read-only selection -- the caller
    /// drops each physical table, then [`Self::remove`]s the name. Returns the
    /// names ordered oldest-first, taking only as many as the overshoot: if the
    /// count exceeds `cap` by k, at most k stale results come back.
    ///
    /// "Oldest" = smallest `result_N` number: the monotonic never-reused
    /// numbering (ADR-0022) makes the number the authoritative creation order,
    /// so the smallest-N stale result is the earliest-produced. A source whose
    /// sanitized name happens to parse as `result_N` is excluded by the
    /// `results`-set membership filter (mirrors [`Self::next_result_number`]).
    ///
    /// Active results are NEVER selected (ADR-0013: GC only reclaims stale).
    /// When fewer stale results exist than the overshoot, all of them are
    /// returned and the count stays over `cap` -- the cap is a soft ceiling
    /// enforceable only while stale results exist to reclaim. Empty when the
    /// count is at or under `cap`, or when no stale result is available.
    pub fn gc_stale_candidates(&self, cap: usize) -> Vec<String> {
        let over = self.results.len().saturating_sub(cap);
        if over == 0 {
            return Vec::new();
        }
        let mut stale: Vec<(u64, String)> = self
            .datasets
            .iter()
            .filter(|d| self.results.contains(&d.reference_name) && d.stale.is_some())
            .filter_map(|d| {
                d.reference_name
                    .strip_prefix("result_")
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(|n| (n, d.reference_name.clone()))
            })
            .collect();
        stale.sort_by_key(|(n, _)| *n);
        stale.into_iter().take(over).map(|(_, name)| name).collect()
    }

    /// result_N that directly depend on `reference_name` (name it as a member
    /// of their provenance set). The forward edge of the cascade.
    fn dependents_of(&self, reference_name: &str) -> Vec<String> {
        self.provenance
            .iter()
            .filter(|(_, deps)| deps.contains(reference_name))
            .map(|(r, _)| r.clone())
            .collect()
    }

    /// Record a freshly materialized result's provenance (issue #40,
    /// ADR-0025): the working-set reference names its SQL named as FROM/JOIN
    /// targets. The cascade reads this on a later source delete to find
    /// dependents. The caller pre-intersects with the live working set and has
    /// already checked no name is a stale reference (ADR-0013 invariant 2). A
    /// conservative fallback (parse failure) records every current member so a
    /// delete never under-cascades.
    pub fn record_provenance(&mut self, result_name: &str, deps: HashSet<String>) {
        self.provenance.insert(result_name.to_string(), deps);
    }

    /// The reference names of every currently registered member (sources +
    /// results, stale or active) -- the conservative-fallback dependency set
    /// (issue #40 "宁可多失效不漏失效").
    pub fn member_names(&self) -> HashSet<String> {
        self.datasets
            .iter()
            .map(|d| d.reference_name.clone())
            .collect()
    }

    /// The original on-disk file paths of every registered source (non-result
    /// datasets with a non-empty `source_path`), in registration order. These
    /// are the files the user handed the session and become the read-only roots
    /// the gateway file-reachability whitelist carries (ADR-0080, issue #293).
    /// A `result_N` has no source path (it is a main-DB table, ADR-0024) and is
    /// excluded by the `results` guard; a source whose path is empty is dropped
    /// -- it cannot be `read_*` anyway. Borrows from `self` so callers consume
    /// the paths without an owning copy.
    pub fn source_paths(&self) -> Vec<&str> {
        self.datasets
            .iter()
            .filter(|d| !self.results.contains(&d.reference_name))
            .filter_map(|d| {
                let path = d.source_path.as_str();
                if path.is_empty() {
                    None
                } else {
                    Some(path)
                }
            })
            .collect()
    }

    /// Transitively mark every result_N downstream of `removed_ref` as stale,
    /// each carrying `anchor` (the invalidating source event identity -- Deleted
    /// per #40 or Replaced per #41, for traceability ADR-0040). The walk is the
    /// provenance-graph transitive closure over direct dependents: a source
    /// delete/replace ripples through chained results (result_2 FROM result_1
    /// FROM source). A result already stale keeps its FIRST anchor (the earliest
    /// invalidating event), matching ADR-0041's "终局死轮" (a dead turn is never
    /// revived, so the first death is the truth). Returns the newly-staled names
    /// so the caller can log the cascade's reach. `removed_ref` itself is the
    /// source being deleted/replaced; its dependents (not the source) are what
    /// get marked.
    pub fn cascade_stale(&mut self, removed_ref: &str, anchor: StaleAnchor) -> Vec<String> {
        let mut frontier: Vec<String> = self.dependents_of(removed_ref);
        let mut newly_stale: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(dep) = frontier.pop() {
            if !seen.insert(dep.clone()) {
                continue;
            }
            // Only mark + expand a registered, currently-active result. An
            // already-stale result keeps its first anchor (ADR-0041); a name
            // since removed is skipped (dependents_of may lag a removal).
            let is_live_result = self
                .get(&dep)
                .map(|d| self.results.contains(&dep) && d.stale.is_none())
                .unwrap_or(false);
            if !is_live_result {
                continue;
            }
            self.mark_stale(&dep, anchor.clone());
            newly_stale.push(dep.clone());
            // Ripple: results depending on the just-staled result also fall.
            frontier.extend(self.dependents_of(&dep));
        }
        newly_stale
    }

    /// Mark one result_N stale by setting its descriptor's anchor. Private --
    /// the only caller is `cascade_stale` (stale is a consequence of a source
    /// event, never a standalone mutation).
    fn mark_stale(&mut self, reference_name: &str, anchor: StaleAnchor) {
        if let Some(slot) = self
            .datasets
            .iter_mut()
            .find(|d| d.reference_name == reference_name)
        {
            slot.stale = Some(anchor);
        }
    }
}

/// Quote a reference name as a SQL identifier (double quotes; embedded quotes
/// doubled). Mirrors `ingest::schema::quote_ident` / `session::quote_alias`;
/// kept local so the working set stays independent of the ingest module. The
/// input is always a tool-generated reference name, never user SQL.
fn quote_reference(name: &str) -> String {
    let escaped = name.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnSchema, RectifyProvenance, StaleAnchor, StaleReason};

    fn descriptor(name: &str) -> DatasetDescriptor {
        descriptor_with(name, name)
    }

    /// A descriptor whose reference name and display label are independent -- the
    /// shape the ingest path actually produces (sanitized reference vs readable
    /// label, ADR-0037).
    fn descriptor_with(reference_name: &str, display_name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: format!("/{reference_name}.csv"),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 1,
            sample: vec![vec!["1".into()]],
            fingerprint: reference_name.into(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    #[test]
    fn deconflict_keeps_first_unused_name() {
        let ws = WorkingSet::default();
        assert_eq!(ws.deconflict("orders"), "orders");
    }

    #[test]
    fn deconflict_appends_suffix_on_collision() {
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert_eq!(ws.deconflict("orders"), "orders_2");
        ws.register(descriptor("orders_2"));
        assert_eq!(ws.deconflict("orders"), "orders_3");
    }

    #[test]
    fn deconflict_with_honours_reserved_set() {
        // Batch reservation (e.g. an Excel workbook's sheets): two sheets that
        // sanitize to the same name must not collide before any is registered.
        let ws = WorkingSet::default();
        let mut reserved = HashSet::new();
        assert_eq!(ws.deconflict_with("orders", &reserved), "orders");
        reserved.insert("orders".to_string());
        assert_eq!(ws.deconflict_with("orders", &reserved), "orders_2");
        reserved.insert("orders_2".to_string());
        assert_eq!(ws.deconflict_with("orders", &reserved), "orders_3");
    }

    #[test]
    fn register_points_active_at_most_recent() {
        let mut ws = WorkingSet::default();
        ws.register(descriptor("a"));
        assert_eq!(ws.active().unwrap().reference_name, "a");
        ws.register(descriptor("b"));
        assert_eq!(ws.active().unwrap().reference_name, "b");
        // older source remains in the shared namespace
        assert!(ws.get("a").is_some());
    }

    #[test]
    fn set_active_repoints_to_a_registered_source() {
        // ADR-0035 / issue #39: remove_active_source switches the focus pointer
        // to the user's explicit choice. The pointer actually moves (the prior
        // active is no longer reported as active), and the previous focus stays
        // registered -- only the pointer moved, no dataset was dropped here.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        ws.register(descriptor("people")); // active = people (most recent)
        assert!(ws.set_active("orders"));
        assert_eq!(ws.active().unwrap().reference_name, "orders");
        assert!(ws.get("people").is_some(), "prior focus still registered");
    }

    #[test]
    fn set_active_rejects_unknown_name_leaving_pointer_unchanged() {
        // A stale view racing a concurrent mutation names a source that no
        // longer exists -- refuse rather than write a dangling pointer.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert!(!ws.set_active("ghost"));
        assert_eq!(ws.active().unwrap().reference_name, "orders");
    }

    #[test]
    fn set_active_rejects_a_materialized_result_name() {
        // The active pointer must alias a source, never a result_N (resolve_active
        // handles results separately, ADR-0022). A result name is registered, so
        // a plain membership check would wrongly accept it -- the result-set
        // guard is what keeps the pointer in the source domain.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        ws.register_result(descriptor("result_1"));
        assert!(!ws.set_active("result_1"));
        assert_eq!(
            ws.active().unwrap().reference_name,
            "orders",
            "pointer stayed on a source"
        );
    }

    #[test]
    fn deconflict_display_keeps_first_unused_label() {
        let ws = WorkingSet::default();
        assert_eq!(ws.deconflict_display("Orders"), "Orders");
    }

    #[test]
    fn deconflict_display_appends_human_readable_suffix_on_collision() {
        // Two sources sharing a stem must not show identical labels: the second
        // gets a human-readable "(2)" suffix -- distinct from the reference
        // name's "_2" (ADR-0037 display-layer de-conflict).
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        assert_eq!(ws.deconflict_display("Orders"), "Orders (2)");
        ws.register(descriptor_with("orders_2", "Orders (2)"));
        assert_eq!(ws.deconflict_display("Orders"), "Orders (3)");
    }

    #[test]
    fn deconflict_display_with_honours_reserved_set() {
        // Batch reservation (an Excel workbook's sheets): two sheets whose names
        // collide at the display layer must not both show the same label before
        // any is registered.
        let ws = WorkingSet::default();
        let mut reserved = HashSet::new();
        assert_eq!(ws.deconflict_display_with("Sheet1", &reserved), "Sheet1");
        reserved.insert("Sheet1".to_string());
        assert_eq!(
            ws.deconflict_display_with("Sheet1", &reserved),
            "Sheet1 (2)"
        );
    }

    #[test]
    fn rename_display_changes_only_label_not_reference() {
        // ADR-0037 core invariant: renaming touches only the display name. The
        // reference name is untouched, so every reference stays valid.
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        let resolved = ws.rename_display("orders", "Q3 订单").unwrap();
        // returned descriptor carries the unchanged reference + updated label
        assert_eq!(resolved.reference_name, "orders");
        assert_eq!(resolved.display_name, "Q3 订单");
        let d = ws.get("orders").unwrap();
        assert_eq!(d.reference_name, "orders"); // unchanged in working set
        assert_eq!(d.display_name, "Q3 订单"); // updated in working set
    }

    #[test]
    fn rename_display_rejects_collision_with_another_dataset() {
        // Display-layer uniqueness: renaming onto another dataset's label is
        // rejected, leaving the working set unchanged (explicit user action --
        // least surprise; ADR-0037 allows reject).
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        ws.register(descriptor_with("people", "People"));
        let err = ws.rename_display("orders", "People").unwrap_err();
        assert_eq!(err, RenameError::DisplayTaken("People".into()));
        // rejected rename left the label untouched
        assert_eq!(ws.get("orders").unwrap().display_name, "Orders");
    }

    #[test]
    fn rename_display_allows_noop_rename_to_own_label() {
        // Renaming to the dataset's own current label changes nothing and is
        // allowed (not a collision with another dataset).
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        ws.rename_display("orders", "Orders").unwrap();
        assert_eq!(ws.get("orders").unwrap().display_name, "Orders");
    }

    #[test]
    fn rename_display_rejects_blank_label() {
        // A display label must be visible: empty / whitespace-only answers are
        // rejected (the UI trims first, but the working set is the authority).
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        for blank in ["", "   ", "\t"] {
            let err = ws.rename_display("orders", blank).unwrap_err();
            assert_eq!(err, RenameError::InvalidLabel);
        }
        // rejected rename left the label untouched
        assert_eq!(ws.get("orders").unwrap().display_name, "Orders");
    }

    #[test]
    fn rename_display_trims_surrounding_whitespace() {
        // Surrounding whitespace is trimmed before storage so it never perturbs
        // display-layer uniqueness: "  Q3  " becomes "Q3".
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        let resolved = ws.rename_display("orders", "  Q3 订单  ").unwrap();
        assert_eq!(resolved.display_name, "Q3 订单");
        assert_eq!(ws.get("orders").unwrap().display_name, "Q3 订单");
    }

    #[test]
    fn rename_display_rejects_unknown_reference() {
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        let err = ws.rename_display("nope", "X").unwrap_err();
        assert_eq!(err, RenameError::NotFound("nope".into()));
    }

    #[test]
    fn replace_takes_over_reference_name_and_becomes_active() {
        // AC1 (issue #11): a replace swaps the dataset body under the same
        // reference name -- columns/sample/fingerprint change, the name doesn't,
        // and no second entry appears. It also becomes the active dataset.
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("orders", "Orders"));
        let original = ws.get("orders").unwrap().clone();

        let mut replacement = descriptor_with("orders", "Orders v2");
        replacement.row_count = 99;
        replacement.fingerprint = "newfp".into();
        assert!(ws.replace(replacement));

        assert_eq!(ws.len(), 1); // taken over, not added
        let d = ws.get("orders").unwrap();
        assert_eq!(d.reference_name, "orders"); // name stable
        assert_eq!(d.row_count, 99); // body replaced
        assert_eq!(d.fingerprint, "newfp");
        assert_ne!(d.fingerprint, original.fingerprint);
        assert_eq!(ws.active().unwrap().reference_name, "orders"); // now active
    }

    #[test]
    fn replace_makes_replaced_dataset_active_over_others() {
        // ADR-0022: a replace is a fresh upload -> active moves to it even when
        // another source was active before.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        ws.register(descriptor("people"));
        assert_eq!(ws.active().unwrap().reference_name, "people");
        let mut replacement = descriptor("orders");
        replacement.row_count = 7;
        assert!(ws.replace(replacement));
        assert_eq!(ws.active().unwrap().reference_name, "orders");
    }

    #[test]
    fn replace_returns_false_for_unknown_reference() {
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert!(!ws.replace(descriptor("nope")));
        assert_eq!(ws.len(), 1); // unchanged
    }

    #[test]
    fn set_privacy_updates_the_descriptor_in_place() {
        // ADR-0011, issue #9: the per-dataset privacy config lands on the stored
        // descriptor and is returned, so the command boundary reflects it
        // immediately and the (future) #1 window assembler reads it back.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        // sanity: ships the ADR-0011 default
        assert!(ws.get("orders").unwrap().privacy.send_samples);

        let cfg = DatasetPrivacy {
            send_samples: false,
            type_only_columns: vec!["secret".into()],
        };
        let resolved = ws.set_privacy("orders", cfg.clone()).unwrap();
        assert_eq!(resolved.reference_name, "orders");
        assert_eq!(resolved.privacy, cfg); // returned
        assert_eq!(ws.get("orders").unwrap().privacy, cfg); // and stored
    }

    #[test]
    fn set_privacy_returns_none_for_unknown_reference() {
        // A single-failure op (unknown name) -> None, not a typed error; the
        // command maps None to an error string. No phantom dataset is created.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert!(ws.set_privacy("nope", DatasetPrivacy::default()).is_none());
        assert_eq!(ws.len(), 1); // unchanged
    }

    // --- Materialized turn results (issue #22) --------------------------------
    //
    // ADR-0022/0024: a turn result is a Dataset like any source, sharing the
    // FROM namespace, but stored as a main-DB physical table (not an attached
    // snapshot). Its number is session-monotonic and never reused; the active
    // pointer tracks the most-recent source, not results.

    fn result_descriptor(name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 1,
            sample: vec![vec!["1".into()]],
            fingerprint: name.into(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    #[test]
    fn next_result_number_starts_at_one_with_only_sources() {
        let mut ws = WorkingSet::default();
        ws.register(descriptor("people"));
        assert_eq!(ws.next_result_number(), 1); // no results yet
    }

    #[test]
    fn result_number_is_monotonic_and_one_past_max() {
        // ADR-0022: result_N = max(existing)+1, monotonic, never reused.
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        assert_eq!(ws.next_result_number(), 2);
        ws.register_result(result_descriptor("result_2"));
        assert_eq!(ws.next_result_number(), 3);
        // a gap leaves 6 as the next -- numbers are never back-filled.
        ws.register_result(result_descriptor("result_5"));
        assert_eq!(ws.next_result_number(), 6);
    }

    #[test]
    fn a_source_named_like_a_result_does_not_inflate_the_counter() {
        // A source whose sanitized name collides with the result_N pattern
        // (e.g. result_9.csv -> result_9) is NOT a derived result and must not
        // be scanned by next_result_number.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("result_9"));
        assert_eq!(ws.next_result_number(), 1);
        assert!(!ws.is_result("result_9"));
    }

    #[test]
    fn register_result_does_not_steal_active_from_source() {
        // Active tracks the most-recently-uploaded source (ADR-0022); a derived
        // result must not move active (resolution across results is #27).
        let mut ws = WorkingSet::default();
        ws.register(descriptor("people"));
        assert_eq!(ws.active().unwrap().reference_name, "people");
        ws.register_result(result_descriptor("result_1"));
        assert_eq!(ws.active().unwrap().reference_name, "people");
    }

    #[test]
    fn sql_from_picks_catalog_form_for_source_and_table_form_for_result() {
        // A source FROM is "<ref>".data (attached read-only catalog); a result
        // FROM is "<ref>" (main-DB physical table). Same namespace, distinct
        // storage forms.
        let mut ws = WorkingSet::default();
        ws.register(descriptor_with("people", "People"));
        assert_eq!(ws.sql_from("people").as_deref(), Some(r#""people".data"#));
        ws.register_result(result_descriptor("result_1"));
        assert_eq!(ws.sql_from("result_1").as_deref(), Some(r#""result_1""#));
    }

    #[test]
    fn sql_from_returns_none_for_unknown_reference() {
        let ws = WorkingSet::default();
        assert!(ws.sql_from("nope").is_none());
    }

    #[test]
    fn source_paths_lists_sources_excluding_results() {
        // ADR-0080 / issue #293: the gateway file-reachability whitelist
        // carries the original file paths of uploaded sources as its read-only
        // roots. A derived result_N has no source path (it is a main-DB table,
        // ADR-0024), so even though it shares the FROM namespace with sources
        // it never contributes a root. Registration order is preserved.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("people")); // source_path "/people.csv"
        ws.register(descriptor("orders")); // source_path "/orders.csv"
        ws.register_result(result_descriptor("result_1")); // source_path ""
        assert_eq!(ws.source_paths(), vec!["/people.csv", "/orders.csv"]);
    }

    // --- Source removal (issue #38) -------------------------------------------

    #[test]
    fn remove_drops_a_non_active_source_and_keeps_the_rest() {
        // The delete-source happy path: a non-active source is removed, the
        // others stay, and the removed descriptor comes back so the caller can
        // stamp a Deleted event with its display label.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders")); // active after this
        ws.register(descriptor("people")); // active = people now
        assert_eq!(ws.active().unwrap().reference_name, "people");

        let removed = ws.remove("orders").expect("orders registered");
        assert_eq!(removed.reference_name, "orders");
        assert_eq!(removed.display_name, "orders"); // label preserved for the event
        assert_eq!(ws.len(), 1);
        assert!(ws.get("orders").is_none()); // gone from the namespace
        assert!(ws.get("people").is_some()); // untouched
        assert_eq!(ws.active().unwrap().reference_name, "people"); // active unchanged
    }

    #[test]
    fn remove_clears_active_when_it_pointed_at_the_removed_name() {
        // Defensive: the session guard never removes the active source, but the
        // working set stays correct if that ever changes -- active must not
        // dangle at a name that's no longer registered.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert_eq!(ws.active().unwrap().reference_name, "orders");
        ws.remove("orders");
        assert!(ws.active().is_none());
        assert!(ws.is_empty());
    }

    #[test]
    fn remove_returns_none_for_unknown_reference() {
        // Removing a name that was never registered (or already removed) is a
        // no-op returning None; the working set is unchanged.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("orders"));
        assert!(ws.remove("nope").is_none());
        assert_eq!(ws.len(), 1);
        // idempotent on the live name too: a second remove after the first is None
        ws.remove("orders");
        assert!(ws.remove("orders").is_none());
    }

    // --- GC cap (issue #42, ADR-0013) -----------------------------------------
    //
    // M=100 default: result_N total over the cap -> auto-reclaim the oldest
    // stale; active results are never auto-deleted. These unit tests pin the
    // selection policy in isolation; the session-level GC (physical-table DROP
    // + thread preservation) is exercised at the black-box seam in
    // `lifecycle_blackbox.rs`.

    fn anchor() -> StaleAnchor {
        StaleAnchor {
            reference_name: "src".into(),
            display_name: "src".into(),
            reason: StaleReason::Deleted,
        }
    }

    /// Register a result_N and mark it stale -- the GC-eligible shape. Uses the
    /// private `mark_stale` (accessible from the child test module) so the test
    /// doesn't have to stand up a provenance graph just to exercise selection.
    fn register_stale_result(ws: &mut WorkingSet, name: &str) {
        ws.register_result(result_descriptor(name));
        ws.mark_stale(name, anchor());
    }

    #[test]
    fn gc_returns_empty_when_results_at_or_under_cap() {
        // AC1 (issue #42): no overshoot -> nothing to reclaim. At-cap and
        // under-cap both yield an empty selection.
        let mut ws = WorkingSet::default();
        register_stale_result(&mut ws, "result_1");
        ws.register_result(result_descriptor("result_2"));
        assert!(ws.gc_stale_candidates(2).is_empty(), "at cap -> nothing");
        assert!(ws.gc_stale_candidates(5).is_empty(), "under cap -> nothing");
    }

    #[test]
    fn gc_picks_oldest_stale_when_result_count_exceeds_cap() {
        // AC2 (issue #42): over cap -> the oldest stale result(s) are selected,
        // ordered by creation (smallest result_N first).
        let mut ws = WorkingSet::default();
        ws.register(descriptor("people")); // a source -- not counted, not selectable
        register_stale_result(&mut ws, "result_1");
        register_stale_result(&mut ws, "result_2");
        ws.register_result(result_descriptor("result_3")); // active
                                                           // 3 results, cap 2 -> overshoot 1 -> oldest stale (result_1) selected.
        assert_eq!(ws.gc_stale_candidates(2), vec!["result_1".to_string()]);
    }

    #[test]
    fn gc_takes_only_as_many_as_the_overshoot() {
        // Over cap by k -> at most k stale results, oldest-first. GC restores
        // the cap; it never over-reclaims past the overshoot.
        let mut ws = WorkingSet::default();
        register_stale_result(&mut ws, "result_1");
        register_stale_result(&mut ws, "result_2");
        register_stale_result(&mut ws, "result_3");
        register_stale_result(&mut ws, "result_4");
        // 4 results, cap 2 -> overshoot 2 -> result_1, result_2.
        assert_eq!(
            ws.gc_stale_candidates(2),
            vec!["result_1".to_string(), "result_2".to_string()]
        );
    }

    #[test]
    fn gc_never_selects_active_results_even_when_over_cap() {
        // AC3 (issue #42): active (non-stale) results are never selected, even
        // when they are older than every stale result or the count is far over.
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1")); // active, oldest
        ws.register_result(result_descriptor("result_2")); // active
        register_stale_result(&mut ws, "result_3"); // stale, youngest
                                                    // 3 results, cap 1 -> overshoot 2, but only 1 stale exists -> just
                                                    // result_3. result_1/result_2 (active) never selected despite being
                                                    // older and the count being 3x the cap.
        assert_eq!(ws.gc_stale_candidates(1), vec!["result_3".to_string()]);
    }

    #[test]
    fn gc_returns_empty_when_no_stale_results_to_reclaim() {
        // Over cap but every result active -> nothing can be reclaimed. The
        // count stays over the soft cap (active is never auto-deleted). This is
        // the safety-valve escape hatch: GC is best-effort, not a hard limit.
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        ws.register_result(result_descriptor("result_2"));
        ws.register_result(result_descriptor("result_3"));
        assert!(
            ws.gc_stale_candidates(2).is_empty(),
            "no stale results -> nothing to GC even over cap"
        );
    }

    #[test]
    fn gc_excludes_sources_named_like_a_result() {
        // A source whose sanitized name is `result_1` lives in `datasets` but
        // not in `results` -> never counted toward the cap, never selected
        // (mirrors next_result_number's result-set guard).
        let mut ws = WorkingSet::default();
        ws.register(descriptor("result_1")); // a SOURCE named result_1
        register_stale_result(&mut ws, "result_2");
        // 1 actual result (result_2), cap 0 -> overshoot 1 -> only the real
        // result_2 is selected; the source-named result_1 is left registered.
        assert_eq!(ws.gc_stale_candidates(0), vec!["result_2".to_string()]);
        assert!(
            ws.get("result_1").is_some(),
            "source named result_1 is not a reclaim target"
        );
    }

    #[test]
    fn remove_clears_provenance_edge() {
        // AC2 (issue #42): GC reclaims via `remove`, whose contract includes
        // clearing the provenance edge. Without it, a later source delete's
        // cascade would still treat the GC'd result as a dependent. The
        // `is_live_result` guard in `cascade_stale` skips an unregistered name
        // today, so a stale edge is latent cruft rather than an active bug --
        // this test pins the contract so a future `remove` rewrite can't
        // silently drop it. The session-layer GC path (DROP + `remove`) rides
        // on this guarantee for AC2's "lineage entry reclaimed" limb.
        let mut ws = WorkingSet::default();
        ws.register(descriptor("people"));
        ws.register_result(result_descriptor("result_1"));
        let mut deps = HashSet::new();
        deps.insert("people".to_string());
        ws.record_provenance("result_1", deps);
        assert!(
            !ws.dependents_of("people").is_empty(),
            "result_1 depends on people before the remove"
        );
        ws.remove("result_1");
        assert!(
            ws.dependents_of("people").is_empty(),
            "provenance edge cleared -- a GC'd result is no longer a dependent"
        );
    }
}
