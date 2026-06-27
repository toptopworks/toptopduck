//! Working set registry (ADR-0022 / ADR-0037). Tracks loaded source Datasets,
//! de-conflicts reference names, and holds the active-dataset pointer (= the
//! most recently uploaded source).

use std::collections::HashSet;

use crate::model::DatasetDescriptor;

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
        if !taken(candidate) {
            return candidate.to_string();
        }
        let mut n = 2;
        loop {
            let candidate = format!("{candidate}_{n}");
            if !taken(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }

    fn taken(&self, name: &str) -> bool {
        self.datasets.iter().any(|d| d.reference_name == name)
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
    use crate::model::ColumnSchema;

    fn descriptor(name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: format!("/{name}.csv"),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 1,
            sample: vec![vec!["1".into()]],
            fingerprint: name.into(),
            rectify: None,
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
}
