# 会话行操作菜单：行级管理操作回归与行尾动作统一

## Decision

会话侧栏行（`SessionSidebar` 的 `SidebarRow`）的操作面从「行尾 hover 内联动作钮」收敛为**单 `⋯` 触发钮 + `DropdownMenu`**，Rename / Close / Delete 三项管理操作回归行级：

1. **行尾「⋯」操作菜单。** 触发钮用 `MoreHorizontal`，视觉重量对齐 `SessionHeaderMenu` 触发钮惯例（`h-7 w-7` 命中区 + `h-3.5 w-3.5` 图标）；菜单 `align="end"`，菜单项按行态渲染三种形态——open 行：Pin/Unpin · Rename · Close · Archive · 分隔线 · Delete（destructive）；持久行（未归档、未打开）：Pin/Unpin · Rename · Archive · 分隔线 · Delete（destructive）；归档行：Restore · 分隔线 · Delete（destructive）。

2. **操作语义与组件复用。** Pin/Archive/Restore 走既有 sidecar 回调（`set_session_pinned` / `set_session_archived`）；Rename 复用 `RenameSessionDialog`；Delete 复用 `DeleteSessionDialog` 强确认；open 行 Close 一击直达不弹确认；open 行的 Close/Delete 走 `SessionHeaderMenu` 同款 shell 回调。头部菜单现只服务活动会话，非活动行的 Delete 接线（`onDelete(duckPath, sessionId)` 对非活动 `sid` 的行为）在实现期验证或补齐。

3. **内联动作钮退役。** `SidebarRow` 的 `actions` prop 与行尾动作 pill 移除，归档行的 Restore/Delete 内联钮同批退役；三种行态共用一套菜单形态，任意行态行尾恒一钮。

4. **HoverCard 保留。** ADR-0093 决策 2 的 HoverCard 元信息浮层不动——预览与管理正交；菜单打开后指针移入菜单时经既有 close grace 自然关闭。

5. **头部菜单保留。** `SessionHeaderMenu` 与行菜单并存分工：头部锚定「当前正在用的会话」（常驻 chrome、一击直达），行菜单锚定「列表中的任意行」；两菜单共享对话框组件与 shell 回调，操作逻辑零重复。

## Context

ADR-0093 将行从「导航 + 管理 + 信息」三角色收缩为纯导航：管理操作迁入 session-header，行不再承载任何管理入口；其 Considered options 同时预言「pin 落地时行内操作按钮随之一并回归」。ADR-0127 落地置顶/归档 sidecar 时，行内动作钮回归了半程——Pin/Archive（及归档行的 Restore/Delete）成为行尾 hover 内联钮——但 Rename/Close/Delete 未随行，仍只存在于活动会话头部的 `⋯` 菜单。

由此形成管理能力不对称：Pin/Archive 可对任意行操作，Rename/Close/Delete 只对活动会话可达（header menu 只随活动会话渲染）。重命名一个持久会话、关闭一个后台等待审批的会话、删除列表中任意一个会话，都必须先打开并激活目标会话；行级对这三项操作没有入口。

## Why

1. **补齐能力不对称**：管理入口的可达面不应依赖「会话已激活」。行是列表管理语境的自然锚点，头部是使用语境的自然锚点；只留头部使列表语境下的管理动作被迫绕道激活。
2. **ADR-0093 自预言的归位**：其 Considered options 明文预留「行内操作按钮随 pin 一并回归」；半程已由 ADR-0127 的行动作钮走完，本 ADR 补完另半程并把形态定为单钮菜单，而非新起对立裁决。
3. **单触发钮优于多钮**：hover 落点唯一、行尾宽度恒定、与 HoverCard 的指针干扰面最小；后续增删操作不改行形态。行内钮的省击收益不成立——pin 无行上常驻指示（置顶态靠分组标题传达），高频痛点不存在。
4. **双菜单并存优于删一**：移除头部菜单使当前会话操作失去常驻一击入口，且目标行在长列表中可能滚出视口；两菜单共享对话框与回调，双入口的维护成本接近于零。
5. **归档行同形态**：归档是默认隐藏的低频区域，Restore 的一键直达价值撑不起「菜单 + 内联钮」双形态并存的维护成本。
6. **对话框而非行内编辑**：行内重命名是纯形态升级、无功能增益，且侧栏行窄 + truncate + HoverCard 时序 + 焦点管理的编辑态边界全需新写；rename 低频，打断感不构成痛点。

## Considered options

- **右键上下文菜单承载行级操作**：发现性差（无视觉提示可达性）、需新建 context-menu 基建、右键处理与整行 `HoverCardTrigger` 的指针处理叠加易冲突。**否决**——「⋯」菜单对 ADR-0093 的回滚幅度最小；右键入口叠加在「⋯」菜单之上的扩展留待独立决策。
- **Pin/Unpin 保留内联、其余进菜单**：hover 落点 ×2、行尾变宽、时间标签被覆盖更多，为省一次点击付双代价。**否决**——「行尾恒一钮」是可随操作集扩展的不变量。
- **一并移除 HoverCard**：净减代码，但元信息（数据源摘要/轮次数）失去展示位。**否决**——预览与管理正交，无新动因不翻既有决策。
- **移除头部菜单**：消除双入口，但当前会话的高频管理路径变慢且失去常驻锚点。**否决**——删除永远比加回容易，落地后若证实纯冗余可另立裁决。
- **工作集行按钮同批菜单化**：数据集 rename/replace/delete 是分析进行中的高频操作且本就在行上（无能力缺口），行处于宽面板（无挤压动因），rowHints 提示协议是近期专项裁决。**否决**——不同表面的成本收益结构相反，独立决策。

## Consequences

- 行级管理能力与激活态解绑：任意行可 Rename/Archive/Delete，open 行可 Close，操作不再要求先打开并激活目标会话。
- **supersede ADR-0093 决策 1**：「侧边栏行不再承载任何管理入口」由本 ADR 取代为「行以单一菜单承载管理入口」——该 ADR Considered options 的回归预言至此兑现闭环；决策 2（HoverCard）与决策 3（状态圆点）不受影响。ADR-0127 无条款被取代：归档行的动作集（恢复与删除）与 sidecar 语义照旧，仅形态归一进本 ADR 的菜单。
- 实现期义务：非活动行 Delete 的 shell 接线验证或补齐；i18n 双 catalog 补 Close 菜单项键；`SessionSidebar.shell.test.tsx` 扩展三行态菜单项集与操作触发。
- 未决（留独立决策）：右键上下文菜单作为「⋯」菜单之外的叠加入口；工作集行动作形态是否对齐本 ADR。
- 可逆性：菜单形态 → 恢复内联钮是渲染层替换，shell 回调与对话框组件不受形态决策约束。
