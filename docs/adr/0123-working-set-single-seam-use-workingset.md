# 工作集存取收敛：useWorkingSet 单一接缝

## Decision

1. **工作集域收敛为单一 hook 接缝 `useWorkingSet(sessionId, selectedName, surfaces)`。** 查询（workingSet / active / previewRows）、四类变更（rename / replace / delete / privacy）、删源确认状态机（pendingActiveDelete）、详情选中解析（pick ?? active ?? 首项）与样本预览门控同属一个 module（`src/session/useWorkingSet.ts`）。级联语义的权威叙述（三键扇出、previewRows 嵌套前缀继承、staleTime Infinity 下替换源旧行不残留、门控键 = 解析后的 pick）随 module 头注释落位，不再散落在 query 键工厂注释与组件门控多处。

2. **selected 参数化，useState 留在消费组件。** 接缝不拥有选中状态：消费组件持有 pick 的 useState 并以参数传入，接缝只拥有解析与回退。跨目录 import（组件目录引 session 接缝）沿用 query 键工厂的既有先例。

3. **失效级联私有、不按 kind 分化，变更级联对外仅单一入口。** 三键扇出（workingSet + active + thread）是 module 内一个无参分化的函数——四类变更没有分化证据，kind 只在错误包装层作动词前缀。ingest（useIngestFlow）保持独立编排，作为该级联的失效消费者：refreshServerState 的扇出核收编进 module，错误标注留在消费侧各自的 error 面。校准：轮末刷新是对外的第二入口——轮次结束已乐观写入 thread 缓存（ADR-0051），再失效 thread 会以陈旧/空数据冲掉乐观追加，故该入口只刷工作集键；两入口的键清单在 module 内单点派生（全级联 = 工作集键 + thread），级联集增键仍单点生效。轮末入口是读写语境之别，不是按变更 kind 的分化。

4. **删源确认对话框随状态机落工作集侧。** ActiveSourceDeleteDialog 的挂载与 pendingActiveDelete 状态机同侧（工作集容器内），SessionPane 的 hoisting 退役；pane 对工作集面退为渲染壳，仅余会话寻址、跨域 busy 门、空态 ingest 入口与变更上报面（mutation surfaces，注入 sink——useIngestFlow deps 的同形先例）四项 props。四类变更的错误横幅、busy 并集与持久化轮询经上报面写回 pane 级状态：横幅条带在两个 tab 面板之外渲染，变更失败无论当前所在 tab 恒可见。

## Context

工作集的查询、变更与失效知识此前分散四层：四类变更回调与删源状态机的确认/中止操作从 useSessionState 的三十余字段返回面穿 SessionPane 转发进工作集组件；失效级联的唯一叙述是 query 键工厂的 doc 注释，执行散在 useSessionState 的 refreshServerState、SessionPane 的 resetSessionCache 与组件门控多处；删源一个用户动作横跨四模块（状态机在 useSessionState、对话框挂载与 hoisting 在 SessionPane、触发在列表、回退恢复规则在 workspace 纯函数）。近三张工作集票的修复面都横穿这条 relay。

## Why

1. **变更知识的唯一属主使修复面收敛。** 连续数张工作集票都要在 relay 的每一层同步理解同一变更；单接缝把理解成本压回一处。
2. **选中是渲染关注点，不是接缝不变量。** pick 的生命周期（种子、用户点选、随删除回退）一半属于渲染壳、一半属于解析规则；参数化让两侧各持其半，接缝的回退解析可独立钉测。
3. **失效级联无分化证据。** 四类变更跑同一无参扇出；按 kind 标签化会把假接缝引入失效层。
4. **ingest 是编排域不是工作集域。** guidance 停靠、批次续跑与失效是两种节奏；并入会让接缝同时承载两套状态机。

## Considered options

- **useSessionState 继续集中拥有工作集字段**：god-seam 返回面持续膨胀，即本决策要收敛的现状。**否决**。
- **SessionPane 调用接缝后下传**：选中参数与 useState 归属冲突，且 relay 只是换形。**否决**。
- **失效按 kind 分化标签**：四类变更无行为差异，标签化是假接缝。**否决**。
- **ingest 并入接缝**：承载 guidance 状态机后接缝不再单一职责。**否决**。
- **对话框留在 pane、经回调上提状态**：hoisting 与转发以回调形式回归。**否决**。

## Consequences

- 变更横幅、busy 并集与持久化告警保持 pane 级渲染（条带双 tab 恒可见）；接缝不拥有跨域 UI 状态，经注入 sink 上报。busy 经 props 回流，工作集按钮对 turn / ingest / 工作集变更三域执行窗的禁用语义与 rail 重试、重跑的禁用门均不变。
- useSessionState 瘦身为 turn-flow 编排；workingSet / active 两查询的接线单点落在接缝 module 的只读切片，pane 侧（rail 徽章 / Targets chip / 错误聚合 / hero 判空）消费该切片。
- 权威测试落 hook 层（级联、删源状态机、回退门控）；组件层只留渲染契约。
- resetSessionCache（错误边界 + notify-manager 时序承重）与 ResultView 分页行读取不动，留待各自独立裁决。
