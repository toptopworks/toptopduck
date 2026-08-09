# 数据分析 agent:DuckDB 从唯一引擎降为默认工具

## Decision

1. **Agent 身份 = 数据分析 agent**（非"SQL 执行代理"）。系统提示 `TOOL_CALLING_PROMPT` 的开篇从"SQL 执行代理"改为"数据分析 agent"；保留 DuckDB IN/OUT scope 为 DuckDB 工具的默认能力描述（非 agent 全部能力）。新增工具选择指导段：DuckDB 是表格型分析（查询/聚合/统计）的默认工具；当请求超出 DuckDB 能力且工具箱中存在匹配的外部工具时，使用该外部工具；无任何匹配工具时诚实拒绝。

2. **能力边界扩展触发条件拓宽。** 系统提示的技能条款从"仅挂载技能显式提供工具时扩展"改为"工具箱中存在匹配工具时扩展"，不区分工具来源——技能声明的 MCP 工具与用户直接配置的 MCP 工具同等对待。与网关已有的工具归一路径一致（ADR-0076：内置 + 外部 + 技能声明三者归一）。

3. **外部工具产出 -> DuckDB 导入 = 文件中介。** 外部 MCP 工具将产出写到会话沙箱目录（`/sandbox/tool_output/`）；agent 在后续轮次中用 DuckDB 原生文件读取（`read_csv_auto` / `read_json` / `read_parquet`）经 explore/materialize 引用。inline 结果由 agent 循环内部落临时文件再走同一路径。新增沙箱目录约定，外部 MCP 工具的 fs_acl 白名单增量放行该目录。

4. **派生源 (Derived Source) 持久化。** materialize 时 SQL 引用 sandbox 临时文件的，系统自动将该文件拷贝到会话持久化目录（与上传源文件同级），记录路径 + 内容指纹。recipe 中该 materialize 步的 SQL 路径指向持久化路径。resume 时文件在、指纹对、重放成功——行为与上传源文件一致（ADR-0034/0035 不变）。

## Context

ADR-0002 定"Text-to-SQL over DuckDB"为唯一执行模型；ADR-0017 以 DuckDB 原生 SQL 能力划定 IN/OUT scope 并诚实拒绝越界。ADR-0079 已将能力边界从系统不变量降为默认技能集语义（用户可经技能与 MCP 工具扩展）。ADR-0076 引入双运行时 + MCP 网关，内置工具与外部工具经网关归一。

但系统提示（`TOOL_CALLING_PROMPT`）的 agent 身份仍是"SQL 执行代理"——它在文本上把 agent 锁死在 DuckDB SQL 为唯一分析路径的心智中。即使用户配置了能处理 ML/预测的外部 MCP 工具（且它们已在 LLM 的 tools 数组中），系统提示仍告诉 agent 对这类请求"拒绝，不要尝试"。能力边界的扩展触发条件（技能条款）也仅限"挂载技能显式提供工具"，不覆盖用户直接配置的 MCP 工具。

用户期望系统核心是数据分析 agent——DuckDB 是强大但可选的工具，一个会话可能完全不使用它。

## Why

1. **身份决定行为**：系统提示把 agent 框定为"SQL 执行代理"时，LLM 即使看到 tools 数组里有外部工具也倾向于先用 SQL——身份句是 LLM 推理的最强锚点。改身份为"数据分析 agent"是让 LLM 真正把外部工具当作可选手段的最小杠杆。
2. **网关已归一，提示不应更窄**：ADR-0076 的网关已不区分工具来源（内置 + 外部 + 技能声明三者归一）。系统提示的能力边界比网关更窄（仅技能触发扩展）是一个不应存在的语义裂缝。
3. **文件中介复用已有管道**：DuckDB 的 `read_csv_auto` / `read_json` 已处理类型推断、嵌套展开、规整（ADR-0014/0015/0043）。复用比新建 `ingest` 工具 + 重新实现 schema 推导更 KISS。
4. **派生源持久化保 resume 承诺**：ADR-0001/0034/0035 的 resume 是产品核心承诺。外部工具产出文件不持久化则依赖链在 resume 时全部 stale——对用过外部工具的会话是意外退化。持久化为派生源复用源文件的指纹验证与 stale 检测。
5. **DuckDB 保持 builtin 不降为普通 MCP server**：审批恒放行是深思熟虑的设计（builtin 工具已受沙箱约束，不需二次审批，ADR-0080 Decision 1）。降为普通 MCP server 引入每会话审批弹窗，除非额外引入"内置 MCP 信任"概念（等于换名的 builtin）。

