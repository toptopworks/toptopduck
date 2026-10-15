# Excel workbooks (xlsx)

Commands below are written in shell form (`officecli set data.xlsx ...`) for
readability. Pass them to the `office-cli` tool as the `args` array, one
token per element: `["set", "data.xlsx", "/Sheet1/A1", "--prop", "value=42"]`.
Quotation marks in these examples are display-only -- never include them in
`args` elements. There is no shell — values containing `$` or `!` (number
formats, cross-sheet refs) pass through verbatim with no escaping needed at
your layer.

## Help-first rule

This file teaches what a good xlsx looks like, not every flag. The help-first
rule lives in the skill body; the xlsx shapes:

```
help xlsx                  # list all xlsx elements
help xlsx chart            # full element schema
help xlsx add chart        # verb-scoped
help xlsx chart --json     # machine-readable
```

## Value escapes

`\n` in a prop value is a real in-cell line break (pair with `--prop
wrapText=true`); `\t` a tab. Double them (`\\n`) for a literal. Inside
`batch` JSON, standard JSON escaping applies -- a real backslash is
`"\\\\"` (the value layer doubles it, then JSON doubles each). Cross-sheet
refs (`Sheet1!A1`) and number formats (`$#,##0`) need no escaping here.

Structural ops in xlsx: sheet, chart, named range, pivot. The
incremental-execution discipline (one command, check, continue) lives in the
skill body.

## Requirements for outputs

**Zero formula errors.** Every delivered workbook has ZERO `#REF!`,
`#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`. Guard denominators with `IFERROR` or
`IF(x=0,...)`.

**Formulas, not hardcoded values.** If a number can be computed from other
cells, it is a formula. Hardcoding `5000` where `SUM(B2:B9)` belongs breaks
the contract that the workbook stays live. The single most important rule in
this file.

**Professional font.** One consistent font across the workbook (Arial /
Calibri / Times New Roman).

**Explicit widths.** There is no auto-fit. Any column the user reads needs a
`width` — the default 8.43 chars clips everything. Starts: labels 20–25,
numbers 12–15, dates 12, short codes 8–10.

**Preserve existing templates.** Match the file's existing look.

### Visual delivery floor (every workbook)

Before declaring done, run `view <file> html` and read the returned HTML path
(via the `python` tool) and confirm:

- **No `###` in any cell** — a column too narrow for its value; `###` in a
  delivered file is unfinished work, never a small nit.
- **No truncated titles.** Widen the column or `wrapText=true`.
- **No placeholder tokens rendered as data** — `$fy$24`, `{var}`, `<TODO>`,
  `xxxx` never appear in a cell, chart title, series name, or legend.
- **Pie / doughnut slices have distinct fills.** If slices render
  same-colored, switch to `bar`/`column` or set `colors=` explicitly.
- **No empty chart anchors.** A chart over empty source cells is a broken
  chart.

**Print layout** for any sheet the user may print (board pack, handoff):

```
# Summary / chart sheet (short): fit to one page.
set data.xlsx /Summary --prop orientation=landscape --prop fitToPage=true
# Tall data table: fit WIDTH only — fitToPage=true would crush every row onto one unreadable page.
set data.xlsx /Data --prop orientation=landscape --prop fitToPage=1x0
```

`fitToPage=true` == `1x1` (both axes, one page) — correct only when the sheet
is already short. `1x0` = one page wide, unlimited tall.

### Financial models only

Scope: budgets, forecasts, 3-statement models, valuation. A tracker or
template does not need this section.

**Color coding — the industry language.** A reviewer tells what a cell IS by
color alone, before reading the formula:

| Color | Role |
|---|---|
| Blue text `0000FF` | Hardcoded inputs, scenario variables |
| Black text | All formulas and calculations |
| Green text `008000` | Cross-sheet links inside this workbook |
| Red text `FF0000` | Links to external files |
| Yellow fill `FFFF00` | Key assumptions needing review |

**Number formatting standards:** years are text (`type=string` or
`numFmt="@"`) — never `2,026`; currency units live in headers
(`Revenue ($mm)`), not every cell; zeros display as `-`
(`$#,##0;($#,##0);"-"`); percentages `0.0%`; negatives in parentheses;
valuation multiples `0.0x`.

**Assumptions live in cells, not inside formulas.** `=B5*(1+GrowthRate)` is
correct; `=B5*1.05` is a bug. Document each blue input with an adjacent source
note ("Source: Company 10-K, FY2024, Revenue Note") or a cell comment.

## Common workflow

1. **Create or load.** `create <file>` (new) or `view <file> outline`
   (existing — sheets, dimensions, formula counts).
