---
name: office-cli
description: "Work directly on Office-file content with the local OfficeCLI (Word, Excel, PowerPoint): extract text and tables, edit, fill templates, or author a document from scratch. Converting a document that already exists between formats belongs to pandoc."
---
Use the `office-cli` tool for direct Office document work -- reading or editing DOCX/XLSX/PPTX content, extracting text and tables, filling templates, or generating Office files from scratch. It is the agent-oriented path when the task is about the Office file itself rather than about converting it (conversion between document formats belongs to `pandoc`).

Pass the subcommand and its arguments as the `args` list, one argument per element (do not pre-join them into a single shell-style string). OfficeCLI's own help output is the authority on subcommand names -- when unsure of a subcommand's exact shape, say so rather than guessing flags.
