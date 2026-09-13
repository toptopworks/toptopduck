# 内置运行时实现形态：rig 进程内双 crate 取代 yoagent 循环 crate

## Decision

1. **循环与协议层整体换为 rig，不做 fork 止血。** 内置运行时的实现形态从 yoagent crate 换为 rig（rig-core + rig-agent 双 crate 直引，crates.io minor 闸门 `"0.42"` + Cargo.lock 锁版，MIT，`default-features = false`）。动机双轮：上游为单人维护（bus factor = 1），且 0.18.1 双协议线序缺陷已实证——anthropic 构造器把批内多个 `tool_result` 拆成多条 user 消息（模型一次发出 ≥2 个工具调用时次轮请求必 400）、openai 构造器丢弃 thinking 回传（`reasoning_content` 强制回传的端点同样 400），无用户侧绕行、上游无修复可等。fork 修复等于向已决定淘汰的依赖投维护承诺，否决。

2. **借内核不借框架。** rig-agent 的 multi-turn 循环（`PromptRequest`）作为循环内核，每轮无状态喂入 app 窗口化全量历史（继承 ADR-0107 Decision 2）；框架的 hook 体系、会话记忆（`without_memory()`）、`ToolContext`、模型选择重写全部空挂不用——除取消检查点（Decision 3）外，rig 的介入面收敛为零。rig-core 的 anthropic/openai provider 作为线协议实现，此前实证其批内 `tool_result` 合并进单条 user 消息、`reasoning_content` 原生支持——两处缺陷面在 rig 无原样风险。

3. **取消经 hook 检查点，事件驱动取代轮询。** 取消桥为一个 `AgentHook` 实现：在 `on_completion_call` 与 delta 级检查点（`on_text_delta` / `on_reasoning_delta` / `on_tool_call_delta`）轮询 app 取消令牌，被请求时返回终止动作，由 rig 以 `PromptCancelled { reason }` 终止；生成静默期由驱动线程 select 竞速兜底。`reason` 携带 app 私有分叉词汇（用户取消 / 无进展看门狗触发），在集成层常量化钉死——终态分叉语义（ADR-0021 整轮取消、ADR-0115 原因分叉）逐位保持。工具批中段取消不经 rig：网关派发侧的批内停止检查原样保留。

4. **工具面单一动态适配器，app 全量包装错误。** 经 rig 的 `DynamicTool`（name/schema 运行时构造）实现网关适配器：callback 经通道把调用发回 session 线程的派发服务（非 `Sync` 协作者不跨线程的原约束保持），回包经 oneshot 返回。callback 恒返回成功——工具执行失败被包装为错误文本进 `tool_result` 回喂模型自纠（ADR-0028 语义），rig 的工具错误通道（fail-fast / retryability）结构性不可达。派发顺序 `tool_concurrency = 1`，持久化历史按调用序由框架结构保证（`result_N` 单调性）。

5. **终态映射结构化穷尽。** app 终态词汇从 rig 错误变体穷尽 match 推导：`MaxTurnsError` → 步数帽耗尽、`PromptCancelled` → 取消两分叉、`CompletionError` 按 HTTP status（401/403 → 配置未接线，其余 → 瞬态）、未知工具调用 → 瞬态兜底、记忆错误不可达。步数帽 24 与取消即时性等帽值语义不变（ADR-0081/0021）；编译器强制穷尽取代对上游错误措辞的字符串前缀匹配。生成侧重试不外委：网络与限流错误直接落瞬态终态，无自动重试（rig 的重试构件不启用）——先前「限流 / 网络错误交上游退避重试」的处置随之退役，重试路径交上层与用户。

6. **重定向结构性禁用，跨 host 凭据泄漏根除。** 经 rig client builder 的注入点传入 app 自构造的 reqwest client（重定向策略 `none`）：跨 host 3xx 直接落为瞬态诚实失败。先前「实测上游不剥 `x-api-key`、以哨兵钉记录已接受暴露」的决策被推翻——注入点存在后接受暴露失去必要性；相应重定向测试钉从记录器（断言泄漏送达）改向为断言器（断言拒绝跟随）。

7. **命名中性化，上游名零模块外引用延伸到模块名。** 集成层落中性目录与类型名（`session/loop_runtime/`、`LoopRuntime`），不携带 rig 或任何上游名——上游类型与上游名均不逃出集成层目录，下一次引擎替换的目录与类型名零改动。迁移三切片：集成层落地（离线可验、行为零变化）→ 接线换接（唯一行为变化点）→ yoagent 退役删除，单轨无双轨。

## Context

