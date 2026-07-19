# 样式落地形态：styles.css 收敛为 layout-only 薄层 + 视觉细节上 token/utility + slice 增量迁移

## Decision

在 ADR-0049 样式栈（shadcn/ui v4 + Tailwind v4 + Lucide）与 ADR-0050 视觉系统主题（token 模型 + teal primary + 明暗三态 + 紧凑密度）之上，定样式**落地形态**——v0 scaffold 遗留的 `src/styles.css` 与 shadcn 组件 / token 系统并存局面如何收口：

**（1）`styles.css` 收敛为 layout-only 薄层**
- 布局类（`.shell` / `.session-pane` / `.topbar` / `.session-sidebar` / `.settings-overlay` / `.profiles-master-detail` 等 grid + flex 结构）**保留为语义化 CSS**——它们表达「三栏 shell / 嵌套 pane / master-detail」这种布局语义；塞进 Tailwind utility 会退化为语义不透明的 `grid grid-cols-[220px_1fr] grid-rows-[auto_auto_1fr]` 长串。
- 视觉细节（硬编码 `box-shadow`、散落的 `0.72 ~ 1.4rem` 字号、`0.2 ~ 2rem` 间距、`400/500/600` 字重、硬编码 `6px` 圆角与色值）**迁出 `styles.css`**，落到 Tailwind v4 自带 scale utility、ADR-0050 既定 color/radius token、或 shadcn 组件 variant。

**（2）不新增 elevation / typography / spacing token**
- 字号走 Tailwind `text-xs/sm/base/lg/xl`；间距走 `gap-2 / p-3` 等；阴影走 `shadow-sm/md/lg`。
- 颜色与圆角继续用 ADR-0050 既定 token（`--primary` / `--radius` 等）。
- 现有 token 系统不扩——避免与 Tailwind v4 自带 scale 重复（DRY）。

**（3）slice-by-slice incremental 作为迁移风险策略**
- 采用增量切片迁移（非 big-bang 全量重写）——650 行 legacy CSS 集中重写 review 困难、风险集中；增量迁移每步可验证、可回退。项目历史即 slice 路线（0050 注释「land with the component migration slices」）。
- `ui/table.tsx` 注释里「依赖 `styles.css` 全局 `th/td` 兜底」的耦合按本决策定义（`th/td` 的 border/padding/background 是视觉细节）**拆进 Table 组件本体**，不留全局规则——这是结构性边界，非实施顺序。
- 具体切片顺序、样板选择、PR 节奏属实施计划，不进本 ADR，由迁移 issue 追踪。

## Context

ADR-0049 定样式栈、ADR-0050 定 token 模型与组件映射，两者都未触及 v0 scaffold 遗留的 `src/styles.css` 的归宿——0050 Consequences 的「未决」段只列了「卡片悬停态」等零散视觉打磨项，样式**落地形态**（legacy CSS 与新栈如何并存 / 谁覆盖谁 / 迁移路径）一直是空缺。

现状：`styles.css` 在 `main.tsx:8` 加载于 `app.css`（token）之后，含 203 个类选择器、约 650 行，被 9 个核心组件直接引用（`App` / `SessionSidebar` / `SessionPane` / `Thread` / `SettingsView` / `ProfilesSection` / `QuestionBar` / `FileDropzone` / `ErrorBoundary`）。它与 shadcn 组件（`ui/` 下 14 个 copy-in）+ token 系统并存：同一视觉概念（卡片、选中态、阴影）在 legacy CSS 与 shadcn variant 两处各表达一次；且 `ui/table.tsx:15` 注释明确「this layering holds only while styles.css keeps its [global th/td rules]」——shadcn Table **有意依赖** legacy 全局规则兜底。这套双层并存是视觉表现不一致的根因。

## Why

