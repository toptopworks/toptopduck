# 沙箱 read_* 可用:移除 lockdown + FsAcl 独占约束

## Decision

1. **移除 sandbox 的 `disabled_filesystems` lockdown。** sandbox 构造流程不再调用 `SET disabled_filesystems='LocalFileSystem'`。DuckDB 引擎的 LocalFileSystem 保持启用，使 `read_csv_auto` / `read_json` / `read_parquet` 可在 sandbox 中读取白名单内路径（源文件 + session temp + `tool_output/` 子目录）。ADR-0087 Decision 3 的端到端「DuckDB 可读取外部工具产出」承诺闭合。

2. **FsAcl 成为 `read_*` 路径的唯一约束。** preflight 的字面量路径白名单（FsAcl `canonicalize` + `starts_with` 组件级匹配）是 `read_*` 的唯一文件可达性约束。白名单外路径仍被拒绝，给 agent 结构化错误（ADR-0077）。

3. **非字面量 `read_*` 路径由 preflight 显式拒绝。** `read_paths` 提取器对 `read_*` / `sniff_csv` 的首参做三态分类：非 read 函数 / 字面量路径 / read 函数但路径不可提取。第三态（动态表达式、列引用、列表参数等 FsAcl 无法校验的路径）触发 preflight 拒绝，错误消息指示 agent 使用字面量路径字符串。

## Context

ADR-0080 定下双层防御：引擎级 `disabled_filesystems` lockdown 作为 `read_*` 的硬阻断保证（ADR-0005 / issue #25），网关 FsAcl 白名单叠加做结构化越界错误。管线层已就绪（`tool_output/` 目录 + FsAcl 白名单覆盖 + 环境变量注入），但 lockdown 使 DuckDB 拒绝所有 `read_*`——即使路径在白名单内。ADR-0087 Decision 3 的端到端承诺未闭合。

`disabled_filesystems` 是 DuckDB 实例级全局且不可逆的设置——无法按路径选择性放行。要使 `read_csv_auto` 在 sandbox 可用，必须移除 lockdown。移除后，`read_paths` 提取器的「尽力而为」特性暴露了一个覆盖盲区：非字面量 `read_*` 路径被静默跳过，零路径到达 preflight 循环，SQL 直达引擎。lockdown 在时这是 guidance-quality 问题（引擎兜底）；lockdown 移除后这是安全问题。

## Why

1. **ADR-0087 闭合需要引擎可读**：外部 MCP 工具产出写到 `tool_output/`，agent 用 DuckDB 原生 `read_*` 引用。lockdown 使该路径不可用——每个用过外部工具的会话的 ADR-0087 承诺是空话。移除 lockdown 是最小闭合。
2. **非字面量拒绝消除移除 lockdown 的安全缺口**：LLM 可写出合法的动态路径模式（从表读文件名再读取）。FsAcl 无法校验运行时计算的路径；不加固则这类调用无约束读取任意路径，违反 ADR-0080 的文件可达性承诺。preflight 拒绝非字面量路径后，agent 可先查出路径值再用字面量重写查询——两步而非一步，但 lockdown 本来全禁，任何 `read_*` 能力都是纯增量。
3. **FsAcl 的安全分析已由现有实现覆盖**：symlink 逃逸（`canonicalize` 跟随到真实目标后判断）、CWD 相对路径（镜像 DuckDB 的 CWD 解析，`../` 逃逸被拒）——`fs_acl` 模块已实现这些防护。
4. **walker 盲区是可接受的残余风险**：`read_paths` 的 AST walker 有 `_ => {}` 兜底分支，未被识别的构造中的 `read_*` 不被检测。在非对抗威胁模型下（ADR-0080：agent 是用户选择运行的非对抗 LLM，非 SQL 注入对手），LLM 不会构造对抗性 AST 来绕过 walker；per-session 实例隔离（ADR-0027）框定爆炸半径到会话自身引擎。walker 覆盖面可随 sqlparser 升级渐进补全。

## Considered options

- **保留 lockdown + 用自定义 DuckDB filesystem 做路径白名单**：需经 C API 注册自定义 filesystem handler，Rust duckdb crate 未暴露所需接口；复杂度高且维护成本大。**否决**。
- **保留 lockdown + 新增 `ingest` 内置工具读文件**：与 `read_csv_auto` 的 schema 推导重叠（DRY 违反），且 ADR-0087 已否决 `ingest` 工具方案。**否决**。
- **接受动态路径缺口（不加固 preflight）**：合法动态路径模式（从表读文件名再读取）无约束读取任意路径，违反 ADR-0080 核心承诺。**否决**。
- **穷尽 walker 覆盖（消除 `_ => {}` 盲区）**：把 `_ => {}` 改为「遇到未识别节点即拒」会过度保守——无 `read_*` 的合法罕见构造也被拒，破坏可用性。**否决**。

## Consequences

- **校准 ADR-0080**：Consequences 中 lockdown 作为 `read_*` 保证层的角色移除。FsAcl 成为唯一约束；双层防御变为单层（preflight 字面量路径白名单 + 非字面量拒绝）。
- **了结 issue #436**：sandbox 中 `read_csv_auto` / `read_json` / `read_parquet` 对白名单内路径端到端可用。
- **校准 ADR-0005**：引擎级 `read_*` 硬阻断不再是 guardrail 层的一部分——guardrail 改为 preflight FsAcl（仍非 SQL 文本过滤，是 SQL 解析 + 路径提取 + 白名单校验）。
- **校准 ADR-0087**：Decision 3 的「DuckDB 可读取外部工具产出」端到端承诺闭合。
- **残余风险记录**：walker `_ => {}` 盲区 + symlink TOCTOU（best-effort read-time check）——均在非对抗威胁模型下接受。
