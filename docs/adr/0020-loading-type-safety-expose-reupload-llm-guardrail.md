# Loading type safety: expose inferred schema, re-upload to fix, LLM sample guardrail; no guided type confirmation for CSV/JSON in v1

## Decision

CSV/JSON 源 Dataset copy-in 后，在 UI **明示每列 DuckDB 推断的类型**（可检视）；类型推断错误的**唯一修正路径 = 重新上传**（ADR-0012），会话内不改源（ADR-0004 只读不变）；LLM 经 ADR-0011 的 3 行真样本**感知高危类型错**（前导零丢失、混合类型截断、日期 locale）→ 经 `assumption`（ADR-0009）主动标注 + 提供修正 `result_N`（CAST/字符串处理）。**v1 不对 CSV/JSON 做引导式类型确认**（Excel 的引导加载仅因 sheet 结构杂乱，ADR-0015）；高危模式自动检测/确认留 v2。

## Context

ADR-0015 给 Excel 配了"尽力规整 + 引导加载"。但 CSV/JSON 同样有类型推断风险（DuckDB 自动推断：ID/编码/手机号 → INTEGER 丢前导零、混合类型截断、日期 locale、JSON 数字/字符串边界/嵌套），却无对应 ADR。而 ADR-0012（copy-in 冻结）+ ADR-0004（源只读）合起来 = 推断错误不可逆；非技术用户看到的是"工号/手机号变了"——信任命门。需框定 CSV/JSON 的加载类型安全姿态，并统一 Excel 与 CSV/JSON 的加载类型安全叙事。

## Why

1. **多数 CSV/JSON 推断正确，引导式确认对 v1 是 YAGNI**——全量"每列类型对吗？"确认摩擦大，违背服务非技术用户（ADR-0001）；Excel 才需要引导，因其多行表头/合并单元格/杂乱结构。
2. **明示推断类型 + 重传 = 最小且不破现有边界**：不破 0004 只读、复用 0012 重传；用户有发现错误的检视面，修正路径明确。
3. **LLM 真样本兜底是 0011 的自然延伸**：样本暴露的类型矛盾（如 `007` vs INTEGER）LLM 可感知，经 assumption 标注 + 修正 result_N，把"不可逆源错误"软化为"可派生修正"。
4. **诚实优于假装准确**：推断可能错是已知局限，明示类型 + 兜底路径是诚实姿态（呼应 0011/0017）。

## Considered options

- **v1 给 CSV/JSON 上引导式类型确认（类 0015）**：最稳，但多数文件推断正确，全量确认摩擦大，违背非技术用户定位。**否决（v1），高危检测留 v2**。
- **静默 copy-in、不暴露类型**：最省，但用户无法发现错误，信任风险。**否决**。
- **源可写、允许会话内改源类型**：最灵活，但直接破坏 0004 只读信任命门。**否决**。

## Consequences

- **校准 ADR-0012**：copy-in 冻结意味着类型推断错误不可逆；明示推断类型 + 重传为修正路径，LLM 经样本兜底。
- CSV/JSON 加载须在 UI 暴露每列推断类型（非阻塞、可检视）。
- Excel（0015）与 CSV/JSON 的加载类型安全由此 ADR 统一叙事：结构杂乱走引导（0015），类型推断走暴露 + 兜底（本 ADR）。
- 高危模式自动检测/引导式类型确认（前导零、混合类型、日期 locale）为已知 v2 增强点。
- **被 ADR-0032 校准**：「明示每列 DuckDB 推断的类型」精确化为「发给 LLM 的类型 = 物理类型原样 + 单一规范名（不混别名）+ 嵌套全展开（STRUCT 字段 / LIST 元素 / MAP 键值）」；UI 明示同源。
