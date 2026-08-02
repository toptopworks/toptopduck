# toptopduck

本地优先的 AI 数据分析桌面工具：用户上传多格式数据集（Excel/CSV/JSON/Parquet），用自然语言做查询、清洗、聚合与描述性统计（含相关性、简单回归）。分析执行由**运行时**完成——内置 BYOK agent 循环，或用户选配的第三方 CLI agent；DuckDB 工作集经 MCP 工具面接入。**默认**能力以 SQL/DuckDB 原生为界——预测、机器学习、语义文本分类等默认不做，越界请求诚实拒绝并给出 in-scope 替代（见 ADR-0017）；用户可经自定义**技能**与 MCP 工具自行扩展能力，边界随之降为每技能语义。app 主动联网仅限 LLM 调用路径与用户启用的 MCP 工具；外部运行时进程自身的网络行为归其第三方。

## Language

**数据集 (Dataset)**:
会话内一个可被查询的逻辑表，是 LLM 生成 SQL 时的最小引用单元。一个 CSV/Parquet/JSON 文件映射为一个 Dataset；一个 Excel sheet 映射为一个 Dataset（杂乱结构需先规整，见 ADR-0015）；**隐藏的 sheet 不映射**——用户在 Excel 中隐藏的表不属于待分析数据。
_Avoid_: 文件(file)、表(table)、数据源(source)——这些是实现概念，非领域概念

**提问 (Question)**:
用户在一个轮次中输入的自然语言请求，是轮次的**输入**。它触发一次 agent 执行（0 或多次工具调用），可能产出中间结果，也可能触发越界拒绝 / 消歧澄清 / 执行失败 / 取消而**不**产出中间结果——产出与否取决于该轮的 outcome，而非提问本身。
在远期对话窗口与历史视图中，轮次以**提问原话（有界截断）**为指代句柄——非 LLM 生成的摘要（ADR-0039）；它同时是用户可见的步标签与 LLM 远期重定向的映射依据（ADR-0010）。
_Avoid_: 查询(query)——易与生成的 SQL 混淆；指令(command)、prompt

**轮次 (Turn)**:
一次完整的交互单元 = 一次提问 + 一次 agent 执行 + 一个 outcome。agent 执行是运行时（见「运行时」）就该提问发起的工具调用序列（0 或多次，构成**执行轨迹**）；**中间结果仅由轨迹内的显式物化调用产出**，轮末 scratch 探索即弃。outcome 四分保持：result（本轮产出一或多个晋升）/ textual / failed / cancelled。轮次恒在对话 thread 中**可见**——条目本身始终存在，产不产中间结果只决定 outcome 类型，与计步序、是否进对话窗口是相互独立的维度。对话 thread 还含**源生命周期事件**（加/换/删源）——与轮次并列、恒可见、占时序位置，但**非轮次**、不进 LLM 窗口（ADR-0040）；工具调用也非轮次，不推进计步序。
_Avoid_: 请求(request)、消息(message)、回合

**执行轨迹 (Execution Trace)**:
一轮内运行时发起的全部工具调用串（探索 / 物化 / 外部工具，各带参数、结果摘要与成败）。是轮次的**子结构**而非轮次：持久化、在 thread 中**可折叠**（rail 恒显提问与终局答复，轨迹按需展开）、**不进远窗**——远窗只收其摘要（答复 + 晋升 + 调用数 + 失败概要）。审计与跨轮失败回溯的依据。
_Avoid_: 日志(log)、步骤(step)、消息(message)

**源生命周期事件 (Source Lifecycle Event)**:
对工作集构成的一次用户驱动突变——加源（ADR-0022）/ 换源（ADR-0025）/ 删源。它在对话 thread 中**恒可见、占时序位置**，但**不是轮次**（无提问、无 outcome）——故不进 LLM 轮次窗口（ADR-0023）、不占 N=20 槽、不动 result_N 编号；它是 stale 派生"因何失效"标注（ADR-0025）的锚点。与创作新轮在会话内**互斥**（ADR-0040）。
_Avoid_: 操作(operation)、动作(action)、事件(event)——太泛

**中间结果 (Intermediate Result)**:
由轮次执行轨迹内的**显式物化**工具调用产生、晋升进工作集的 Dataset（探索查询的 scratch 表不是中间结果，轮末即弃）。其**引用名**（`result_1`、`result_2`…按晋升顺序单调递增、永不复用，ADR-0022）是 SQL、recipe 链、active 指针引用它的**稳定身份**；用户可改的是**显示名**（纯展示别名，仅显示层查重），改名不波及任何已存 SQL、不断 resume 重放链（ADR-0037）。它本身也是一种 Dataset。
_Avoid_: 临时表(temp table)、缓存(cache)、视图(view)——实现概念

**会话 (Session)**:
一个**持久化、可命名、可 resume** 的分析单元，拥有一条 recipe（见下）存在本地磁盘；重启后按 recipe 重建其工作集。打开时其工作集在内存中物化，多个打开的 Session 在内存中相互隔离（见 ADR-0027）。会话是持久化单位；临时的只是工作集，不再是“关闭即重置”。
_Avoid_: 项目(project)、对话(conversation)、工作区(workspace)

