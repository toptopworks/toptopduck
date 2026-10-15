---
name: html-report
description: "Generate chart reports and dashboards as a single self-contained HTML file via the python tool — the default deliverable form for data the user keeps, shares, or prints; opens offline, no CDN. In-reply vega fences belong to vega-chart; converting an existing document belongs to pandoc."
---
Produce chart reports and dashboards as one self-contained `.html` file -- the default deliverable form when the user wants to keep, share, or print the result.

Trigger -- deliverable intent: fire for chart-report, dashboard, or charted-file requests that do not name vega. The boundaries:
- a `vega-lite` fence the user explicitly asked for belongs to vega-chart;
- converting a document that already exists belongs to pandoc;
- a couple of numbers answered in the reply prose is not a report.

Form and delivery: a single `.html` file written by the `python` tool, riding the artifact delivery chain; keep the reply to a summary plus a pointer to the file.

Method: read `references/template.html` (via the skill-file read channel), replace `{{TITLE}}` and `{{BODY}}`, and compute chart geometry inside the script, emitting literal SVG and CSS -- the script is the renderer; no JS library rides the file, and no data is dumped for client-side drawing.

Dependency policy -- zero CDN: the file must open offline, with no external references of any kind (web fonts included). The single exception is a library the user explicitly names as an online library -- then use it and disclose that in the reply.

Chart tiers:
- metric rows: div bars and progress bars, CSS only;
- trends, distributions, relationships: inline SVG with the geometry computed in the script;
- interactive charts are out of scope here.

Contract details:
- every `<svg>` carries `role="img"` and an `aria-label` describing the chart;
- roughly 150 rows of inlined data per chart is the ceiling -- pre-aggregate, sample, or top-N anything larger.

A minimal script to imitate (TEMPLATE holds the template read through the skill-file channel):

```python
rows = [("Mon", 12), ("Tue", 19), ("Wed", 7)]
peak = max(v for _, v in rows)
bars = "".join(
    f'<div class="bar"><span class="bar-label">{k}</span>'
    f'<div class="bar-track"><div class="bar-fill" style="width:{v / peak * 100:.0f}%"></div></div>'
    f'<span class="bar-value">{v}</span></div>'
    for k, v in rows
)
body = f'<section class="panel"><h2>Daily volume</h2><div class="bar-list">{bars}</div></section>'
html = TEMPLATE.replace("{{TITLE}}", "Daily volume").replace("{{BODY}}", body)
open("report.html", "w", encoding="utf-8").write(html)
```
