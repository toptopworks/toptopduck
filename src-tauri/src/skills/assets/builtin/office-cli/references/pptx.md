# PowerPoint decks (pptx)

Commands below are written in shell form (`officecli add deck.pptx ...`) for
readability. Pass them to the `office-cli` tool as the `args` array, one
token per element: `["add", "deck.pptx", "/slide[1]", "--type", "shape",
"--prop", "text=Title"]`. Quotation marks in these examples are display-only
-- never include them in `args` elements. There is no shell — no quoting, no
`$` expansion; each value is one verbatim element.

## Help-first rule

This file teaches what good slides look like, not every flag. The help-first
rule lives in the skill body; the pptx shapes:

```
help pptx                    # list all pptx elements
help pptx shape              # full element schema
help pptx add chart          # verb-scoped
help pptx animation          # preset names + duration syntax
```

Help reflects the installed CLI version. Triggers to run help immediately:
`UNSUPPORTED props:` warning, unknown animation preset, `connector.shape=`
enum drift, prop-vs-alias confusion (`lineWidth` vs `line.width`).

## Value escapes

`\n` in a `text=` value is a paragraph break inside the shape; `\t` a tab.
Double them (`\\n`) for a literal. Inside `batch` JSON, standard JSON
escaping applies (`"\n"`, `"\""`, a real backslash is `"\\\\"` -- the value
layer doubles it, then JSON doubles each).

Structural ops in pptx: slide, chart, connector. The incremental-execution
discipline (one command, check, continue) lives in the skill body; repetitive
shape grids go through `batch` (atomic) with `--commands`.

## Requirements for outputs

Violating any one = not done, regardless of content quality.

**One idea per slide.** If a slide needs a second title to explain it, split
it. Use a section divider to group one-idea slides, not a mega-slide.

**Explicit type hierarchy — never rely on theme defaults** (they drift
between masters). Set sizes explicitly on every text shape.

| Element | Minimum | Typical | Min shape height |
|---|---|---|---|
| Slide title | **≥ 36pt** bold | 36–44pt | ≥ 2cm |
| Section / subtitle | ≥ 20pt | 20–24pt | ≥ 1.2cm |
| Body text | **≥ 18pt** | 18–22pt | ≥ 1cm |
| Caption / axis label | ≥ 10pt muted | 10–12pt | ≥ 0.6cm |

Rule of thumb: min shape height ≈ font_pt × 0.05cm — an 18pt label in a
0.8cm box overflows (`view annotated` catches this). Title ≥ 2× body size.
Four legit exceptions to body ≥ 18pt: chart axis labels, legends, footer /
page numbers, ≤ 5-word KPI sublabels. Left-align body; center only titles
and hero numbers. If cards won't fit, drop cards — never shrink the font.

**Two fonts max, one palette.** One heading font + one body font; a third
display face only for big numerals or the cover title. One dominant brand
color (60–70%) + one supporting + one accent. Never 4+ colors in body
content.

**Every slide carries a non-text visual — one that informs.** Shape, chart,
icon, gradient band that carries meaning, not decoration. A bullet-only deck
is interchangeable with a Word doc. Exceptions: quote slides, code blocks, a
single summary-table slide.

**Less is more.** Don't pad with decorative stats, icons, or filler sections
("data slop"). If a slide feels empty, fix it with layout and whitespace, not
invented content — cut scope rather than bulk it.

**Speaker notes on every content slide.** `--type notes --prop text="..."`.
The speaker needs a script; the audience shouldn't read the slide verbatim.

**Copy reads human, not AI.** Titles orient on content, not punchline. No
"It's not X. It's Y.", no manufactured tension, no one-word drama
("Momentum."). Cut hype adjectives — let the number carry it.

**Preserve existing templates.** Match an existing theme and masters;
existing conventions override these guidelines.

### Visual delivery floor (every deck)

- **No placeholder tokens rendered as content** — `{{name}}`, `$fy$24`,
  `<TODO>`, `lorem`, `xxxx`, empty `()`/`[]` in chart titles never appear.
- **No overflow off-edge, no clipped text in shapes.** `view issues` flags
  both. To fix a clip: grow the box or shorten the value — never trim content
  to fit.
