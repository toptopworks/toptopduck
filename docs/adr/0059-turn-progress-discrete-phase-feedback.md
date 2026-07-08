# turn 渐进反馈：离散阶段 event（turn-progress）+ callback 注入 turn_runner + 长 listener + 独立 UI 态

## Decision

ask 阻塞期（LLM HTTP ≤120 s + SQL ≤10 s，ADR-0021）给非技术用户（ADR-0001）的渐进反馈定下四块，**不开 LLM token 流式**（0051 Q5 punt）：

**（1）离散阶段 event 通道（C-1）**
- 新增 `turn-progress` Tauri event（侧通道），发**离散阶段标记**，非百分比——LLM HTTP + SQL 两段主等待都无内在连续进度，离散是唯一诚实粒度（守 ADR-0017）。
- 复用 `resume-progress`（ADR-0034，`api.ts:189`）先例，同形 Tauri event。
- ask 仍阻塞返回 outcome（ADR-0009 契约不变），event 不进契约载荷。

**（2）callback 注入 turn_runner（C-2）**
- `TurnRunner::run()` 增 `on_phase: Box<dyn Fn(TurnPhase) + Send>` 参数，在阶段边界调用：
  - `provider.generate` 前（`turn_runner.rs:155`）→ `TurnPhase::Thinking { attempt }`
  - `try_materialize` 前（`turn_runner.rs:193`）→ `TurnPhase::Querying { attempt }`
- `attempt` 从 retry loop（`turn_runner.rs:147`）带出，诚实反映 blind retry。
- emit 实现在 **commands 边界构造**（持 `AppHandle` → emit `turn-progress`），经 `Session::ask`（`mod.rs:1516`）透传注入 `run()`。领域层（session/turn_runner）不碰 Tauri 句柄（守 ADR-0029）。
- **延续 ADR-0053 注入风格**——materializer 已是 `Box<dyn>` 注入，callback 同形；turn_runner 不持有 emit 实现，仍 pure orchestration（不读 history、不调 persist 不变）。测试传 no-op callback，5 routing-branch 单测零改动。

**（3）前端独立 UI 态（C-3）**
- phase 持有走 **0051 客户端 UI 态**（`SessionPane` 内 `useState<TurnPhase | null>`），**不进 TanStack Query / thread cache**——thread 是完成 `TurnRecord` 真相，phase 是"进行中"提示，塞进去污染单一真相 + 生命周期错位。
- 复用 `resumeStatus` 模式（`App.tsx:135,712-729`）：listener → setPhase、完成 → clear。
- per-tab 分片：每 SessionPane 独立 phase，契合 ADR-0056 会话内单飞行。

**（4）长 listener 随 SessionPane 挂卸（C-4）**
- listener 在 `SessionPane` mount 时 `listen` 一次（按 sessionId 过滤），unmount 时 `unlisten`——**复用所有 turn**，非 per-turn listen。
- 收尾契约：outcome 返回（含 Cancelled）→ `handleAsk` finally `setPhase(null)`（同 `setLoading(false)` 位置，`App.tsx:624`）；关 tab（ADR-0055）→ SessionPane 卸载 cleanup `unlisten` + phase 随卸载销毁，in-flight turn 后台孤儿 event 无 listener 丢弃、无害。
- **`turn-progress` event 带 sessionId**（ADR-0056 寻址延伸；`resume-progress` 不带是 v1 单会话遗留，多会话落地一并补）。

## Context

ADR-0009（阻塞式 ask）+ 0021（软取消 ≤120 s）+ 0053（TurnRunner pure orchestration）定了 ask 的执行管道，但**阻塞期的用户反馈从未被决策**——`App.tsx` 仅一个 `loading` flag（`:105`）+ spinner，非技术用户面对最长 120 s 空白 = "是不是坏了"。ADR-0051 Q5 把"流式"punt 为未来项但只讲 LLM token，**未定义执行反馈架构**。本 ADR 收口渐进反馈，跨前后端：后端 event 机制（C-1/C-2）+ 前端消费（C-3/C-4）。

关键代码事实：ask 阶段离散（`turn_runner.rs:155` `provider.generate` / `:193` `try_materialize` 是真实边界），离散标记诚实可行；两段主等待无连续进度，百分比不可行（违 0017）。

