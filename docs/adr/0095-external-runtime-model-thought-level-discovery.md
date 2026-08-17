# 外部运行时:模型与思考强度的发现、选择与注入

## Decision

1. **模型与思考强度为会话级可配置项，允许轮间切换**。用户可在会话任意时刻切换模型或思考强度，切换在下一轮 turn boundary 生效（与运行时切换同语义）。每轮无状态架构下切换意味着新 spawn + 扁平化历史喂入，依赖 CLI 自身的上下文消化能力，不做特殊标注。

2. **发现策略绑定 StreamFormat（turn 路径）**。`StreamFormat::Acp` 从每轮握手响应的 `config_options` 提取模型列表与思考强度选项；`StreamFormat::JsonEventStream` 在 turn 路径无动态发现（`exec --json` 不暴露 config catalog）——诊断探测路径的目录获取（含 JsonEventStream 经 app-server 查询）由 ADR-0096 另行定义。零 per-CLI 代码不变量保持：发现逻辑在 per-format 分派路径内，不在适配器定义中。

3. **Wire 类型以 `serde_json::Value` 透传扩展**。`NewSessionResult` 新增可选 `config_options: Option<serde_json::Value>`（不定义完整 ConfigOption 类型层级）。引擎在 handshake 边界从 `Value` 提取 category 为 model / thought_level 的项，转为 `DiscoveredRuntime`。原始 `Value` 保留供未来扩展（mode 等其他 config 维度）。

4. **注入机制 per-format 分派**。ACP 路径：模型与思考强度在握手后、prompt 前各追加一次 `session/set_config_option`（schema 0.13.8 的 `NewSessionRequest` 不携带 model 字段，`session/set_config_option` 是协议的配置注入通道；stdio 本地通信边际成本可忽略）。config id 以目录条目自选的 `id` 为键（schema 只标准化 category、不标准化 id），目录无可用 id 时回退 category 常量。JsonEventStream 路径：经 argv——`AdapterSpec` 新增两个 `Option` 字段：`model_arg`（如 `"--model"`，引擎追加 `[flag, value]`）与 `effort_config_key`（如 `"model_reasoning_effort"`，引擎拼装 `["-c", "{key}={value}"]`）。ACP 适配器两字段均 `None`（注入走 `session/set_config_option`）。

5. **发现结果经 `LoopOutcome` 回传**。`LoopOutcome` 新增 `discovered_runtime: Option<DiscoveredRuntime>`（含 models / current_model / thought_levels / current_thought_level）。内置运行时与 JsonEventStream 恒 `None`（不支持发现），ACP 填 `Some(...)`。每轮回传，前端做去重判断。`Option` 语义区分「该运行时不支持发现」与「发现结果为空」。

6. **SessionHandle 新增三个会话级字段并持久化**：`model: Option<String>`（选中的模型 ID）、`thought_level: Option<String>`（选中的思考强度值）、`cached_discovered: Option<DiscoveredRuntime>`（上轮发现的模型列表缓存，供 resume 冷启动渲染）。resume 时三者一并恢复——模型选择丢失是 resume 承诺的意外退化。recipe **不记录**模型与思考强度：LLM 模型不是可重放的确定性输入，模型选择是会话级配置而非 recipe 步骤。

7. **IPC 为两个独立 lock-light 命令**：`set_session_model(session_id, model)` 与 `set_session_thought_level(session_id, thought_level)`，与 `set_session_runtime` 同模式（落 handle、turn boundary 生效、resume 中拒绝）。模型 ID 不在 IPC 边界校验：前端下拉只提供发现的模型，无效 ID 只能来自 stale 缓存或手动调用，CLI 在 spawn 时自行处置。

8. **内置运行时（BYOK）的思考强度不在本 ADR 范围**。`thought_level` 对内置运行时为 no-op。provider 级思考强度（anthropic extended thinking / openai reasoning_effort）语义异构于 CLI 的离散 thought_level，需逐 provider 适配，留待独立 ADR。内置运行时的模型选择维持现状（provider profile 驱动）。

## Context

ADR-0081 定外部运行时为数据定义适配器引擎，每轮 `session/new` + 全量窗口化上下文（无状态）。ADR-0094 引入 `StreamFormat` per-format 分派。当前 `AdapterSpec` 仅有 spawn 与通信字段；`InitializeResult` / `NewSessionResult` 丢弃了 ACP 握手响应中的模型信息（wire 类型注释明确写着 "config_options and mode state are ignored"）。外部 CLI 的模型与思考强度调节是数据分析场景的高频需求——简单查询用低思考强度、复杂多步推理用高思考强度，用户需要在会话中途按任务复杂度切换。

## Why

