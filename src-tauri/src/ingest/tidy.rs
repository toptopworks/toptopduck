//! Best-effort Excel auto-tidy (ADR-0015/0042). Takes a raw sheet's cached cell
//! grid + merged-cell ranges and produces a tidy single-header table when the
//! structure can be read *confidently*; otherwise signals
//! [`TidyOutcome::NeedsGuidance`] so the UI can gather explicit header/skip
//! choices (guided fallback). The auto algorithm's own result is never recorded
//! as rectify params (ADR-0042) -- resume re-runs the current version.
//!
//! Two deterministic transforms, in order:
//! 1. **Forward-fill merged ranges** -- each merged region's top-left value
//!    fills the rest of the region, using the exact merge dimensions, so genuine
//!    NULLs (`Data::Empty` outside any merge) are never touched.
//! 2. **Header-row detection** -- locate the single header row, skipping leading
//!    title/blank rows. Two or more header-like rows above the first data row
//!    => multi-row header => `NeedsGuidance` (the auto algorithm won't guess how
//!    to splice a multi-row header; the user decides via guided load).
//!
//! Determinism contract (ADR-0042): given the same input grid + merges and the
//! same code version, the output is byte-identical. No randomness, no
//! iteration-order dependence (merged ranges are disjoint in valid workbooks).

use calamine::Data;

use crate::ingest::excel::SheetRows;

/// A sheet auto-tidied into a single-header table: the materialized rows (first
/// row = header) still as `Data` cells, so the shared CSV renderer + DuckDB type
/// inference apply uniformly (ADR-0032 single source of truth).
#[derive(Debug, Clone, PartialEq)]
pub struct TidiedSheet {
    pub rows: Vec<Vec<Data>>,
}

/// Outcome of auto-tidying one sheet.
#[derive(Debug, Clone, PartialEq)]
pub enum TidyOutcome {
    /// The sheet tidied confidently into a single-header table.
    Tidied(TidiedSheet),
    /// The structure can't be confidently read -- the UI must gather explicit
    /// header/skip choices (ADR-0015 guided fallback).
    NeedsGuidance,
}

/// Auto-tidy one sheet (ADR-0015). See the module docs for the transform
/// sequence and the confidence gate.
pub fn auto_tidy(sheet: &SheetRows) -> TidyOutcome {
    // Clone so forward-fill + row selection don't mutate the caller's grid.
    let mut rows = sheet.rows.clone();
    forward_fill_merges(&mut rows, &sheet.merges);

    // Indices of non-blank rows (after forward-fill, so a filled merge region
    // counts as non-blank).
    let non_blank: Vec<usize> = (0..rows.len()).filter(|&i| !is_blank(&rows[i])).collect();
    if non_blank.is_empty() {
        return TidyOutcome::NeedsGuidance;
    }

    // First row carrying a data-typed cell (Int/Float/DateTime/Bool). Its
    // presence anchors "data starts here"; non-blank rows above it form the
    // header zone.
    let first_data = non_blank.iter().copied().find(|&i| has_data_type(&rows[i]));

    let header_idx = match first_data {
        None => {
            // All-text sheet (no numeric/date/bool column): trust a single
            // header row. Skip a leading single-cell banner title first, so a
            // cell like "Report" above an all-text table doesn't become the
            // header. Multi-row all-text headers can't be auto-detected without
            // a type anchor -- an accepted auto-tidy limitation the user can
            // override via guided load.
            first_multi_col_row(&rows, &non_blank).unwrap_or(non_blank[0])
        }
        Some(data_idx) => {
            // Header zone = non-blank rows strictly above the first data row.
            let header_zone: Vec<usize> = non_blank
                .iter()
                .copied()
                .filter(|&i| i < data_idx)
                .collect();
            let header_like: Vec<usize> = header_zone
                .iter()
                .copied()
                .filter(|&i| is_header_like(&rows[i]))
                .collect();
            match header_like.len() {
                1 => header_like[0],
                // No multi-column header, but exactly one row above the data:
                // accept it as a single-column header (a legit narrow table).
                0 if header_zone.len() == 1 => header_zone[0],
                // 2+ header-like rows (multi-row header), an empty header zone
                // (data starts at row 0), or several non-header rows above the
                // data -- the auto algorithm won't guess; defer to the user.
                _ => return TidyOutcome::NeedsGuidance,
            }
        }
    };

    // Materialize: the header row, then every row below it. Leading title/blank
    // rows above the header are dropped; so is anything between the header and
    // the first data row (already guaranteed non-header-like above).
    let mut tidy = Vec::with_capacity(rows.len().saturating_sub(header_idx));
    tidy.push(rows[header_idx].clone());
    tidy.extend(rows[header_idx + 1..].iter().cloned());
    TidyOutcome::Tidied(TidiedSheet { rows: tidy })
}

