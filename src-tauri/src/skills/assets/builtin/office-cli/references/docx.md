# Word documents (docx)

Commands below are written in shell form (`officecli set report.docx ...`) for
readability. Pass them to the `office-cli` tool as the `args` array, one token
per element: `["set", "report.docx", "/body", "--prop", "text=Hello"]`. Values
containing spaces stay one element. Quotation marks in these examples are
display-only -- never include them in `args` elements. There is no shell — no
quoting or `$` escaping is needed at your layer.

## Help-first rule

This file teaches what a good docx looks like, not every flag. The help-first
rule lives in the skill body; the docx shapes you will use most:

```
help docx                          # list all docx elements
help docx paragraph                # full element schema (props, aliases, examples)
help docx set paragraph            # verb-scoped: props usable with `set`
help docx paragraph --json         # machine-readable schema
```

Help is pinned to the installed CLI version.

## Mental model

A `.docx` is a ZIP of XML parts (`document.xml`, `styles.xml`, `numbering.xml`,
`header*.xml`, `footer*.xml`, `comments.xml`, ...). Everything the user sees —
headings, tables, page numbers, TOC, tracked changes — is XML inside that ZIP.
`officecli` gives you a semantic-path API (`/body/p[1]/r[2]`) over it, so you
almost never touch raw XML; when you must, use `raw-set` (XML appendix below).

## Value escapes

`\n` in a `text=` value becomes a soft line break (`<w:br/>`); `\t` a tab.
Double them (`\\n`) for a literal backslash-n. Inside `batch` JSON, standard
JSON escaping applies -- a real backslash is `"\\\\"` (the value layer
doubles it, then JSON doubles each). If in doubt, `view text` after writing
and compare character-for-character.

Structural ops in docx: style, table, TOC, section. The incremental-execution
discipline (one command, check, continue) lives in the skill body; the
resident never mutates the disk file until flushed -- `save`/`close` before
another tool reads it.

## Requirements for outputs

**Clear hierarchy.** Every non-trivial document has Title → Heading 1 →
Heading 2 → body, not a wall of unstyled `Normal` paragraphs. If
`view outline` shows one flat list, the hierarchy is missing.

**Explicit heading sizes** (template defaults drift): H1 ≥ 18pt (20pt for long
reports), H2 = 14pt bold, H3 = 12pt bold, body = 11–12pt, line spacing
1.15–1.5x. Prefer `style=Heading1` over inline sizes; set explicit sizes when
the template's styles can't be trusted.

**One body font, one accent.** One readable body font (Calibri, Cambria,
Georgia, Times New Roman); accent color for heading emphasis or table headers,
not rainbow formatting.

**Spacing through properties.** `spaceBefore` / `spaceAfter` on paragraphs.
Rows of empty paragraphs break pagination and are flagged by `view issues`.

**Typographic quality.** Curly quotes (`’` `“` `”`), en-dash `–` for ranges,
em-dash `—` for parenthetical breaks.

**Headers, footers, page numbers on any document > 1 page.** Page numbers go
through a live `PAGE` field (`--prop field=page`), never the literal text
"Page 1".

**Preserve existing templates.** When editing a file that already has a look,
match it — existing conventions override these guidelines.

### Visual delivery floor (every document)

Before declaring done, run `view <file> html` and read the returned HTML path
(use the `python` tool to read it) and confirm:

- **No placeholder tokens rendered as data** — `$xxx$`, `{var}`, `{{name}}`,
  `<TODO>`, `lorem`, `xxxx` never appear in headings, body, cover, TOC,
  captions, header, or footer.
- **No truncated titles or overflowing cells.** Widen the column or set
  `wrapText` rather than trimming content.
- **TOC present when the document has 3+ headings.**
- **Cover page ≥ 60% filled, last page ≥ 40% filled.** Pad a thin cover with
  subtitle / author / date / scope / key highlights.
- **No `\$`, `\t`, `\n` literals in document text** — if `view text` shows
  these, an escape layer leaked; delete the paragraph and re-enter it.

If any fails, STOP and fix before declaring done.

## Common workflow

1. **Orient.** New file: `create <file>`. Existing: `view <file> outline` —
   heading tree, section count, TOC / watermark / tracked-changes presence.
   Never edit blind.
2. **Build incrementally.** Structural first, content next, formatting last:
   styles & numbering → sections / page setup → headings & body → tables /
   images / fields / TOC → headers / footers → comments. After each structural
   op, `get` it back before stacking on top.
3. **Format to spec.** Explicit heading sizes, spacing, widths, alignment,
   list indents — formatting is part of the deliverable, not polish.
