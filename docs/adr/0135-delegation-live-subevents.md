# 委派 live 子事件：tagged sink 转发、事件身份与 live-only 全文

## Decision

1. **live 子事件由 tagged sink 转发既有非 delta phase。** `run_subagent` 的 noop sink 替换为 tagged sink：子智能体事件 fold 产出的 `Thinking` / `ThinkingCompleted` / `ToolCallStarted` / `ToolCallCompleted` 原样转发，每条贴所属委派的 call id；`TextDelta` 滤除——轮文本的 live 面不流式，随 settle 的 `sub_rounds` 全量可见。审批卡既有通道不变（子面 dispatch 的 `origin` 标注，ADR-0117）。
2. **事件身份由起点铸造单一 id。** 委派 execute 入口铸 call id，贯穿 started/completed phase、每条子事件与落地条目；持久 `TraceEntry` 不携带——id 是纯 live 路由事实（LiveTurn 不入 thread cache 的既有边界），同名并行委派由此可路由。
3. **全文为 live-only。** 任务全文随 started phase、报告全文随 completed phase 到达前端，仅渲染于展开区；持久投影维持瘦身摘录（`TRACE_EXCERPT_MAX`），resume 后全文不可见——与成功摘录持久后清空（ADR-0036）同姿态。

## Context

委派运行期间前端唯一可见是委托行 spinner：`run_subagent` 以 noop sink 驱动子智能体的事件 fold，thinking / 轮文本事件按 `TurnPhase` 形状产生即被丢弃，仅审批卡 live 可见（子面 dispatch 的 `origin` 标注）；子代理的工具调用走宿主 dispatch 通路发射 phase，不在此列。并行批次上限 `DELEGATION_BATCH_CAP`（8）、运行可达分钟级，「在工作」与「卡死」不可区分。事件转发的基础设施已存在——子事件 fold 与主 fold 同构，thinking 两族 phase 本就在产生，缺口只是替换 noop；工具调用对不经 fold（dispatch 通路定稿时未携委派身份），其转发是后续接线。

## Why

1. **行内展开面是唯一子轨迹面**（ADR-0117 Decision 6）：live 尾窗与 settled `sub_rounds` 同构复用同一渲染，live→settle 只是数据续播，无第二呈现面；定稿时 live 只承载 thinking 两族，工具调用对随 `sub_rounds` 于 settle 显形（live 期间以无归属行浮于主轨）。
2. **转发即达**：thinking 两族事件已在产生，转发零 Rust 逻辑增量；「在干什么」由轮推进与 thinking 全文（折叠）覆盖，工具调用对的转发待 dispatch 通路携带委派身份后并入，过程性 prose 价值密度低。
3. **同名并行需要真身份**：`DELEGATION_BATCH_CAP`（8）下按名称与顺序的前端配对存在同名歧义，起点铸造是唯一干净解。
4. **全文与摘录是两个面**：240 字符摘录服务模型输入与持久审计，读者需要的任务书与终局报告是显示面事实——截断常数分设，持久契约不动。

## Considered options

- **全 delta 流式**：行内区导入主轨 prose 流式契约（caret / proseMode / 轮脚手架）只为过程性独白。**否决**——转发粒度已覆盖运行可见性，settle 后 prose 全量可见。
- **前端按名称与顺序配对**：与 usage 小计配对同型的手工配对，同名并行即歧义。**否决**——起点铸 id（Decision 2）。
- **全文进 recipe**：`TraceEntry` 加任务/报告字段。**否决**——破瘦身投影、`.duck` 膨胀，live-only 已满足显示面（Decision 3）。
- **逐委派中断**：per-delegation 取消令牌链 + 新 IPC + 部分取消语义裁决。**否决**——无使用场景支撑，整 turn cancel 覆盖现有场景。

## Consequences

- 行面状态芯片（单委托「step n」、批次聚合「N-of-M done, 1 running」）为纯前端派生，零协议增量。
- settle 换帧时展开态不存续（已知限制：展开收起、位置不变、重击展开即可）。
- resume 后展开区只渲染摘要 + `sub_rounds`，全文不可见且不报错。
- `TurnPhase::ToolCallStarted` / `ToolCallCompleted` 增字段为加性 wire 变更，`ipc_contract` 同步。
- `TextDelta` 滤除点收敛在 tagged sink 一处；轮文本落点事件留实施期可选。
- 拒绝臂（batch cap / 空任务）行为不变：失败行、无 phase 对、无子事件。
