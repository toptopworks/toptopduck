# thread rail 视觉语言：单行逐字卡片 + 四类 outcome 编码 + 源事件标记条与 stale 因果染色

## Decision

thread rail（ADR-0045 左栏）承载两类**视觉异种**条目：

**（1）轮次卡片（单行）**
`[outcome 字形] 逐字提问（占满 rail 宽截断） [→result_N 仅显式点名时出现]`
- **逐字提问**是身份句柄（ADR-0039），**非 LLM 摘要**——独占卡片主宽度。
- **assumption 不上卡**——它归 workspace 结果展示（ADR-0016 Consequences：渲染为可纠偏旁注，0010/0018 共用）；上卡 = DRY 违反 + 双真相源。
- **active chip 仅显式点名时出现**——多数轮次隐式作用于上一步（CONTEXT.md「通常无需感知」），无 chip；用户点过名（"在订单表上"）才亮 `→orders`，让 chip 成为信号非噪音。

**（2）四类 outcome 视觉语言**（ADR-0028）——按「有无产物 / 主动不产出 / 失败 / 中断」语义轴编码，**非「成功 vs 出错」**：

| outcome | 字形 | 色相 |
|---|---|---|
| A 结果轮 | ● 实心 | teal `#0d9488` |
| B 文本态轮 | ○ 空心 | 中性无 tint |
| C 失败轮 | ✗ | 错误红 `#b00020` |
| D 取消轮 | ⊘ | 弱化灰 |

- **B 必须中性、C 必须红**——B 是系统按设计不产出（0017 越界拒绝 / 0018 澄清），给任何暖色会把「诚实拒绝」误译成「出错」，背叛 0017。
- `○ / ●` 顺带编码「有 / 无产物」，一眼可辨 A 与其余三类。
- 复用 `styles.css` 既有色板（teal / red / grey），不引新色。

**（3）源生命周期事件标记条（第二物种）+ stale 因果染色**
- 标记条与卡片**视觉异种**（无 outcome 图标、无提问），细窄全宽，占时序位、恒可见（ADR-0040）：`加源 ＋` / `换源 ↻ ·失效 N 个派生`（0025）/ `删源 − ·失效 N 个派生`（0013 软删）。
- stale 结果卡 = **鬼影化**（降不透明度 + `●`→`⊘`）+ 内联 chip `失效·换源 X` / `失效·上游删除`；**点 chip 跳选**对应源事件标记条；**不画连线**。
- 鬼影仍可见、仍占位（0013 保留可见）；不进 LLM 工作集、不可被新 SQL 引用。
- **措辞分流**守 ADR-0041 诚实性：换源「因源已更新而失效」（SQL 物理能跑、v1 不做重算）vs 删源「因上游删除已失效」（引用名没了、真不可得）。
- stage 一张 stale 卡：workspace 显示结果 + 披露横幅「此结果已失效（因源已更新）— 重新提问以基于新源重算」（0041 重提问 + 0017 诚实披露，复用 0033 disclosure 模式）。

## Context

ADR-0045 定了 thread rail 为 shell 左栏、承载「轮次卡片 + 源事件标记条」双物种，但卡片长相、outcome 如何区分、源事件与 stale 的因果如何编码均留为 UX 子决策。多条 ADR 的 UI 落点依赖这套视觉语言：0039（逐字标签）、0028（四类 outcome 可区分渲染）、0010/0016（assumption 归结果展示）、0017（诚实拒绝不能像失败）、0040（源事件恒可见且非轮次）、0013/0025/0041（stale 可见 + 措辞诚实）。参照系 ChatGPT Codex agent 的紧凑卡片用 LLM 摘要，与本项目 0039 逐字约束冲突——须偏离。

## Why

1. **逐字提问是身份句柄（0039）**须独占主宽；Codex 单行靠 LLM 摘要，本项目故意不用 → 用宽度换可辨识度。
2. **assumption 归 workspace（0016）非时间线**——上卡 = DRY 违反 + 双真相源。
3. **active chip 条件出现**让「显式点名」成为视觉信号（守 CONTEXT.md 隐式语义）。
4. **B ≠ C 守 0017 诚实拒绝哲学**——本决策核心；B 是 feature 不是 bug。
5. **`○ / ●` 编码有无产物 + 复用既有色板**（KISS + 视觉系统一致，新色留视觉系统 ADR）。
6. **鬼影化**让「新鲜血缘 vs 死亡过去」一扫可辨；**chip-trace 承载因果不画线**（抗交错穿插、渲染稳健、KISS）。
7. **措辞分流守 0041 诚实性**（换源「能跑但不做」vs 删源「真不可得」）。
8. **stage stale 走披露横栏**复用 0033 既有 disclosure 模式（DRY）。

## Considered options

- **两行卡 / assumption 上卡**：assumption 双真相源 + 卡片变高撑长 rail。**否决**。
- **outcome 仅「成功 vs 出错」两档**：B 被误译失败、背叛 0017。**否决**。
- **A 细分「产表 vs 产图」字形**：v1 YAGNI（workspace 一看便知）。**否决（v1）**。
- **连续 B/C/D 折叠**：v1 仅**弱化**（降不透明度）不折叠——折叠藏住「最近意图含失败」高价值上下文（0028 Why 2）。折叠留 v2。
- **画连线**连源事件与 stale 卡：交错下打结、渲染脆弱。**否决**。
- **stale 折叠成源事件上计数**（藏单卡）：违反 0013 保留可见 + 0041 死轮须可历史检视。**否决**。
- **stale 同亮度仅加小图标**：一眼分不出新鲜 vs 死亡。**否决**。
- **换源 / 删源 stale 措辞合并**：背叛 0041 诚实区分。**否决**。

## Consequences

- **rail 实现**：轮次卡（单行 + outcome 字形 + 条件 active chip）+ 源事件标记条（异种）+ stale 鬼影 + chip-trace + stage-stale 披露横幅。
- 复用 `styles.css` 既有色板（teal / red / grey）；新色留视觉系统 ADR 统一定。
- assumption 仅在 workspace 结果展示渲染（0010 / 0016），rail 卡片不带。
- stage stale 复用 `DisclosureBanner`（0033）模式。
- **Q8（workspace tab 选择路由）不入本 ADR**——它属 workspace 交互、非 rail 视觉，且多 codify 既有 `App.tsx` 行为（`handleAsk` / `handleSelectResult` / `WorkingSetList onSelect`），惊讶度低；作为实现细节由 0045 / 0040 / 0028 指导即可。若后续需固化再开 ADR。
- **被 ADR-0045 限定**：rail 是 shell 左栏（0045）；本 ADR 定其内部视觉语言，不改 shell 结构。
- **未决（留视觉系统 ADR）**：具体字形集（`●/○/✗/⊘` vs 表/泡/警/删线）、字体 / 密度 / 明暗、Vega-Lite 主题、「结果」tab 对 B/C/D 的标签 wrinkle、截断策略（头部 vs 尾部留字符）。
- **被 ADR-0049 改写前提 + 闭合字形集未决**：色板从「复用 `styles.css`」改为「迁入 Tailwind theme tokens（取值由 0050 定）」；「字形集未决」闭合——outcome / 源事件 / stale 字形用 Lucide（精确映射在 0050）。见 ADR-0049。
- **被 ADR-0050 闭合 open item**：色板取值（teal→`--primary` 等迁入 Tailwind tokens）+ 字形集（Lucide：A=`Table2` B=`MessageSquareQuestion` C=`TriangleAlert` D=`Ban`；源 加=`Plus` 换=`RefreshCw` 删=`Trash2`；stale=`CircleOff`）。见 ADR-0050。
