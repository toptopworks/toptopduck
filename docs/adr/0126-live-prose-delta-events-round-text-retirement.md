# 回合正文事件：delta 粒度直通、RoundText 退役

## Decision

1. **`TurnPhase` 新增 `TextDelta { delta }`，流内正文逐 delta 直通。** 四条 runtime 路径（rig fold / claude stream-json / codex / ACP-native）在正文片段到达即 `emit_phase`，不合并、不定窗。外部三条共用 `RoundTracker::push_prose` 一个累积 seam（一处落点覆盖三条），rig fold 自成一处在 batch 确认前。delta 不带 round 定位：隐式归属当前轮（前端 `live.step ?? 1`，与 `RoundText` 既有语义同款）——`PhaseSink` 为同步回调、单通道 FIFO 保序，且 fold 的 `open_call` 保证每个轮次首个 item 先发 `Thinking`，delta 必然落在 step 已知之后。

2. **`RoundText` 退役。** `TextDelta` 成为唯一正文事件；batch 确认处不再发正文事件（rounds 构建沿用既有 `text_deltas` 聚合），轮次收口由既有 `ToolCallStarted` 天然标记。终端轮（纯文本收尾，无 ToolCall 确认）的 delta 自然流出，turn 结束随 settle 收敛——该轮由此首次获得 live 文本。

3. **发送侧零状态零 flush，频率治理下沉消费侧。** 攒批窗口状态机不进后端（各路径的 turn 结束 flush / cancel flush / 窗口残留均为事故面）。若实测前端渲染吃紧，在 `onTurnProgress` 消费口做时间窗合并——一处改动、协议不动，作为预留后手而非本期交付。

4. **settle 投影按 outcome 分叉，镜像后端 settle 语义。** 携带终端文本的 outcome（Textual/Materialized 的 body）下，尾轮 call-less round 的 prose 不进 optimistic `TurnRecord.trace`——正文随 outcome 渲染，镜像后端 settle 对 Text 终止的清理（清空且空轮弹除）；Cancelled/Failed 保留尾轮 prose——外部三路径的权威 trace 记录未 seal 的半截正文（issue #628 的诊断价值裁决），投影与之对齐以防 turn-end refresh 后文本二次变化（rig fold 的未确认轮文本不落 rounds，为该路径既有 durable 差异，见 Decision 5）。live 半截正文在 settle 换脸时保留，refresh 落同一 round。

5. **两项不在 v1 范围。** thinking/reasoning 不做 delta（`ThinkingCompleted` 维持一次性到达）；cancel 时的未 seal prose 落权威 trace 与否维持各路径现状（外部路径记录、rig fold 不记），统一该语义是 durable 变更，超出正文流式呈现的目标面。瞬态通道不落库、同体部署零版本偏斜，两者皆可纯加法补做，真实诉求落地时各自另裁。

## Context

回合正文（`RoundProse`）长期无流式观感：`TurnPhase` 只有 round 粒度的 `RoundText`（一轮合并全文一次），四条路径一致——rig fold 把正文片段累积到 batch 确认才发；外部三条路径（claude stream-json / codex / ACP-native）的正文 chunk 经共享 `RoundTracker` 累积、首个 tool call 触发的 `fire_round_prelude` 一次性发整段；终端轮更是零 live 正文事件，最终答案只随 settle 的 `TurnRecord` 整体出现。前端接收端（streamdown streaming 模式与 caret）已就绪，始终无增量输入。`RoundText` 事件协议此前未经 ADR 裁决（通道与事件族出自 ADR-0059，其轮次分组与连接话语的展示语境见 ADR-0078/0103）。

## Why

1. **逐 delta 直通是四家 harness 的无分歧形态。** ZCode（`row.delta` 追加 op，落库流逐 token，节流仅在派生 fan-out 250ms）、codex（`AgentMessageDelta` 通知，消费侧重放缓冲做相邻合并）、deepseek harness（`assistant-stream` 的 `start/chunk/end` 逐帧，渲染层增量消化）——无一家在发送侧设时间窗；频率治理全部下沉消费侧或渲染层。

2. **瞬态通道无逐条保真义务，同体部署无偏斜窗口。** `turn-progress` 为观察反馈（不进 `TurnOutcome` 契约），权威文本唯一来源是 settle 的 record；Tauri 单体使 Rust 协议端与前端同生共死——旧事件可直接退役、新字段可随时追加，均零迁移。三家带定位字段皆因存在 gap 检测/重连/落库重放需求，此处不存在该面。

3. **投影对齐优于事后对账。** optimistic append 的契约是「与后端将记录的一致」；投影携带后端不会记录的文本，等于制造一个 refresh 后必回缩的差异——回缩发生在网络往返之后，观感为缺陷。

## Considered options

- **后端时间窗攒批**：窗口状态机须进后端（turn 结束 flush、cancel flush、窗口残留各成坑，路径数即倍数），直通为零状态单点；频率封顶可在消费侧以更小代价达成同等效果。**否决**。
- **`TextDelta` 带显式 step 定位**：同步 sink 加单通道 FIFO 下漂移面不存在，同语义的 `RoundText` 无漂移先例；定位字段解决的是此处没有的重放/重连问题。**否决**。
- **`RoundText` 保留为 batch seal 对账快照**：seal 全文与前端 delta 累积的逐字节一致成为新不变量义务；其纠偏目标（单帧丢失）在进程存活时不存在，webview 重载时 seal 事件同样全丢（liveTurn 整体重置、refresh 收敛）。**否决**。
- **thinking/reasoning delta 同期交付**：折叠态的增量展示策略是独立 UX 决策面，混入则协议票胀为协议加 UX 票；协议可后补纯加法。**否决（v1）**——压力真实再扩。
- **cancel 未 seal prose 落权威 trace**：durable 语义变更，超出正文流式呈现的目标面，其取舍独立裁决。**否决（v1）**。

## Consequences

- 流内正文含终端轮答案在 turn 进行中逐 delta 可见；streamdown streaming 模式（caret、word cascade）首次获得真实增量输入。
- 协议端与前端 union 同票原子迁移：`RoundText` 退役后任一路径未迁即该路径正文完全消失，不存在可分批的中间态；外部三路径经 `RoundTracker` 单点收编，迁移面为该 seam 加 rig fold 两处。
- Cancelled/Failed turn 的 live 半截正文经 settle 投影保留，与外部路径的权威 trace 一致，refresh 后无二次变化；rig 路径 cancel 与 hook 重试弃置轮的未确认文本不落权威 trace，settle 换脸后 refresh 回缩——该路径既有 durable 差异（Decision 5）；rig 路径终端轮的 delta 累积与 `FinalResponse.output` 的同源性无结构保证（外部三路径的正文与终端文本同源聚合，天然一致），不同源的差异由 fold 侧收敛义务覆盖。
- 消费侧节流为预留后手，启用判据为实测渲染表现，不改变协议语义。
- `ipc_contract`、`useTurnFlow`、thread 组件测试面随语义更新；`turn-progress` 事件基数由 round 级升至 delta 级（仅瞬态通道，不落数据库）。
- **校准 ADR-0059**：开篇「不开 LLM token 流式」与 Considered 的「LLM token 流式」否决项按其出口保留条款兑现——`TextDelta` 走既有 `turn-progress` 侧通道（ask 阻塞契约与 ADR-0009 不变，phase 不进 thread 真相与 ADR-0051 不变），形态为逐条载荷事件流而非该条款设想的一体计数变体；「离散是唯一诚实粒度」（守 ADR-0017）针对虚构进度估计，真实增量载荷流不受其限。
