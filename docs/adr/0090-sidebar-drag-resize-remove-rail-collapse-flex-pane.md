# 前端 shell：sidebar 可拖拽调宽 + 移除 rail collapse + flex pane 布局

## Decision

1. **Sidebar 改为可拖拽调宽。** Sidebar 宽度通过 pointer 事件驱动，clamp 到固定下限 + 上限范围内，前端 localStorage 持久化（非 app-config 字段）。宽度作为 CSS 自定义属性注入 shell 根元素，grid-template-columns + resize handle + settings overlay 均消费该变量。ADR-0054 Decision「rail 固定宽度，v1 不可拖拽调宽」退役。

2. **移除 thread rail collapse。** Rust 持久化模型（`ShellPrefs`）+ TS 状态层 + 组件层 + CSS 布局规则中的 rail collapse 状态、切换逻辑及相关 UI 全部删除。Rail 恒显；workspace fold（ADR-0083）成为 session pane 内唯一折叠机制。ADR-0054 Decision「rail 可折叠」+ Consequences「三级手动折叠」退役。

3. **Session pane 布局从 grid 迁移到 flex。** Workspace fold 的双向动画要求布局属性可插值；grid track 混合固定长度与 flex 单位时不可插值（折叠方向 snap），flex 的数值属性双向可插值。Pane 内部从 grid 双列改为 flex row：conversation 列（rail + questionbar）+ workspace flex sibling。QuestionBar 移入 conversation 列，宽度始终跟踪 rail。

## Context

ADR-0054 定了 sidebar 固定宽 + rail 可折叠 + Tauri minWidth 兜底。两个前提在实践中发生了变化：

- **可拖拽调宽解决了固定宽的截断问题。** ADR-0054 否决了 resizable splitter，但 sidebar 承载会话列表，不同用户的会话命名长度差异大，固定宽导致频繁截断。可拖拽调宽以最小机制成本（一个 pointer 事件 hook + CSS 变量）解决了这个问题。
- **Rail collapse 的窄屏逃生口场景已被 workspace fold 覆盖。** ADR-0083 引入 workspace fold（workspace 面板默认折叠，rail 成为主面），已经覆盖了「窄屏让 rail 全宽」的核心场景。Rail collapse 与 workspace fold 是两套独立的折叠语义，共存使 CSS 交互复杂度上升（二者叠加时的 specificity 覆盖、QuestionBar 布局跨折叠态同步），而 rail collapse 的独立使用率不足以支撑这份复杂度。

同时，旧 grid 布局在 workspace fold 动画上有结构性缺陷：grid track 混合固定长度与 flex 单位时不可插值，折叠方向 snap；flex 的数值属性双向可插值，消除了 snap。

## Why

1. **可拖拽调宽而非固定宽**：sidebar 内容（会话名）长度用户可控且差异大；固定宽导致截断或留白。localStorage 持久化比 app-config 更轻量——宽度是纯 UI 偏好，非领域概念，不需要跨设备同步或 Rust 侧迁移。
2. **移除 rail collapse 而非保留**：workspace fold（ADR-0083）已覆盖窄屏逃生口场景；rail collapse 的独立价值不足以支撑两套折叠机制的 CSS 交互成本。移除后 CSS 规则减少、折叠语义单一化。
3. **Flex 而非 grid for pane 布局**：flex 数值属性双向可插值；grid 混合 length/flex 不可插值。消除折叠方向 snap，且 QuestionBar 天然跟踪 conversation 列宽度。

## Considered options

- **保留 rail collapse + 固定 sidebar（ADR-0054 现状）**：两套折叠机制共存使 CSS specificity 叠加规则复杂；固定 sidebar 宽度导致会话名截断。**否决**——维护成本高于 rail collapse 的独立价值。
- **Rail 可拖拽调宽而非 sidebar**：rail 承载单行逐字卡（固定宽截断策略 ADR-0054），可变宽会破坏截断语义；sidebar 承载会话列表，可变宽收益更高。**否决**。
- **保留 grid pane 布局、仅修复 snap**：grid 的 length ↔ flex 不可插值是 CSS 规范限制，无法绕过（只能用近似值或接受 snap）。**否决**。

## Consequences

- **ADR-0054 部分退役**：Decision「rail 固定宽度，v1 不可拖拽调宽」+ Decision「rail 可折叠」+ Consequences「三级手动折叠」退役。截断策略（尾部 ellipsis）+ Tauri minWidth 兜底不受影响。
- **Sidebar 宽度持久化走 localStorage**（非 ADR-0038 app-config store）：宽度是设备本地 UI 偏好，不跨设备同步、不需要 Rust 迁移。与 app-config 的 `sidebar_collapsed` / `sidebar_grouping`（跨设备持久化的 shell 偏好）区分。
- **Tauri minWidth 相应调整**：新 minWidth = sidebar clamp 下限 + workspace 基础宽度（精确 px 值留实现期 / 视觉打磨）。
- **QuestionBar 不再需要跨折叠态布局覆盖**：移入 conversation flex column 后，其宽度天然跟踪 rail；旧 rail-collapsed 下 QuestionBar 跨列覆盖规则一并删除。
- **ADR-0083（workspace fold）不受影响**：fold 语义不变，仅动画机制从 grid track 切换变为 flex 数值切换。
