# 前端样式栈：shadcn/ui v4（copy-in）+ Tailwind CSS v4（CSS-first）+ Lucide React

## Decision

前端样式栈定为 **shadcn/ui v4 + Tailwind CSS v4 + Lucide React**，取代当前 `styles.css` 纯 CSS：

- **shadcn/ui v4**（copy-in 组件，非 npm 运行时依赖）——基于 Radix UI primitive，组件源码复制进仓库、自有可改。
- **Tailwind CSS v4**（CSS-first 配置）——主题走 `.css` 内 `@theme`、**无 `tailwind.config.js`**；经 `@tailwindcss/vite` 插件接入 Vite 8，无 PostCSS 配置。
- **Lucide React**——图标集，tree-shakeable，承载 0047 的 outcome / 源事件 / stale 字形。

绿地采用——现 `package.json`（React 19 / Vite 8 / vega-lite 6）无任何 Tailwind/shadcn/Lucide 痕迹，无 v3→v4 迁移债。

## Context

ADR-0045 Consequences 假设重写 `styles.css`；ADR-0047 Consequences 假设「复用 `styles.css` 既有色板」并把「字形集」列为未决。二者都基于纯 CSS 前提。前端样式栈从未被 ADR 决策——选栈决定组件形态、主题机制、图标来源、与 Vega-Lite 的 theming 协作方式，是 0045 / 0047 落地的前提。

## Why

1. **lean 契合 ADR-0008 低内存动因**——shadcn copy-in 无运行时库包袱、Tailwind v4 仅发用到的 utility、Lucide tree-shake；比 MUI / AntD 更轻，不为 Tauri webview 额外加包体积 / 内存。
2. **copy-in 契合 0047 高度定制组件**——rail 卡 / 源事件标记条 / stale 鬼影是 bespoke 视觉，shadcn copy-in 让直接改源码、不跟库 API 搏斗；安装式组件库（MUI / AntD）要对抗其默认风格。
3. **Tailwind v4 CSS-first 绕开配置保护**——主题在 `.css` 的 `@theme`、无 `tailwind.config.js`，不触项目 lint / JS 配置保护约束；Vite 插件接入零 PostCSS 配置。
4. **Lucide 解决 0047 字形集未决**——统一、开源、tree-shakeable 图标集，承载 outcome / 源事件 / stale 全部字形。
5. **React 19 / Vite 8 兼容**——shadcn v4 + Radix 支持 React 19；Tailwind v4 有一等 Vite 插件；现栈版本足够，无升级债。

## Considered options

- **MUI / AntD / Mantine**（安装式组件库）：生态大但运行时包袱重（背叛 0008 lean）+ 默认风格强、对抗 bespoke rail 视觉更费力。**否决**。
- **Tailwind v3 + shadcn 旧版**：v4 已稳定且更快（Oxide）；新项目无迁移债，无理由降级。**否决**。
- **纯 CSS / CSS Modules（沿用 styles.css 路线）**：无系统、无 a11y primitive、定制字形要自造轮子；0047 多类视觉语言无 token 系统难一致。**否决**。
- **自建设计系统**：控制力最强但 v1 过度（YAGNI）；shadcn copy-in 已给足控制力 + 免造轮子。**否决**。

## Consequences

- **取代 styles.css**：0045 Consequences「`styles.css` 的 `.layout` 须重写」升级为「`styles.css` 被 Tailwind utilities + shadcn 组件**取代**」；0047「复用 styles.css 既有色板」改为「色板迁入 Tailwind theme tokens（`@theme`），具体取值由 0050 视觉系统 ADR 定」。
- **字形集由 Lucide 定**：0047「未决：字形集」闭合——outcome / 源事件 / stale 字形用 Lucide（精确映射在 0050 定）。
- **Vega-Lite 主题桥接**：vega-lite 6 自带 theming；图表色须从 Tailwind CSS vars 桥接到 Vega config，使图表与应用同色——留 0050 视觉系统 ADR 定桥接方案。
- **组件映射（粗）**：shadcn `Tabs` → workspace tabs（0045）+ 会话 tabs（0046）；`Dialog` → Settings / GuidedLoad；`Badge` → active chip / stale chip / 纠偏 chip；`Alert` → stale 披露横幅 / viz 退化披露（0033）/ 软上限提示；`Tooltip` → 卡片截断全文；rail 卡与源事件条为 bespoke（copy-in 基座上自写）。
- **a11y**：Radix primitive 带键盘 / ARIA，契合桌面工具可达性。
- **安装侧**：`components.json`（shadcn CLI 配置）、`@tailwindcss/vite`、`lucide-react` 入 devDeps；主题 `.css` 进 src。
- **未决（留 0050 视觉系统 ADR）**：primary 色取值、明暗模式（default / toggle）、密度、Vega 桥接、精确 Lucide 映射、「结果」tab 对 B/C/D 的标签 wrinkle。
- **被 ADR-0050 闭合 open item**：primary 取值（teal）、明暗模式（系统默认 + 三态 toggle）、紧凑密度、Vega CSS-var 桥接、Lucide 精确映射、「结果」tab 对 B/C/D 标签 wrinkle 全在 0050 定。见 ADR-0050。
