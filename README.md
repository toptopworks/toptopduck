# TOPTOP Duck

> 本地优先的 AI 数据分析 agent 桌面工具——数据不离本机，仅 LLM 推理联网。

toptopduck 是一个数据分析 agent：用自然语言提问，agent 自主选用合适的工具完成分析。内置 DuckDB SQL 工具覆盖查询、清洗、聚合与描述性统计；用户可配置外部 MCP 工具扩展能力（机器学习、预测等）。完整数据集始终留在本地；只有 schema、最小样本行和查询会发送给你自带密钥（BYOK）的 LLM。

## 核心特性

- **数据不出本机** —— 完整数据集保留在本地；仅 schema + 最小样本 + 查询外发给 LLM，样本量可调。
- **数据分析 agent** —— agent 根据提问自主选用工具：表格型分析默认走内置 DuckDB SQL，超出 DuckDB 能力时自动使用已配置的外部 MCP 工具。
- **可扩展工具箱** —— 内置 DuckDB 工具（查询 / 聚合 / 统计）+ 用户配置的外部 MCP 工具 + 自定义技能（提示片段 + 工具引用），按需组合。
- **诚实的能力边界** —— 默认能力以 DuckDB SQL 原生为界；无匹配工具时诚实拒绝并给出 in-scope 替代，绝不编造结果。
- **数据操作完全离线** —— DuckDB 扩展随应用预打包，加载数据无需联网。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri v2（Rust 核心 + Web 前端） |
| 数据引擎 | 嵌入式 DuckDB（官方 Rust binding，bundled） |
| 前端 | React 19 + Vite + TypeScript |
| 可视化 | Vega-Lite（JSON、schema 校验）+ react-vega / Vega-Embed |
| LLM 接入 | 双运行时：内置 BYOK agent 循环 + 外部 CLI agent（ACP）+ MCP 工具网关 |
| 测试 | Vitest（前端）/ `cargo test`（Rust） |

## 快速开始

### 前置条件

- Node.js（含 npm）
- Rust 工具链（推荐 `rustup`，stable 通道）
- Tauri v2 系统依赖——参见 [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### 安装与开发

```sh
npm install            # 安装前端依赖
npm run tauri dev      # 启动桌面应用（开发模式）
```

### 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 仅启动前端（Vite，端口 1420） |
| `npm run tauri dev` | 启动完整 Tauri 应用 |
| `npm run build` | 类型检查 + 前端构建 |
| `npm run tauri build` | 产出桌面安装包 |
| `npm test` | 运行前端测试（Vitest） |
| `cargo test` | 运行 Rust 测试（在 `src-tauri/` 下执行） |

## 文档

- [CONTEXT.md](./CONTEXT.md) —— 领域语言与统一上下文
- [docs/adr/](./docs/adr/) —— 架构决策记录
- [docs/agents/](./docs/agents/) —— 代理协作规范（分支、issue、triage）

## 贡献

本项目采用 git-flow（AVH edition）：`main` + `develop`，特性 / 修复分支绑定 GitHub issue。详见 [docs/agents/git-flow.md](./docs/agents/git-flow.md)。

## License

详见 [LICENSE](./LICENSE)。
