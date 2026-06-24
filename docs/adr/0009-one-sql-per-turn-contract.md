# LLM output contract: one SQL + optional viz spec per turn

## Decision

每个**提问**（一轮）模型返回**一条 SQL + 可选 viz 规格**（产出**一个 `result_N`**），**或一条文本响应（不产 SQL）**——用于越界拒绝（ADR-0017）与消歧澄清（ADR-0018）。多步需求靠**跨轮物化链式**（引用前序 `result_N`）完成。**不做**单轮 pipeline，**不做** plan-then-execute。

## Context

需把 ADR-0003（物化链式）、ADR-0006/0007（viz 规格、Provider 契约）钉到**一张精确输出契约**上。

## Why

1. **KISS + YAGNI**：契约最简 → 护栏最简、错误最干净（一条查询失败 = 一个明确错误，回喂重试），UX 即 notebook cell。
2. **物化链式（ADR-0003）已让多步自然跨轮完成**，无需在单轮塞多语句。
3. **可追溯最强**：每步独立、可检视、可回退，而非一坨黑盒多步。

## Considered options

- **Pipeline**（一轮返回有序多条 SQL，各产 `result_N` + 终态 viz）：一句话做多步，但契约/错误恢复复杂（中间步失败如何回滚？viz 指哪个结果？）。**否决**。
- **Plan-then-execute**（先返回自然语言计划再生成 SQL）：透明可纠偏，但多一轮往返、延迟与成本翻倍。**否决**。

## Consequences

- 契约 = `{ sql: string, viz?: spec, assumption?: string }` | 文本态（澄清/拒绝，无 SQL）；`viz` 缺省即表格。
- `assumption?` 承载"本次 SQL 的自然语言旁注"——0018 的歧义假设标注、0017 的方法名标注（如"用了简单线性回归"）走同一字段；有 SQL 时可选附，文本态不带。结果展示/历史视图渲染为可纠偏旁注（0016/0010）。
- 复杂需求需用户多打几轮（依赖物化链式）。
- 错误恢复简单：单查询失败 → 回喂 LLM 重试 1–2 次 → 仍失败如实告知用户。