2. **Build incrementally.** One command, check, continue. Many cells: `batch`.
3. **Format.** Column widths, number formats, freeze panes, tab colors,
   header fills — part of the deliverable, not polish.
4. **Save, then reckon with the cache.** Newly-added formulas ship without
   cached values; a human's spreadsheet app recalculates them on open. But a
   downstream formula referencing an upstream formula caches whatever the
   upstream cached at write-time — often `0` or stale — and that cached lie
   survives into non-recalculating readers. After a multi-formula build
   (SUMPRODUCT, SUMIFS, cross-sheet chains), **re-touch every downstream
   cell** (run `set` again with the same formula) so the engine recomputes;
   then `get` a few downstream cells and eyeball `cachedValue=` for sanity.
5. **QA — assume there are problems.** See QA.

## Quick start

Minimal viable xlsx: headers, 3 months, a total formula, widths, currency
format.

```
create model.xlsx
set model.xlsx /Sheet1/A1 --prop value=Month --prop bold=true
set model.xlsx /Sheet1/B1 --prop value=Revenue --prop bold=true
set model.xlsx /Sheet1/A2 --prop value=Jan
set model.xlsx /Sheet1/B2 --prop value=42000 --prop numFmt='$#,##0'
set model.xlsx /Sheet1/A3 --prop value=Feb
set model.xlsx /Sheet1/B3 --prop value=45000 --prop numFmt='$#,##0'
set model.xlsx /Sheet1/A5 --prop value=Total --prop bold=true
set model.xlsx /Sheet1/B5 --prop formula="SUM(B2:B3)" --prop bold=true --prop numFmt='$#,##0'
set model.xlsx /Sheet1/col[A] --prop width=12
set model.xlsx /Sheet1/col[B] --prop width=15
save model.xlsx
validate model.xlsx
```

Never write `=` at the start of a formula — the CLI strips it.

## CSV / bulk import

**Native `import` command (preferred).** One call loads a CSV into a sheet;
`--header` sets AutoFilter + freeze pane on row 1. Widths and `numFmt` still
need a follow-up pass.

```
import data.xlsx /Sheet1 --file data.csv --header
import data.xlsx /Sheet1 --file data.tsv --format tsv --header
```

For custom type coercion or formula injection, generate a `batch` op list
(with the `python` tool if the source is large) and run it through
`batch --commands` in chunks (~80 ops per batch is the tested sweet spot for
pure value-sets; drop to 40 if a chunk fails). On a chunk failure, retry only
that failed chunk -- completed chunks stand. After the import, reconcile the
landed row count against the source (`view stats`, or `get` the last row): a
half-landed import must not ship as complete.

## Reading & analysis

Start wide, then narrow.

```
view data.xlsx outline                          # sheets, dimensions, formula counts
view data.xlsx text --start 1 --end 50 --cols A,B,C   # scoped text dump
view data.xlsx annotated                        # values + types/formulas + warnings
view data.xlsx stats                            # numeric summaries
view data.xlsx issues                           # broken formulas, empty sheets, missing refs
```

**Round-trip dump.** `dump <file> [path]` serializes the workbook — or one
worksheet (`/Sheet1`) — into a replayable batch JSON; `batch new.xlsx
--commands <json>` replays it. Use it to learn an existing workbook's
structure or clone a template. Subtree dumps don't carry workbook-level
resources (settings, named ranges) — the replay target must define them.

**Inspect one element** (`--depth N` expands, `--json` for machine output):

```
get data.xlsx /Sheet1/A1              # one cell
get data.xlsx /Sheet1/A1:D10         # range
get data.xlsx /Sheet1/chart[1]       # chart
get data.xlsx /Sheet1/table[1]       # ListObject
get data.xlsx /namedrange[1]         # workbook-level named range
```

**Query across the workbook:**

```
query data.xlsx 'cell:has(formula)'       # every formula cell
query data.xlsx 'cell:contains("#REF!")'  # broken references
query data.xlsx 'cell[type=Number]'       # typed filter
query data.xlsx 'Sheet1!B[value!=0]'      # sheet-scoped
query data.xlsx merge                     # every merged range (alias: mergedrange)
```

When data is big enough that a row-walk is useless, use Excel's own
analytical elements: **pivot tables** (`add --type pivottable`; key props
`source`, `rows`, `cols`, `values="Field:func"`, `filters`, `grandTotals`,
`subtotals`, `sort`; aggregators sum/count/average/max/min/...; date columns
auto-group; `help xlsx pivottable` for the full schema), **sparklines**
(`--type sparkline`, `type` ∈ line|column|stacked — invalid values
hard-fail), **slicers** (`--type slicer`) for reader-side filtering.

## Creating & editing

