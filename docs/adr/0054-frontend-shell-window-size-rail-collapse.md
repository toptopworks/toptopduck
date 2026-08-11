# 前端 shell 窗口尺寸策略：rail 固定宽 + 可折叠 + Tauri minWidth 兜底 + 尾部 ellipsis 截断

> 部分被 [ADR-0090](./0090-sidebar-drag-resize-remove-rail-collapse-flex-pane.md) 取代：Decision「rail 固定宽度，v1 不可拖拽调宽」+ Considered options「rail 可拖拽调宽（resizable splitter）：v1 YAGNI…否决」**退役**——sidebar 改为可拖拽调宽（clamp 到固定下限 + 上限，localStorage 持久化）。Decision「rail 可折叠」+ Consequences「三级手动折叠」**退役**——rail collapse 移除，rail 恒显；workspace fold（ADR-0083）成为 session pane 内唯一折叠机制。截断策略（尾部 ellipsis）+ Tauri minWidth 兜底不受影响。

## Decision

ADR-0045 定了两栏 shell（thread rail + workspace），但**未定义桌面窗口可变尺寸下的行为**。本 ADR 收口这道边界遗漏，并连带闭合 ADR-0047 / 0050 的截断策略 open item：

- **rail 固定宽度**，v1 **不可拖拽调宽**；workspace flex 自适应剩余空间，宽表**横向滚动**而非挤 rail。
- **rail 可折叠**（一个切换收起 / 展开，折叠后 workspace 全宽）——窄窗 / 小屏的逃生口。
- **Tauri 窗口设 `minWidth` / `minHeight`**（精确值留实现期），用原生能力零成本兜底「两栏最小可用」，不写响应式断点。
- rail 单行逐字卡（ADR-0047）卡宽由此确定 → **截断策略定为尾部 ellipsis**（保头部、尾部省略号），闭合 ADR-0047 / 0050「截断（头部 vs 尾部）」open item。

## Context

ADR-0045 的 Decision 只写了「两栏 = thread rail + workspace」，`Considered options` 全在争论 *两栏 vs 三栏 vs notebook*，**整篇未出现窗口可变尺寸下的行为**。这不是无关细节：

- ADR-0008 是 **Tauri 桌面应用**，窗口尺寸用户可随意变（非 web viewport 可控场景）。
- ADR-0050 定了**紧凑密度**、ADR-0047 定了 rail **单行逐字卡**——单行卡要有最小确定宽度，截断才有意义；窗口被拖窄时 rail 与 workspace 谁让位？
- 目标人群是**非技术用户**（ADR-0001 / 0050）——最可能随手拖出奇怪比例。
- 连带：rail 卡宽不确定，ADR-0047 / 0050 标为「未决」的**截断策略**永远定不下来。

`styles.css` 旧 `.layout` 的 `280px / 1fr` 双栏是脚手架值（ADR-0045 Consequences 已判须重写），非有意识决策。

## Why

1. **固定宽 + 不拖拽**：单行逐字卡需确定卡宽，截断行为才有意义；非技术用户不会去精细调栏宽，resizable splitter 是 v2 的 YAGNI。
2. **可折叠**：窄窗 / 小屏的逃生口；没有它，拖小窗口就挤死。折叠近乎免费（一个 UI 态 + 一个按钮），收益正比于窗口尺寸方差。
3. **Tauri `minWidth` / `minHeight` 兜底**：原生能力、零额外机制（KISS）；比写一堆响应式断点简单得多，且在最小尺寸下保证两栏都可用。
4. **workspace 表格横滚而非挤 rail**：rail 是时间线主轴（ADR-0045 Why#1「对话流是主轴」），不能被表格挤压。
5. **尾部 ellipsis**：提问是身份句柄（ADR-0039），头部更可辨识，故保头部、截尾部。

## Considered options

- **rail 可拖拽调宽（resizable splitter）**：v1 YAGNI、非技术用户不用；确定卡宽才能截断的目标会被「用户随时改宽」破坏。**否决（v1）**，留 v2。
- **仅 `minWidth` 硬挡、不给折叠**：拖不到更窄但用户失去窄屏全宽 workspace 的选择；折叠近免费，纯硬挡是更严 KISS 但损失灵活性。**否决（作更严 KISS 备选标注）**。
- **rail 宽度响应式断点**：复杂、违 KISS；`minWidth` 兜底已足够覆盖极端窄窗。**否决**。
- **截断保尾部（头部省略）**：提问句柄头部更可辨识，保头部符合 ADR-0039 身份语义。**否决**。
- **自动折叠（按窗口宽阈值）**：不可预测，违用户控制。**否决**。
- **会话栏折叠成图标条**：仍占宽，窄窗退化不彻底。**否决**。

## Consequences

- **闭合 ADR-0047 / 0050 open item**：「截断策略（头部 vs 尾部）」定为**尾部 ellipsis**。ADR-0047 / 0050 待追加反向指针。
- **填 ADR-0045 边界遗漏**：shell 在可变窗口尺寸下的行为定案（固定 rail + flex workspace + 折叠 + minWidth 兜底）。ADR-0045 待追加反向指针。
- **前端实现**：shell grid（固定 rail 列 + flex workspace 列）+ rail 折叠状态（React 原生 UI 态，ADR-0051 客户端态范畴）+ Tauri window `minWidth` / `minHeight` 配置。
- **折叠状态持久化**走 ADR-0038（app 级 preference，与 theme / locale 同 store 模式）；折叠态是 preference、非领域概念，不进 CONTEXT.md。
- **留实现期 / 视觉打磨**（非架构）：精确 px 值（rail 宽、`minWidth` / `minHeight`、`--radius`，呼应 ADR-0050「精确 spacing 值是视觉迭代、非架构」）、折叠按钮位置 / 图标 / 动画、rail 折叠时源事件标记条（ADR-0040）的呈现。
- **延伸：三级手动折叠退化**——rail 折叠（本 ADR）+ 会话栏折叠（0060 新增栏）= 三级手动折叠（不自动）：会话栏先（**完全隐藏** + 顶栏按钮呼出，非图标条）→ rail（本 ADR，workspace 全宽）→ Tauri `minWidth` 兜底（含会话栏宽度）；折叠态走 0038（与 rail 折叠态 / theme / locale 同 store）。