- **Cover carries its orienting elements** — title + subtitle + presenter /
client + date + a brand band or key-takeaway strap. A title-only cover reads
  as a stub.
- **Contrast.** `view issues` auto-flags the common dark-text-on-own-dark-fill
  case; it can't see icon / chart-series fills or text over a separate
  background shape. On any fill with brightness < 30% (`1E2761`, `36454F`),
  confirm every body run, card body, chart series, and icon is `FFFFFF` or
  brightness > 80% — mid-gray (`6B7B8D`) reads on a laptop and vanishes on
  projection.

## Design principles

The audience has 3 seconds per slide. Before adding anything ask: "If they
read only the biggest element and glance once, do they get the point?"

### Grid, margins, negative space

Standard widescreen is **33.87 × 19.05cm** — treat as a 12-column grid:

- Edge margin ≥ 1.27cm all sides; inter-block gap ≥ 0.76cm — pick one value
  and use it everywhere; mixed gaps look unfinished.
- **≥ 20% negative space per slide.** Whitespace is structural: top-weighted
  with open lower third is correct composition, not a defect. Intentional
  asymmetry reads more designed than web-centering everything.
- Card grids: `usable = 33.87 − 2·margin − (N−1)·gap`, `col_width = usable/N`.
  Don't hand-pick x coordinates.

### Font pairings

Pair by document register. These are seeds, not the set — a pairing outside
the table is fine if it fits; match user brand fonts first when given.

| Header | Body | Best For |
|---|---|---|
| Georgia | Calibri | Formal business, finance, executive reports |
| Arial Black | Arial | Bold marketing, product launches |
| Calibri | Calibri Light | Clean corporate, minimal design |
| Cambria | Calibri | Traditional professional, legal, academic |
| Trebuchet MS | Calibri | Friendly tech, startups, SaaS |
| Impact | Arial | Bold headlines, event decks, keynotes |
| Palatino | Garamond | Elegant editorial, luxury, nonprofit |
| Consolas | Calibri | Developer tools, technical / engineering |

Set both fonts explicitly on every shape, not via theme inheritance.

### Color and contrast

Columns: **Primary** (dominant, 60–70%), **Secondary** (supporting),
**Accent** (one-hit emphasis), **Text** (body on light fills), **Muted**
(captions / axis / footer).

| Theme | Primary | Secondary | Accent | Text | Muted |
|---|---|---|---|---|---|
| Coral Energy | `F96167` | `F9E795` | `2F3C7E` | `333333` | `8B7E6A` |
| Midnight Executive | `1E2761` | `CADCFC` | `FFFFFF` | `333333` | `8899BB` |
| Forest & Moss | `2C5F2D` | `97BC62` | `F5F5F5` | `2D2D2D` | `6B8E6B` |
| Charcoal Minimal | `36454F` | `F2F2F2` | `212121` | `333333` | `7A8A94` |
| Warm Terracotta | `B85042` | `E7E8D1` | `A7BEAE` | `3D2B3B` | `8C7B75` |
| Berry & Cream | `6D2E46` | `A26769` | `ECE2D0` | `3D2233` | `8C6B7A` |
| Ocean Gradient | `065A82` | `1C7293` | `21295C` | `2B3A4E` | `6B8FAA` |
| Teal Trust | `028090` | `00A896` | `02C39A` | `2D3B3B` | `5E8C8C` |
| Sage Calm | `84B59F` | `69A297` | `50808E` | `2D3D35` | `7A9488` |
| Cherry Bold | `990011` | `FCF6F5` | `2F3C7E` | `333333` | `8B6B6B` |

Pick by topic — finance reads Midnight Executive, a launch reads Coral
Energy; blend when the closest named theme isn't quite right (Forest primary
+ gold `D4A843` accent). Use Text on light fills, Muted for captions, `FFFFFF`
or Secondary for body on dark fills.

### Chart-choice decision table

Wrong chart type kills the 3-second test:

