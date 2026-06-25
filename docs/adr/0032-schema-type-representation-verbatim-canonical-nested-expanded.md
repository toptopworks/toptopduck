# Schema type representation to LLM: verbatim canonical DuckDB physical types, nested types expanded

## Decision

发给 LLM 的 schema 载荷里，每列类型 = **DuckDB 物理类型原样、取单一规范名、嵌套全展开**：

1. **物理类型原样 + 单一规范名**：用 DuckDB 报告的规范类型名（`INTEGER` 不混 `INT`/`INT32`、`VARCHAR` 不混 `TEXT`、`BIGINT` / `DECIMAL(p,s)` / `TIMESTAMP` / `DOUBLE`…），**不翻译**成友好词汇（string/int/float/date/bool）。
2. **嵌套类型全展开**：`STRUCT` 给全字段名 + 类型、`LIST`/数组给元素类型、`MAP` 给键类型 + 值类型——即 DuckDB `DESCRIBE` 的展开形。深度上限（超 N 层摘要）为 impl 调参，v1 全展开。

## Context

ADR-0006 发「schema（表/列/类型）」给 LLM、ADR-0020 明示「DuckDB 推断的类型」并定类型错只能重传、ADR-0026 发首 3 行样本兜底类型歧义——都假设「类型」进了 prompt，却从未钉**类型长什么样**：物理原样还是友好词汇？嵌套展开还是塌成 `STRUCT`？这是写对 DuckDB SQL 的前置依赖（CAST / 类型函数 / `DECIMAL` 精度 / 嵌套字段访问都依赖精确类型）。

## Why

1. **LLM 写 DuckDB SQL，需要精确物理类型**：CAST、类型专属函数、`DECIMAL` 精度、嵌套字段访问（`col.name`）都依赖真实类型；友好词汇丢的正是写对 SQL 所需信息。翻译层 = 摩擦 + 错误源（KISS），Claude（ADR-0007）对 DuckDB 类型本就一线。
2. **单一规范名消除别名歧义**：DuckDB 同一类型多名，统一取规范名避免 LLM 困惑。
3. **语义歧义（VARCHAR 实为日期）由样本兜底、不由类型语义提示**：ADR-0026 首 3 行让 LLM 看真实值自行判断；类型层不加额外「语义提示」（那是样本的活，0020 已定样本兜底）。
4. **嵌套全展开是「物理类型原样」对嵌套的正确做法**：`DESCRIBE` 本就展开；塌成「STRUCT」= 丢掉该列可用的结构内容，LLM 只能从样本猜字段名（可选字段 / 深嵌套难从值反推）→ 写错访问 → 执行失败（ADR-0028）。展开给精确结构，样本补值，互补不互代。
5. **精度优先于 token**（呼应 0006「SQL 质量是命脉」）：物理类型比友好词多几字符、嵌套展开更耗 token，但写错 SQL 的代价（重试 / 失败 / 信任）远高于此。

## Considered options

- **友好词汇（string/int/float/date/bool）**：省 token，但丢精度（`DECIMAL` 精度、类型函数、嵌套），LLM 仍须写 DuckDB SQL → 翻译回真实类型，绕圈易错。**否决**。
- **嵌套塌成 `STRUCT`/`LIST`/`MAP` 不展开**：省 token，但丢字段名 / 结构 → LLM 从样本猜字段名（脆）或写错访问。**否决**。
- **类型加「语义提示」（如 `VARCHAR (looks like date)`）**：与样本职责重叠（样本已暴露值），多一层且 0020 已定样本兜底。**否决**。
- **物理类型混用别名**：同一类型多名致 LLM 困惑。**否决（取单一规范名）**。

## Consequences

- **校准 ADR-0020**：「明示每列 DuckDB 推断的类型」精确化为「发给 LLM 的类型 = 物理类型原样 + 单一规范名 + 嵌套全展开」（UI 明示同源）。0020 Consequences 已追加校准指针。
- **校准 ADR-0026**：schema 载荷的「类型」部分 = 物理类型原样 + 嵌套展开；首 3 行样本补值、不替代嵌套结构（可选字段 / 深嵌套难从值反推），两者互补。0026 Consequences 已追加校准指针。
- 实现侧：schema 序列化取 DuckDB 规范类型名 + 嵌套展开；深度上限（超 N 层摘要）为 impl 调参，v1 全展开。
- 仅窗口内 Dataset 发类型（ADR-0023：窗口外只发表名 + 列名 + 摘要，不发类型）——本 ADR 钉的是「发类型时」的表示，不改变窗口裁剪。
