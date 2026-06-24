# result_N materialization: physical table per step; windowed display + streamed COPY TO export

## Decision

每个 `result_N` 物化为**会话 DuckDB 里的一张物理表**（`CREATE TABLE result_N AS <sql>`），执行完即物化一次，驻留至会话结束或被删除/GC（ADR-0013）。**展示**走前端分页（默认 `LIMIT 10000`，ADR-0005 的 1 万行展示上限），物理表存全量；**导出**走工具侧 `COPY result_N TO 'file'` 流式（不经前端内存）。

## Context

ADR-0003「自动物化进工作集」、ADR-0012「`result_N` 住同一内存 DB」、ADR-0005「1 万行展示 + 全量可导出」反复假设结果"物化"，却从未钉死**物化成什么**（物理表 / 视图 / 惰性），以及「全量导出」在千万行下怎么不 OOM。纯内存会话（0012）能否扛住大结果，取决于此。

## Why

1. **物理表避免长链重算**：视图（VIEW）下 `result_5 FROM result_4 FROM … FROM 源` 每次引用重算整条底层链，长链性能爆炸；物理表只算一次。视图省内存的诱惑被重算性能否决。
2. **物化契合 notebook 心智**：ADR-0003 要求每步可检视/可重命名/可回溯，用户点开历史某步须立刻可见——惰性物化与之冲突。
3. **展示分页控前端内存**：千万行结果不进前端，只取 1 万行展示，物理表存全量。
4. **流式 COPY TO 控导出内存**：导出不经应用内存，DuckDB 直接写盘（ADR-0004 已定 .csv/.parquet 经 COPY TO 工具侧；本 ADR 钉死"流式、全量、不 OOM"）。
5. **内存代价可接受**：物化表吃内存，但 DuckDB 列存压缩 + 透明 temp-spill（0012）兜底，`result_N` 总数有 M=100 上限（0013）。

## Considered options

- **视图（VIEW）**：省内存，但长链每次引用重算底层链，性能否决。**否决**。
- **惰性物化**：省内存，但与 0003 notebook 即时检视心智冲突。**否决**。
- **导出经应用内存**：简单但千万行 OOM。**否决**。

## Consequences

- `result_N` = 会话内物理表，命名按 ADR-0022 单调递增、共享 `FROM` 命名空间。
- 展示默认 `LIMIT 10000`（可调，ADR-0005）；前端分页取数。
- 导出 = 工具侧 `COPY result_N TO` 流式；千万行不 OOM。LLM SQL 仍禁 `COPY`（ADR-0005），导出是工具侧显式用户动作（ADR-0004）。
- 物化表内存占用由列存压缩 + temp-spill（0012）+ M=100 上限（0013）+ memory_limit（0005）共同兜底。
- 重试载荷（回喂发什么）属 prompt 工程，留实现期；架构层“失败→重试→告知”（0005/0009）已定。
- **被 ADR-0030 校准/延伸**：物化物理表明确含 0 行（空物理表）；「展示分页」补「展示行 < 总行数时须披露总行数 + 截断状态」诚实不变量（不静默以截断冒充完整）。
