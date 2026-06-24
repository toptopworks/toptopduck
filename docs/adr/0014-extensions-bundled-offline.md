# DuckDB extensions bundled offline; data ops never need network

## Decision

App 用到的所有 DuckDB 扩展（首当其冲 `excel`）**预打包进 Tauri 包、启动时由工具侧离线加载**，**绝不**在运行时从 DuckDB 扩展仓库自动下载。数据加载/处理因此**完全不需联网**；只有 LLM 推理调用出网（呼应 ADR-0001）。LLM SQL 的 `INSTALL/LOAD` 禁令（ADR-0005）不变。

## Context

excel 扩展（.xlsx 读写所需，见 ADR-0015）及任何未来扩展默认 `INSTALL ...; LOAD ...;` 从 DuckDB 仓库**联网下载**。ADR-0001 的"仅 LLM 推理联网"要求数据操作完全离线；ADR-0005 又禁 LLM SQL 用 `INSTALL/LOAD`，故扩展加载天然是工具侧——离线打包只是把"何时拿扩展"提前到构建期。

## Why

1. **兑现"仅 LLM 联网"**——数据操作若要联网下扩展，隐私/离线卖点破功。
2. **LLM SQL 本就禁 `INSTALL/LOAD`（0005）**——加载是工具侧，离线打包是把获取时机提前，无新增机制。
3. **版本可控**——扩展版本随 App 版本固定，不受 DuckDB 仓库变动影响。

## Considered options

- **运行时自动下载扩展**：包小，但数据操作联网，违反 0001。**否决**。
- **不用扩展、手写 .xlsx 解析**：失去 DuckDB 一等支持、自维护解析器。**否决**。

## Consequences

- Tauri 包体积 +扩展二进制（每个几 MB）；扩展更新随 App 发版。
- 未来加任何 DuckDB 扩展都须同样预打包，不得运行时下载。
- LLM SQL 的 `INSTALL/LOAD` 禁令（0005）不变。
