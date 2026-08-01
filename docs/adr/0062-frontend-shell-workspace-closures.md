# 前端 shell 与 workspace：闭合 0060 三栏化与状态机遗留接缝（R1-R5）

## Context

ADR-0060 把前端 shell 从两栏（0045）扩为三栏（+ 左会话栏），ADR-0051 定了 active / viewedResult 分层但留了若干含糊处，ADR-0045 / 0047 把 workspace「结果」tab 内容列成枚举而非布局，0061 的拖放 / resume 路径留白。审读这批 ADR 暴露五道 **0060 / 0045 / 0051 / 0061 留下、未闭合的接缝**——都是「已有 ADR 的隐含推论没拼成闭合规则」或「0060 扩栏后旧措辞读不通」。本 ADR 逐条闭合，并顺各被引 ADR 措辞。五条都是**闭合 open item / 精确化**，不引入新机制、不破任何已定架构。

## R1 — QuestionBar 横向跨度：只跨 rail + workspace，会话栏独立通底

> 被 [ADR-0083](./0083-conversation-stream-workspace-panel.md) 取代：R1 Decision「QuestionBar 只跨 rail + workspace」跨度演进为 **rail 内**（输入区收进 rail 列）——工作区默认折叠后全宽跨度失去前提。「会话栏独立通底」保留。详见 ADR-0083。

0060 在最左加常驻会话栏后，0045「底 = QuestionBar（跨全宽）」读不通——「全宽」现在是整窗（含会话栏）还是活跃会话工作区（rail + workspace）？0058「shell 骨架（header / 会话 tabs / QuestionBar）」把 QuestionBar 归进顶层骨架，但该措辞是 0060 之前写的（还叫「会话 tabs」），三栏下同样读不清。

**Decision**：QuestionBar 只跨 rail + workspace；会话栏独立通到窗口底边。

**Why**：
1. **语义边界**——会话栏是导航 chrome（0060 异色沉色分层）、QuestionBar 是活跃会话输入，延伸到会话栏下方把「这个会话的输入」耦合到「会话间导航」。
2. **Chat 风格参照自洽**——0060 显式采 Chat 风格外壳，ChatGPT 的 composer 在主区（sidebar 右）、不压 sidebar，选此才与 0060 自采参照系一致；选整窗宽反而背离。
3. **折叠态自洽**——会话栏折叠（0054）时 QuestionBar 自然填满 rail + workspace，行为可预期；整窗宽则会话栏折叠时 QuestionBar 突然变长。
4. **布局网格更简**——会话栏 `grid-row: 1 / -1` 通顶到底独立成列，右侧 rail + workspace + QuestionBar 自成一块（KISS）。

**触面**：0045「跨全宽」顺为「跨 rail + workspace」；0058「shell 骨架」中 QuestionBar 归「会话级骨架」。

## R2 — workspace「结果」内容：派生(viewedResult, thread 末轮, pinnedToHistory)

0051 既说 viewedResult 只指 Materialized（第 5 点），又说非 Materialized「靠最新轮次在 workspace 自然渲染」——两者冲突时谁赢没拼成规则。最尖锐冲突：末轮 B 澄清时 workspace 须显 B 文本（0048 要求用户读到才能作答），但 viewedResult 没动；用户此时点回历史 result_1 卡，显 result_1 还是 B 文本？0047「点 Materialized → setViewedResult」没说它能否压过「最新非 Materialized 覆盖」。顺带子缝：加载了源、还没任何轮次时（viewedResult=null、无末轮），workspace 显什么没定义。

**Decision**：workspace「结果」内容是**派生值**（不新存），由 viewedResult + thread 末轮 + 一个客户端布尔旗 `pinnedToHistory` 决定：

- 末轮 = B/C/D 且 `pinnedToHistory=false` → 显末轮文本卡（0051「自然渲染」显式化、瞬态）；
- 否则 viewedResult ≠ null → 显 viewedResult 的图 + 表（R4 布局）；
- 否则（viewedResult=null、无末轮 / 末轮 A 未产出）→ hero 空态。

`pinnedToHistory`（默认 false）：新轮产出（任何 outcome）→ false；用户点 rail 历史 Materialized 卡（非末轮）→ true + setViewedResult；末轮 B/C/D 时 true 让 viewedResult 压过末轮文本、false 让末轮文本压过 viewedResult。

**Why**：
1. **守 0051 单一真相**——不新存「workspace 内容」，从 viewedResult + thread 派生，新增的只是布尔旗（客户端 UI 态、与 viewedResult 同档、不进 Query / 服务端）。
2. **闭合 0048 澄清流**——末轮 B 默认显文本（`pinnedToHistory=false`），用户能读到、能作答；点回历史 result 卡 → `true` → 重看表，两意图不打架。
3. **闭合「源已加载未提问」子缝**——hero 延伸到该中间态，首问产出即切走。
4. **不破「产出即选中」**——末轮 A 时 viewedResult 自动跟随、`pinnedToHistory=false`，体感不变。

**触面**：0051「自然渲染」显式化为派生规则 + `pinnedToHistory`；0047「点 Materialized → setViewedResult」补「+ 若非末轮则 pinnedToHistory=true」；0061 hero 空态适用范围延伸到源已加载未提问。

## R3 — 拖放落点：活跃会话→加源，hero→createSession

