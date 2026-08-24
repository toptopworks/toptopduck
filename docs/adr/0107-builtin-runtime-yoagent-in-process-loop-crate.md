# 内置运行时实现形态：yoagent 进程内 agent 循环 crate 取代自写循环与协议适配器

## Decision

1. **循环与协议层整体移交 yoagent。** 内置运行时的实现形态从自写 Rust agent 循环 + 自写协议适配器，换为 yoagent crate（crates.io 依赖，minor 闸门 `"0.18"` + Cargo.lock 精确钉版，MIT，MSRV 1.86）。自写 agent 循环与 anthropic/openai 两个协议适配器退役；app 保留 prompt 装配、窗口化、网关、preflight、配置面与钥匙串——这些是领域差异层，不外委。

2. **每轮无状态驱动。** 每轮新建上下文、调 yoagent 的无状态入口 `agent_loop()`，喂入 app 窗口化的全量上下文；轮内 thinking 回喂与工具批连续性由 yoagent 内部接管。yoagent 的有状态组件（`Agent` 包装、Session 历史树、上下文压缩、skills 加载、MCP 客户端、子代理）一律不用——运行时无状态不变量（ADR-0076/0081）逐位保持；`context_config` 恒 `None`，压缩归 app 窗口化（ADR-0023），防双重截断。

3. **工具面单一适配器走网关。** 实现一个按网关工具目录参数化的 `AgentTool` 适配器：name/schema 来自网关装配（内置 DuckDB 工具直列 + 外部工具固定发现面，ADR-0105），`execute()` 一律路由 app 网关——分级审批（ADR-0080）、审计、`result_N` 物化命名（ADR-0077）原样强制。yoagent 的 `ToolMiddleware` 不用（单一强制点 = 网关，不立第二闸门）；yoagent 的内置工具（bash / 文件读写 / 搜索）不注册——它们绕网关，会击穿能力边界（ADR-0017/0079）与 FS 可达性封锁（ADR-0080/0088）。

4. **执行轨迹完全等价。** yoagent 的 `AgentEvent` 流逐字段映射执行轨迹：轮分组、thinking（时长 + 模型原始推理）、连接话语、工具批（参数 + 结果摘要 + 成败）。轨迹持久化进 recipe（ADR-0078/0103），是审计与跨轮失败回溯依据，不降级。

5. **安全网帽值不变，接纳循环检测，重试交上游。** 步数帽 24 与墙钟 120s 映射 `ExecutionLimits` 不变（ADR-0021/0081）；取消 = 整轮中止，映射 `CancellationToken`。接纳 yoagent 的循环检测（连续同参调用第 3 次打断、下次终止）：`LoopDetected` 映射为轨迹注记，被其终止的轮以诚实失败原因落盘。重试执行交 yoagent（限流 / 网络错误，退避 + 抖动），终态错误映射进现有用户可见错误分类词汇（ADR-0044 两档语义保留）。

6. **协议轴一期只保等价。** Profile 协议轴维持 anthropic + openai 两协议，替换对用户零可见（循环检测等新行为除外）。yoagent 原生支持的其他线协议（OpenAI Responses / Azure / Gemini / Vertex / Bedrock）扩面是另一棵决策树（preflight 分级诊断、模型发现全套重适配），拆独立 issue。

## Context

ADR-0081 定内置运行时 = 自写 Rust 原生循环，并否决「借壳第三方 agent 进程」——否决理由是 key 经环境变量过界、重依赖第三方二进制、M 纪律靠他进程自觉。自写循环与协议适配器此后持续长边界案例，维护成本是持续税。yoagent 是进程内链接的 Rust crate：提供每轮无状态的一等入口 `agent_loop()`（全量历史 + 执行上限 + 取消令牌一次传入）、原生线协议实现（含 thinking 支持）、单一工具闸门与离线 `MockProvider` 测试。它是 ADR-0081 决策时备选集合之外的第三选项——借循环但不借进程。

## Why

