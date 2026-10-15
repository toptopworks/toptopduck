# TOPTOPDuck

<div align="center">

<img src="src-tauri/icons/icon.png" width="160" />

**Local-first AI data analysis agent for your desktop — your data never leaves your machine.**

[![CI](https://github.com/toptopworks/toptopduck/actions/workflows/ci.yml/badge.svg)](https://github.com/toptopworks/toptopduck/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Built with Tauri v2](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8D8?logo=tauri&logoColor=white)

[Features](#features) • [Privacy](#how-the-privacy-boundary-works) • [Installation](#installation) • [Quick Start](#quick-start) • [Scripts](#available-scripts) • [Tech stack](#tech-stack) • [Docs](#documentation) • [Contributing](#contributing) • [License](#license)

English | [简体中文](./README.zh-CN.md)

<!-- TODO: app screenshot once available
![TOPTOPDuck](docs/assets/screenshot.png)
-->

</div>

TOPTOPDuck is a data analysis agent: ask questions in natural language, and the agent autonomously picks the right tools to get the job done. A built-in DuckDB SQL tool covers querying, cleaning, aggregation, and descriptive statistics; user-configured external MCP tools extend the toolbox (machine learning, forecasting, and more). Your full dataset always stays local — only the schema, a small sample, and the query are sent to the bring-your-own-key (BYOK) LLM.

## Features

- **Data never leaves your machine** — full datasets stay local; only schema + minimal sample + query go out to the LLM, with the sample size under your control.
- **A real analysis agent** — the agent chooses tools on its own per question: tabular analysis defaults to built-in DuckDB SQL; beyond DuckDB's reach it automatically reaches for configured external tools (MCP servers or CLI tools).
- **Dual agent runtimes** — sessions run on the built-in BYOK agent loop, or on an external CLI agent you pick (bridged via ACP).
- **Extensible toolbox** — built-in DuckDB tools (query / aggregate / statistics) + external tools (MCP servers and CLI tools) + custom skills (prompt snippets + tool references), composed as needed.
- **Honest capability boundaries** — default capabilities are bounded by native DuckDB SQL; with no matching tool it says no and suggests in-scope alternatives instead of making things up.
- **Fully offline data operations** — DuckDB extensions ship bundled with the app; loading data requires no network.

## How the privacy boundary works

| Stays on your machine | Sent to the LLM |
|---|---|
| Full datasets (Excel / CSV / JSON / Parquet) | Table schema |
| DuckDB queries and results | Minimal sample rows (adjustable) |
| Generated results and artifacts | Your natural-language question |

LLM access is BYOK: you configure your own API profiles (Anthropic protocol or any OpenAI-compatible endpoint — DeepSeek, GLM, Qwen, Ollama, etc.), and keys are stored in the OS keychain.

## Installation

### Pre-built binaries

Download the latest release for your platform from [Releases](https://github.com/toptopworks/toptopduck/releases):

- **macOS**: `.dmg`
- **Windows**: `.msi` / `.exe`
- **Linux**: `.deb` / `.AppImage`

### Build from source

Prerequisites: Node.js (with npm), the Rust stable toolchain ([`rustup`](https://rustup.rs) recommended), and the [Tauri v2 system dependencies](https://tauri.app/start/prerequisites/).

```sh
npm install            # Install frontend dependencies
npm run tauri dev      # Launch the desktop app (dev mode)
npm run tauri build    # Build the desktop installer
```

## Quick Start

1. Launch the app and open **Settings** — configure an API profile (Anthropic protocol or any OpenAI-compatible endpoint — DeepSeek, GLM, Qwen, Ollama, etc.); keys are stored in the OS keychain.
2. Import a dataset — Excel, CSV, JSON, or Parquet.
3. Ask a question in natural language — the agent picks tools on its own and answers from your local data.

## Available scripts

| Command | Description |
|---|---|
| `npm run dev` | Frontend only (Vite, port 1420) |
| `npm run tauri dev` | Full Tauri app |
| `npm run build` | Type check + frontend build |
| `npm run tauri build` | Desktop installer |
| `npm test` | Frontend tests (Vitest) |
| `cargo test --workspace` | Rust tests (run from the repo root, includes `crates/*` members) |

## Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri v2 (Rust core + web frontend) |
| Data engine | Embedded DuckDB (official Rust binding, bundled) |
| Frontend | React 19 + Vite + TypeScript |
| Visualization | Vega-Lite (JSON, schema-validated) + Vega-Embed |
| LLM access | Dual runtimes: built-in BYOK agent loop + external CLI agents (ACP) + MCP tool gateway |
| Testing | Vitest (frontend) / `cargo test` (Rust) |

## Documentation

- [CONTEXT.md](./CONTEXT.md) — domain language and unified context
- [docs/adr/](./docs/adr/) — architecture decision records
- [docs/agents/](./docs/agents/) — agent collaboration conventions (branching, issues, triage)

## Contributing

This project uses git-flow (AVH edition): `main` + `develop`, with feature/bugfix branches tied to GitHub issues. See [docs/agents/git-flow.md](./docs/agents/git-flow.md).

## License

This project is licensed under the GNU Affero General Public License v3.0 — see [LICENSE](./LICENSE) for details.