Verbs: `add`, `set`, `remove`, `move`, `swap`, `batch`.

### Cells, formulas, structure

```
set data.xlsx /Sheet1/B5 --prop formula="SUM(B2:B4)" --prop numFmt='$#,##0'
set data.xlsx /Sheet1/col[A] --prop width=20
set data.xlsx /Sheet1/row[1] --prop height=22
set data.xlsx /Sheet1 --prop freeze=A2 --prop tabColor=1F4E79
```

**On a bare cell, `color` is ambiguous** — use `font.color` (text) or `fill`
(background). Rule: in cell props (shell or batch JSON) always write the full
dotted name — `font.color`, `font.size`, `font.name`.

### Named ranges

Prefer named ranges over `$B$6` — they self-document and survive moves:

```
batch data.xlsx --commands '[{"command":"add","parent":"/","type":"namedrange","props":{"name":"GrowthRate","ref":"Sheet1!$B$6"}}]'
```

Full schema: `help xlsx namedrange`.

### Charts

Chart types: `help xlsx chart` (20+ enum values, incl. `boxWhisker`,
`waterfall`, `funnel`, `histogram`, `treemap`, `sunburst`, `pareto`). Column
for category comparison, line for time series, pie only when slices are
self-evidently proportional, scatter for correlation.

**Three ways to feed chart data — pick one per chart, don't mix:**

| Form | Shape | When |
|---|---|---|
| inline `data` | `--prop data="Sales:100,200,300" --prop categories="Jan,Feb,Mar"` | tiny demos; source of truth lives in chart XML |
| 2D `dataRange` | `--prop dataRange="Sheet1!A1:B4"` (first col = categories, first row = header) | the normal case |
| dotted per-series | `--prop series1.name=Sales --prop series1.values="Sheet1!B2:B4" --prop series1.categories="Sheet1!A2:A4"` | multi-series / non-contiguous ranges |

**The single-column trap:** `dataRange="Sheet1!B2:B13"` looks right but fails
with "Chart requires data" — `dataRange` must be 2-D. Widen to include the
category column (`A2:B13`) or use per-series with explicit `categories`.
**Always prefix `dataRange` with the sheet name** — the sheet-less form works
inconsistently.

**Series are immutable after create** — to add/change a series, `remove` the
chart and `add` with the full series list. Note `remove chart[1]` shifts
`chart[2]` → `chart[1]` and re-add appends at the end — to preserve order,
remove all and rebuild in order. Position is mutable: `set chart[N] --prop
anchor="F5:N25"` (or `x=`/`y=`/`width=`/`height=`).

**Anchor sizing:** no auto-fit. A column chart with 5–6 categories + 2 series
needs roughly `A5:L22` (12 cols × 18 rows) for uncut labels. Start narrow,
preview via `view html`, widen in increments.

**NEVER put unreplaced template tokens in chart title / series name / legend
/ axis title** — `$fy$24`, `{var}`, `<TODO>` render literally; validate
passes but a CFO sees `$fy$24` where "FY2024" should be.

