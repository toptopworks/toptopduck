# 会话栏:模态框搜索 + 分组模式可切换(flat 默认、time 可选)

## Decision

会话栏(`SessionSidebar`)加搜索入口:居中模态框(Radix `Dialog`,遮罩 + 右上 X + ESC 关闭 + 可滚动),由 sidebar 顶部圆形放大镜按钮或全局 `Ctrl/⌘+K` 触发。搜索范围 = 会话名(`display_name`)+ 首源名(`source_summary.first_source_name`),大小写不敏感子串;结果扁平单段(按 `last_modified_at` 倒序),每项 = 聊气泡图标(`MessageSquare`)+ 标题 + 副行(`首源名 · N turns` 左 + 动态时间右)。空查询显示全部,搜索入口兼作浏览/跳转。

分组模式改为用户可切换,默认 `flat`(扁平单段,按 mtime 倒序,标题「Recent」);时间分组(`time`,今天/昨天/前 7 天/更老)保留为可选。内部值 `SidebarGrouping = "flat" | "time"`(避开 `recent_files` 的 `recent` 歧义)。持久化字段 `AppConfig.shell.sidebar_grouping`(`#[serde(default)]` 默认 `flat`,`format_version` 不 bump)。切换入口在分组标题 hover `⋯` → Radix `Popover`(Group by: In a list / By time,选中项右侧 `Check`);切换立即 `commitShellPrefs`,与 `sidebar_collapsed` / `rail_collapsed` 同档持久化。

顺带调整两项 sidebar 视觉(细节见 Consequences):顶部从满宽实心 teal New 按钮改为品牌标题行(`TOPTOPDuck` 左 + 圆形搜索放大镜按钮右)+ New icon 按钮(`Pencil` + 文字 + 融合背景 `bg-secondary`);会话行 active 态从整条 teal 实心填充改为浅 tint(`bg-accent text-accent-foreground`)+ 左 2px inset 条(`shadow-[inset_2px_0_var(--primary)]`)。

## Context

ADR-0060 定的时间分组(今天/昨天/前 7 天/更老)写死为默认,无搜索入口——行 53 否决搜索框,理由:软上限控规模、v1 YAGNI。但 `SOFT_CAP_OPEN_SESSIONS = 8`(`App.tsx`)只约束保活的内存会话,持久化的 `.duck` 列表无上限;会话积累后无搜索难以定位,行 53 否决理由与运行时行为不一致。分组写死为时间分组,与「按最近」的浏览习惯存在错配。

ADR-0054 的 `ShellPrefs` 已持久化 `sidebar_collapsed` / `rail_collapsed`;分组模式同属 shell chrome 偏好,延伸入 `ShellPrefs` 而非新建顶层字段。

## Why

1. **搜索是实需**:持久化 `.duck` 列表无上限,搜索解决定位;模态框形态不占 sidebar 常驻空间,不与分组视图竞争。
2. **默认 flat + 时间可选**:「按最近」是浏览默认习惯;时间分组保留为可选,不丢失能力,切换入口就在分组标题上。
3. **mode 命名 flat|time**:避开 `recent_files`(MRU 路径)的 `recent` 歧义;内部值无歧义,UI 标题仍可用「Recent」面向用户。
4. **字段入 ShellPrefs**:分组模式与 `sidebar_collapsed` / `rail_collapsed` 同属 shell chrome 偏好;延伸 ADR-0054 而非新建顶层字段或拆新子结构。
5. **serde default flat 无迁移**:简单 + 新老同起点;迁移分叉(老用户 time、新用户 flat)的「老用户」边界模糊、复杂度无收益。
6. **顶部布局 + active 视觉调整**:与 New 按钮的实心去除统一视觉语言,从「teal 实心强调」转向「muted/accent」;ADR-0050 的 teal `--primary` 保留用于左 2px 条 + 搜索按钮图标等次级强调(不变更 token)。

## Considered options

