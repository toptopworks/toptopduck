# 前端 shell：两栏（thread rail + tabbed workspace），工作集为 workspace tab、非常驻栏

## Decision

前端 shell 从当前单列 1100px dev 默认（`App.tsx`）改为**两栏**：

- **左 = thread rail**：承载**轮次卡片**（逐字提问截断 + outcome 图标 + 「作用于 X」active chip + assumption 一行）与**源生命周期事件标记条**（非轮次，ADR-0040）。
- **右 = workspace**：大块舞台，用 tabs 切换「结果 / Schema / 工作集」。当前或重选的中间结果在「结果」tab 全尺寸渲染（表 + Vega-Lite + assumption 旁注 + 退化披露，ADR-0016/0033/0010）。
- **底 = QuestionBar**（跨全宽），带「作用于 result_N（隐式）」active 指示器，可下拉显式点名覆盖（CONTEXT.md「用户可显式点名覆盖」）。

**工作集不做常驻第三栏**——它是 workspace 里的一个 tab。「当前表」的可见性靠 rail 卡片 active chip + QuestionBar 指示器两处轻量呈现。**中间结果不内联进 thread**（否决 notebook 式）。参照系：ChatGPT Codex agent 的「对话 rail + canvas」双栏。

## Context

ADR-0008（Tauri）与 0016（React + Vega-Lite）定了框架与渲染管线，但**前端 shell 的空间结构从未被决策**——当前 `App.tsx` 的单列 `max-width:1100px` 居中是脚手架默认值，不是有意识的 ADR。多个已落 ADR 的 UI 落点都依赖 shell 形态：ADR-0010 隐式链式、ADR-0028 重开历史结果、ADR-0039 逐字提问标签、ADR-0040 源事件与轮次并列、ADR-0033 退化披露——它们都需要稳定的「时间线 vs 查看器」分离才能落地。

## Why

1. **对话流是主轴，不是表**——CONTEXT.md 定义「当前表」为"用户通常无需感知其存在"，ADR-0010 让链式引用对用户不可见。导航主轴是轮次序列，否决「以工作集为左导航树」的 DB 工具壳。
2. **中间结果需要全尺寸空间**——物化的 Dataset（ADR-0024）渲染为宽表 + Vega-Lite 图（0016/0033）；内联进 thread（notebook 式）会让含图轮次撑极高，几轮后把提问栏与"当前在做什么"推出视口。
3. **重开历史结果是一等动作**——ADR-0028「无结果轮次 outcome 契约」+ `handleSelectResult` 已实现"点历史轮次→重演到 ResultView"。两栏把 thread=时间线索引、workspace=查看器分离，正是这个交互的形态化。notebook 式把它降级为"滚动"，DB 壳把它降级为"底部日志"。
4. **工作集是低频操作**——rename（0037）/ replace（0025/0042）/ privacy（0011）偶发，不为偶发操作永久占一栏视口（KISS）；「当前表」既"通常隐式"，给最左常驻栏反而把它抬成主角，与领域相悖。
5. **rail 卡片用逐字提问截断**（ADR-0039）而非 LLM 摘要——即便 Codex 风格用摘要；这是领域硬约束对参照系的必要偏离。

## Considered options

- **Notebook 内联（a）**：轮次纵轴、结果内联。图表撑爆 thread、重开历史退化为滚动。**否决**。
- **DB 工具壳（c）**：工作集左栏为主导航 + 主舞台 + thread 折叠。与「当前表」通常无需感知相悖、把表抬成主角。**否决**。
- **三栏（ii，工作集常驻最左）**：rename/replace/privacy 零跳转，但为低频操作永久占视口、违背 active 隐式语义、比参照系更重。**否决**；active 速览用 QuestionBar 下拉吸收。
- **参照 Codex CLI 单列 TUI**：等同 a。**否决**。

## Consequences

- **前端 shell 重构**：`App.tsx` 由单列改为 two-pane grid（rail + workspace），workspace 内 tabs；`styles.css` 的 `.layout` 280px/1fr 双栏与新 shell 不兼容，须重写。
- **工作集管理降级为 tab**：`WorkingSetList` / `DatasetDetail` 从常驻面板移入 workspace tab；rename/replace/privacy 多一次点击。
- **「当前表」可见性**：靠 rail 卡片 active chip + QuestionBar 指示器两处呈现，不靠常驻栏；QuestionBar 下拉给轻量工作集速览。
- **轮次卡片标签**：逐字提问有界截断（ADR-0039），禁用 LLM 摘要——即便视觉上 Codex 用摘要。
- **thread rail 双物种**：轮次卡片（4 种 outcome 图标，ADR-0028）+ 源事件标记条（非轮次、无 outcome，ADR-0040）。
- **未决（留后续 ADR）**：视觉系统（字体/色彩/明暗/密度）；多会话切换 UI（ADR-0027，tabs vs sidebar vs 多窗口）；workspace tab 在会话切换时的重置策略。
- **被 ADR-0046 闭合**：「多会话切换 UI（tabs vs sidebar vs 多窗口）」open item 定为**单窗 + 顶栏 tabs**；关 tab = 落 recipe + 卸载（非销毁）。见 ADR-0046。
- **被 ADR-0047 细化**：thread rail 的视觉语言（单行逐字卡片 / 四类 outcome 编码 / 源事件标记条 + stale 因果染色）在 0047 详定。本 ADR 只定 shell 结构，rail 内部视觉见 0047。
- **被 ADR-0048 限定交互**：澄清文本载荷（B 轮）与 `assumption` 可纠偏旁注的**交互**（应答/纠偏走下一条自然语言轮次、不开新原语）在 0048 定；其渲染位置仍归本 ADR shell + 0047 rail。见 ADR-0048。
- **被 ADR-0049 改写前提**：「`styles.css` 的 `.layout` 须重写」升级为「`styles.css` 被 Tailwind utilities + shadcn 组件**取代**」——前端样式栈定为 shadcn/ui v4 + Tailwind v4 + Lucide。见 ADR-0049。