ADR-0107 将内置运行时实现形态从自写循环移交 yoagent（crates.io 0.18），当时已将「0.x 单一组织供应链」列为已知风险，以 minor 闸门 + Cargo.lock + revert 底线承接，并做过可替换性设计评审——`LoopOutcome` 契约、派发核签名、安全网全部留在 app 侧，换接成本收敛为集成层目录整体重写（约 3.5k 行含测试）。此后上游实证双协议线序缺陷：anthropic 批 `tool_result` 拆条（单调用批次恰好合法，故长期未暴露）与 openai thinking 回传丢弃，双协议均 400、无绕行；上游仓库为单人维护，修复延迟不可指望。候选集合：rig（8604 星、十余名常态贡献者、公司主体、发版活跃）、adk-rust（全栈平台形状）、fork yoagent（止血）。rig 经实测验证：批结果合并单条 `Message::User`、`reasoning_content` 原生支持、`PromptError` 变体结构化携带状态与历史、`DynamicTool` 运行时构造、client builder 开放 HTTP 客户端注入。

## Why

1. **供应链从记录在案变成现实压力**：单人仓库的任一上游缺陷修复延迟以月计，而 app 的轮次执行路径全部押在该依赖上；fork 止血能解一时但把维护承诺投向淘汰对象，与替换动机自相矛盾。
2. **可替换性投资直接兑现**：ADR-0107 评审确立的「契约在 app 侧、上游类型零模块外引用」使替换的爆炸半径收敛在单目录，越晚换契约面越漂移。
3. **缺陷面验收可直接平移**：上一轮诊断留下的红绿探针（拆分形状 400 同形 / 合并形状 200）转为 rig 侧回归测试钉，「rig 是否犯同病」成为持续哨兵而非一次性判断。
4. **结构化终态优于字符串协议**：rig 错误变体携带类型化字段（HTTP status、max_turns、终止原因、伴随历史），穷尽 match 由编译器强制——ADR-0107 留档的「终态推导匹配上游非公开措辞」脆弱点结构性消除。
5. **顺序与安全语义框架内建**：持久化历史恒按调用序（并发度无关），重定向策略可注入——两处此前依赖显式纪律的位置获得结构性保证。

## Considered options

- **fork yoagent 修缺陷止血（含上游 PR）**：向已决定淘汰的依赖投维护承诺，双线负担；替换照做则 fork 即弃。**否决**——直接替换，接受落地前的内置运行时阻塞期。
- **等待上游修复**：单人仓库修复延迟不可指望，生产阻塞无绕行。**否决**。
- **adk-rust**：全栈 agent 平台（会话编排、记忆、工件、部署面），其执行模型与「app 自持会话/物化/轨迹/审批」正面冲突，空挂成本最重；社区量级弱于 rig 一档。**否决**。
- **只用 rig-core 线协议客户端、循环回自写**：自写循环已随 ADR-0107 实现链退役，回退推翻其维护减负动机。**否决**。
- **经 `rig` 门面 crate 引入、默认 feature 全开**：门面默认面不受控（proc-macro、伴生 crate），与「依赖极轻」纪律冲突。**否决**——直引双 crate 并关默认 feature。
- **放权工具错误语义给 rig 的重试 / fail-fast 通道**：行为漂移——引入新终止形态，且与步数帽收敛机制互相虚增计数。**否决**——app 全量包装（本 ADR Decision 4）。
- **保留默认 HTTP 客户端 + 哨兵钉记录泄漏（先前姿势）**：客户端注入点存在后，接受已知凭据泄漏窗口失去必要性。**否决**——禁重定向注入（本 ADR Decision 6）。
- **纯 select 竞速取消（不经 hook）**：丢弃后拿不到上游错误通道，取消终态失去上游证据。**否决**——hook 检查点为主、select 兜底（本 ADR Decision 3）。

## Consequences

- **部分取代 ADR-0107**：其实现选型决策（yoagent crate、`ExecutionLimits` / `CancellationToken` 映射、接纳上游循环检测、重试交上游）被本 ADR 取代；其集成形态决策（每轮无状态全量窗口、工具面单一适配器走网关、轨迹完全等价、帽值与取消语义）**继承保留**——本次替换换实现、不动架构。
- **重定向处置反转**：先前以「上游实测不剥 `x-api-key`」为前提的哨兵钉（断言凭据送达已接受）随之改向为断言拒绝；BYOK 自定义端点若依赖跨 host 3xx 跳转将开始诚实失败，属收紧而非回归。
- **阻塞期**：替换落地前内置运行时双协议不可用（缺陷无绕行），以三切片节奏尽快收敛。
- **供应链**：rig 同为 0.x 且官方预告破坏性变更——minor 闸门 + Cargo.lock + revert 底线姿势不变；MSRV 保持 1.86（rig edition 2024 地板 1.85，余量一位），rig 升版顶穿 MSRV 的风险留档、触发再议。
- **可观测性**：上游 tracing 事件经 log feature 桥入 app 日志面——上一轮诊断靠 HTTP 调试行拼时间线的盲区不再。
- **留实施期**：注入 client 的泛型约束验证；rig 的 anthropic base-url 归一化与 app scheme 闸门的对齐；步数帽语义（模型调用预算）与既有行为契约的对齐钉；诊断探针回归钉（批 `tool_result` 合并、`reasoning_content` 回传）落地。
- **词汇表不动**：「内置运行时」语义（= app 进程内执行、由活跃 BYOK 档案驱动）不变，CONTEXT.md 无需修订。