## Considered options

- **DuckDB 降为普通 MCP server（取消 BUILTIN_SERVER 特权）**：审批恒放行丢失，每会话弹审批卡；或需引入"可信 MCP server"概念（换名的 builtin）。**否决**。
- **上传不自动物化进 DuckDB（仅注册文件路径）**：推迟物化破坏 ADR-0012（源不可变快照）与 ADR-0035（resume 重放）的确定性；schema 感知从"上传时就知道"退化为"加载后才知道"。**否决**。
- **新增 `ingest` 内置工具（接收 inline 数据并加载）**：inline 传大表不现实（LLM 上下文中继）；schema 推导与 `read_csv_auto` 部分重叠（DRY 违反）。**否决**——文件中介覆盖。
- **外部工具产出不持久化（resume 标 stale）**：用过外部工具的会话 resume 退化到半数结果失效。**否决**——违 resume 承诺。
- **recipe 记录外部工具调用、resume 时重新执行**：外部工具可能不可用 / 非确定性 / 耗时花钱。**否决**——脆弱且过度工程。
- **移除系统提示中硬编码 IN/OUT scope（能力边界隐含在工具描述中）**：agent 会尝试用 SQL 做不擅长的事（粗糙"聚类"）然后失败回退。**否决**——不如直接告诉边界。
- **完全重写系统提示结构（tool-agnostic 基础 + DuckDB 节 + 动态节）**：更"正确"但改动面大。**否决**——改身份句 + 加指导段验证行为后再考虑拆分（YAGNI）。

## Consequences

- **ADR-0002 的逃生舱满足**：原 Consequence"若未来出现强需求，需要一个显式逃生舱——届时另立 ADR"由本 ADR 满足——逃生舱 = 外部 MCP 工具（经文件中介与 DuckDB 协作）。
- **校准 ADR-0079**：能力边界扩展触发条件从"技能显式提供"拓宽为"工具箱存在匹配工具"。
- **延伸 ADR-0076**：网关工具归一在提示层面兑现——系统提示不再比网关更窄。
- **CONTEXT.md 更新**：首段从 DuckDB 中心叙述改为 agent 中心；新增「派生源」术语。
- **领域模型不变**：Dataset、Working Set、Intermediate Result、Recipe、Materialize 概念保持——它们仍是 DuckDB 表。派生源是 Dataset 的一种来源（与上传源并列），非新概念。
- **recipe 格式不变**：派生源的 materialize 步仍是 `{sql, display_name?}`——不需要升 format_version。
- **派生源的 recipe SQL 用 catalog 引用**：Decision 4 措辞「SQL 路径指向持久化路径」精确化为——materialize 引用 tool_output 文件时，系统对该文件做 copy_in + ATTACH（与上传源同一管线），SQL 改写为 catalog 引用（`"ref".data`），非路径替换。`provenance::analyze` 只追踪 `TableFactor::Table`；`read_csv_auto` 落入 `_ => {}` 不被追踪，路径替换方案下 stale 级联（ADR-0025/0041）无法覆盖派生源。catalog 引用使派生源完整复用上传源的 provenance / stale / resume 管线。
- **未决（实施期）**：沙箱目录约定与命名、fs_acl 白名单增量、派生源存储上限。
- **被 ADR-0089 校准**：本 ADR Decision 4「派生源拷贝到会话持久化目录」的路径从 `<duck_stem>.assets/`（.duck 同级）变为 per-session 目录内的 `assets/` 子目录（`sessions/{uuid}/assets/`）。`migrate_derived_sources` 的路径构造从 `{duck_dir}/{duck_stem}.assets` 变为 `{session_dir}/assets`。