4. **Save, then trust structure over cached text.** TOC / PAGE / SEQ /
   PAGEREF fields carry **cached values** that may be stale or empty until a
   human recalculates (F9 in Word). Confirm fields *exist* (`get --depth 3`
   shows `fldChar`) rather than trusting the visible text.
5. **QA — assume there are problems.** See QA below. You are done after one
   fix-and-verify cycle finds zero new issues, not when the last command
   exited 0.

## Quick start

Minimal viable docx: a heading, a body paragraph, a subheading, and a footer
with a live page-number field. Adapt, don't copy.

```
create report.docx
add report.docx /body --type paragraph --prop text="Q4 Review" --prop style=Heading1 --prop size=20pt --prop bold=true --prop spaceAfter=12pt
add report.docx /body --type paragraph --prop text="Revenue grew 18% year-over-year, ahead of plan." --prop size=11pt --prop spaceAfter=8pt
add report.docx /body --type paragraph --prop text="Key Drivers" --prop style=Heading2 --prop size=14pt --prop bold=true --prop spaceBefore=12pt --prop spaceAfter=6pt
add report.docx / --type footer --prop type=default --prop size=9pt --prop text="Page " --prop field=page
set report.docx /footer[1]/p[1] --prop align=center
save report.docx
validate report.docx
```

## Reading & analysis

Start wide, then narrow.

```
view report.docx outline                  # heading tree, sections, tables, tracked changes
view report.docx text --start 1 --end 80  # text with [/body/p[N]] anchors for follow-up get
view report.docx annotated                # values + style/font/size + warnings per run
view report.docx stats                    # paragraph counts, font usage, style distribution
view report.docx issues                   # empty paras, missing alt text, spacing anomalies
```

**Inspect one element** (1-based semantic paths; `--depth N` expands
children; `--json` for machine output):

```
get report.docx /                                # root: metadata, page setup
get report.docx /body/p[1]                       # one paragraph
get report.docx /body/p[1]/r[1]                  # one run (character formatting)
get report.docx /body/tbl[1] --depth 3           # table with rows and cells
get report.docx /footer[1] --depth 3             # footer — check for fldChar
get report.docx /styles/Heading1                 # style definition
get report.docx /numbering --depth 2             # abstractNum + num bindings
```

`[last()]` (with parens) addresses the last element; `[last]` errors.

**Query across the document** (CSS-like; operators `=`, `!=`, `~=`, `>=`,
`<=`, `[attr]`, `:contains()`, `:empty`, `:no-alt`):

```
query report.docx 'paragraph[style=Heading1]'   # all H1s
query report.docx 'p:contains("quarterly")'     # text match
query report.docx 'p:empty'                     # empty paragraphs (clutter)
query report.docx 'image:no-alt'                # accessibility gaps
query report.docx 'field[fieldType!=page]'      # non-PAGE fields
```

`query --json` wraps results in `.data.results[]`. Large documents: navigate
by heading with `view outline`, jump with `query` — don't dump the whole body.

## Creating & editing

Verbs: `add` (new element), `set` (change a prop), `remove`, `move`, `swap`,
`batch`, `raw-set` (last resort). Ninety percent of a build is paragraphs,
runs, tables, a couple of images, a TOC, and a footer.

### Paragraphs, runs, styles

A paragraph (`p`) is a block; a run (`r`) is a span of consistent character
formatting inside it. Paragraph-level props (style, alignment, spacing,
indent) go on the `p`; font / size / color / bold on the `r`.

```
add report.docx /body --type paragraph --prop text="Executive Summary" --prop style=Heading1 --prop size=18pt
set report.docx /body/p[1]/r[1] --prop color=1F4E79
```

Left indent: `--prop indent=720` (twips), `firstLineIndent=360`,
`hangingIndent=720`. Never indent with leading spaces.

### Tables

`/body/tbl[N]` with rows `tr[N]`, cells `tc[N]`.

```
add report.docx /body --type table --prop rows=4 --prop cols=3 --prop width=100%
set report.docx /body/tbl[1]/tr[1] --prop header=true --prop c1=Quarter --prop c2=Revenue --prop c3=Growth
set report.docx /body/tbl[1]/tr[1]/tc[1]/p[1]/r[1] --prop bold=true
```

Row-level `set` supports `height`, `header`, and `c1`..`cN` text shortcuts.
Cell formatting (bold, fill, color) goes on the cell's paragraph / run — not
row-level. Per-cell borders: `--prop border.bottom="single;6;000000;0"` on the
`tc` (format `style;size;color;space`).

