# 视觉系统主题：teal primary + shadcn token 模型 + 明暗三态 + Vega CSS-var 桥接 + 紧凑密度 + 组件映射

## Decision

在 ADR-0049 样式栈（shadcn/ui v4 + Tailwind v4 + Lucide）之上，定视觉系统的四块：

**（1）调色板基线（Q10）**
- **primary = teal `#0d9488`**（沿用 0047 已编为 A 轮色，存活进新栈、零重决策）。
- 标准 shadcn token 集（`--primary / --background / --foreground / --card / --muted / --destructive / --border`…），light/dark 成对，在 Tailwind `@theme` 定义。
- 语义映射：teal→`--primary`；红→`--destructive`（0047 C 失败轮）；灰→`--muted`（0047 D 取消轮 + stale 鬼影）；B 文本态轮用 `--muted / --secondary`（中性，0047 B≠C）。

**（2）明暗模式（Q11）**
- **默认跟随系统**（`prefers-color-scheme`）；Settings 给 **light/dark/system 三态 toggle**。
- 偏好持久化走 **ADR-0038**（app 级配置、preferences only）。
- 实现：`<html>.dark` class；小 `useTheme` hook；主题变更事件驱动 Vega 桥接重建（Q12）。

**（3）Vega-Lite 主题桥接（Q12）**
- **运行时读 CSS vars 建 Vega config**（`getComputedStyle` → config 对象），单一真相 = tokens（DRY）；主题变 → 重建 → 图表随明暗翻转。
- 映射：`--background`→`config.background`；`--foreground`→标题 / 轴 / 图例文字；`--border`/`--muted`→轴 domain / 网格；**单系列 mark = `--primary`（teal）**；**多系列用现成可访问色板（Okabe-Ito / Vega `category`）**，自创品牌色板留 v2。
- 覆盖 ADR-0016 v1 白名单 6 类（table / bar / line / scatter / area / pie）；与 0033 退化正交（桥接产合法 config，校验 / 渲染失败走既有重试→退化路径）。

**（4）密度 + 组件映射（Q13）**
- **紧凑数据工作台密度**——在 `@theme` 覆盖 shadcn `--radius` / spacing token 一次（非逐组件 hack）；支撑 0047 rail 单行卡「最近 N 轮一屏可见」（0023）+ 宽表显更多行列；控件最小触靶保 32px（非技术用户可达）。精确 spacing 值是视觉迭代、非架构。
- **组件映射原则**：标准面用 shadcn 原语；bespoke 仅限 rail 两物种（轮次卡 + 源事件条，0047）；图标全 Lucide。
  - `Tabs`→workspace tabs（0045）+ 会话 tabs（0046）；`Dialog`→Settings（BYOK + 主题）/ GuidedLoad（0015）；`Button`+`Textarea`→QuestionBar；`Badge`→active / stale / 纠偏 chip + key 状态；`Alert`→stale 披露 / viz 退化披露（0033）/ 软上限提示（0046）；`Tooltip`→卡片截断全文；`Switch`→privacy；`Table`+`Tabs`→schema / 详情。
  - Lucide 字形：A=`Table2` / B=`MessageSquareQuestion` / C=`TriangleAlert` / D=`Ban`；源事件 加=`Plus` 换=`RefreshCw` 删=`Trash2`；stale=`CircleOff`。B 拆「澄清 / 拒绝」子图标留视觉打磨期（v1 守 0028 四类 + 0047 B 单视觉）。
- **「结果」tab 对 B/C/D 标签 wrinkle（闭合 0049 open item）**：保留「结果」tab 标签；B/C/D 在其中渲染为**明显异于表格的文本卡**（无表）+ outcome 字形已明示语义——不另设 tab、不改名（守 Q8 选择驱动路由 + KISS）。

## Context

ADR-0049 定了样式栈并把 primary 取值、明暗、密度、Vega 桥接、Lucide 映射、「结果」tab 标签 wrinkle 列为「留 0050」。ADR-0047 把色板取值与字形集列为未决。ADR-0045 的 shell 与 0047 的 rail 视觉语言须落在具体 token / 组件 / 密度上才有实现路径。本 ADR 收口这四块，闭合 0049 与 0047 的相关 open item。

## Why

1. **teal 沿用 0047**——已编为 A 轮色，提为 `--primary` 使 0047 色板决策存活进新栈、零重决策；teal 数据工作台语义（冷静、分析性）契 ADR-0001。否决 shadcn 默认 zinc（模板脸、无个性）。
2. **明暗默认跟随系统 = 非技术用户零配置**（0001）；toggle 服务想覆盖少数（长时用、dark 减眼疲劳），Settings 已在（0010 不开新 surface）+ 持久化契合 0038。
3. **Vega 运行时 CSS-var 桥接 = 单一真相（DRY）**——颜色只在 tokens 定义、Vega config 派生、永不漂移；随明暗自动翻转是 token 模型 + Q11 红利，零额外机制。
4. **紧凑密度支撑 rail 密度目标（Q4 / 0023）+ 表格密集（0024）**；token override 一刀切非逐组件 hack（系统化）。
5. **标准面用 shadcn 原语 = 最大复用（KISS）**；bespoke 仅 rail 两物种（尊 0047 定制）；图标全 Lucide（统一）。

## Considered options

- **primary：shadcn 默认 zinc / 另立品牌色**：模板脸无个性 / v1 YAGNI。**否决**。
- **明暗：v1 仅 light**：浪费栈能力 + 违 styles.css 既定意图。**否决**。
- **明暗：仅系统不给 toggle**：Settings 已在、0038 已撑偏好，toggle 近乎免费。**否决（作更严 KISS 备选标注）**。
- **Vega：双份硬编码 light/dark config**：DRY 违反 + 漂移。**否决**。
- **Vega：固定色板仅背景跟模式**：暗色下轴 / 文字撞色。**否决**。
- **Vega：用默认主题不桥接**：图表蓝 vs 应用 teal 脱节。**否决**。
- **密度：shadcn 默认 airy / toggle**：背 Q4 rail 密度 / v1 YAGNI。**否决**。
- **rail 卡用 shadcn `Card`**：默认 airy 对抗单行紧凑 + 不适第二物种。**否决**——bespoke。
- **B 拆澄清 / 拒绝两套 outcome 图标**：v1 守 0028 四类 + 0047 B 单视觉；图标分流留视觉打磨。**否决（v1）**。
- **「结果」tab 改名「回答」**：牵动 A 语义；文本卡 + 字形已够区分。**否决**。

## Consequences

- **闭合 ADR-0049 open item**：primary=teal、明暗三态、紧凑密度、Vega 桥接、Lucide 映射、「结果」tab wrinkle 全定。
- **闭合 ADR-0047 open item**：色板取值（迁 tokens）+ 字形集（Lucide 映射）定。
- **延伸 ADR-0016**：Vega-Lite 渲染的主题来源定为「运行时 CSS-var 桥接」；0016 的 schema 校验 / 退化路径不变。
- 主题 `.css`（`@theme` light/dark token）+ `useTheme` hook + Vega 桥接 util 进 src；shadcn 组件按映射表 copy-in；`lucide-react` 字形按表用。
- **Vega 桥接触发**：挂在 Q11 `useTheme` 主题变更事件；主题切换时图表重渲一闪（罕见事件，可接受）。
- **未决（留实现期 / 视觉打磨）**：精确 spacing / `--radius` 值、B 澄清 / 拒绝子图标分流、自创品牌多系列色板（v2）、截断策略（头部 vs 尾部留字符）、卡片悬停态。