/// Forward-fill every merged range with its top-left cell's value. Only
/// `Data::Empty` cells inside a range are overwritten, so a value the user
/// actually placed elsewhere in a merged region is left intact (defensive --
/// Excel merges store one value, but the grid could carry extras). Bounds-
/// checked: ranges outside the grid are clipped, never panic.
pub(crate) fn forward_fill_merges(rows: &mut [Vec<Data>], merges: &[calamine::Dimensions]) {
    for m in merges {
        let (r0, c0) = m.start;
        let (r1, c1) = m.end;
        let Some(src_row) = rows.get(r0 as usize) else {
            continue;
        };
        let Some(src) = src_row.get(c0 as usize).cloned() else {
            continue;
        };
        for r in r0..=r1 {
            let Some(row) = rows.get_mut(r as usize) else {
                continue;
            };
            for c in c0..=c1 {
                if let Some(cell) = row.get_mut(c as usize) {
                    if matches!(cell, Data::Empty) {
                        *cell = src.clone();
                    }
                }
            }
        }
    }
}

/// A row is blank when every cell is empty.
fn is_blank(row: &[Data]) -> bool {
    row.iter().all(|c| matches!(c, Data::Empty))
}

/// Count non-empty cells in a row.
fn non_empty_count(row: &[Data]) -> usize {
    row.iter().filter(|c| !matches!(c, Data::Empty)).count()
}

/// A row "looks like a header": at least two non-empty text cells whose values
/// are not all identical. The two-column minimum distinguishes a real header
/// from a single-cell banner title; the not-all-identical rule excludes a
/// merged-title row once forward-fill has spread its one value across columns.
fn is_header_like(row: &[Data]) -> bool {
    let non_empty: Vec<&Data> = row.iter().filter(|c| !matches!(c, Data::Empty)).collect();
    if non_empty.len() < 2 {
        return false;
    }
    if !non_empty.iter().all(|c| matches!(c, Data::String(_))) {
        return false;
    }
    let all_same = non_empty.windows(2).all(|w| w[0] == w[1]);
    !all_same
}

/// The row carries at least one data-typed cell (Int/Float/DateTime/Bool).
fn has_data_type(row: &[Data]) -> bool {
    row.iter().any(|c| {
        matches!(
            c,
            Data::Int(_) | Data::Float(_) | Data::DateTime(_) | Data::Bool(_)
        )
    })
}