**Axis-by-role** (address by role, not index — XML order isn't stable):

```
get data.xlsx /Sheet1/chart[1]/axis[@role=value]
set data.xlsx /Sheet1/chart[1]/axis[@role=value] --prop min=0 --prop max=100000
set data.xlsx /Sheet1/chart[1]/axis[@role=category] --prop title=Month
```

Safe axis props: `title`, `min`, `max`, `majorGridlines`, `visible`,
`labelRotation`.

### Conditional formatting

Three flavors (`help xlsx cf`): **color scales** (`type=colorscale` with
`minColor`/`midColor`/`maxColor`), **data bars** (`type=databar`, set
explicit `min`/`max` for consistent scaling), **formula rules**
(`type=formula` with `formula="$C2>1000"` plus a fill/font). Apply sparingly —
a workbook where every cell is colored tells the reader nothing. Naming
asymmetry: the `--type` name is `conditionalformatting`; the path suffix is
`/cf[N]`.

### Data validation

Input cells in trackers and templates MUST carry it. Three list-source
patterns:

```
# (a) Inline list — short and fixed
add data.xlsx /Sheet1 --type validation --prop sqref="C2:C100" --prop type=list --prop formula1="Yes,No,Maybe" --prop showError=true --prop error="Select from list"

# (b) Named range (preferred for cross-sheet) — define the range first
batch data.xlsx --commands '[{"command":"add","parent":"/","type":"namedrange","props":{"name":"StatusList","ref":"Lookups!$A$2:$A$4"}},{"command":"add","parent":"/Sheet1","type":"validation","props":{"sqref":"B2:B100","type":"list","formula1":"=StatusList"}}]'

# (c) Direct cross-sheet range
batch data.xlsx --commands '[{"command":"add","parent":"/Sheet1","type":"validation","props":{"sqref":"C2:C100","type":"list","formula1":"Lookups!$A$2:$A$4"}}]'
```

Verify with `get /Sheet1/validation[N]` — `formula1=` must show a plain `!`,
no backslash. Other `type` values: `decimal`, `whole`, `date`, `textLength`,
`custom`. Full schema: `help xlsx validation`.

### Other elements

- **Tables (ListObjects):** `add --type table` with a range — auto-filter +
  structured refs. `help xlsx table`.
- **Comments:** `add --type comment` — for documenting hardcoded assumptions.
- **Sheet reordering:** `move`, not `swap` (`swap` is rows/cells only). A
  `position` prop on sheet add is often ignored — reorder with
  `move --index` after creating.
- **Clone a row with formatting:** `add /Sheet1 --from /Sheet1/row[5]
  --index 5` clones fills, fonts, formulas (refs shift); `--type row` inserts
  a bare row.
- **`remove /sheet[N]` cascade guard:** rejects when the sheet is referenced
  by validation / CF / sparkline / hyperlink / named range on another sheet —
  remove dependents first.
- **Sort:** `set /Sheet1 --prop sort="C desc" --prop sortHeader=true`
  (format `COL DIR[, COL DIR]`; rejects ranges with merged cells or formulas;
  sidecar metadata follows rows automatically).
- **Document-level:** `set / --prop calc.mode=manual`, workbook password via
  `set /` — `help xlsx /` for the full set.

## QA (required)

Assume there are problems. Your job is to find them.

1. `view issues` — empty sheets, broken formulas, missing refs.
2. `view annotated` (sample ranges) — values + types + warnings.
3. Query every error type: `cell:contains("#REF!")`, `#DIV/0!`, `#VALUE!`,
   `#NAME?`, `#N/A` — all must be empty.
4. `validate`.
5. **Visual pass:** `view html`, read the returned HTML path (via `python`).
   Scan for `###`, truncation, token leakage, sliced charts, empty anchors.
   "validate passes but the numbers are fiction" is not delivery.
6. Anything failed → fix → rerun the full cycle.

### Formula verification checklist

- [ ] Pick 2–3 formulas at random; `get` each; confirm the formula string AND
      a plausible `cachedValue` — arithmetic in your head.
- [ ] Every summary cell (COUNTA / COUNTIF / SUMPRODUCT / INDEX&MATCH) has a
      plausible cache — a tracker showing `199/199/100%` on a blank template
      means the cache lies; re-touch the formula.
- [ ] One cell per numeric column spot-checked: `%` columns at integer `0.0%`
      throughout = wrong denominator or stale cache.
- [ ] Ranges include every row — off-by-one on `SUM(B2:B12)` when data runs
      to `B13` is the most common bug.
- [ ] Named ranges point at what their names claim.
- [ ] Every `/` denominator guarded: `IFERROR(x/y, 0)`.
- [ ] Chart data spot-checked against source cells; titles / series /
      legends carry no unreplaced tokens.

### Template QA

Leftover placeholders look like content and slip past `validate`:
`query 'cell:contains("{{")'`, `query 'cell:contains("xxxx")'`,
`query 'cell:contains("TBD")'` — all empty before delivery.

**Honest limit:** `validate` catches schema errors, not design errors — a
workbook can pass with every number wrong. The checklist above is how you
catch what validation can't.

## Known issues & pitfalls

| Pitfall | Fix |
|---|---|
| `--name "foo"` | All attrs go through `--prop`: `--prop name="foo"` |
| Guessing a prop name | `help xlsx <element>` — don't improvise |
| `color=` on a cell | Ambiguous — `font.color` (text) or `fill` (bg); same inside batch JSON |
| `#FF0000` hex colors | Drop the `#` |
| `--index` vs `[N]` | `--index` 0-based; `[N]` paths 1-based |
| Sheet name with spaces | It's one `args` element — spaces are fine |
| Year as `2,026` | `type=string` or `numFmt="@"` |
| `swap` not reordering sheets | `swap` is rows/cells; sheets use `move` |
| Cached values missing after write | Human open recalculates; downstream cells need the re-touch pass |
| Modifying a file open in Excel | Close it in Excel first |
| Multiple residents on one file | Another agent/session holding a resident on the same file can contend — avoid parallel writers |

Renderer caveats (don't chase): pie/doughnut fills may collapse to a single
theme tint in some viewers; series colors may drift from the workbook theme.
Structural checks (`###`, truncation, placeholders) stay authoritative; spot-
check color fidelity in the user's target viewer.
