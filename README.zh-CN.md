# TOPTOPDuck

<div align="center">

<img src="src-tauri/icons/icon.png" width="160" />

**本地优先的 AI 数据分析 agent 桌面工具——数据不离本机，仅 LLM 推理联网。**

[![CI](https://github.com/toptopworks/toptopduck/actions/workflows/ci.yml/badge.svg)](https://github.com/toptopworks/toptopduck/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Built with Tauri v2](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8D8?logo=tauri&logoColor=white)

[核心特性](#核心特性) • [隐私边界](#隐私边界如何工作) • [安装](#安装) • [快速上手](#快速上手) • [常用脚本](#常用脚本) • [技术栈](#技术栈) • [文档](#文档) • [贡献](#贡献) • [License](#license)

[English](./README.md) | 简体中文

<!-- TODO: 应用截图待补
![TOPTOPDuck](docs/assets/screenshot.png)
-->

</div>

TOPTOPDuck 是一个数据分析 agent：用自然语言提问，agent 自主选用合适的工具完成分析。内置 DuckDB SQL 工具覆盖查询、清洗、聚合与描述性统计；用户可配置外部 MCP 工具扩展能力（机器学习、预测等）。完整数据集始终留在本地；只有 schema、最小样本行和查询会发送给你自带密钥（BYOK）的 LLM。

## 核心特性

- **数据不出本机** —— 完整数据集保留在本地；仅 schema + 最小样本 + 查询外发给 LLM，样本量可调。
- **数据分析 agent** —— agent 根据提问自主选用工具：表格型分析默认走内置 DuckDB SQL，超出 DuckDB 能力时自动使用已配置的外部工具（MCP 服务器或 CLI 工具）。
- **双 agent 运行时** —— 会话由内置 BYOK agent 循环驱动，也可换选外部 CLI agent（经 ACP 桥接）。
- **可扩展工具箱** —— 内置 DuckDB 工具（查询 / 聚合 / 统计）+ 外部工具（MCP 服务器与 CLI 工具）+ 自定义技能（提示片段 + 工具引用），按需组合。
- **诚实的能力边界** —— 默认能力以 DuckDB SQL 原生为界；无匹配工具时诚实拒绝并给出 in-scope 替代，绝不编造结果。
- **数据操作完全离线** —— DuckDB 扩展随应用预打包，加载数据无需联网。

## 隐私边界如何工作

| 留在你的机器上 | 发送给 LLM |
|---|---|
| 完整数据集（Excel / CSV / JSON / Parquet） | 表结构（schema） |
| DuckDB 查询与结果 | 最小样本行（可调） |
| 生成的结果与产物 | 你的自然语言提问 |

LLM 接入为 BYOK：自行配置接入档案（Anthropic 协议或任意 OpenAI 兼容端点——DeepSeek、GLM、Qwen、Ollama 等），密钥存于 OS keychain。

## 安装

### 预编译安装包

从 [Releases](https://github.com/toptopworks/toptopduck/releases) 下载对应平台的最新安装包：

- **macOS**：`.dmg`
- **Windows**：`.msi` / `.exe`
- **Linux**：`.deb` / `.AppImage`

### 从源码构建

前置条件：Node.js（含 npm）、Rust stable 工具链（推荐 [`rustup`](https://rustup.rs)）、Tauri v2 系统依赖（[Tauri prerequisites](https://tauri.app/start/prerequisites/)）。

```sh
npm install            # 安装前端依赖
npm run tauri dev      # 启动桌面应用（开发模式）
npm run tauri build    # 产出桌面安装包
```

## 快速上手

1. 启动应用，打开 **设置** 配置 API 档案（Anthropic 协议或任意 OpenAI 兼容端点——DeepSeek、GLM、Qwen、Ollama 等）；密钥存于 OS keychain。
2. 导入数据——支持 Excel / CSV / JSON / Parquet。
3. 用自然语言提问——agent 自主选用工具，基于本地数据作答。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 仅启动前端（Vite，端口 1420） |
| `npm run tauri dev` | 启动完整 Tauri 应用 |
| `npm run build` | 类型检查 + 前端构建 |
| `npm run tauri build` | 产出桌面安装包 |
| `npm test` | 运行前端测试（Vitest） |
| `cargo test --workspace` | 运行 Rust 测试（仓库根执行，含 `crates/*` 成员） |

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri v2（Rust 核心 + Web 前端） |
| 数据引擎 | 嵌入式 DuckDB（官方 Rust binding，bundled） |
| 前端 | React 19 + Vite + TypeScript |
| 可视化 | Vega-Lite（JSON、schema 校验）+ Vega-Embed |
| LLM 接入 | 双运行时：内置 BYOK agent 循环 + 外部 CLI agent（ACP）+ MCP 工具网关 |
| 测试 | Vitest（前端）/ `cargo test`（Rust） |

## 文档

- [CONTEXT.md](./CONTEXT.md) —— 领域语言与统一上下文
- [docs/adr/](./docs/adr/) —— 架构决策记录
- [docs/agents/](./docs/agents/) —— 代理协作规范（分支、issue、triage）

## 贡献

本项目采用 git-flow（AVH edition）：`main` + `develop`，特性 / 修复分支绑定 GitHub issue。详见 [docs/agents/git-flow.md](./docs/agents/git-flow.md)。

## License

本项目基于 GNU Affero General Public License v3.0 授权——详见 [LICENSE](./LICENSE)。