**Horizontal rule = a paragraph bottom border, never a 1-row table:**
`set report.docx /body/p[3] --prop pbdr.bottom="single;6;2E75B6"`.

### Lists

Single-level: `listStyle` is a paragraph prop (NOT a run prop):

```
add report.docx /body --type paragraph --prop text="First item" --prop listStyle=bullet
```

Multi-level (1 / 1.1 / 1.1.1): add `abstractNum`, then `num`, then reference
`numId` per paragraph:

```
add report.docx /numbering --type abstractnum --prop format=decimal   # → abstractNum id=0
add report.docx /numbering --type num --prop abstractNumId=0          # → num id=1
add report.docx /body --type paragraph --prop text="Section one" --prop numId=1 --prop ilvl=0
```

IDs are 0-based; a non-existent `abstractNumId` errors. Verify:
`query 'paragraph[numId>0]'`. Full level/format options:
`help docx abstractnum` / `help docx num`.

### Tab stops (signature lines, leader rows)

A first-class `tab` child of the paragraph; `pos` accepts `6in`/`6cm`/twips,
`val` ∈ left/center/right, `leader` ∈ none/dot/hyphen/underscore.

```
add report.docx /body/p[1] --type tab --prop pos=6in --prop val=right --prop leader=dot
```

**Leader caveat:** `leader=dot` alone emits no dots — the leader renders only
when a real tab character sits in a run between text and the stop. Put one
there with `\t` in the text: `--prop text="Chapter 1\t12"`.

### Fields (PAGE / NUMPAGES / DATE / MERGEFIELD / REF)

Fields are live values computed at render time; `fieldType` picks the field,
`name` the target, `instruction` carries raw switches.

| Field | Use | Example |
|---|---|---|
| `page` | current page number | `--prop field=page` on footer |
| `numpages` | total pages | `--prop fieldType=numpages` |
| `date` | today | `--prop fieldType=date --prop format=yyyy-MM-dd` |
| `mergefield` | template merge token | `--prop fieldType=mergefield --prop name=CustomerName` |
| `ref` | cross-reference to bookmark | `--prop fieldType=ref --prop name=bookmarkName` |

Full enum (30+ values) in `help docx field`. Picture switches
(`MERGEFIELD Amount \# "#,##0.00"`) go via `--prop instruction='...'`.

**MERGEFIELD templates must never render placeholder literals** — a
`{{customer_name}}` shown as body text is a failed template. Insert a real
MERGEFIELD or confine literal tokens to an obvious instruction paragraph.
Confirm: `query 'field[fieldType=mergefield]'`.

**Recalculating cached values:**

- **SEQ numbering** (`Figure 1/2/3`): `set <file> / --prop recalcFields=seq`
  counts SEQ fields in document order and writes correct cached values now.
- **PAGE / PAGEREF / NUMPAGES / TOC page numbers** need pagination, which the
  CLI has no engine for — `set <file> /settings --prop updateFields=true`
  defers them to Word on open. Report the TOC as dynamic and uncomputed; do
  not guess static page numbers.

### Headers & footers

The CLI injects `<w:fldChar>`, so you never compose the field by hand:

```
# Empty first-page footer — auto-enables differentFirstPage so the cover has no number
add report.docx / --type footer --prop type=first --prop text=""
# Default footer with live page number
add report.docx / --type footer --prop type=default --prop align=center --prop size=9pt --prop text="Page " --prop field=page
```

When both exist, the default footer is `/footer[2]`; alone, `/footer[1]`.
**Verify by structure**: `get /footer[N] --depth 3` must show `fldChar`
children — `view outline` printing "Footer: Page" means nothing (it prints
that for static text too). Do NOT `set --prop differentFirstPage=true` —
unsupported; adding a first-type footer flips the bit instead.

**Page X of Y**: add the footer paragraph, then three child ops:

```
add report.docx / --type footer --prop type=default --prop text="Page " --prop align=center --prop size=9pt
add report.docx /footer[1]/p[1] --type field --prop fieldType=page
add report.docx /footer[1]/p[1] --type run --prop text=" of "
add report.docx /footer[1]/p[1] --type field --prop fieldType=numpages
```

### Table of contents

A TOC source must use a built-in Heading style or a custom paragraph style
with `outlineLvl`; bold or large Normal text is NOT a source. If no eligible
source exists, fix the heading structure instead of inserting a TOC that
renders "Error! No table of contents entries found."