| Data shape | Use | Avoid |
|---|---|---|
| Category comparison | `column` (vertical) / `bar` (≥ 6 categories, horizontal) | pie (slices merge), line (no time axis) |
| Time series, 1–3 series | `line` | area (occlusion), bar (implies discrete) |
| Part-of-whole, 2–5 slices | `pie` / `doughnut` | pie with 8+ slices |
| Correlation / distribution | `scatter` | line (implies ordering) |
| Multiple categories × metrics, dense | stacked `column` or heatmap | one chart per metric |
| KPI snapshot (single big number) | **Large-text shape** (60–72pt + ≤ 5-word sublabel), NOT a chart | gauge, tiny bar |

If > 3 series and > 8 categories, split into two charts or switch to a table.

### Animation

A tool, not décor. Three floors (none cap the amount):

- **Purposeful** — each animation reveals or emphasizes; if it doesn't aid
  comprehension, cut it. A formal finance deck trends to near-zero.
- **Degrades gracefully** — animation renders inconsistently across viewers
  and may not play at all; every slide must read correctly as a *static*
  frame. Never hide essential content behind a reveal.
- **Verify live** — animation is runtime-only; `view html` and screenshots
  can't see it. Confirm in a real presentation viewer before shipping.

Taste steer (not a ban): `fade` / `appear` / a single `zoom-entrance` with
snappy durations fit most decks; `bounce` / `swivel` / `spin` / dense
multi-object choreography usually read amateur.

### Layout patterns

Vary layout across slides — repeating one pattern makes every slide feel
identical. Building blocks, not the full set:

| Pattern | When | Key measurement |
|---|---|---|
| **Two-column** (text left, visual right) | Concept + evidence | Each col ≈ 14–15cm; gap 1cm |
| **Icon rows** (icon circle + bold header + description) | Feature lists, team roles | Circle 1.5–2cm; 3–4 rows max |
| **2×2 / 2×3 card grid** | Quadrant, SWOT, comparison | Gap ≥ 0.76cm; consistent card height |
| **Half-bleed image** (one full half, content overlay) | Hero moments, case openers | Image 16–17cm; content col ≥ 14cm |
| **Large stat callout** (60–72pt number + sublabel) | Single KPI | Shape, NOT a chart; sublabel 14–16pt muted |

Comparison columns beat a table for 2–3 options; timelines and flows use
numbered step shapes + connectors, not a bullet list.

### Image treatment

**Read the image first** (via the `python` tool) and choose treatment from
what you see — don't place blind from a filename.

- **Full-bleed photo** → size to COVER (crop edges), no border.
- **Screenshot / diagram / logo** → size to FIT (never crop content); a
  transparent image sits on a contrasting fill — drop a colored rectangle
  behind it.
- **Text over a photo** → never raw: a card, or a dark scrim (~50–60%
  opacity) between image and text.
- Never stretch (distort aspect); no text on a busy screenshot. Prefer
  user-provided assets; no emoji or self-drawn art unless asked.

### Visual motif commitment

Pick ONE distinctive element (rounded frames, section numbers in filled
circles, single-side border band) and carry it to every slide — styling one
slide and leaving the rest plain reads abandoned.

### Visual AI-tells to avoid

- **No decorative underline under slide titles** — the single most common
  AI-slide tell. Use whitespace or a background change.
- **No rounded card with a colored left-border accent stripe** — the other
  classic. Solid fill, top accent band, or whitespace instead.
- **No emoji as iconography** unless the brand uses them.

## Common workflow

1. **Orient.** New deck: `create <file>`. Existing: `view <file> outline`
   first. Never edit blind.
