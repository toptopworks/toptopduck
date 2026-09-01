# 工作区结果面：退役末轮文本态与钉住旗，纯数据呈现

## Context

ADR-0062 R2 把工作区「结果」内容定为三态派生：末轮非物化（B/C/D）且未钉住时，工作区渲染末轮文本卡；`pinnedToHistory` 布尔旗仲裁 viewedResult 与末轮文本的压过关系。该设计的前提是 rail 侧只有结局编码（0047 glyph 卡）而无正文读面——ADR-0048 因此把澄清的读面钉在 workspace。

ADR-0103 把 thread 改为 chat 化投影：rail 渲染轮次全量内容——prose 恒展开、app 注解（active chip、outcome、stale、假设说明等）归 assistant 侧、Failed/Cancelled 单卡（原因 + 技术细节折叠）。rail 成为轮次内容的全量读面。

由此两个事实成立：

1. 工作区末轮文本卡与 rail 信息零增量——正文、app 注解、失败原因与技术细节折叠在 rail 全量可得。
2. B/C/D 轮不触发工作区展开（自动展开仅在 Materialized 时消耗，ADR-0083）；默认折叠姿态下该卡不可见，而澄清流照样成立——用户读 rail、答 QuestionBar，ADR-0048 的闭环依赖 QuestionBar，不依赖此卡。

## Decision

退役末轮文本派生态与 `pinnedToHistory` 布尔旗；工作区「结果」面收敛为纯数据两态派生：

- viewedResult ≠ null 且载荷可自 thread 解析 → 显该结果的图 + 表（ADR-0062 R4 布局不变）；
- 否则 → hero 空态（ADR-0061 / 0083 语义不变）。

工作区对 B/C/D 轮无反应：非物化轮次既不移动 viewedResult、也不改变工作区内容。viewedResult 的移动事件均为既有（点选时间线 Materialized 卡、产出即选中，0047/0051/0062 所定），本 ADR 不增不减。

轮次内容的读面统一归 rail；澄清 / 纠偏流不变（ADR-0048：读 rail、答下一条 QuestionBar、无新原语）。

## Why

1. **信息零增量**——ADR-0103 之后，工作区文本卡不携带任何 rail 没有的内容；双份渲染只产生两个必须同步维护的面。
2. **默认姿态不可见**——B/C/D 轮不展开工作区，默认折叠下该卡不在任何流的关键路径上。
3. **名实相符**——「结果」tab 只渲染数据结果；非物化轮次是对话事件，归回对话列，消除 tab 语义异物。
4. **仲裁旗失去所指**——`pinnedToHistory` 的唯一作用是仲裁末轮文本与 viewedResult 的压过关系；文本态退役后该旗无可观察效果，随同退役避免死状态留存。

## Considered options

- **保持现状，接受双份渲染**：宽栏阅读是唯一增量，但默认折叠姿态下不成立，且同步维护成本随 rail 投影演进而增长。**否决**。
- **保留文本卡并加信息增量**：工作区卡上补动作；quick-reply 形态已为 ADR-0048 否决，无与既有决策不冲突的增量可加。**否决**。
- **B/C/D 轮清空 viewedResult 回 hero**：失败轮抹掉用户正在查看的结果视图，破坏性过强。**否决**。

## Consequences

- ADR-0062 R2 三态派生收敛为两态；`pinnedToHistory` 退役（R5 resume 初始化中 `pinnedToHistory=false` 条款随之失效）。
- ADR-0048「workspace 文本载荷卡显示澄清问题」条款失效；澄清读面归 rail，流程闭环不变。
- 时间线历史结果的点选语义简化：仅移动 viewedResult，结果持续展示直至新 Materialized 轮或另一次点选；不存在钉住状态，「当前展示的是不是最新结果」为派生事实而非状态。
- 工作区不再对对话事件做出反应；hero 是唯一非数据呈现态。
- CONTEXT.md 不动：无领域词增减，纯 UI 状态派生变更。
