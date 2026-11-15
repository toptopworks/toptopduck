# DuckDB 扩展通道：配置三档语句级放开，隐式装载归零

## Decision

扩展通道治理为**配置三档**（`EngineDefaults` 三态枚举 `off` / `core` / `community`，默认 `off`；设置页渲染为主开关 + 社区子开关的联动组）：`off` 档通道全关——`INSTALL` / `LOAD` 语句在 preflight 拒绝；`core` 档 agent SQL 可写 `INSTALL` / `LOAD`（官方核心扩展，`allow_community_extensions` 维持 false）；`community` 档追加 `allow_community_extensions=true`（社区构建档）。引擎 `autoinstall_known_extensions` / `autoload_known_extensions` **全档恒置 false**：bundled 静态扩展（core_functions / parquet / json）不受影响，其余扩展的装载只经显式 `INSTALL` / `LOAD` 语句边界——联网只发生在 `INSTALL` 语句处。沙箱 CTAS wrapping 模型不变：preflight 把扩展语句识别为前置语句逐条执行，剩余 SELECT 照旧包 CTAS；放开仅涉沙箱——admin 连接只跑工具控制语句，无任意 SQL 面。`LOAD` 治理为**函数面守卫**而非扩展白名单：preflight 增设**写函数拒绝清单**（首批 `st_write`），命中即结构化拒绝、引导 agent 走会话产物面；读面维持 ADR-0137 D4 现状（扩展自带读函数如 `st_read` 随任意绝对路径放开无新增权）；URL / 远程读取维持 FsAcl `Unresolvable` 拒绝。扩展二进制安装目录重定向至应用数据目录（`SET extension_directory`），不落 `~/.duckdb`。扩展通道错误归 Runtime 档（agent 可自纠：先 `INSTALL` 再 `LOAD`）。

## Context

现状是隐式半开：libduckdb-sys bundled 构建显式编译 `DUCKDB_EXTENSION_AUTOINSTALL_DEFAULT=1` 与 `AUTOLOAD_DEFAULT=1`，而全仓对两项零显式配置——任何非静态扩展函数（icu collation、spatial，连 json 都不在静态清单）首次使用即触发静默联网下载并装载，网络行为发生在任意 SQL 边界、无裁决、不可观测；显式 `INSTALL` / `LOAD` 语句则被 CTAS wrapping 拦截。扩展生态按信任分档：官方核心扩展（icu / spatial / httpfs 等，官方构建签名）与社区扩展（同走官方 CI 构建签名，但无官方维护与审计承诺；`allow_community_extensions` 在 bundled 构建下默认为 `true`，社区把关不能依赖该上游默认）。生态诉求场景（中文区域排序等）全在 core 档。分档生态事实的另一面：带文件 / 网络 IO 的扩展（spatial 的 `st_read` / `st_write`、httpfs 的远程读取）装载后部分函数绕过 FsAcl——其守卫只看 `read_*` 前缀——而 ADR-0137 D4 后读面已放开至任意绝对路径，绕过的实际增量集中在写面（FsAcl 写仅限会话临时目录）。

## Why

1. **默认态从失控半开翻转为全关**：静默联网从隐式副作用收敛为显式 `INSTALL` 语句边界的行为——可观测、可预期，网络动作与用户意图一一对应。
2. **高级功能显式开**：扩展通道是高级能力，普通用户不需要；默认 off、设置页显式开档——生态诉求的满足方式是显式开档而非默认可用。
3. **函数面守卫优于扩展白名单**：生态扩展普遍带文件 / 网络 IO，逐扩展审计与纳管成本追扩展数跑；读面已随 D4 全盘放开，真实旁路只剩写函数——拒绝清单一次覆盖且精准。
4. **骑用 DuckDB 自带信任分档**：`allow_community_extensions` 即官方档位开关，开 community 是一行配置不是机制变更，不自造信任机制。

## Considered options

- **现状显式化（维持 AUTOINSTALL=1 零实现）**：联网行为仍隐式发生在任意 SQL 边界，不可观测不可预期。**否决**。
- **配置面预装（EngineDefaults 扩展清单实例化时 LOAD）**：清单外扩展无路可走，agent 生态愿望只解决一半。**否决**。
- **逐扩展 LOAD 白名单（首批 {icu}，文件系扩展纳管后准入）**：纳管成本随扩展数线性涨，生态扩展普遍带 IO 使白名单趋近全拦。**否决**。
- **core+community 默认全开**：社区构建无官方审计承诺，默认态不应暴露该供应链面；社区档属用户显式选择。**否决**。
- **写面也无守卫（st_write 放行）**：会话临时目录写面语义是 LLM 路径幻觉防护，独立于对抗假设。**否决**。
- **扩展安装目录维持默认 ~/.duckdb / per-session 临时目录**：前者 app 写用户 home、卸载不净；后者每次会话重复联网下载，带宽与体验浪费，扩展二进制共享无害故隔离收益不成立。**否决**——重定向应用数据目录。

## Consequences

- 默认 off 档下非静态扩展函数报 extension not loaded 结构化错误且无 INSTALL 路径（语句拒绝）；json 随本裁决进 bundled features，基础格式能力不依赖扩展通道。
- community 档开启即用户显式接受社区构建的维护 / CVE 响应风险；开档的生效语义（新开沙箱实例即新档）归实现票。
- 写函数拒绝清单的不完备性接受：新带写函数的扩展按需补清单；清单命中引导走会话产物面。
- URL / 远程读取维持拒绝——放开是独立裁决（远程数据面 vs FS 白名单边界），不在本 ADR 范围。
- 实现票另开：preflight 扩展语句提取与写函数清单、`EngineDefaults` 三态枚举、`extension_directory` 重定向、设置页联动开关组。