1. **key 不过界，否决理由不适用**：yoagent 链接进同一进程，key 经显式参数传入、不经环境变量——ADR-0029 不变量（key 仅在 Rust 进程）逐位保持。0081 的两条否决理由（key 过界、二进制依赖）对进程内 crate 均不成立；M 纪律仍由 app 侧 system prompt + 网关强制。
2. **维护权移交，差异层自留**：循环与协议实现（约 7k 行）交上游社区；app 收敛到领域差异层（网关 / 装配 / 轨迹映射 / preflight）。差异层是 domain-specific、不可外委的部分，本就该 app 持有。
3. **无状态入口一等公民**：`agent_loop()` 的形态与外部运行时「每轮恒 `session/new` + 喂全量窗口」哲学同构，运行时无状态不需要为迁就上游打补丁。
4. **强制点零漂移**：工具调用经单一适配器统一路由网关，上游的 middleware 与内置工具整体不启用——审批 / 审计 / 物化纪律不因换循环而分叉。
5. **供应链风险有界**：minor 闸门 + Cargo.lock 把上游破坏性变更挡在显式升级动作里；回滚底线 = revert 整个替换链（旧实现在 git 历史）。

## Considered options

- **维持自写循环（现状）**：边界案例持续增量，维护税被反复证实。**否决**。
- **只换循环层、保留自写协议适配器**：须为 yoagent 的 `StreamProvider` trait 写桥接，两块维护面都在还多一层桥，与减负动机矛盾。**否决**。
- **协议轴顺势扩到 yoagent 全线协议**：与减负正交；每条新协议都要重适配 preflight 分级诊断与模型发现，验收面翻倍。**否决**——拆独立 issue。
- **运行时开关、双循环共存过渡**：M 契约 / 审批语义双轨维护，ADR-0081 否决「借壳与自建双提供」的理由原样适用。**否决**——单轨替换。
- **跨轮状态交给 yoagent 的 Session 树**：违反「运行时无状态」词汇表——resume、会话内换运行时、窗口管理全被上游状态污染。**否决**。
- **注册 yoagent 内置工具（bash / 文件读写 / 搜索）**：绕网关，击穿能力边界与 FS 封锁，与 key 同进程的信任模型冲突。**否决**。
- **git 钉 main / vendor 进仓库**：前者无 semver 护栏、破坏性变更静默进构建；后者等于把循环维护权拿回来。**否决**——crates.io minor 钉。

## Consequences

- **取代 ADR-0081 内置半**：「内置运行时 = Rust 原生 agent 循环（自写）」的实现形态移交 yoagent；外部运行时数据定义适配器引擎半、执行级兜底帽值（24 步 / 120s / 整轮取消）与对「借壳第三方进程」的否决**保留**——后两条否决理由对第三方进程仍然成立。
- **校准 ADR-0064**：anthropic/openai 协议适配器实现移交 yoagent；Profile 概念、协议轴、活跃档案语义不变，key 仍住 keychain per-profile slot。
- **校准 ADR-0044**：重试执行点移交 yoagent 内置退避重试；两档分类（permanent / transient）与用户可见失败词汇保留，yoagent 终态错误映射进既有分类再上达。
- **校准 ADR-0021**：内置路径换为 async 循环，取消经 `CancellationToken` 任务级即时生效，HTTP / SSE 流可中途中断——「同步阻塞期间仅置 cooperative flag、跑完再丢弃」的约束不再适用于内置路径；「当前轮作废」语义不变。
- **重申 ADR-0029**：key 仅在 Rust 进程，经显式参数传入 yoagent，不经环境变量、不出进程。
- **MSRV 1.80 → 1.86**：yoagent 下限；CI 无 minor 版本钉，仅声明性抬升。
- **词汇表不动**：「内置运行时」语义（= app 进程内执行、由活跃 BYOK 档案驱动）与代码作者无关，CONTEXT.md 无需修订。
- **留实施期**：yoagent `max_turns` 计步语义与「工具批轮次」的对齐验证；轨迹映射逐字段等价的测试钉。
- **供应链风险**：上游 0.x、单一组织维护、迭代活跃——minor 闸门 + 精确锁版承接；回滚底线为 revert 替换链。
