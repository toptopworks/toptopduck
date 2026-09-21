---
name: pandoc
description: "Convert existing documents between formats with the local pandoc — render Markdown to DOCX/HTML/PDF for delivery, or read DOCX/EPUB into Markdown for analysis. Authoring or manipulating Office-file content (tables, templates, reports) belongs to office-cli."
---
Use the `pandoc` tool whenever a task needs a document converted between formats -- rendering Markdown as DOCX/HTML/PDF for delivery, or reading a DOCX/EPUB source into Markdown for analysis.

Call `pandoc` with `input` (path to the source document) and `output` (path to write the converted document to); the extension of each path selects the format. Pandoc's own options are NOT part of the tool's parameter table -- when a conversion needs flags (e.g. a template or a standalone flag), say so in the reply instead of improvising arguments.
