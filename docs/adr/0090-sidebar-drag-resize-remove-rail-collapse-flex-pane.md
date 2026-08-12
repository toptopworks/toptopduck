# 前端 shell：sidebar + rail 可拖拽调宽 + 移除 rail collapse + 4-track grid slide pane 布局

## Decision

1. **Sidebar 改为可拖拽调宽。** Sidebar 宽度通过 pointer 事件驱动，clamp 到固定下限 + 上限范围内，前端 localStorage 持久化（非 app-config 字段）。宽度作为 CSS 自定义属性注入 shell 根元素，grid-template-columns + resize handle + settings overlay 均消费该变量。ADR-0054 Decision「rail 固定宽度，v1 不可拖拽调宽」退役。

2. **移除 thread rail collapse。** Rust 持久化模型（`ShellPrefs`）+ TS 状态层 + 组件层 + CSS 布局规则中的 rail collapse 状态、切换逻辑及相关 UI 全部删除。Rail 恒显；workspace fold（ADR-0083）成为 session pane 内唯一折叠机制。ADR-0054 Decision「rail 可折叠」+ Consequences「三级手动折叠」退役。

3. **Session pane 布局演进为 4-track grid slide。** Workspace fold 的双向动画要求布局属性可插值。旧双列 grid（固定长度 + flex 混合）不可插值，折叠方向 snap；中间曾迁回 flex row（conversation 列 + workspace flex sibling），但后续为支持 workspace 折叠时的居中布局（左右 spacer track）回到 4-track grid（spacer / conversation / workspace / spacer），全 track 使用 fr / minmax 单位保证双向可插值。QuestionBar 始终在 conversation 列内，宽度跟踪该列。

4. **Rail（conversation thread 列）也改为可拖拽调宽。** 镜像 sidebar resize 模式（Decision 1）：pointer 事件 hook + CSS 自定义属性注入 shell 根元素（与 sidebar 同模式）、session-body grid-template-columns 消费 + resize handle 消费。宽度全局共享（非 per-session）——切换 keep-alive 会话时不跳变。Rail 宽度**不持久化**——每次启动回到默认值（RAIL_DEFAULT_WIDTH=350），是临时布局调整；仅 sidebar 宽度持久化（localStorage）。MIN_WIDTH 下限保护 QuestionBar toolbar 不破位（submit 按钮固定尺寸不收缩 + auth chip 文本不换行 + provider / context trigger 固定方形，窄于下限时 submit 被挤出可见区；精确 px 值留实现期）。Handle 在 workspace 折叠时隐藏（4-track grid 重新布局用于居中，边界不再映射该变量）。

## Context

ADR-0054 定了 sidebar 固定宽 + rail 可折叠 + Tauri minWidth 兜底。两个前提在实践中发生了变化：

- **可拖拽调宽解决了固定宽的截断问题。** ADR-0054 否决了 resizable splitter，但 sidebar 承载会话列表，不同用户的会话命名长度差异大，固定宽导致频繁截断。可拖拽调宽以最小机制成本（一个 pointer 事件 hook + CSS 变量）解决了这个问题。
- **Rail collapse 的窄屏逃生口场景已被 workspace fold 覆盖。** ADR-0083 引入 workspace fold（workspace 面板默认折叠，rail 成为主面），已经覆盖了「窄屏让 rail 全宽」的核心场景。Rail collapse 与 workspace fold 是两套独立的折叠语义，共存使 CSS 交互复杂度上升（二者叠加时的 specificity 覆盖、QuestionBar 布局跨折叠态同步），而 rail collapse 的独立使用率不足以支撑这份复杂度。

同时，旧 grid 布局在 workspace fold 动画上有结构性缺陷：grid track 混合固定长度与 flex 单位时不可插值，折叠方向 snap；flex 的数值属性双向可插值，消除了 snap。

Rail 可调宽的前提也已成熟：本 ADR Considered options 原否决 rail 可调宽，理由是"固定宽截断语义"（ADR-0054）。ADR-0083 workspace fold 引入后，rail 宽度在折叠 / 展开态之间已大幅变化（展开时受 `--rail-width` 约束，折叠时扩展到更宽的居中上限），尾部 ellipsis 截断策略在可变宽下已正常工作——否决前提消解。

## Why

