---
name: office-cli
description: "Work directly on Office-file content with the local OfficeCLI (Word, Excel, PowerPoint): extract text and tables, edit, fill templates, or author a document from scratch. Converting a document that already exists between formats belongs to pandoc."
---
Use the `office-cli` tool for direct Office document work -- reading or editing DOCX/XLSX/PPTX content, extracting text and tables, filling templates, or generating Office files from scratch. It is the agent-oriented path when the task is about the Office file itself rather than about converting it (conversion between document formats belongs to `pandoc`).

Pass the subcommand and its arguments as the `args` list, one argument per element (do not pre-join them into a single shell-style string). Example: `args: ["set", "data.xlsx", "/Sheet1/A1", "--prop", "value=Name", "--prop", "bold=true"]`. There is no shell between you and the CLI: no quoting, no glob expansion, no `$` interpretation -- every element lands verbatim. Values containing spaces are simply one array element.

## Task dispatch

| Task | Command face |
|------|--------------|
| Create a new file | `create <file>` (blank; type from extension) |
| Read content or structure | `view <file> outline\|text\|annotated\|stats`, `get <file> <path>`, `query <file> <selector>` |
| Check quality | `view <file> issues`, `validate <file>` |
| Edit a property | `set <file> <path> --prop key=value` (repeat `--prop`) |
| Add an element | `add <file> <parent> --type <type> [--prop ...]` |
| Find / replace text | `set <file> <path> --find X [--replace Y]` |
| Structural moves | `move <file> <path>`, `swap <file> <p1> <p2>`, `remove <file> <path>` |
| Multi-step edit | `batch <file> --commands '<json>' --json` (atomic) |
| Escape hatch | `raw <file> <part>`, `raw-set <file> <part> --xpath ... --action ... --xml ...` (last resort) |

For format-specific depth (element catalogs, recipes, QA gates) read `references/docx.md` / `references/xlsx.md` / `references/pptx.md` via `read_skill_file` when working on that format. This page carries only the shared syntax.

## Escalation ladder

**Read view → DOM operation → raw XML.** Always prefer the higher layer.

1. **Read view** -- `view` / `get` / `query` to see what is there before changing it. Never edit blind.
2. **DOM operation** -- `set` / `add` / `move` / `remove` on semantic paths. Schema-validated, safe.
3. **Raw XML** -- `raw` / `raw-set` only when DOM verbs cannot express the change. No schema protection; any XML attribute is reachable this way.

## Help before guessing

When a property name, enum value, or flag shape is uncertain, run help first -- one help query beats a guess-fail-retry loop. Help is the authority on names and shapes; this skill is the map.

- `args: ["help"]` -- all commands + global options
- `args: ["help", "docx"]` -- list every docx element
- `args: ["help", "docx", "paragraph"]` -- full schema for one element (properties, aliases, examples)
- `args: ["help", "docx", "set", "paragraph"]` -- verb-filtered: props usable with `set`

Format aliases accepted everywhere: `word`→`docx`, `excel`→`xlsx`, `ppt`/`powerpoint`→`pptx`.

## Path addressing

- Paths are 1-based, XPath-like: `/body/p[3]` is the third paragraph, `/Sheet1/B2` a cell, `/slide[1]` a slide. `--index` flags are 0-based (array convention).
- Prefer stable-ID addressing in multi-step workflows: `shape[@id=...]`, `shape[@name=Title 1]` (pptx), `p[@paraId=...]` (docx). Positional indices shift on insert/delete; stable IDs do not.
- `get <file> <path> --depth N` expands children. `query` takes CSS-like selectors: `paragraph[style=Heading1]`, `cell[value>5000]`, `p:contains("quarterly")`, `image:no-alt`, with boolean `and`/`or`.

## Structured output

Add `--json` on `get` / `query` / `view` / `batch` for machine-readable output -- parse it instead of scraping stdout with regex. `query --json` wraps results in `.data.results[]`.

## Resident mode: flush before other tools read

Commands run through a resident that holds the file in memory with delayed disk writes. `office-cli`'s own reads (`get`/`query`/`view`) always see the latest edits -- but **another tool reading the same file (`python`, `pandoc`) sees stale bytes until you flush.** Before any non-office-cli tool touches the file: `args: ["save", "<file>"]` (flush, keep resident) or `args: ["close", "<file>"]` (flush + release). `OFFICECLI_RESIDENT_FLUSH=each` forces a flush on every mutation when the boundary is hard to track; explicit `save` remains the default discipline.

## Batch for multi-step edits

Multi-step edits go through `batch` as one `--commands` JSON argument (atomic by default): any item failing rolls the whole batch back, leaving the file byte-identical. One batch beats N sequential `set` calls on both consistency and round-trips. `dump <file> <path>` emits a replayable batch JSON for round-trip edits.

`args: ["batch", "data.xlsx", "--commands", "[{\"command\":\"set\",\"path\":\"/Sheet1/A1\",\"props\":{\"value\":\"Name\",\"bold\":\"true\"}}]", "--json"]`

In batch JSON props, always use full dotted names (`font.color`, `font.size`) -- the bare shell aliases (`color`, `size`) are ambiguous and rejected in cell context.