```
add report.docx /styles --type style --prop id=ThesisH1 --prop type=paragraph --prop outlineLvl=0   # custom source
add report.docx /body --type toc --prop levels=1-3 --prop title="Table of Contents" --prop hyperlinks=true --index 0
set report.docx /settings --prop updateFields=true
```

Address the TOC as `/toc[1]` or `/tableofcontents` for `get`/`set`/`remove`.

### Images and charts

Pictures go inside a run; `alt` is mandatory for accessibility:

```
add report.docx /body/p[5] --type picture --prop src=logo.png --prop width=1.5in --prop alt="Acme logo"
```

Confirm `query 'image:no-alt'` is empty before delivery.

For data, add a **native chart** — editable, themeable, re-renders in Word —
never a flat PNG screenshot:

```
add report.docx /body --type chart --prop chartType=bar --prop title="Revenue by Region" --prop categories="EMEA,APAC,Americas" --prop data="2026:120,150,180"
```

`chartType` ∈ bar / column / line / pie / area / scatter (`help docx chart`
for styling). PNG via `--type picture` only as a fallback.

### Hyperlinks and bookmarks

```
add report.docx /body/p[2] --type hyperlink --prop url=https://example.com --prop text="our site"
# Internal: --prop anchor=bookmarkName (not a #fragment in url)
add report.docx /body/p[2] --type hyperlink --prop anchor=chapter1 --prop text="See Chapter 1"
```

### Sections and page setup

Document root `/` carries page setup in twips. Multi-section documents
(landscape insert, columns) add a `section` break — `help docx section`.

```
set report.docx / --prop pageWidth=12240 --prop pageHeight=15840 --prop marginTop=1440 --prop marginLeft=1440
set report.docx / --prop columns=2 --prop columnSpace=720      # multi-column flow
```

Both camelCase (canonical) and lowercase aliases accepted; prefer camelCase.

### Forcing page breaks

One mechanism per boundary — never both. Default: `pageBreakBefore=true` on
the target heading (`--prop break=newPage` is an alias). Alternative: one
explicit `pagebreak` before it. Combining both can produce a blank page. Never
set `pageBreakBefore` on `p[last()]` right after adding a `pagebreak`.

### Recipes

**(a) Rich cover page (≥ 60% filled):** stack a confidentiality banner, title
(32pt Title style), italic subtitle (16pt), prepared-for / engagement lines, a
key-themes line, then `--prop pageBreakBefore=true` on the first Heading 1.

**(b) Header row with fill:** order matters — populate header cell text FIRST
(runs don't exist in empty cells; `set .../tc[N]/p[1]/r[1]` on an empty cell
errors), THEN the cell fill, THEN run formatting:

```
add report.docx /body --type table --prop rows=5 --prop cols=4 --prop width=100%
set report.docx /body/tbl[1]/tr[1] --prop header=true --prop c1=Quarter --prop c2=Revenue --prop c3=Growth --prop c4=Status
set report.docx /body/tbl[1]/tr[1]/tc[1] --prop fill=1F4E79
set report.docx /body/tbl[1]/tr[1]/tc[1]/p[1]/r[1] --prop bold=true --prop color=FFFFFF
```

**(c) Financial table:** right-align number cells
(`set .../tc[N]/p[1] --prop align=right`), bold the totals row, bottom-border
the row above totals (`--prop pbdr.bottom="single;6;000000;0"`).

**(d) Multiple bullets in one cell:** `c1="a\nb"` gives a line break within
ONE paragraph — bullets need separate paragraphs. Seed the first via
`set c1=`, then `add paragraph --prop listStyle=bullet` under the cell per
bullet; re-order with `move --index 0` if the seed landed last.

**(e) Template delivery:** internal-only guidance ("replace {{CompanyName}}")
must not ship. Either a trailing "Template Notes" Heading 1 removed before
distribution (`query 'paragraph[style=Heading1]:contains("Template Notes")'`
to locate), or bookmark-bounded internal section removed via `raw-set`.
Delivery gate: `query 'p:contains("Template Notes")'` and
`query 'p:contains("{{")'` both empty.

### Advanced (only if the document needs it)

**Equations and footnotes.** `--type equation` takes LaTeX
(`\frac`, `\sum`, Greek); default is a standalone display block,
`--prop mode=inline` with a paragraph parent drops an inline `<m:oMath>` into
running text. Footnotes auto-number. Bibliography hanging indent:
`firstLineIndent=-720 indent=720` per entry.

```
add report.docx /body --type equation --prop formula="\\frac{a}{b} + \\sum_{i=1}^{n} x_i"
add report.docx /body/p[3] --type footnote --prop text="See Appendix A for methodology."
```