1. **布局语义类是合理工程选择，不是待消灭的 legacy**——`.shell` 三栏 grid、`.session-pane` 嵌套布局用语义化类表达，可读、可 grep、可局部改；塞进 Tailwind utility 会退化为长串 `[220px_1fr]`，损害可维护性。shadcn 官方对复杂布局也是语义化类 + utility 混合，非「全 utility」教条。
2. **视觉细节散落是表现不一致的根因**——硬编码阴影、散落字号、间距未走 scale，导致同一组件在不同位置渲染表现不一致；迁到 Tailwind scale + token 即根因消除，无需重写布局。
3. **Tailwind v4 自带 scale 成熟，造新 token 违 DRY**——`text-* / gap-* / shadow-*` 是成品级配，shadcn 组件本身就如此用；再造一套 elevation/typography/spacing token 是重复造轮子，且 type scale 级配决策面大（YAGNI）、易陷入逐档微调偏离「统一」主目标。
4. **slice-by-slice 控风险**——650 行 big-bang 重写 review 困难、风险集中；增量迁移每步可验证、可回退。

## Considered options

- **完成态：彻底清空 `styles.css`，全量进 Tailwind utility / CVA / 组件 props**：布局塞 utility 成语义不透明长串 + 需拆 `table.tsx` 全局耦合 + 重写 650 行，代价远超收益。**否决**。
- **完成态：维持现状，零散补视觉细节**：未触及根因，视觉不一致持续。**否决**。
- **token：全扩 elevation + typography + spacing 三套**：与 Tailwind 自带 scale 重复（DRY 违反）+ type scale 级配决策面大（YAGNI）。**否决**。
- **token：只扩 elevation（自定义 2-3 级 `--shadow-card / --shadow-popover / --shadow-overlay`）**：先验不足——跑完一个切片才能判断 Tailwind 默认 shadow 是否够表达卡片浮起感；压力来了再扩是小可逆步骤，非返工。**否决（作 token 策略「未决」备选标注）**。
- **迁移：big-bang 全量重写**：风险集中、review 困难、违背项目 slice 历史。**否决**。
- **引入第二套成品组件库（如 Radix Themes）替换 shadcn**：成品组件库自带 Theme provider / CSS reset / 一套 token，与现有 Tailwind v4 + shadcn + CVA 体系**互斥而非叠加**（两套 color token、两套 spacing、CSS reset 叠加）；需推翻 `ui/` 下 14 个 copy-in 组件 + 重写所有页面 + Tauri 包体积增加。视觉不一致的根因是 legacy CSS 未迁移（本决策（1）即消除），非组件库选错。**否决**。

## Consequences

- `src/styles.css` **保留但收缩**到布局语义层（`.shell` / `.session-pane` / `.topbar` / `.session-sidebar` / `.settings-overlay` / `.profiles-master-detail` 等 grid/flex 结构类）；视觉细节类（`.textual-card.clarify` 的硬编码 border-left、`.session-entry.active` 的硬编码背景、`.degrade-card` 的硬编码阴影等）退役，由 Tailwind utility + token + variant 替代。
- `ui/table.tsx` 注释里「依赖 `styles.css` 全局 `th/td` 兜底」的耦合**拆进 Table 组件本体**；`styles.css` 的全局 `th/td` / `table` 规则随之退役，`table.tsx:15` 的 layering 不变量注释更新。
- 关联 **ADR-0049**：0049 的样式栈不变，本 ADR 定其落地形态（legacy CSS 归宿）。
- 关联 **ADR-0050**：0050 的 token 模型 + 组件映射不变，本 ADR 补其「未决」中的样式落地层（0050「未决」仅留视觉打磨项如卡片悬停态，本 ADR 不动这些）。
- 关联 **ADR-0047**：thread rail 双物种视觉语言（0047）随迁移落地，outcome 色彩编码语义不变，仅样式表达从 legacy CSS 迁到 utility + token。
- **未决（留实现期 / 视觉打磨）**：迁移推进中若 Tailwind 默认 `shadow-sm/md/lg` 不足以表达卡片浮起感，则新增 2-3 级 elevation token（即 Considered options 中「只扩 elevation」项），届时增补本 ADR 或新开 ADR。
