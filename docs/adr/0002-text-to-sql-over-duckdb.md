# Execution model: Text-to-SQL over DuckDB

## Decision

自然语言 → 由 LLM 生成 **DuckDB SQL** → 在嵌入式 DuckDB 引擎上执行 → 返回结果集。**不**使用代码解释器（不生成、不执行任意 Python）。

## Context

执行模型是产品灵魂。备选有代码解释器（Pandas）、纯 SQL、受约束 DSL。需求格式含 JSON/Parquet/Excel，且用例含"处理"——表面上倾向代码解释器。

## Why（为什么明知 JSON 与"处理"仍选纯 SQL）

1. **格式广度不是问题**：DuckDB 原生直接读 CSV/Parquet/JSON（含嵌套），SQL 侧无短板。
2. **爆炸半径小、更安全**：SQL 是声明式的，本地执行的"作恶面"远小于任意 Python 代码。
3. **桌面包更轻**：无需捆绑 Python 运行时（省 ~30–50MB 与版本/分发复杂度）。
4. **幻觉面更小**：约束到 SQL 文法，比生成自由代码更可控、更易校验。

## Considered options

- **代码解释器（Pandas + DuckDB）**：最灵活，但需捆绑 Python + 本地执行隔离，且任意代码风险更高。**否决**。
- **受约束 DSL（function calling 操作目录）**：最安全，但要自建并长期维护一套操作目录，表达力受限。**否决**。

## Consequences

- **表达力有天花板**：SQL 擅长的关系查询/聚合/清洗/Pivot（DuckDB 支持 PIVOT）均 OK；但**统计建模、机器学习、任意自定义变换**不在本期能力范围内。
- 若未来出现强需求，需要一个**显式逃生舱**（如受控的代码执行扩展）——届时另立 ADR。
- LLM 生成 SQL 需强 schema 感知（表名/列名/类型），并需防注入与"查询不安全"的护栏。