1. **可拖拽调宽而非固定宽**：sidebar 内容（会话名）长度用户可控且差异大；固定宽导致截断或留白。localStorage 持久化比 app-config 更轻量——宽度是纯 UI 偏好，非领域概念，不需要跨设备同步或 Rust 侧迁移。
2. **移除 rail collapse 而非保留**：workspace fold（ADR-0083）已覆盖窄屏逃生口场景；rail collapse 的独立价值不足以支撑两套折叠机制的 CSS 交互成本。移除后 CSS 规则减少、折叠语义单一化。
3. **4-track grid slide for pane 布局**：全 fr / minmax track 双向可插值，消除折叠方向 snap；4-track 结构（spacer / conversation / workspace / spacer）支持 workspace 折叠时 conversation 居中。中间 flex row 方案因无法表达居中布局而回退。QuestionBar 天然跟踪 conversation 列宽度。
4. **Rail 可调宽的前提变化**：本 ADR Considered options 原否决 rail 可调宽，理由是"固定宽截断语义"（ADR-0054）。ADR-0083 workspace fold 已经让 rail 宽度可变（fold 时 rail 扩展到远超展开态的居中宽度），尾部 ellipsis 截断策略在可变宽下已正常工作——否决前提消解。用户拖动只是把宽度控制权从 fold 状态机分一部分给用户，不引入新的可变性。

## Considered options

- **保留 rail collapse + 固定 sidebar（ADR-0054 现状）**：两套折叠机制共存使 CSS specificity 叠加规则复杂；固定 sidebar 宽度导致会话名截断。**否决**——维护成本高于 rail collapse 的独立价值。
- **Rail 可拖拽调宽而非 sidebar（二选一）**：sidebar 与 rail 各有可调宽需求，非互斥；sidebar 先行（Decision 1），rail 随后（Decision 4）。原否决理由"固定宽截断语义"已被 ADR-0083 workspace fold 消解（见 Why 4）。**否决（二选一框架）**。
- **Rail 宽度 per-session / 走 app-config 持久化**：per-session 导致切换会话时宽度跳变；app-config 对纯 UI 偏好过重（不需要 Rust 迁移 / 跨设备同步）。**否决**——全局宽度，不持久化（每次启动回到默认值），rail 宽度是临时布局调整而非持久偏好。
- **保留旧双列 grid pane 布局、仅修复 snap**：旧 grid 混合 length + flex 单位不可插值是 CSS 规范限制；4-track 全 fr / minmax 方案绕过了此限制同时支持居中。**否决**。

## Consequences

- **ADR-0054 部分退役**：Decision「rail 固定宽度，v1 不可拖拽调宽」+ Decision「rail 可折叠」+ Consequences「三级手动折叠」退役。截断策略（尾部 ellipsis）+ Tauri minWidth 兜底不受影响。
- **Sidebar 宽度持久化走 localStorage**（非 ADR-0038 app-config store）：宽度是设备本地 UI 偏好，不跨设备同步、不需要 Rust 迁移。与 app-config 的 `sidebar_collapsed` / `sidebar_grouping`（跨设备持久化的 shell 偏好）区分。
- **Tauri minWidth 相应调整**：新 minWidth = sidebar clamp 下限 + workspace 基础宽度（精确 px 值留实现期 / 视觉打磨）。
- **QuestionBar 不再需要跨折叠态布局覆盖**：移入 conversation flex column 后，其宽度天然跟踪 rail；旧 rail-collapsed 下 QuestionBar 跨列覆盖规则一并删除。
- **ADR-0083（workspace fold）不受影响**：fold 语义不变，仅动画机制从旧双列 grid track 固定长度切换变为 4-track grid 全 fr / minmax 数值切换。
- **Rail 宽度不持久化**：rail 宽度是临时布局调整，每次启动回到 RAIL_DEFAULT_WIDTH=350。仅 sidebar 宽度持久化（localStorage）。
- **Rail resize handle 在 workspace 折叠时隐藏**：折叠态 4-track grid 以居中为目的重布局，列边界不再映射该变量，handle display:none。
- **MIN_WIDTH 双层保护 QuestionBar toolbar**：conversation 列 CSS min-width + resize hook JS clamp 双层保护，防止拖窄至 submit 按钮（固定尺寸不收缩）被 auth chip（文本不换行）+ provider / context trigger（固定方形）挤出可见区。
- **被 ADR-0092 校准**：本 ADR Decision 3「QuestionBar 始终在 conversation 列内」精确化为「有活跃会话时在 conversation 列内，无活跃会话时居中于主区域（session header / rail / workspace 全隐藏，无 conversation 列）」。bar 上提 shell 级，宽度仍跟踪 conversation 列。见 ADR-0092。