0061 只定义 hero 拖放（createSession + 加源）。用户已在活跃会话时拖新文件——任何 ADR 没定义。

**Decision**：以「是否存在活跃会话」二分，无修饰键 / 无弹窗。有活跃会话（workspace 非 hero）→ 拖放 = 加源（0022 / 0040 标记条）；无活跃会话（hero 可见）→ createSession + 加源（0061）。

**Why**：
1. **领域映射干净**——加源（0022）是工作集加 Dataset 的突变，拖放是其最自然触发（DRY，不另造隐式开新会话路径）。
2. **Chat 风格一致**——ChatGPT 拖文件进现有对话 = 进当前对话，选加源与 0060 外壳自洽；偷开新会话让用户「只想加个表、却跑到新会话」困惑（违 0017 诚实 / 非技术用户预期）。
3. **无修饰键 / 无弹窗 = KISS**——「有没有活跃会话」已是 UI 现成状态（hero 是否可见）。
4. **「想用新文件开新会话」有显式出口**——左栏「+ 新建会话」进空态再拖（0061 两步路径），入口可发现。

**触面**：0061 拖放路径补二分。

## R4 — 「结果」tab 内部布局：assumption → 图 → 表，退化替换图位，分页 sticky

0045 把「结果」tab 列成「表 + Vega-Lite + assumption + 退化披露」枚举，非布局顺序；也没说四块垂直关系、是否共滚、分页搁哪。枚举把表放第一，隐隐是 SQL 工具心智；但本项目是 NL 数据分析给非技术用户（0001），图（0016 核心动词）是答案。

**Decision**：assumption 顶 → Vega-Lite 图 → 表，整 tab 一条滚动；退化披露（0033，viz 失败时）**替换图位**（非第 4 个堆叠项）；表分页控件 sticky 在 pane 底。无 viz 直接 assumption → 表。**反转 0045 枚举顺序**（表→图 改 图先于表）。

**Why**：
1. **图 = 用户要的答案**（NL 分析、非技术用户，0001 / 0016），表 = 证据 / 钻取 / 复制 / 导出（SQL 遗产，验证位）；表主角是 SQL IDE 心智，错配。
2. **assumption 顶置守 0017**——caveat 在结论（图）之前披露；它是 0048 纠偏入口，须显眼。
3. **退化替换图位守 0033**——0033 已定「emitted viz 渲染失败 → 明示已显示表格」，它就该在图本该出现的位置，而非额外一条 banner。
4. **sticky 分页守 0057**——不引入跳页 / 虚拟化，但分页控件始终可见，滚过图也够得着。

**触面**：0045 枚举显式化为布局顺序（反转）；0033 退化披露落点注明「图位替换」；0057 分页控件落点注明「pane 底 sticky」。

## R5 — resume 后初始 viewedResult：末个 Materialized

0051「产出即选中」只覆盖新产出，没覆盖 resume。隐式默认 viewedResult=null → hero（R2），resume 一个有 result_1..result_N 的会话落眼是 hero，体感断裂。

**Decision**：resume 成功（0034 重放链完、thread query 就绪）→ 前端扫 thread 取末个 outcome=Materialized 轮的 reference_name → setViewedResult，`pinnedToHistory=false`。无 Materialized → viewedResult=null → hero（R2 一致）。末个 Materialized 若 stale → workspace 显旧表 + 披露横幅（0047 stage-stale）。QuestionBar 照常显 active（服务端真相，可能 ≠ viewedResult，active / viewed 分裂守 0051）。

**Why**：
1. **resume = 接续上次工作（0034）**——末个结果即「上次做到哪」；hero 是新会话语义，resume 后给 hero 语义错配。
2. **延伸 0051「产出即选中」精神**——补平行规则「resume 即选中末个 Materialized」，两条入口（新产出 / resume 重入）都落到「展示最近分析产物」。
3. **守 active / viewed 分裂（0051）**——viewedResult = 末个结果（展示位）、active = 服务端真相（QuestionBar），两者通常重合但分裂语义不破。
4. **stale 落眼诚实（0017 / 0047）**——若末结果失效，resume 即见披露横幅，不藏。

**触面**：0051 viewedResult 规则补 resume 初始化；0061 resume 路径注明前端初始化 viewedResult。

## Consequences

- **不引入新机制**：R1-R5 全是闭合 open item / 精确化 / 顺措辞，不新增 IPC、不动 Rust 契约、不进 Recipe、不加 turn id / event id。
- **新增一个客户端 UI 布尔旗**（R2 `pinnedToHistory`）——与 viewedResult 同档（0051 客户端 UI 态），不进 Query / 服务端。
- **反转一处已决枚举**（R4 反转 0045 枚举顺序）——实现者须采「图 = 答案在前」心智。
- **顺措辞被引 ADR**（反向指针 + 精确化，已追加）：0045（R1 跨度 + R4 布局）、0051（R2 派生 + R5 resume init）、0047（R2 pinned）、0058（R1 骨架归类）、0061（R3 拖放 + R5 resume）、0033（R4 退化落点）、0057（R4 分页落点）。
- **CONTEXT.md 不动**：R1-R5 全是 UI 布局 / 状态机 / 交互实现，不引入领域术语。
- **未决（留实现期 / 视觉打磨）**：R4 图自然高度过大时的处理、assumption 旁注展开 / 折叠态、R2 `pinnedToHistory` 的精确命名。
