# Frontend: React; visualization via schema-validated Vega-Lite with a chart whitelist

## Decision

前端 = **React**（收口 ADR-0008 的开放子决策），跑在 Tauri webview。ADR-0009 契约里的 `viz` spec = **Vega-Lite JSON、schema 校验**，经 `react-vega`/Vega-Embed 渲染。v1 chart 类型**白名单约束**（table / bar / line / scatter / area / pie），白名单外 → **退化为表格**。Vega-Lite schema 校验失败 → 按"查询失败"同路处理：回喂 LLM 重试 1–2 次，仍失败则退化表格（呼应 ADR-0009）。

## Context

ADR-0009 留 `viz?: spec` 未定义；ADR-0008 留前端框架开放。spec 格式与渲染器耦合，须一起定。

## Why

1. **Vega-Lite 强 JSON schema 让 viz spec 走与 SQL 同一条"结构化输出 + 校验 + 重试"轨道**（0007/0009）——护栏最干净；ECharts 自由式 options 会重新引入解析/兜底的护栏债。
2. **Claude 对 Vega-Lite 训练充分** → 幻觉少 → 直击 0007"把结构化输出调到最佳"。
3. **chart 白名单**约束面（KISS + 与全套"约束面"哲学一致）；白名单外优雅退化表格。
4. **React**：生态最广、LLM 最熟、notebook/图表组件成熟——Tauri webview 的 boring-but-correct 默认。

## Considered options

- **ECharts**：CN 熟悉、交互丰富，但 options 自由式 → 难校验、幻觉多、护栏脏。**否决（护栏代价）**。
- **自建 viz DSL**：控制力最强但要自建 + 让 LLM 学新格式。**否决**。
- **v1 纯表格、viz 推后**：最 YAGNI，但"画图"是核心动词 → 太瘸。**否决**。
- **Svelte/Vue**：更轻，但 notebook UI 的生态/LLM 熟悉度不及 React。**否决**。

## Consequences

- viz spec = Vega-Lite JSON、schema 校验；v1 chart 类型白名单。
- 前端 React；图表经 react-vega/Vega-Embed，表格用 React 组件。
- viz 校验失败走与 SQL 相同的"重试→退化"路径（0009）。
- 后续加图表类型 = 白名单扩展，不改契约。
- 结果展示须渲染 0009 契约的 `assumption?` 字段为可纠偏旁注（0010 历史视图、0018 假设标注共用）。
- 若未来 CN 市场图表 UX 成优先项，ECharts 是已知重评选项（代价：重引入护栏债）。
