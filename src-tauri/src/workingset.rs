//! Working set registry (ADR-0022 / ADR-0037). Tracks loaded source Datasets,
//! de-conflicts reference names, and holds the active-dataset pointer (= the
//! most recently uploaded source).

use std::collections::HashSet;

use crate::model::{DatasetDescriptor, RenameError};

#[derive(Debug, Default)]
pub struct WorkingSet {
    datasets: Vec<DatasetDescriptor>,
    active: Option<String>, // reference name (stable)
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

    pub fn list(&self) -> &[DatasetDescriptor] {
        &self.datasets
    }

    pub fn active(&self) -> Option<&DatasetDescriptor> {
        self.active.as_ref().and_then(|r| self.get(r))
    }

    pub fn get(&self, reference_name: &str) -> Option<&DatasetDescriptor> {
        self.datasets
            .iter()
            .find(|d| d.reference_name == reference_name)
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

    pub fn len(&self) -> usize {
        self.datasets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.datasets.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnSchema, RectifyProvenance};

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
}
