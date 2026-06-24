# Guardrails: enforce safety at the engine level, never by parsing SQL text

## Decision

LLM 生成 SQL 的安全属性由 **DuckDB 引擎/配置层**保证，**不**做 SQL 文本过滤。四层：

1. **只读源**：源 Dataset 上传时 copy-in 进会话 DB 成只读表（见 ADR-0012），引擎层物理不可写。
2. **受限函数面**：LLM SQL 禁用文件系统类函数（`read_*`、`COPY`、`ATTACH`、`INSTALL`、`LOAD`）；数据加载只在 attach 时由工具执行。
3. **资源上限**：`memory_limit`、`threads`、结果行数上限、语句超时。
4. **错误自愈**：Schema 错（表/列不存在）回喂 LLM 重试 1–2 次，仍失败则如实告知用户。

## Context

派生 + 只读边界（ADR-0004）需落地为可执行的安全机制。LLM SQL 可能引用错对象、写危险语句、跑无界查询。

## Why

1. **SQL 文本过滤（正则删危险词）必然漏**——绕过手段无穷、永远做不全。安全属性必须由引擎本身保证。
2. READ-ONLY attach 让 `UPDATE/DELETE/DROP` 在引擎层直接失败，无需检测。
3. 禁用文件系统函数 + 仅工具侧加载，堵住 LLM 偷读/偷写任意磁盘路径。
4. 资源上限防本地 OOM / 卡死。

## Considered options

- **SQL 文本过滤/重写**：必然漏，不可接受。**否决**。
- **独立低权限进程/容器隔离**：最强但桌面场景过重，引擎级已足够。**否决（本期）**。

## Consequences

- 必须正确配置 DuckDB READ-ONLY attach 与函数禁用（依赖 DuckDB 能力）。
- 结果行数上限默认 **1 万行展示 + 全量可导出**（可调）。
- 文件系统函数在 LLM SQL 中不可用——所有数据接入必须经工具 attach 流程，LLM 不能自取数据。
