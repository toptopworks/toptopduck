# Session 拆分：TurnRunner + Resumer 深模块 + Materializer trait 注入，聚合根持有共享状态

## Decision

1. **Turn 编排抽出为独立 TurnRunner 深模块**——从 3505 行的 `session/mod.rs` 抽出 `Session::ask` 的 retry / cancel / outcome 路由逻辑为独立 `session/turn_runner.rs`。TurnRunner 持有 `provider` + `materializer` + `cancel` + `timeout`，方法 `run(request, result_name, deps) -> TurnOutcome`——纯编排，**不读 history、不调 persist**（record 留 `Session::ask` facade）。SQL 执行 + 物化通过 `Materializer` trait 注入，TurnRunner 不持有 admin `Connection`。

2. **Materializer trait 封装 try_materialize**——把"执行 SQL + 物化 result_N + 注册 working_set"契约为 `pub(crate) trait Materializer: Send`，方法 `try_materialize(&mut self, sql, cancel, result_name, deps: &mut TurnDeps) -> Result<DatasetDescriptor, ExecError>`。`RealMaterializer`（stateless）从 Session 搬逻辑；fake materializer（脚本化调用序列，仿 `FakeProvider::scripted_seq`）供 TurnRunner + Resumer 单测共用。`TurnDeps` 打包 `&Connection` + `&source_files` + `&mut WorkingSet`。

3. **Resumer 抽出为独立构造器**——`Session::open_duck`（5 phase）的 phase 2/3/4（active 解析 / SQL 链重放 / timeline 重建）抽到 `session/resume.rs` 的 `Resumer<'a>`，不持有 Session，phase 方法返回结构化结果（`ResolvedActive` / `Option<ReplayBreak>` / `Vec<ThreadEntry>`），`open_duck` 填 Session。phase 3 复用 Materializer trait（与 TurnRunner 共享）。phase 1（文件 I/O）+ phase 5（persist）留 open_duck。`RESUMING_COUNT` / `OpenDuckGuard` 全局状态封装进 `session/resume.rs`，`is_resuming()` 读门对 commands 透明不变。

4. **聚合根持有共享状态，子模块借入**——admin `Connection` / `source_files` / `working_set` / `history` 留 `Session`（TurnRunner / Resumer / source lifecycle 编排 + facade 都要读写，独占不可能）；TurnRunner / Resumer 通过方法参数（`&TurnDeps` / phase 结果）借入，不拥有。trait 协作者用 `Box<dyn ...>`（dyn 不泛型），避免 `Session<M>` 类型参数穿透 `commands.rs` / `lib.rs`。

5. **source lifecycle 不深化，仅物理移动**——`ingest` / `remove_source` / `remove_active_source` / `replace_source` / `commit_removal` / `append_source_event` 移到 `session/source_lifecycle.rs`，仍 `&mut Session` 方法（`pub(crate)`）。其可测内核（`cascade_stale` / `active` / `deconflict`）已在 `WorkingSet`，深化为独立对象复杂度移动而非集中（删除测试不通过），故仅做物理移动改善 locality。

6. **测试边界重定义：模块内单测 + blackbox 瘦身**——TurnRunner / Resumer 各加模块内 `#[cfg(test)]` 单测（fake materializer 精确注入 `ExecErrorKind`，不碰 DuckDB / 文件系统）；`query_blackbox` / `persistence_blackbox` 瘦身为端到端骨架（真 DuckDB + 真文件覆盖 Materializer 实现 + facade 编排 + I/O 边界）；`lifecycle_blackbox` / `provider_integration` 不动。

## Context

`session/mod.rs` 增长到 3505 行——承载 Turn 编排（`ask` ~200 行内联 retry + watchdog + 四分支错误路由）、Resume 状态机（`RESUMING_COUNT` 全局 + `OpenDuckGuard` + `ReplayBreak` + `ResumeEvent`）、Source Lifecycle 执行、持久化协调（`persist_if_bound` / `take_persist_error` / `take_pending_conflict`）四个独立领域关注点。`ask` 的多处调用者（含 4 套 blackbox）不得不构造整个 Session 才能驱动一次 turn；retry / error-routing 的具体分支（Resource 不重试 / StaleReference 不重试 / budget 耗尽聚合）难以通过 facade 精确触达（要让真 SQL 产生特定 `ExecErrorKind`）。locality 流失是 ADR-0013 软失效窗口 / ADR-0035 resume 后续 / turn generation id 修已知竞态等改进的前置摩擦。