## Why

1. **ADR-0001 硬痛点**——"思考中/查询中"比空白 spinner 显著降焦虑，非技术用户可感知性一档提升。
2. **离散是唯一诚实粒度**——LLM HTTP + SQL 都无连续进度；后端边界真实（`turn_runner.rs:155/193`），标记精确对应阶段，不发造假百分比（守 0017）。
3. **复用 resume-progress 先例**——Tauri event 通道已验证，零新机制。
4. **callback 注入守 0053 pure orchestration**——延续 materializer `Box<dyn>` 注入风格，turn_runner 不硬编码 emit；测试传 no-op，纯净性零退化。
5. **不进 thread query 守 0051 单一真相**——thread 是完成 `TurnRecord` 真相，phase 是进行中提示，生命周期不同构。
6. **长 listener 避 per-turn 竞态**——turn 高频，per-turn listen（resume 模式）放大 H5 类 subscribe-before-ask 竞态（`App.tsx:707-712`）+ 每 turn IPC；长 listener 一次挂零竞态。
7. **关 tab 收尾契合 0055**——SessionPane 卸载自动 unlisten + state 销毁，后台孤儿 event 无害，无需额外处理。

## Considered options

- **不开发通道（维持 spinner）**：非技术用户 120 s 空白焦虑。**否决**。
- **LLM token 流式（真进度）**：违 0051 Q5 punt + 改 ask 阻塞契约（ADR-0009）。**否决**——离散阶段标记是侧通道，契约不变。
- **拆 run() 让 session 上层发 event**：违 0053 line 5"路由收在 TurnRunner"，让 facade 承接 retry/cancel 路由。**否决**。
- **provider/materializer trait 各自发 event**：污染 trait 抽象（违 0053 line 7/46）+ 让底层知道 UI 关注。**否决**。
- **并入 0051 thread query（setQueryData）**：污染 thread 单一真相 + 生命周期错位（phase 随 turn 生灭、thread cache 保留）。**否决**。
- **独立 event store（reducer/Context）**：一个临时 enum 用 useState 够，过度（YAGNI），违 0051"不引 store"。**否决**。
- **per-turn listen（复制 resume 模式）**：turn 高频放大 H5 竞态 + 每 turn IPC。**否决**。
- **全局 listener（App 顶层）按 sessionId 路由**：跨组件路由 phase 到 SessionPane setter，比 per-SessionPane listener 复杂。**否决**。

## Consequences

- **后端**：`TurnRunner::run()` 签名增 `on_phase` 参数；`Session::ask`（`mod.rs:1516`）增 callback 透传；commands 边界 `ask` 构造 emit callback（持 `AppHandle` → emit `turn-progress`）。新增 `TurnPhase` enum（`Thinking{attempt}` / `Querying{attempt}`），序列化跨 IPC。
- **前端**：`SessionPane` 内 `phase: TurnPhase | null` useState + 长 listener（mount listen / unmount unlisten，按 sessionId 过滤）；QuestionBar 渲"思考中（第 N 次）/查询中"；`handleAsk` finally `setPhase(null)`。
- **延伸 ADR-0053（小）**：`run()` 增 `on_phase` 注入参数——延续其注入精神（不硬编码副作用、测试传 no-op 保纯净），不违字面（仍不读 history、不调 persist）。0053 待追加反向指针。
- **延伸 ADR-0051**：渐进反馈走客户端 UI 态（非 Query），闭合 Q5"流式"punt 的执行反馈子项（token 流仍 v2）。
- **延伸 ADR-0056**：`turn-progress` event 带 sessionId；`resume-progress` v1 不带是遗留，多会话落地一并补 sessionId 寻址。
- **延伸 ADR-0055**：关 tab in-flight 的 phase/listener 收尾与"立即卸前端 + 后台丢弃"一致，无需额外处理。
- **CONTEXT.md 不动**：渐进反馈是实现/UX 决策，不引入新领域术语。
- **出口保留**：LLM token 流式（真进度）若成刚需，走 0051 Q5 已 punt 的流式通道（改 ask 契约）；届时 `turn-progress` 可扩 `Streaming{tokens}` 变体。