**配方 (Recipe)**:
一个 Session **当前工作集**的持久化描述（非历史账本），分两部分——**可重建部分**：当前源集（路径 + 规整参数 + 内容指纹）+ 当前仍有效的**物化晋升链**（被换源级联失效的轮不在此列，ADR-0025）；**展示部分**：全量对话历史（轮次恒可见、轨迹可折叠，纯追加永不裁剪）。外加 `format_version`、session 名、active dataset 指针。resume 即载入当前源集 + 重放可重放链。本身不含物化数据（遵循 ADR-0004 derive-only）。
_Avoid_: 日志(log)、账本(ledger)、脚本(script)、快照(snapshot)

**工作集 (Working Set)**:
一次会话内当前可被 SQL 引用的全部 Dataset 集合——包括上传的**一个或多个**源 Dataset，以及会话过程中产生的中间结果。
_Avoid_: 数据库(database)、状态(state)

**当前表 (Active Dataset)**:
一个提问在用户未显式指明时所作用的 Dataset——默认是上一步的中间结果，会话开始时即**最近上传的源 Dataset**；由 LLM 从对话上下文隐式解析，用户通常无需感知其存在。用户可显式点名覆盖（如"在原始数据上重新算"、"在订单表上"）。
_Avoid_: 选中项(selection)、焦点(focus)、当前行(current row)

### LLM 接入

**协议 (Protocol)**:
LLM 接入的线协议，支持两种——**anthropic**（Anthropic Messages 原生、`x-api-key` 鉴权）与 **openai**（OpenAI Chat Completions、Bearer 鉴权，覆盖 OpenAI 直连 / DeepSeek / GLM / Qwen / Ollama 等兼容端点）。接入档案的差异轴是「协议 + endpoint + model + key 的组合」，而非 provider 名——多家共用同一协议。
_Avoid_: 提供商(provider)、API、后端(backend)

**接入档案 (Profile)**:
一套命名的 LLM 接入组合 = 协议 + endpoint + model + key，是用户在设置里创建、命名、并指定其一为活跃的单元。非机密部分（协议/endpoint/model/展示名）住 app-config（ADR-0038），key 住 OS keychain 的 per-profile slot（ADR-0029），活跃 Profile 全局单一、不进 `.duck`（ADR-0034/0036）。它是机器级接入偏好，与具体分析正交。
_Avoid_: 账号(account)、连接(connection)、配置项(config item)

### Agent 执行

**运行时 (Runtime)**:
一次轮次的执行引擎：接收（提问 + 窗口化上下文 + 工具面），产出执行轨迹与终局答复。两种并存且可换——**内置**（app 自有 agent 循环，由活跃 BYOK 档案驱动）与**外部**（app 拉起的第三方 CLI agent 进程）。运行时**无状态**：不持任何权威会话状态（thread、窗口、recipe 全归 app）；进程存活只是传输层优化，不是状态边界。
_Avoid_: 提供商(provider)——那是协议档案；引擎(engine)——易与 DuckDB 引擎混；agent——太泛

**网关 (Gateway)**:
运行时访问工具面的唯一聚合接入点：装配工具表（内置 DuckDB 工具 + 用户配置的外部 MCP 服务器 + 技能声明的工具），并在此强制分级审批（ADR-0080）、审计、物化命名（ADR-0077）。内置运行时在 app 进程内直接经网关路由；外部运行时经**桥接**回连网关。网关是强制边界——运行时绕过网关直连工具，则审批/审计/物化皆不可强制。
_Avoid_: 代理(proxy)、中间件(middleware)、路由器(router)

**桥接 (Bridge)**:
外部运行时回连网关的传输中介进程——由外部 CLI 按 MCP stdio 契约拉起（server 由 client 启动），携带会话寻址参数，把 CLI 的工具调用透传到 app 网关。内置运行时不经桥接（进程内直接路由）。桥接是**纯传输**：不解析工具语义、不做审批、不执行工具——所有业务在网关。per-session 隔离（每外部 turn 一个桥接实例）。
_Avoid_: 代理(proxy)——那是网关的别名；适配器(adapter)——那是 CLI 的数据定义；连接器(connector)

**工具 (Tool)**:
运行时在轮次内可调用的、带名称与参数 schema 的能力；所有调用经 app 网关统一路由（可审计、可限、可沙箱）。**内置工具**作用于工作集：探索查询（scratch，轮末即弃）与显式物化（晋升为中间结果、得 result_N 名、受上限约束）；**外部工具**来自用户配置的 MCP 服务器。工具调用是轮次的轨迹构成，**非轮次本身**，不推进计步序。
_Avoid_: 命令(command)、扩展(extension)、接口(interface)

**技能 (Skill)**:
可挂载到会话的命名能力包 = 提示片段 + 可选的工具/MCP 声明（Markdown + frontmatter 格式）；由 app 在轮次装配阶段统一注入，与运行时无涉。技能改变 agent 的「答法」，不动会话的工作集与 recipe 结构。全局技能库 + 每会话多挂载、中途可增减。
_Avoid_: 插件(plugin)、模板(template)、宏(macro)

**技能生命周期事件 (Skill Lifecycle Event)**:
对会话活跃技能集的一次用户驱动突变——挂载 / 卸载。与源生命周期事件同构：在 thread 中恒可见、占时序位置，但**非轮次**、不占计步序、不以轮次身份进远窗——而进窗口装配器的当前状态视图（轮次装配用彼时活跃的技能集）。活跃技能集记入轮次装配上下文（审计依据）。
_Avoid_: 操作(operation)、配置变更(config change)——太泛