1. **发现零额外开销**：无状态架构下握手每轮都在发生，从已有响应中提取模型信息不增加任何 spawn 或 RPC 开销。
2. **Value 透传避免过度建模**：`config_options` 是 ACP 协议标准结构（非 per-CLI），但完整 ConfigOption 类型层级（category / option_type / options[]）在当前需求下只消费 model 与 thought_level 两项；`Value` 透传 + 引擎边界提取把解析复杂度局限在一处，未来扩展不改 wire 类型。
3. **注入点都在引擎内部**：ACP 注入在握手边界（模型与思考强度各一次 `session/set_config_option`），JsonEventStream 注入在 argv 拼装；两条路径对外都不暴露。
4. **session 元数据缓存兼顾 resume 与 KISS**：per-adapter 全局缓存需要考虑过期 / 刷新 / 多会话写入竞争；前端内存缓存不跨重启。session 级快照数据极小（几个字符串），resume 场景体验最好（恢复即知可选列表 + 选中值）。
5. **recipe 不记录是不可重放性的推论**：同一模型不同采样参数产出不同 SQL；模型选择影响「答法」而非「领域数据」，与技能注入同属轮次装配配置。

## Considered options

- **会话级锁定模型（创建时选定，中途不可换）**：运行时选择可换而模型锁定是不一致的用户约束；每轮 spawn 形态下轮间切换只是 argv 变化，无机制障碍。**否决**。
- **模型选择不持久化（前端-only，每轮 ask 时传入）**：resume 后模型选择丢失，违 resume 承诺。**否决**。
- **wire 层定义完整 `ConfigOption` 类型层级**：当前只消费 model / thought_level 两项，完整建模是过度设计；未来需要时从 `Value` 提取不影响 wire 兼容。**否决**。
- **发现结果经独立 IPC 拉取或事件流推送**：无状态架构下发现数据只在 turn 执行期间存在，拉取需要重新 spawn；事件流需要引入持续推送基础设施而 turn 是同步 `ask → LoopOutcome` 模型。**否决**——此处否决的是 turn 语境下的自动拉取（无人授权的 re-spawn）；用户显式点击驱动的诊断探测由 ADR-0096 定义，性质不同。
- **per-adapter 全局缓存（app-config 级）**：全局缓存引入跨会话一致性复杂度（过期 / 刷新 / 写入竞争），收益仅限多会话共享同一 CLI 的场景。**否决**——session 级快照冗余可忽略。此处否决的是自动发现路径每轮回写全局缓存的写入竞争；用户显式测试驱动的探测缓存（app-data 独立文件、单一写入点）由 ADR-0096 定义，不在其列。
- **模型 ID 在 IPC 边界校验（有缓存时拒绝不在列表的 ID）**：ACP 对无效模型的 `session/new` 响应行为未定义（可能静默回退），app 侧校验只是把失败提前一步但未消除歧义；正常用户路径不会产生无效 ID。**否决**——实测不可接受时向后兼容增量补充。
- **AdapterSpec 声明 argv builder 函数**：per-CLI 代码，违反 ADR-0081 零 per-CLI 代码不变量。**否决**。
- **内置运行时思考强度一并实现**：anthropic thinking（token 预算）与 openai reasoning_effort（离散枚举）语义异构，需改 Provider trait + 双实现 + profile UI，改动面与本 ADR 耦合后膨胀。**否决**——独立后续。
- **预扫描发现（PATH 扫描时 spawn CLI 枚举模型）**：额外 spawn 成本；各 CLI 的模型枚举命令不同，要么 per-CLI 解析要么只支持 ACP（那不如用已有握手）。**否决**。

## Consequences

- **延伸 ADR-0094**：`StreamFormat` 不仅决定解析器分派，也隐含决定模型发现策略——`Acp` 从握手提取，`JsonEventStream` 无动态发现。未来新增带模型枚举能力的流格式时，需同时声明其发现策略。
- **被 ADR-0096 校准与延伸**：「无动态发现」收窄至 turn 路径——诊断探测路径（设置页测试动作）为 JsonEventStream 适配器经 `codex app-server` 的 `model/list` 获取 per-model 目录，探测结果缓存（app-data 独立文件）作为选择器目录的次级数据源（会话目录优先）。
- **校准 ADR-0081**：wire 类型扩展与 AdapterSpec 新增字段均为纯数据增量，适配器引擎架构不变；`session/set_config_option` 是 ACP 路径的握手扩展步骤，不引入 upstream session 状态（每轮新 `session/new` 的无状态语义不变）。
- **校准 ADR-0089**：session 持久化结构新增 `model` / `thought_level` / `cached_discovered` 三个可选字段，旧会话文件缺字段按 `None` 反序列化（向后兼容）。
- **CONTEXT.md 不变**：模型/思考强度选择是会话级配置（同 runtime choice、审批姿态），非领域概念；不引入新领域词汇。
- **fake fixture 扩展**：ACP fake CLI 需在 `session/new` 响应中返回 `config_options`（含 model + thought_level 项）以驱动发现路径测试。
- **未决（实施期）**：各 CLI `config_options` 实测形态差异（字段名 / category 命名的兼容性矩阵）；前端选择器 UI 形态与 i18n。
- **被 ADR-0097 校准与延伸**：发现策略按格式三分化（`ClaudeStreamJson` 的 turn 路径无动态发现，探测通道为 stream-json 控制平面 `initialize`）；注入字段新增 argv 形 `effort_arg` 与 `effort_config_key` 平行。
