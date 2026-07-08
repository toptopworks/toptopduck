# 后端 IPC 多会话寻址契约：显式 sessionId 首位参数 + 后端 create_session 生成 + 会话间并发 / 会话内单飞行

## Decision

ADR-0046 / 0051 在前端定义了多会话（顶栏 tabs + per-tab `<SessionPane>` + queryKey 按 sessionId 分片），但**后端 IPC 如何按 session 寻址从未被任何 ADR 决策**。本 ADR 收口这道落地硬前提遗漏：

1. **所有会话作用域 IPC 加 `sessionId`（约定首位参数）**；后端 `State` 持 `Map<SessionId, Session>`，命令按 `sessionId` 查表。
2. **sessionId 由后端生成**：新建 tab = `create_session()` → 后端建 DuckDB 实例 + 返回 `sessionId`（UUID）；id 与资源生命周期原子绑定。
3. **并发模型 = 会话间并发 + 会话内单飞行**：`RwLock<HashMap<SessionId, Session>>`（开 / 关 tab 才写锁，余皆读锁）+ 每 `Session` 内部自己的 cancel token 实 ADR-0021 单飞行。会话间 ask 并发不互斥（不同 DuckDB 实例，ADR-0027），会话内串行（ADR-0021）。
4. **会话作用域边界原则**：凡读写某 session 的工作集 / thread / active / recipe 的命令带 `sessionId`；会话无关（api key / provider config / app config / record_recent_file）不带。
5. **新增 `create_session` / `close_session`**（ADR-0055）会话作用域命令。

## Context

ADR-0027 line 27 只陈述「应用层须管理多个独立内存 DuckDB 实例生命周期」；ADR-0046 line 37 只讲「前端 React 状态持有多个会话」；ADR-0051 只定义前端 queryKey 按 sessionId 分片。**三篇都停在陈述层——无一篇定义后端 IPC 如何按 session 寻址**。

`src/api.ts` 现状坐实：`ask` / `cancel` / `conversation` / `list_working_set` / `active_dataset` / `read_rows` / `save_as_duck` / `open_duck` / `remove_source` **全无 `sessionId` 参数**——后端是单会话架构。这是 ADR-0046 / 0051 的落地硬前提：前端 per-tab + queryKey 分片假设了后端能按 sessionId 寻址，后端 IPC 契约却从未被决策。

## Why

1. **显式 sessionId（vs 隐式活跃态）**：隐式「当前活跃 session」+ `switch_session` 在多 tab 并发下崩盘——两 tab 交替 switch，in-flight ask 会作用到错的 session，直接违 ADR-0027 物理隔离。显式参数无隐式可变状态、可测、与 ADR-0051 前端 queryKey 分片**端到端对称**（前端按 sessionId 分片、后端按 sessionId 寻址），心智一致。
2. **sessionId 后端生成（vs 前端生成 UUID）**：session 的物化资源（DuckDB 实例）在后端，由后端生成 id 保证 **id 与资源生命周期原子绑定**；前端先生成 id 再传后端「创建」会留「id 已发、资源未建」的 race 窗口。
3. **会话间并发 + 会话内单飞行**：直接落地 ADR-0027（物理隔离 → 会话间不互斥）+ ADR-0021（会话内单飞行）。**必须显式写进 ADR**，否则实现易误用全局锁把会话间也串行（多 tab 并发 ask 时性能塌方）。
4. **作用域边界由原则派生**：命令清单不必逐条 ADR 化——「读写某 session 工作集 / thread / active / recipe 的带 sessionId」一条原则覆盖全部会话作用域命令。

## Considered options

- **隐式「当前活跃 session」+ `switch_session`**：多 tab 并发下崩盘（违 ADR-0027 物理隔离）。**否决**。
- **每会话一 Tauri webview**：ADR-0046 已否决（背叛 ADR-0008 低内存动因）。**否决**。
- **sessionId 前端生成**：id 与资源生命周期脱钩、「id 已发、资源未建」race 窗口。**否决**。
- **全局锁串行所有 session**：会话间不必要串行，多 tab 并发 ask 时性能塌方，违 ADR-0027 物理隔离的并发潜力。**否决**。

## Consequences

- **闭合 ADR-0046 / 0051 落地前提**：前端 per-tab + queryKey 分片有后端契约支撑。ADR-0046 / 0051 待追加反向指针。
- **所有会话作用域 IPC 签名变更**（加 `sessionId` 首位）：`ask` / `cancel` / `conversation` / `list_working_set` / `active_dataset` / `read_rows` / `rename_dataset` / `replace_source` / `remove_source` / `remove_active_source` / `set_dataset_privacy` / `save_as_duck` / `open_duck` / `take_persist_error`；新增 `create_session` / `close_session`（ADR-0055）。
- **`ingest_file` 归会话作用域**（带 `sessionId`）——当前无参是单会话遗留；前端从某 tab 拖文件应落到该 tab 的 session。
- **后端 `State` 重构**：单一 `Session` → `RwLock<HashMap<SessionId, Session>>`；每 `Session` 内部持自己的 cancel token（ADR-0021 单飞行）。**锁只在查表 / 增删 session 时短暂持有**——`ask` 拿到 `Arc<Session>` 引用后即释放读锁、长 turn（含 HTTP ≤120s）不持锁；否则 `close_session` 的写锁会被 in-flight ask 阻塞 ≤120s，与 ADR-0055「立即收尾」冲突。`Session` 的真正卸载（DuckDB drop）靠 Arc 引用计数：`close_session` 从 Map 移除 + 标 closing，DuckDB drop 等 in-flight ask 的 Arc 释放（ask 结束 / cancel post-check 丢弃时）——这与 ADR-0055「cancel 后 DuckDB 可立即卸」一致（cancel 即时释放 SQL 阶段占用的 DuckDB；HTTP 阶段本就空闲，Arc 释放时实例自然 drop）。
- **依赖关系**：ADR-0055（关 tab × in-flight）的 `close_session` 是本契约命令族成员；ADR-0055 的关 tab 收尾以本 ADR 的 sessionId 寻址为前提。
- **`open_duck` 在已有 tab 内 resume**：**复用同一 sessionId、实例内容被 recipe 替换**（tab ↔ sessionId 绑定恒定，仅 `create_session` / `close_session` 生灭 id）；不在 `open_duck` 时新建 session——新建 session 是前端 `+` 动作（`create_session`）的职责。
- **延伸 ADR-0051**：前端 queryKey 统一前缀 `['session', sessionId, ...]`（0051 已定）与后端 sessionId 寻址端到端对齐；active / Viewed Result 分离（0051）在后端寻址层无额外影响（active 是后端真相、按 sessionId 寻址，Viewed Result 是前端 UI 态）。
- **留实现期**：`sessionId` 类型确认（UUID string）、Tauri `State` 具体结构、命令清单最终核对、`create_session` 是否在新建时即落一个空 recipe。
