# 关 tab 与 in-flight turn 的生命周期契约：隐含 cancel + 立即卸前端 + 后台丢弃 + recipe 不含 cancelled turn

## Decision

「关一个正有 in-flight ask 的 tab」——一个被 ADR-0046 / 0051 / 0021 / 0034 / 0027 五篇共同假设、却无任何一篇定义的场景——定案为：

1. **前端 fire cancel（不等）→ 立即移除 tab + `removeQueries(['session', sid])` + 卸载 `<SessionPane>`**。用户视角 tab 瞬间消失，无等待。
2. **后端标该 session 为 closing**；in-flight ask 继续跑完 HTTP（≤ `REQUEST_TIMEOUT`=120s，ADR-0021 软取消硬约束），post-check 发现 closing → **跳过 materialize、丢弃、不追加 thread、不进 recipe**。
3. **DuckDB 实例在 cancel 释放后立即卸载**——HTTP 阶段不占 DuckDB（ADR-0021：`InterruptHandle` 槽空）、SQL 阶段 query interrupt 即时释放；**无需等 HTTP**。
4. **recipe 落盘不含 cancelled / in-flight turn**（守 ADR-0021 作废语义 + ADR-0034 productive 链）。
5. **不加「确认关闭」对话框**。

## Context

ADR-0051 写了关 tab 的**前端侧**（`removeQueries` + 卸载 `<SessionPane>`），ADR-0046 写了关 tab 的**语义**（落 recipe + 卸载非销毁）。但**没有任何 ADR 定义「关一个正在执行 turn 的 tab」**。三道子裂缝：

- **前端 promise 孤儿**：in-flight `ask` 是 Tauri 全局 IPC，`<SessionPane>` 卸载后 promise 仍在飞；resolve 时组件已卸、cache 已 remove——乐观追加的 `setQueryData` 打在空 cache 上。
- **后端 DuckDB 卸载竞态**：关 tab 要卸 DuckDB（ADR-0027 释放内存），但 in-flight turn 可能正占着它。
- **recipe 收纳问题**：in-flight turn 没 outcome；落 recipe 时这个半成品在不在？cancelled turn 进不进 productive 链？

关键事实（ADR-0021）：真实 LLM HTTP 走同步阻塞，cancel 仅置 cooperative flag，**HTTP 仍跑完 ≤120s**，返回后 post-check 丢弃、落 Cancelled；但 **HTTP 阶段 `InterruptHandle` 槽为空（不占 DuckDB）**，仅 materialize（SQL）阶段占 DuckDB 且 cancel 是硬即时的。ADR-0040 限定执行窗口（提问已提交、outcome 未达）禁源管理。

## Why

1. **用户视角零等待**：tab 瞬间消失（ADR-0001 非技术用户友好）；DuckDB 立即释放（ADR-0008 低内存）。
2. **DuckDB 卸载无竞态**：靠「HTTP 阶段不占 DuckDB + SQL 阶段 interrupt 即时」这一 ADR-0021 既定事实——卸载前后端只需同步确认 in-flight query 已 interrupt 释放（实现细节），架构上「cancel 后 DuckDB 可立即卸」成立。
3. **recipe 语义干净**：cancelled turn 不进 productive 链，是 ADR-0021 作废语义 + ADR-0034 的直接推论，零新规则。
4. **不加确认**：ADR-0021 已赋用户「随时取消」权（停止按钮），关 tab 隐含 cancel 是自然延伸；ADR-0035「宁可打断」针对的是**数据时效静默危险**（漂移 / clobber），关 tab 不损数据（cancelled 作废、recipe 不含），不在其列；多一个确认框对非技术用户是净摩擦。
5. **唯一代价（后台烧 ≤120s quota）是 ADR-0021 软取消的固有债**，关 tab 复用、不放大（ADR-0021 单 in-flight 限制每会话最多一个）。

## Considered options

- **关 tab 先 cancel + 等 outcome 落地再关**：等 ≤120s，非技术用户灾难。**否决**。
- **关 tab 前确认对话框**（「有查询进行中，取消并关闭？」）：契合 ADR-0035 诚实脊柱，但软取消等待仍在 + 增摩擦。**否决**。
- **禁止关闭有 in-flight 的 tab**（关闭按钮置灰到 turn 完成）：用户被 ≤120s 锁死。**否决**。
- **cancelled turn 进 recipe**：违 ADR-0021 作废 + ADR-0034 productive 链。**否决**。
- **后台保留 in-flight 结果**（HTTP 完成后落进已关闭会话）：语义混乱（用户已关，结果落给谁）+ 违「立即卸载」。**否决**。

## Consequences

- **新增 `close_session` IPC**（会话作用域、带 sessionId，见 ADR-0056），触发 cancel + 标 closing + 落 recipe + 卸 DuckDB 的后端收尾。
- **依赖 ADR-0056**（后端 IPC 多会话寻址）：`close_session` 是 ADR-0056 定义的会话作用域命令族成员；本 ADR 的关 tab 收尾以 ADR-0056 的 sessionId 寻址为前提。
- **延伸 ADR-0046**：关 tab 语义补全「in-flight turn 场景」——关 tab ≠ 等待，而是隐含 cancel + 后台丢弃。ADR-0046 待追加反向指针。
- **延伸 ADR-0051**：关 tab 清理补「in-flight mutation 处理」——fire cancel 后立即 `removeQueries`，in-flight promise resolve 时 cache 已移除（`setQueryData` 打在空 cache 须无害处理 / no-op）。ADR-0051 待追加反向指针。
- **延伸 ADR-0021**：软取消的 ≤120s 后台窗口在「关 tab」场景复用，明确不新增债。ADR-0021 待追加反向指针。
- **被 ADR-0058 引用**：关 tab in-flight 场景的「前端 promise 孤儿」（`setQueryData` 打空 cache）仍归本 ADR + 0051 处理，不上抬到 ErrorBoundary（React ErrorBoundary 技术上不 catch async promise）。见 ADR-0058。
- **被 ADR-0059 延伸**：关 tab in-flight 的 phase / listener 收尾与「立即卸前端 + 后台丢弃」一致——`turn-progress` listener 随 `SessionPane` 卸载 cleanup、phase 随卸载销毁，后台孤儿 event 无害，无需额外处理。见 ADR-0059。
- **后端实现**：`close_session` 标 closing → in-flight ask post-check 发现 closing 跳过 materialize → DuckDB interrupt 释放后卸载 → 落 recipe（不含该 turn）。
- **留实现期**：多个 tab 同时关闭的串行 / 并行收尾、closing 状态的并发安全细节、`setQueryData` 打空 cache 的无害化（TanStack Query 对已 remove 的 key setQueryData 默认 no-op，实现期验证）。
- **被 ADR-0060 改写措辞**：「关 tab」→「关闭会话」（载体从顶栏 tabs → 左会话栏，0060），语义不变（隐含 cancel + 立即卸前端 + 后台丢弃 + recipe 不含 cancelled turn）；机制（fire cancel + removeQueries + 卸载）不变。见 ADR-0060。
