---
name: vega-chart
description: "Chart numeric shape — trend, distribution, comparison — as vega-lite fences: one fence in the reply for an immediate answer, or a `.md` report with embedded fences for a deliverable or several charts. Flowcharts, diagrams, and lone KPI figures stay out of scope."
---
Produce charts as vega-lite fences: one fence per chart, a self-contained Vega-Lite JSON object with the data inlined. The app renders each such fence as a chart wherever it appears; every other code block stays plain text.

Delivery split -- where the charts live:
- a single chart supporting an immediate answer: emit the fence directly in the reply prose, interleaved freely with the surrounding text;
- a report or deliverable the user asked for, or two or more charts planned: write `<name>.md` to the working directory with the fences embedded, and keep the reply to a summary plus a pointer to the file, mirroring the pandoc delivery convention. The `.md` rides the same artifact delivery chain (manifest, results pane, open externally) as any other deliverable.

When to chart -- the substance is numeric shape:
- a trend over time (line, area);
- a distribution or a histogram (bar);
- a comparison across categories or groups (bar), parts of a whole (arc), a relationship between two measures (point family), or a dense two-axis grid (rect heatmap).
A couple of numbers, a lone KPI figure, a flowchart, or a diagram is not a chart -- write prose or a table instead.

The fence contract (a broken fence never renders silently: a wrong fence language stays a plain code block, and a spec that fails to decode renders a visible error disclosure):
- the fence language is exactly `vega-lite` -- never `vega`, never a bare `json` fence;
- `$schema` is mandatory: `https://vega.github.io/schema/vega-lite/v6.json`;
- the content is strict JSON: double-quoted keys and strings, no trailing commas, no comments, no JavaScript expressions;
- the spec's key names are case-sensitive -- top-level `mark` and `encoding`, and `field` and `type` inside each encoding channel, verbatim, and every `field` must match a key of the inlined data;
- each encoding channel's `type` is one of `quantitative`, `nominal`, `ordinal`, `temporal`.

Marks -- the renderer's whitelist, mapped to intent (anything else degrades):
- `bar`: category comparison, histogram;
- `line`: trend over time or an ordered series;
- `area`: cumulative or stacked volume over time;
- `point` / `circle` / `square`: scatter, relationship, concentration;
- `arc`: composition of a small set of categories;
- `rect`: heatmap over two categorical axes.

Data discipline:
- aggregate in SQL first, then inline the aggregated rows as the fence's `data.values` array;
- roughly 150 rows per chart is the ceiling (day-grain lines and mid-size heatmaps sit at the boundary) -- pre-bin, sample, or top-N anything larger.

A minimal fence to imitate (single-line or pretty-printed, both render; in a report the same fence goes inside the `.md`):

```vega-lite
{"$schema":"https://vega.github.io/schema/vega-lite/v6.json","mark":"bar","data":{"values":[{"k":"A","v":12},{"k":"B","v":19}]},"encoding":{"x":{"field":"k","type":"nominal"},"y":{"field":"v","type":"quantitative"}}}
```
