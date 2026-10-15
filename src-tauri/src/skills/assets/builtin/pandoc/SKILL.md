---
name: pandoc
description: "Convert existing documents between formats with the local pandoc — render Markdown to DOCX/HTML/PDF for delivery, or read DOCX/EPUB into Markdown for analysis. Authoring or manipulating Office-file content (tables, templates, reports) belongs to office-cli."
---
Use the `pandoc` tool whenever a task needs a document converted between formats -- rendering Markdown as DOCX/HTML/PDF for delivery, or reading a DOCX/EPUB source into Markdown for analysis. Format conversion is this tool's whole job; authoring or editing Office-file content (tables, templates, reports) belongs to office-cli.

## The call

`pandoc` takes `input` (path to the source document), `output` (path to write the converted document to), and `extra` (pandoc's own flags, an empty array when none are needed). The extension of each path selects the format:

| Extension | Format |
| --- | --- |
| `.md` | Markdown |
| `.html` | HTML |
| `.docx` | Word document |
| `.pptx` | PowerPoint presentation |
| `.odt` / `.rtf` | OpenDocument / Rich Text |
| `.epub` | EPUB e-book |
| `.tex` / `.latex` | LaTeX |
| `.pdf` | PDF output (write-only; engine prerequisite below) |

When the source extension is ambiguous or absent, force the reader format with `-f` in `extra` (e.g. `-f html`); the writer format follows the `output` extension (override with `-t`).

## The `extra` parameter

Every element of the `extra` array is appended to the invocation verbatim, after the output path. One array element is one argument -- there is no shell in between, so no quoting, no `~` or `$VAR` expansion, and no splitting on spaces:

- `extra: []` runs the plain conversion `pandoc {input} -o {output}`
- `extra: ["-s", "--toc"]` appends the two flags after the output path
- `extra: ["--pdf-engine", "xelatex"]` and `extra: ["--pdf-engine=xelatex"]` are equivalent; both spellings are legal
- A value with spaces stays one element: `["--metadata", "title=Quarterly Report"]` -- never pre-join or pre-quote elements

## High-frequency flags

| Flag | What it does |
| --- | --- |
| `-s` / `--standalone` | Produce a complete standalone document instead of a fragment (synonyms; required for a usable HTML file) |
| `--toc` | Insert an auto-generated table of contents |
| `--reference-doc=FILE` | Style the output from a reference document's styles (DOCX/PPTX targets) |
| `--pdf-engine=ENGINE` | Select the LaTeX engine for PDF output (table below) |
| `-f FORMAT` / `-t FORMAT` | Override the reader / writer format the extensions imply |
| `--extract-media=DIR` | On DOCX/EPUB to Markdown, extract embedded images into DIR and rewrite the links to point there |
| `--embed-resources` | Inline images and CSS into one self-contained HTML file |

## Charts in the source

Pandoc has no vega engine: a `vega-lite` fence in the Markdown source degrades to a plain code block in every output format, and the conversion itself succeeds -- nothing errors, so check the source before converting. When the goal is a charted report, skip the conversion and regenerate the content with the `html-report` skill instead.

## PDF output and the engine prerequisite

Pandoc does not render PDF itself: it generates LaTeX and hands it to an engine that must already be on PATH. Without one, the call fails with an error like `pdflatex not found`. Pick the engine by source content:

| Engine | Best for |
| --- | --- |
| `pdflatex` | The default; plain ASCII/Latin text |
| `xelatex` | Any non-ASCII text (CJK, accented characters, symbols) |
| `lualatex` | Complex typography (OpenType font features) |

### Escape hatch when no LaTeX engine is installed

Produce a standalone HTML file instead and let the user print it to PDF from their browser -- the default template already carries suitable styling:

`extra: ["-s", "--toc", "--embed-resources"]`

Say plainly in the reply that the output is print-ready HTML and that the browser's print dialog (print to PDF) completes the delivery. Never attempt to install a LaTeX engine.

## Troubleshooting

- `pdflatex not found` (or `xelatex` / `lualatex` not found): no engine on PATH -- take the HTML escape hatch above, or tell the user a LaTeX engine is missing and offer that route.
- `Unicode character ... not set up for use with LaTeX`: pdflatex cannot encode the source -- switch to `--pdf-engine=xelatex`.
- Images broken after a DOCX-to-Markdown conversion: the embedded media was not extracted -- add `--extract-media` (e.g. `extra: ["--extract-media", "media"]`).
- Output is a bare fragment instead of a full page: add `-s`.
- Charts in a Markdown source with `vega-lite` fences degrade to plain code blocks: pandoc has no vega engine -- when the goal is a charted report, regenerate it with the `html-report` skill rather than converting the `.md`.
