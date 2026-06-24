# Source datasets are immutable in-session snapshots (copy-in); session runs in-memory

## Decision

上传时，每个源 Dataset **copy-in 进会话 DuckDB 成一张表**，内容在 attach 时刻**冻结**。源表对 LLM SQL **只读**（表/schema 级强制，见 ADR-0005）。会话 DuckDB 实例**纯内存**（DuckDB 透明 temp-spill 大数据到磁盘）；**v1 不做会话持久化**——关闭会话即全部释放（呼应 CONTEXT：会话"关闭即重置"）。派生 `result_N` 也住同一个内存 DB。

## Context

ADR-0005 反复说"源以 READ-ONLY attach"，却从未定义源 Dataset 的物理形态。"源是不可变真相"（ADR-0004）这条信任命门，要求在**不可变快照（copy-in）**与**实时文件视图（in-place attach）**之间二选一。

## Why

1. **copy-in 给出有保证的不可变快照**——外部改原文件污染不了会话，`result_N` 血缘永远干净。对命门是"别糟蹋/别误信源"的工具，这个保证值得那点存储。
2. **in-place attach 零拷贝，但源文件在磁盘上可变** → 会话中途源漂移 → 静默错误答案 + 血缘断裂；变更检测只"检测"不"阻止"（re-attach 照样让派生作废）。保证更弱、零件更多。
3. **存储代价可接受**：DuckDB 列存压缩下，CSV→表常更小，Parquet≈1:1，真实最坏翻倍 <2x 且仅限已压缩的 Parquet。日常数据分析体量扛得住。
4. **纯内存会话 DB 呼应"关闭即重置"**；持久化/会话恢复对 v1 是 YAGNI，需要时另开 ADR。

## Considered options

- **in-place attach（实时文件视图）**：零拷贝、省存储，但可变源漂移破坏不可变性与血缘。**否决**。
- **copy-in 到持久 .duckdb 文件（会话恢复）**：能恢复会话，但引入持久化/失效复杂度，v1 不需要。**否决（v1）**。

## Consequences

- ADR-0005 第 1 层措辞校准：read-only 落在**源表级**（非"attach 文件"）；语义不变。
- 想用更新后的源重算 = **显式重新上传**（产生新的会话内快照）。
- 大数据集：DuckDB 透明 temp-spill 到磁盘；超大源付出 copy-in 物化时间 + 临时存储。
- 会话恢复 / 历史持久化**明确不在 v1 范围**（未来需要再开 ADR）。
- copy-in 冻结意味着**类型推断错误不可逆**：DuckDB 对 CSV/JSON 的自动推断（前导零丢失、混合类型、日期 locale）一旦冻住，会话内不可改源类型（ADR-0004）。明示推断类型 + 重新上传为修正路径，LLM 经样本兜底，见 ADR-0020。
