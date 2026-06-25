# Dataset naming: stable reference name (creation-time) decoupled from renamable display label; SQL, recipe chain, and active pointer use the reference name

## Decision

每个 Dataset（源 + `result_N`）有**两个名字，解耦**：

1. **引用名（reference name）= 创建时确定、永不随重命名改变**。源 = copy-in 时分配的机器名（文件名去扩展名 / sheet 名，去冲突后，ADR-0022）；`result_N` = 会话级单调递增、永不复用的编号（ADR-0022）。**LLM 生成的 SQL、落进 `.duck` 的 productive SQL 链、active-dataset 指针** 全部用引用名。
2. **显示名（display label）= 用户可重命名、纯展示**。历史视图 / UI 给用户看显示名；显示层查重（两个 Dataset 不能给用户看同名），但**不进 SQL、不进 recipe 的引用链**。

**重命名 = 改显示名**：不改写任何已存 SQL、不传播依赖、不动 recipe 里的引用名。LLM 对 `result_N` 的自然语言指代经**提问摘要**（ADR-0013/0023）映射到引用名——显示名对 SQL 生成不可见、不必要。

## Context

ADR-0003/0024 让 LLM 写 `FROM result_N`、物理表名即 `result_N`；ADR-0022 说「用户重命名撞名由工具侧去冲突/拒绝」（重命名进共享命名空间）；CONTEXT 说 `result_N`「可被用户重命名」。三者合读隐含「引用名 = 可被改的显示名」——则 ADR-0034 落进 `.duck` 的 productive SQL 链存的是当时的显示名，用户改名后 resume 重放断链。**身份（被 SQL/recipe 引用）与标签（给用户看）是否解耦从未定**，是 `.duck` 格式刚锁死（ADR-0036 `format_version=1`）却藏在 0003/0009/0022 里的硬依赖。

## Why

1. **重命名永不断链、无需改写**：引用名恒定，recipe 的 productive SQL 链按引用名重放永远自洽——resume 完整性零成本保住（ADR-0034）。重命名是 O(1) 显示层操作，不是依赖图改写。
2. **LLM 用稳定名写 SQL 更可控**：LLM 始终 `FROM result_N` / `FROM <源机器名>`，不因用户改名而改变引用习惯；自然语言重定向靠**摘要**（ADR-0010/0013/0023）映射到引用名，显示名不参与 SQL 生成。
3. **显示层查重满足 ADR-0022 撞名意图**：两个东西不能给用户看同名（UX 歧义），但内部引用名天然不撞（`result_N` 单调递增、源机器名去冲突）——把 0022「撞名」精确化为显示层语义，不丢其价值。

## Considered options

- **名字即身份（单一命名空间，重命名传播改写）**：SQL 引用 = 显示名；重命名需传递式改写所有依赖它的已存 SQL（依赖 DAG + 跨源传播 + recipe 一致性）。复杂度不成比例，且 recipe 存显示名 → 改名窗口期的崩溃 / 不一致风险放大。**否决（KISS）**。

## Consequences

- **校准 ADR-0022**：「用户重命名撞名由工具侧去冲突 / 拒绝」精确化为**显示层查重**——重命名只改显示名、不进引用命名空间；源机器名与 `result_N` 编号是创建时确定的**引用名**（恒定）。0022 Consequences 已追加校准指针。
- **校准 ADR-0034**：recipe 的 productive SQL 链、active-dataset 指针均存**引用名**；「中间结果名 / 重命名」（ADR-0036 内容边界）= 引用名 + 显示别名。重命名只动显示层、不波及可重放链 → resume 重放自洽。0034 Consequences 已追加校准指针。
- **延伸 ADR-0003/0024**：`FROM result_N` / `CREATE TABLE result_N` 明确用**引用名**（创建时编号，不受重命名影响）；物理表名 = 引用名。行为不变，仅钉死身份语义。
- **延伸 ADR-0010**：LLM 自然语言重定向经**摘要**映射到引用名；显示名对 SQL 生成不可见。历史视图给用户看显示名 + 摘要。
- **CONTEXT 已更新**：「中间结果」条目精确化重命名语义（显示层别名；引用名恒定）。
- 实现侧：Dataset 维护 (引用名, 显示名) 二元组；显示名默认 = 引用名；UI / 历史视图渲染显示名；喂 LLM 的 schema 载荷与 recipe 用引用名。
- **active-dataset 指针用引用名**（稳定），与 ADR-0035 的 resume 失败处理正交。
