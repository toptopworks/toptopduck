# Desktop framework: Tauri (Rust core + web frontend)

## Decision

桌面框架用 **Tauri**：Rust 后端核心 + Web 前端。DuckDB 经**官方 Rust binding** 嵌入；前端用 Web 技术（React/Vue/Svelte，待定）。

## Context

桌面 App 已定（ADR-0001）。需选框架——决定代码库形态、DuckDB 嵌入方式、包体积、内存、安全模型、更新链路。SQL-only 无需 Python，栈选择更自由。

## Why

1. **DuckDB 有一等公民级 Rust binding**，数据引擎原生嵌入 = 最佳性能与控制力。
2. **体积小、内存低**：数据工具本身要为 DuckDB 吃内存，不再为每个窗口额外付一份 Chromium（Electron 动辄 100MB+ 包、高内存）。
3. **Tauri capability/allowlist 安全模型**强化 ADR-0005 的引擎级防御 + 只读源 + API key 安全存储。
4. **内置自动更新器**，直接解决桌面分发/更新。
5. 前端仍为 Web，富 notebook/图表 UI 不受限。

## Considered options

- **Electron（Node + Web）**：生态成熟、上手快、DuckDB 有 Node binding，但包 ~100MB+、每实例高内存与 DuckDB 抢内存。**否决**。
- **原生（C#/WinUI、Swift、Qt）**：性能/体积最佳，但富 notebook UI 原生开发昂贵、跨平台难、DuckDB 绑定非处处一等。**否决**。

## Consequences

- **后端 Rust**：有学习/招聘成本；前端 ↔ Rust ↔ DuckDB 的异步/FFI 边界需谨慎设计。
- 跨平台目标（Windows/macOS/Linux）由 Tauri webview 承载，须测各平台 webview 差异。
- 前端框架（React/Svelte/Vue）是下一个子决策。