**Comments and tracked changes.** Bulk accept/reject:
`set <file> /revision --prop revision.action=accept` (narrow with a selector
like `/revision[@author=Alice]` or `/revision[@type=ins]`). Locate with
`query ins` / `query del`. Create tracked changes on a run:
`--prop revision.type=ins|del --prop revision.author=...`. Comments:
`add /body/p[4] --type comment --prop author=... --prop text=...`; reply via
`--prop parentId=N`; resolve via `set /comments/comment[N] --prop done=true`
(keep the audit trail — don't delete); `query 'comment[done=false]'` lists the
open ones.

**Watermark.** `add / --type watermark --prop text=DRAFT --prop color=BFBFBF
--prop opacity=0.8` (default opacity 0.5).

## QA (required)

Assume there are problems — QA is a bug hunt, not a confirmation step.

1. `view issues` — empty paras, missing alt text, formatting anomalies.
2. `view outline` — hierarchy (no H1 → H3 skips), TOC presence, sections.
3. `view text --max-lines 400` — typos, stray `\$`/`\t`/`\n` literals,
   placeholder tokens.
4. `validate` — schema check.
5. **Visual pass:** `view html`, read the returned HTML path (via the
   `python` tool). Check hierarchy, blank pages, TOC/cover placement,
   truncation. On Windows with Word installed, `view screenshot --grid auto`
   tiles every page into one image for a full contact sheet.
6. Anything failed → fix → **rerun the full cycle** (one fix commonly creates
   another problem).

**Field spot-checks (structure, not text):** footer PAGE =
`get /footer[N] --depth 3` shows the begin / instrText / separate / cached /
end run chain (≥ 5 runs for one PAGE, ≥ 11 for "Page X of Y"). A single run
with text "Page" = field missing. TOC page numbers may read `1 1 1 1` until
recalculated — that's expected, judge by field structure.

**Honest limit:** `validate` catches schema errors, not design errors — a
document can pass with wrong hierarchy, fake heading sizes, or placeholder
tokens as body text. The visual pass and field-structure checks are how you
catch what validation can't.

## Known issues & pitfalls

| Pitfall | Correct approach |
|---|---|
| `--index` vs `[N]` | `--index` is 0-based; `[N]` paths are 1-based |
| Multiple `add --index N` with same N | Each insert shifts content — insert in reverse order or `move --after/--before` anchored on `paraId` |
| `[last]` predicate | Must be `[last()]` with parens |
| Raw twips in spacing | Unit-qualified values: `12pt`, `0.5cm`, `1.5x` |
| Empty paragraphs for spacing | `spaceBefore` / `spaceAfter` |
| Row-level `set` for cell formatting | Row supports only `height`, `header`, `c1..cN`; format the cell paragraph / run |
| `listStyle` on a run | It's a paragraph property |
| `differentFirstPage=true` | Unsupported — add a first-type footer instead |
| Next paragraph inherits Heading style | Set explicit `--prop style=Normal` on the following paragraph |
| Modifying a file open in Word | Close it in Word first |
| `\n` wanted literally | Double it: `\\n` |
| Hex colors with `#` | Drop the `#`: `FF0000` |

Renderer quirks (don't chase): PAGE may render literal "Page" until
recalculated (judge by `fldChar` presence); TOC cached numbers may read
"1 1 1 1" until F9; pie/doughnut fill may collapse to one color in some
viewers.

## Raw-set XML appendix (L3)

`raw-set` injects literal OOXML — no schema protection. Element order in
`<w:pPr>`: `pStyle`, `numPr`, `spacing`, `ind`, `jc`, `rPr` (last). Add
`xml:space="preserve"` to any `<w:t>` with leading/trailing spaces.

**Tracked-change insert/delete** — prefer the typed `--prop revision.type=`
path; raw-set only for what it can't express (rejecting/restoring another
author's change). Replace the whole `<w:r>`, never inject inside a run; copy
the original `<w:rPr>` into both halves. Inside `<w:del>` use `<w:delText>`.
When deleting ALL content of a paragraph, also mark the paragraph mark
deleted (`<w:del/>` inside `<w:pPr><w:rPr>`) or accepting changes leaves an
empty paragraph. To reject another author's insertion, nest your `<w:del>`
inside their `<w:ins>`; to restore their deletion, add an `<w:ins>` after it.

**Composite field in one run** — the `fldChar` chain:

```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>1</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
```

`set <file> /settings --prop updateFields=true` covers layout-dependent
fields; `set / --prop recalcFields=seq` writes correct SEQ cached values now.
