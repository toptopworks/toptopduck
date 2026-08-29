# thread：chat 形态是轮次账本的表现层投影 + 气泡仅承载用户产出

## Decision

thread 表现层把轮次账本渲染为 chat 消息流：一轮 = 右对齐用户气泡 + 左 assistant 流。气泡仅承载用户产出与对话事实——问话全文换行、`asked_at`、复制；app 注解（active chip、技能 drift、outcome、stale、失败回溯、假设说明、结果预览）统一归 assistant 侧。assistant 流时序：头部注解 → 每轮「thinking 折叠（默认折叠）+ 连接话语恒展开 + 步折叠（默认折叠）」交替（按轮分组见 ADR-0078）→ outcome 收尾 + 收尾 meta 行（答复复制 + `settled_at`；Materialized/Textual 的 outcome glyph 仍在收尾行）。Failed/Cancelled 的 outcome 收尾整合为单一卡：glyph 居卡头与 reason 同行，技术详情折叠在卡内其下（Failed 走 destructive tint，Cancelled 同构 muted 卡）；两 outcome 的收尾 meta 行不再渲染 glyph。非轮次条目（源 / 技能生命周期事件、运行时归属段头）保持 divider 形态插在原时序位置。领域层 `Turn` / 执行轨迹 / 生命周期事件定义不变——投影不改域。

## Context

参照范式的可读性来自用户 / assistant 两栏分离与「thinking—散文—步骤」交替节奏；现状轮次卡片形态（问话作单行标题行 + 扁平 trace 单折叠）无法承载该节奏，问话截断态也削弱问话的完整性。

## Why

1. **领域稳定性优先于视觉一致**：outcome 四分、计步序、窗口装配、resume 均依赖轮次原子性；消息流只是同一原子性的另一投影。
2. **归属原则单一**：气泡仅承载用户产出 + 对话事实；app 注解一律归 assistant 侧，阅读顺序即「提问 → 注解 → 答复」。
3. **折叠姿态继承**：散文是可读性主体、恒展开；步折叠与 thinking 默认折叠，继承 ADR-0078 长 rail 可读性约定。
4. **问话全文换行**：chat 形态下问话完整可读优先于标题行信息密度；换行比截断更适配窄 pane。

## Considered options

- **领域消息流化（持久化为消息序列，Turn 降为派生概念）**：推翻 ADR-0028/0039/0040/0078 群，resume / 窗口 / 计步序全重推。**否决**。
- **气泡承载 app 注解（active chip 入气泡 meta 行）**：归属原则双轨。**否决**。
- **问话保留单行尾截断（ADR-0054）**：其载体（标题行）随 chat 化退役，截断态与 chat 可读性冲突。**否决**，该 ADR 退役。
- **「从此处分支」（fork）纳入本次**：thread 树化动摇 recipe 追加只、result_N 单调链、stale 级联锚点与 resume 线性语义。**本次否决**，独立 epic。

## Consequences

- **校准 ADR-0078**（回指）：trace 持久化形态由扁平改为按轮分组，含连接话语与 thinking 子结构。
- **退役 ADR-0054**：问话全文换行，单行尾截断 + tooltip 姿态退出。
- **持久化增列**：`TurnRecord` 加可选 `asked_at` / `settled_at`；老轮 honest degrade 不显示。
- **thinking 接通边界**：内置 anthropic 协议随 posture thought-level 启用 extended thinking（ADR-0095/0100），openai 协议 honest degrade；claude-code 解析器补 thinking 块事件（ADR-0097）；codex 不承诺（ADR-0094）。thinking 原文 persist 不设上限；无数据源 / 老轮不渲染折叠。
- **审批卡保持 in-flow 醒目**：chat 化不削弱分级审批边界（ADR-0083）。
- **live 姿态同构**：提交即现气泡，assistant 侧流式渲染 thinking 度量 / 轮散文 / 工具行。
- **CONTEXT.md**：执行轨迹条目按轮分组校准（回指）。