2. **Title sequence first (plan, don't build).** Write the full ordered list
   of slide titles before creating anything. If reading ONLY the titles can't
   follow the argument, fix the arc now. Pick ONE title grammar — all topic
   noun-phrases or all action statements, never a mix.
3. **Build in display order.** Cover → agenda → divider → content → … →
   closing. Linear append keeps the build readable and avoids index
   arithmetic. Before delivery, confirm slide count + arc match the plan
   (Gate 3's order-sanity check catches a cover that ended up as slide 11).
4. **Incremental per slide.** Slide + background, then title, then
   supporting shapes / charts / connectors. Always `layout=blank` for custom
   designs; `get /slide[N] --depth 1` after each structural op to confirm
   shape IDs.
5. **QA — assume problems.** Fix-and-verify until a cycle finds zero new
   issues.

## Quick start

Minimal viable deck: cover + one content slide + notes.

```
create deck.pptx
add deck.pptx / --type slide --prop layout=blank --prop background=1E2761
add deck.pptx /slide[1] --type shape --prop text="FY26 Strategic Review" --prop x=2cm --prop y=7cm --prop width=29.87cm --prop height=3cm --prop font=Georgia --prop size=44 --prop bold=true --prop color=FFFFFF --prop align=center
add deck.pptx / --type slide --prop layout=blank --prop background=FFFFFF
add deck.pptx /slide[2] --type shape --prop text="Revenue grew 18% YoY" --prop x=1.5cm --prop y=1.2cm --prop width=30cm --prop height=2cm --prop font=Georgia --prop size=36 --prop bold=true --prop color=1E2761
add deck.pptx /slide[2] --type shape --prop text="Enterprise renewals + new EMEA region drove the beat." --prop x=1.5cm --prop y=4cm --prop width=30cm --prop height=3cm --prop font=Calibri --prop size=20 --prop color=333333
add deck.pptx /slide[2] --type notes --prop text="Lead with the 18% beat, preview EMEA."
save deck.pptx
validate deck.pptx
```

## Reading & analysis

```
view deck.pptx outline            # slide count + titles
view deck.pptx annotated          # per-slide breakdown: fonts, sizes, tables, charts
view deck.pptx text --start 1 --end 5   # text dump (includes table cell text)
view deck.pptx issues             # empty slides, overflow hints
view deck.pptx stats              # counts (incl. pictures missing alt)
view deck.pptx html               # HTML preview path — read it (via python) for visual audit
view deck.pptx svg --start 3 --end 3    # single-slide SVG (charts/gradients do NOT render in SVG)
```

Expected non-defect: `layout=blank` slides report `(untitled)` in
`view outline` — titles are plain shapes there. Use `layout=title` +
`placeholder[title]` only when outline compatibility matters.

**Inspect one element** (1-based; prefer `@name=` / `@id=` over positional
`[N]` — stable across reorderings):

```
get deck.pptx /slide[1] --depth 1                  # shape list with IDs and names
get deck.pptx /slide[1]/shape[@name=Title]
get deck.pptx /slide[1]/table[1] --depth 3         # rows / cells
```

**Query:** `shape:contains("Revenue")`, `picture:no-alt`,
`shape[fill=1E2761]`, `shape[width>=10cm]`. `query --json` wraps in
`.data.results[]` — shape name is `.name`, fill is `.format.fill`, text
color `.format.textColor`.

## Creating & editing

Verbs: `add` / `set` / `remove` / `move` / `swap` / `batch` / `raw-set`.

### Slides and backgrounds

```
add deck.pptx / --type slide --prop layout=blank --prop background=1E2761                       # solid
add deck.pptx / --type slide --prop layout=blank --prop background=1E2761-CADCFC-180            # gradient start-end-angle
add deck.pptx / --type slide --prop layout=blank --prop background=image:/path/to/hero.jpg      # image
```

### Shapes

A `shape` holds text, fill, border, position, animation. Positioning is
explicit — no layout engine, you own the grid math.

```
add deck.pptx /slide[2] --type shape --prop name=Title --prop text="Key Insight" --prop x=2cm --prop y=2cm --prop width=20cm --prop height=3cm --prop font=Georgia --prop size=36 --prop bold=true --prop color=1E2761 --prop fill=none
```

`--prop preset=` picks geometry (`rect`, `roundRect`, `ellipse`, `triangle`,
`arrow`, `star5`, ...); custom paths unsupported. **Name shapes at creation**
and address them as `shape[@name=HeroTitle]` — names survive z-order /
remove-then-add, positional `/shape[3]` does not. Re-`get --depth 1` after
any structural change before using positional indexes.

**Z-order:** later-added shapes are on top — add background decoration
FIRST, titles LAST. Fix after the fact: `--prop zorder=back|front` (then
re-`get` before stacking more).

### Text inside shapes

For one-line text, `--prop text=` on the shape is enough; `\n` in the value
makes a paragraph break. `add --type paragraph` takes the same style props.
For mixed styling within a line, append a styled run:

```
add deck.pptx /slide[2]/shape[@name=Card1]/paragraph[1] --type run --prop text=" (inline detail)" --prop size=14 --prop italic=true --prop color=8899BB
```

### Charts

Pick the type per the chart-choice table. Typical multi-series with brand
colors:

```
add deck.pptx /slide[3] --type chart --prop chartType=column --prop series1.name=Revenue --prop series1.values="42,45,48" --prop series1.color=1E2761 --prop series2.name=Growth --prop series2.values="2,7,7" --prop series2.color=CADCFC --prop categories="Q1,Q2,Q3" --prop x=2cm --prop y=4cm --prop width=20cm --prop height=10cm
```

Gotchas: chart titles with `()`, `[]`, `TBD` ship as literal text; some
viewers normalize chart colors to theme defaults — verify in the target
viewer. Series can be appended after creation (`add --type series`).

### Pictures

```
add deck.pptx /slide[4] --type picture --prop src=hero.jpg --prop x=1cm --prop y=1cm --prop width=32cm --prop height=18cm --prop alt="Product hero"
```

`query 'picture:no-alt'` must be empty before delivery.

### Connectors (flowcharts first-class)

```
add deck.pptx /slide[5] --type connector --prop from=/slide[5]/shape[@name=BoxA] --prop to=/slide[5]/shape[@name=BoxB] --prop shape=elbow --prop color=333333 --prop tailEnd=triangle
```

`from`/`to` take full `@name=`/`@id=` path forms. **Every flow connector
needs an arrowhead** — without one, `bentConnector3` renders as a
directionless line. `shape=elbow` is canonical. Full enum:
`help pptx add connector`.

### Animations

```
set deck.pptx /slide[2]/shape[@name=HeroCard] --prop animation=fade-entrance-400
set deck.pptx /slide[2]/shape[@name=HeroCard] --prop animation=none    # clear
```

### Hyperlinks and navigation

`--prop link=slide[N]` (in-deck jump, 1-based, target must exist),
`link=nextslide` / `firstslide` / `lastslide` / `endshow`, `link=https://...`,
`--prop tooltip="..."`.

### Tables, placeholders, groups, comments

- **Tables:** `--type table --prop rows=N --prop cols=M`. Row-level `set`
  supports `height` and `c1/c2/c3` (seed cell text). Header styling is
  table-level (`firstRow=true` / `headerFill=`), not a row prop. Cell
  formatting lives on the cell paragraph / run. Populate rows BEFORE
  table-level font (the cascade gets reset by row ops).
- **Placeholders:** `/slide[N]/placeholder[title]` / `placeholder[body]` —
  only when the slide uses a layout with placeholders (not `layout=blank`).
- **Groups:** address children via `/slide[N]/group[@name=G]/shape[1]` —
  survives reordering better than positional indexes.
- **Comments:** `add /slide[2] --type comment --prop author="Alice" --prop
  text="Tighten this bullet" --prop x=20cm --prop y=3cm`; lifecycle
  add/set/get/query/remove; resolve by `remove` after addressing.

### Recipes

**(a) Cover / section divider:** dark fill, centered 44pt title, 18pt
secondary meta line (`x=2cm`, `width=29.87cm`). A section divider adds a
giant translucent number (`size=120`, `opacity=0.15`) added FIRST so it sits
behind the title.

**(b) Data slide (chart + commentary):** title 36pt; chart left 2/3
(`x=1.5cm`, `width=20cm`, `height=14cm`, `y=3.5cm`) with brand series colors;
right 1/3 commentary card — background `roundRect` (`fill=F5F7FA`,
`line=none`, `x=22.5cm`, `width=9.8cm`), 20pt "Key Insight" heading, 18pt
body inside (`x=23cm`, `width=9cm`). The audience reads the takeaway before
parsing the bars.

**(c) Flowchart row:** four boxes across at `y=8cm`, each 6×3cm. Grid math:
`gap = (33.87 − 2·1.5 − 4·6) / 3 = 2.29cm`; x positions `1.5, 9.79, 18.08,
26.37`. Boxes carry labels via `valign=middle` (no overlay shape); join with
elbow connectors + `tailEnd=triangle`. Do the coordinate arithmetic (with
`python` if needed) — don't eyeball x positions.

**(d) KPI callout cards:** 3 cards, `col_width = (33.87 − 3 − 1.52) / 3 =
9.78cm`; x positions `1.5, 12.04, 22.58`. Each card = filled `roundRect`
(navy standard, terracotta `B85042` for a "watch" metric) + 60pt Georgia bold
number + 14pt sublabel + percent-change chip, all centered. **60pt fits ~5
chars in 9.78cm** — for `$84.2M`, split: `84.2` big, `USD millions` as the
sublabel. Never shrink font to chase a unit suffix.

**(e) Decision tree:** diamond at top-center (`x=13.94cm, y=2cm, 6×3cm`),
YES/NO children diverging left (`x=3cm`) / right (`x=22.87cm`) at `y=7.5cm`,
shared terminal below. Convention: red = stop/escalate, blue = standard,
green = safe terminal. Every connector arrowed.

**Deck skeletons (rhythm, not requirements):** e.g. a 10-slide review —
Cover · Agenda · 3 KPI · Divider · Chart · Chart · Divider · Flow · Timeline
· Close; a 20-slide pitch — Problem · Solution · Market · Product · Traction
· Model · Team · Financials · Ask, with dividers before each section.
Derive the arc from content first; every divider must appear BEFORE its
section content.

## QA (required)

Assume there are problems. First render is almost never correct.

- **Gate 1 — schema.** `validate`. Any error → fix.
- **Gate 2 — overflow / structure.** `view issues`. Any issue line → fix.
- **Gate 2b — leftover placeholders.** `view text`, scan for `xxxx`,
  `lorem`, `<TODO>`, `placeholder`, empty `()` / `[]` in titles.
- **Gate 3 — visual audit (mandatory).** Per-slide screenshots
  (`view screenshot --page N -o slideN.png`, incrementing until past the
  deck) — read each image and judge adversarially. No image reading? Fall
  back to `view html` as text and flag unprovable items ("not visually
  verified").
- **Fix-verify loop (max 3 cycles).** Fix → rerun → until zero new issues;
  one fix often surfaces another. After 3 rounds without convergence, stop
  and report per-slide findings with attempted fixes and likely root —
  don't seesaw.
- **Flush.** End with `save <file>` (or `close`) before delivery — required
  final step; confirm the command succeeds (a file locked open in PowerPoint
  fails it) before delivering.

### Per-slide checklist

overlap (shapes / charts / giant decorative numbers colliding) · text
overflow at slide or shape boundary · narrow text boxes wrapping to many
1–2-word lines · dark-on-dark (fill < 30% brightness with content < 80%) ·
image stretched / text raw on busy image / cropped logo · flowchart
connectors missing arrowheads · accent bar sized for one-line title but
title wrapped to two · footer/citation touching content above · elements
within ~0.5" of slide edge · uneven gaps / broken rhythm · KPI cards off
baseline or inconsistent width · order sanity (cover → agenda →
dividers-before-sections → closing).

## Known issues & pitfalls

| Pitfall | Correct approach |
|---|---|
| `/shape[myname]` | Name in brackets is not indexing — use `@name=` selector: `/shape[@name=myname]` |
| `--name "foo"` | All attrs go through `--prop`: `--prop name="foo"` |
| `shape[1]` as content shape | Typically the title placeholder — content shapes are `shape[2]+`; better: name every shape |
| Paths 1-based vs `--index` 0-based | `/slide[1]` = first slide; `--index 0` = first position |
| PPT `--index` on slide add | Works, but linear append avoids index-arithmetic bugs |
| Guessing property names | `help pptx <element>` — don't improvise |
| Modifying a file open in PowerPoint | Close it in PowerPoint/WPS first |
| `\n` / `\t` in text | Interpreted by the CLI (paragraph break / tab); `\\n` for literal |
| Animation preset rejected | `help pptx animation` for the exact preset names |
