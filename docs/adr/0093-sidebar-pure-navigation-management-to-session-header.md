# 会话栏纯导航化：管理操作迁入 session-header + 行信息改 HoverCard 浮层

## Decision

会话栏（`SessionSidebar`）每行从「导航 + 管理 + 信息」三角色收缩为**纯导航**，三个维度同步调整：

1. **管理操作移入 `.session-header`。** Rename / Save a copy / Close / Delete 从侧边栏行的 `⋯` 弹菜单迁入 `SessionPane` 的 `.session-header`——会话名称后新增 `⋯` 按钮 → Radix `DropdownMenu`（图标 + 标签格式）。侧边栏行不再承载任何管理入口。

2. **行信息从常驻子行改为 HoverCard 浮层。** 移除常驻子行（首源名 + 轮次数），元信息（完整标题 / 数据源 / 轮次数 / 最近修改）经 Radix `HoverCard` 浮层在 hover + focus 时展示——右侧定位、固定宽度、键值对布局。

3. **行状态视觉简化。** `MessageSquare` 行首图标替换为**条件状态圆点**——已打开（绿）/ pending approval（warning）/ 未打开（无，等宽占位保持对齐）；移除所有竖条样式（`shadow-[inset_2px_0_...]`），active 状态仅用 accent 背景表达。

## Context

ADR-0060 行 75 将首源名 + 轮次数 + 修改时间作为常驻子行、行 77 将命名 / 删除 / 关闭操作放在侧边栏行的弹菜单中；ADR-0072 引入 `MessageSquare` 行首图标、active 态 accent tint + 左 2px 竖条。行同时承载导航（点击切换）、管理（`⋯` 菜单）、信息展示（子行）三种角色，视觉密度高。
管理操作在侧边栏行的前提是「所有会话都有管理入口」——但用户的工作焦点始终是当前激活会话。ADR-0073 已为每会话建立了 session-scoped chrome 带（`.session-header` 承载名称 + rail toggle），管理操作作为 session-scoped chrome 的自然延伸归入同一带，使操作发生在工作焦点处。

## Why

1. **导航与管理职责分离**：侧边栏列所有会话（导航），`session-header` 只对当前会话（管理）。操作发生在工作焦点处，侧边栏回归纯列表 + 切换角色。
2. **降低行视觉密度**：常驻子行 + 图标 + 竖条 + `⋯` 按钮使每行承载过多信号。纯标题行 + 条件圆点提升列表可扫读性，更多信息经 hover 按需获取。
3. **延伸 ADR-0073**：0073 已将 session-scoped chrome（名称 + rail toggle）迁入 `.session-header`；管理操作作为同域 chrome 归入同一带，归属内聚。
4. **HoverCard 覆盖鼠标与键盘**：Radix HoverCard 在 focus 时也触发（Tab 到行即展示），触屏退化为长按；比常驻子行更灵活，比纯 CSS hover 更可访问。

## Considered options

- **侧边栏行保留 `⋯` 上下文菜单 / 行内 hover 操作按钮**：行同时承载导航 + 管理，视觉密度不变；hover 按钮（pin + delete）中 pin 需 recipe 格式变更 + IPC + 排序逻辑（独立决策），单留 delete 与 header 菜单重复。**否决**——职责分离后行更简洁；pin 落地时行内操作按钮随之一并回归。
- **HoverCard 用 Tooltip / Popover 原语**：Tooltip 是纯提示性，不支持结构化键值对内容；Popover 需点击触发，不符合「鼠标放上去即出」的交互预期。**否决**——HoverCard 支持富内容 + hover/focus 双触发。
- **浮层显示完整数据源列表**：当前 `SidebarEntry` 仅有首源名 + 源总数，完整列表需新增 IPC。**否决**——首源名 + 总数满足快速辨识，完整列表留后续。
- **未打开会话保留行内管理入口**：侧边栏行继续承载管理角色，视觉密度不变；且单独的 delete 按钮与 header 菜单重复，`⋯` 菜单也与 header 菜单构成双入口。**否决**——接受「先点开再管理」的路径取舍，重命名 / 删除 / 导出已关闭会话频率低。
- **行首保留 MessageSquare 图标 / active 保留竖条**：图标 + 圆点并存视觉冗余；竖条 + 背景双重信号冗余。**否决**——圆点直接表达状态，accent 背景单独表达 active。

## Consequences

- **校准 ADR-0060（部分）**：行 77（左栏条目弹菜单命名 / 关闭 / 删除）——管理操作迁出侧边栏进 `session-header`；行 75 闭合项（副行 = 首源名 + 轮数 + 修改时间）——常驻子行移除，元信息改 HoverCard 浮层。
- **校准 ADR-0072（部分）**：active 态左 2px inset 条（行 9 / Consequences 视觉一致性）——移除，仅保留 accent 背景；`MessageSquare` 行首图标——替换为条件状态圆点。
- **延伸 ADR-0073**：`.session-header` 从「名称 + rail toggle」扩展为「名称 + 管理菜单（`⋯` → DropdownMenu）+ rail toggle」；需从 App 向 `SessionPane` 传入操作回调 + session 的 `.duck` path（当前 `SessionPaneProps` 不含 path）。
- **新增 shadcn copy-in 组件**：`DropdownMenu`（Radix）+ `HoverCard`（Radix）；项目此前未引入这两个原语。
- **置顶（pin）延后**：pin 需 recipe 格式变更 + IPC + 排序逻辑 + `format_version` bump，为独立架构决策；落地时侧边栏行内 hover 操作按钮（pin + delete）随之回归。
- **CONTEXT.md 不动**：侧边栏视觉 / 交互调整是 UI chrome 实现，非领域术语（遵循 ADR-0060 行 73 / 0072 行 46 / 0073 行 42 先例）。