/// First non-blank row with 2+ non-empty cells (header-like, but without the
/// all-text constraint -- used for all-text sheets whose header carries the
/// only text values).
fn first_multi_col_row(rows: &[Vec<Data>], non_blank: &[usize]) -> Option<usize> {
    non_blank
        .iter()
        .copied()
        .find(|&i| non_empty_count(&rows[i]) >= 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Dimensions;

    // Compact cell constructors for readable grids.
    fn s(v: &str) -> Data {
        Data::String(v.into())
    }
    fn i(v: i64) -> Data {
        Data::Int(v)
    }
    fn f(v: f64) -> Data {
        Data::Float(v)
    }
    fn row(cells: &[Data]) -> Vec<Data> {
        cells.to_vec()
    }
    /// Merge range covering `(r0,c0)..=(r1,c1)` (0-based, calamine convention).
    fn merge(r0: u32, c0: u32, r1: u32, c1: u32) -> Dimensions {
        Dimensions::new((r0, c0), (r1, c1))
    }
    fn sheet(rows: Vec<Vec<Data>>, merges: Vec<Dimensions>) -> SheetRows {
        SheetRows {
            name: "s".into(),
            rows,
            merges,
        }
    }
    fn tidied_rows(o: TidyOutcome) -> Vec<Vec<Data>> {
        match o {
            TidyOutcome::Tidied(t) => t.rows,
            TidyOutcome::NeedsGuidance => panic!("expected Tidied, got NeedsGuidance"),
        }
    }

    #[test]
    fn forward_fill_fills_merged_region_from_top_left() {
        // "East" merged across region col (col 1) rows 1..=2.
        let mut rows = vec![
            row(&[s("id"), s("region"), s("amt")]),
            row(&[i(1), s("East"), f(100.0)]),
            row(&[i(2), Data::Empty, f(200.0)]),
        ];
        forward_fill_merges(&mut rows, &[merge(1, 1, 2, 1)]);
        assert_eq!(rows[2][1], s("East")); // filled
        assert_eq!(rows[1][1], s("East")); // source unchanged
    }

    #[test]
    fn forward_fill_leaves_genuine_nulls() {
        // No merge covers (1,0); a real NULL there stays Empty.
        let mut rows = vec![row(&[s("id"), s("x")]), row(&[Data::Empty, i(1)])];
        forward_fill_merges(&mut rows, &[]);
        assert!(matches!(rows[1][0], Data::Empty));
    }

    #[test]
    fn auto_tidy_clean_single_header_is_tidied_as_is() {
        let g = sheet(
            vec![
                row(&[s("id"), s("name"), s("score")]),
                row(&[i(1), s("Alice"), f(3.5)]),
                row(&[i(2), s("Bob"), f(2.8)]),
            ],
            vec![],
        );
        let out = tidied_rows(auto_tidy(&g));
        // Header preserved, all data rows retained -- nothing to skip.
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], row(&[s("id"), s("name"), s("score")]));
    }

    #[test]
    fn auto_tidy_skips_leading_single_cell_title() {
        // Row 0 is a single-cell banner "Report"; row 1 is the real header.
        let g = sheet(
            vec![
                row(&[s("Report")]),
                row(&[s("id"), s("name")]),
                row(&[i(1), s("Alice")]),
            ],
            vec![],
        );
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[0], row(&[s("id"), s("name")])); // title dropped
        assert_eq!(out.len(), 2); // header + 1 data row
    }

    #[test]
    fn auto_tidy_unmerges_data_cells() {
        // region col merged across the two data rows -> both get "East".
        let g = sheet(
            vec![
                row(&[s("id"), s("region"), s("amt")]),
                row(&[i(1), s("East"), f(100.0)]),
                row(&[i(2), Data::Empty, f(200.0)]),
            ],
            vec![merge(1, 1, 2, 1)],
        );
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[2][1], s("East")); // merged cell unmerged (forward-filled)
        assert_eq!(out[0], row(&[s("id"), s("region"), s("amt")]));
    }

    #[test]
    fn auto_tidy_multi_row_header_needs_guidance() {
        // Two header-like rows above the data => multi-row header.
        let g = sheet(
            vec![
                row(&[s("base"), s("base"), s("contact")]),
                row(&[s("id"), s("name"), s("email")]),
                row(&[i(1), s("Alice"), s("a@x")]),
            ],
            vec![],
        );
        assert_eq!(auto_tidy(&g), TidyOutcome::NeedsGuidance);
    }

    #[test]
    fn auto_tidy_data_without_header_needs_guidance() {
        // First row already carries a data type -- no header to anchor on.
        let g = sheet(
            vec![row(&[i(1), s("Alice")]), row(&[i(2), s("Bob")])],
            vec![],
        );
        assert_eq!(auto_tidy(&g), TidyOutcome::NeedsGuidance);
    }

    #[test]
    fn auto_tidy_all_text_sheet_trusts_single_header() {
        // No numeric/date column at all -> single header assumed.
        let g = sheet(
            vec![
                row(&[s("name"), s("city")]),
                row(&[s("Alice"), s("NYC")]),
                row(&[s("Bob"), s("LA")]),
            ],
            vec![],
        );
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[0], row(&[s("name"), s("city")]));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn auto_tidy_all_text_sheet_skips_leading_title() {
        let g = sheet(
            vec![
                row(&[s("Users")]),
                row(&[s("name"), s("city")]),
                row(&[s("Alice"), s("NYC")]),
            ],
            vec![],
        );
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[0], row(&[s("name"), s("city")]));
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn auto_tidy_is_deterministic() {
        // Same input twice -> identical output (ADR-0042 determinism).
        let g = sheet(
            vec![
                row(&[s("Report")]),
                row(&[s("id"), s("region"), s("amt")]),
                row(&[i(1), s("East"), f(100.0)]),
                row(&[i(2), Data::Empty, f(200.0)]),
            ],
            vec![merge(2, 1, 3, 1)],
        );
        assert_eq!(auto_tidy(&g), auto_tidy(&g));
    }

    #[test]
    fn auto_tidy_empty_sheet_needs_guidance() {
        let g = sheet(vec![row(&[Data::Empty, Data::Empty])], vec![]);
        assert_eq!(auto_tidy(&g), TidyOutcome::NeedsGuidance);
    }

    #[test]
    fn auto_tidy_single_column_header_is_accepted() {
        // A narrow one-column table (header + data) tidies via the
        // single-column fallback, not NeedsGuidance.
        let g = sheet(vec![row(&[s("id")]), row(&[i(1)]), row(&[i(2)])], vec![]);
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[0], row(&[s("id")]));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn auto_tidy_merged_title_row_does_not_become_second_header() {
        // A merged banner (forward-filled to one value across columns) above a
        // real header is skipped, not mistaken for a second header row.
        let g = sheet(
            vec![
                row(&[s("Title"), Data::Empty, Data::Empty]),
                row(&[s("id"), s("name"), s("score")]),
                row(&[i(1), s("Alice"), f(3.5)]),
            ],
            vec![merge(0, 0, 0, 2)],
        );
        let out = tidied_rows(auto_tidy(&g));
        assert_eq!(out[0], row(&[s("id"), s("name"), s("score")]));
        assert_eq!(out.len(), 2);
    }
}