## Why

1. **locality 是最大收益**——读 Turn 只读 TurnRunner、读 resume 只读 Resumer，不再在 3500 行里跳；这是后续每项改进的开发体验前置。
2. **接口即测试面**——Materializer trait 让编排逻辑（决定要不要重试）与物化实现（执行 SQL）分离，fake materializer 一行注入 `ExecErrorKind::Resource` 即可断言"不重试"，当前要通过真 SQL 触发 Resource 错误才能间接覆盖。
3. **删除测试通过（TurnRunner / Resumer）**——删掉 Session 的上帝性，复杂度集中到有内聚的深模块；source lifecycle 删除测试不通过（复杂度移动），故不深化。
4. **dyn 不泛型**——`Box<dyn Materializer>` 避免 `Session<M>` 类型参数穿透 `commands.rs`（17 命令）+ `lib.rs`（managed state）+ 4 套 blackbox，签名 surgery 收益仅省虚调用（每 turn 一次，纳秒级），过早优化。
5. **共享状态留聚合根**——admin `Connection` 三子模块共用，独占不可能；借入是唯一 sane 选项，Rust 拆借（disjoint field borrows）允许 `self.turn_runner.run(...)` 同时 `&mut` self 的不同字段。
6. **不与现有 ADR 冲突**——纯内部重构，ADR-0007（provider 浅抽象）、ADR-0013（软失效语义）、ADR-0034/0035（resume 契约）、ADR-0028（outcome 分类）文本与契约零改动。

## Considered options

- **保守路线（内部重构，测试不动）**：locality 收益拿到但测试隔离收益打折，retry 分支仍要间接触达。**否决**——放弃"测试边界重定义"的核心兑现。
- **TurnRunner 泛型化 `Session<M>`**：零虚调用但类型参数穿透 IPC 层 + 测试标注泛型。**否决**——签名 surgery 收益不抵成本。
- **record 留 TurnRunner 内（TurnSink trait）**：TurnRunner "完整 turn"语义。**否决**——record 是会话时间线关注点，与编排不同构，多一个 trait 无新能力。
- **source lifecycle 深化为 SourceRegistry 独立对象**：对称美感。**否决**——可测内核已在 WorkingSet，深化是复杂度移动（YAGNI）。
- **Resumer 内进一步拆 ReplayEngine / ActiveResolver / TimelineRebuilder**：每 phase 独立深模块。**否决**——phase 2/4 是几行纯逻辑，碎片化反方向。

## Consequences

- **`session/mod.rs` 从 3505 行降到 ~2100–2600**（ask 移走 + resume 移走 + source 方法移走），仅余聚合根状态 + facade 委托。
- **`commands.rs` / `lib.rs` 零改动**——所有 `#[tauri::command]` 签名 + managed state 注册不变；IPC 契约零影响。
- **测试新增**：`session/turn_runner.rs` + `session/resume.rs` 各 `#[cfg(test)]` 单测；`query_blackbox` / `persistence_blackbox` 瘦身（移走分支不重复）。
- **Materializer trait object-safe**：无泛型方法、无 `Self` 返回类型。
- **延伸 ADR-0013**：LineageTracker 抽出仍延后评估——本 ADR 不动 WorkingSet 的 cascade 逻辑，未来 ADR-0013 软失效窗口 / GC 落地时再判。
- **延伸 ADR-0035**：`OpenDuckGuard` / `RESUMING_COUNT` 物理移到 `session/resume.rs`，语义零改动，`is_resuming()` 读门不变。
- **不延伸 ADR-0007**：provider 抽象仍故意浅，本 ADR 不加深（`UnwiredProvider` 默认实现不变）。