- **sidebar 视图切换 / 内嵌过滤框作搜索入口**:前者搜索时丢失分组上下文、引入额外交互;后者占 sidebar 垂直空间,搜索时与分组处理冲突。**否决**——居中模态框(`Dialog`)聚焦、不污染常驻视图,`Ctrl/⌘+K` 兼作浏览入口。
- **搜索范围加 `+path`**:路径技术性强,噪音大于价值。**否决**——`display_name` + `source_summary.first_source_name` 覆盖 sidebar 可见信息,复用 `list_sessions` 已有字段、零后端改动。
- **搜索范围扩到全文对话内容**:要求后端全文检索 IPC 遍历 recipe,架构级成本,与本地单机 + 会话数量级不匹配。**否决**。
- **消息内容片段作副行**:逻辑上要求全文搜索,后端成本不匹配。**否决**——复用 `list_sessions` 已有元数据(首源名 · N turns + 动态时间)。
- **mode 命名用 `recent`|`time`**:同词异义污染领域语言(`recent_files` 是 MRU 路径)。**否决**——用 `flat`|`time`,UI 标题仍可面向用户显示「Recent」。
- **字段放 AppConfig 顶层 / 拆新 sidebar 子结构**:前者 shell 偏好被拆散;后者破坏 ADR-0054 现结构。**否决**——延伸 `ShellPrefs`(`sidebar_collapsed` / `rail_collapsed` 同类)。
- **默认值按新老分叉(老用户 `time`、新用户 `flat`)**:「老用户」边界模糊,复杂度无收益。**否决**——serde default `flat`,新老同起点。
- **切换持久化 debounce**:低频离散动作无意义。**否决**——立即 commit,跟 ADR-0054 toggle 一致。
- **New + 搜索并排(无品牌行) / 搜索条**:前者搜索按钮单挂显空;后者占垂直空间。**否决**——品牌标题行(`TOPTOPDuck` 左 + 圆形搜索放大镜右) + New icon 按钮(`Pencil` + 文字)下。
- **active 态实心填充 / 浅 tint 无条**:前者与去实心的 New 按钮视觉割裂;后者失强选择信号,违 ADR-0060 行 15。**否决**——浅 tint(`bg-accent text-accent-foreground`) + 左 2px inset 条(`shadow-[inset_2px_0_var(--primary)]`)。
- **行首用 Database / CircleDot(已存/未存)**:toptopduck 特有区分,副行已表达持久化,YAGNI。**否决**——聊气泡(`MessageSquare`),统一 + 与搜索结果项一致。

## Consequences

- **修订 ADR-0060(部分)**:搜索框否决(行 53)推翻——理由与运行时不一致(软上限只管保活、不管持久化列表);时间分组默认(行 72)改为 flat + time 可选;New 按钮实心满宽(行 13/50)改为品牌标题行 `TOPTOPDuck` + New icon + 融合背景;active 整条 teal 填充(行 15)改为浅 tint + 左 2px 条。ADR-0060 顶部已加「部分被 0072 修订」blockquote。
- **延伸 ADR-0054**:`ShellPrefs` 加 `sidebar_grouping: SidebarGrouping`;`commitShellPrefs` 签名加 grouping,单次 IPC 写三个 shell 偏好;「collapse toggle 立即 commit」契约延伸到 grouping。
- **数据模型边界**:Rust `AppConfig` / `ShellPrefs` struct 加字段 + serde default;TS `AppConfig.shell.sidebar_grouping` + union `SidebarGrouping = "flat" | "time"`;`format_version` 不 bump(向后兼容);`list_sessions` 元数据不变(搜索复用 `display_name` + `source_summary.first_source_name` + `last_modified_at` + `source_summary.turn_count`,零新持久化)。
- **组件边界**:新搜索模态框(Radix `Dialog`,已依赖)+ 分组切换面板(Radix `Popover`,已依赖)+ 动态时间格式化函数(`formatLastModified`,intl 相对 + 绝对 fallback);`Ctrl/⌘+K` 全局 keydown 监听挂 App 层。
- **CONTEXT.md 不动**:分组模式 / 搜索是 UI 偏好与导航实现,非领域术语(遵循 ADR-0060 行 70 先例);领域术语「会话」「源」「首源名」已有定义,不受影响。`recent_files` 的 `recent`(MRU 路径)与 mode `flat`(渲染)内部值解耦,无领域语言污染。
- **视觉一致性**:active 态不再整条实心 + New 按钮不再实心 + 品牌标题 + 聊气泡行首,整体 sidebar 视觉语言从 ADR-0060 的「teal 实心强调」转向「muted/accent」;ADR-0050 的 teal `--primary` 仍用于左 2px 条 + 搜索按钮图标等次级强调(不变更 token,仅调整使用密度)。
