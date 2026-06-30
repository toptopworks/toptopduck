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
- 语句超时与用户取消（ADR-0021）走同一"当前轮作废"路径：不产 result_N、工作集不变。
- **被 ADR-0028 校准/延伸**：L4「schema 错重试」扩展为「schema 错 + 运行时/逻辑错（除零/类型转换等）+ 畸形输出共用单预算重试回路」；L3 资源上限/超时仍走 ADR-0021 abort、不进回路；失败轮恒可见、占 N=20 槽（ADR-0023）、不动 `result_N` 编号。
- **被 ADR-0030 校准**：「1 万行展示 + 全量可导出」补「展示行 < 总行数时须披露」——静默截断（把部分当完整呈现）为禁止行为（诚实不变量，同源 ADR-0011/0017）。

## read_* 阻断机制（沙箱，issue #25）

L2 的 `COPY/ATTACH/INSTALL/LOAD` 由 `CREATE TABLE result_N AS <query>` 的子查询包装在引擎解析层直接拒（它们是语句、不能作子查询）。唯一存活威胁是 SELECT 中的 `read_*` 表函数（`read_csv_auto`/`read_parquet`/`read_json_auto`）——它们是合法查询表达式，解析层放行。阻断它需要一个禁用了文件系统的连接。

**硬约束（实测，DuckDB 1.x）**：`SET disabled_filesystems='LocalFileSystem'` 是**实例级全局且不可逆**——一旦禁用无法 re-enable，且毒化该实例所有连接。因此 admin 连接（ingest 的 copy-in 依赖 `read_*`，必须 LFS-on）与 LLM SQL 连接（必须 LFS-off）**不能共存于同一实例**；`Connection::try_clone()` 共享实例，也不行。

**决策**：每轮在 `try_materialize` 内开一个**全新** `open_in_memory` 沙箱实例（不可逆性决定了沙箱用完即弃，不能跨轮复用），其上 `SET disabled_filesystems='LocalFileSystem'` 后跑 LLM SQL。admin 实例不变（始终 LFS-on）。**只有沙箱执行 provider SQL；admin 只跑工具侧语句（ATTACH/CREATE/INSERT，标识符皆工具生成）。**

**源/结果如何进入沙箱**（让 provider SQL 解析形态与 admin 完全一致）：
- **源**（`"<ref>".data`）：沙箱 READ_ONLY 重新 attach 同一快照文件。两个实例可并发 READ_ONLY attach 同一 `.duckdb` 文件（实测），零拷贝，不打扰 admin。源文件真实路径由 Session 在每个 attach 点记入 `source_files` 映射（replace 的 rename-fallback 可能把文件留在 swap 路径，故不重建 `temp_path/<ref>.duckdb`）。
- **历史结果**（`result_N`，admin 主库 base 表）：经 `duckdb::types::Value` + Appender 做类型无关的按行镜像，成为沙箱主库的同名 base 表（流式，内存 O(单行)）。新结果以同法镜像回 admin，再由 admin 派生/注册（路径不变）。

**分类**：沙箱对 `read_*` 的拒错串含 `"disabled by configuration"`，被既有分类器归为 `Resource`——与资源上限同路径，**不进重试回路**（同一 SQL 撞同一墙，ADR-0028）。
