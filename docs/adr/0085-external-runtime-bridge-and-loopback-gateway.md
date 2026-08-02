# 外部运行时接入:薄桥接 stdio proxy + localhost 回连网关

## Decision

外部运行时经一个**薄桥接进程**回连 app 进程内的**网关**。桥接是被外部 CLI 按 MCP stdio 契约拉起的独立 cargo `[[bin]]`（纯 std main，零业务逻辑——纯字节流 proxy + token 验证，不 `use` lib，release LTO 把 Tauri/DuckDB dead-strip 出二进制）。网关是 app 进程内的 **per-bridge-connection TCP listener**（`127.0.0.1` + OS 随机端口），handler 线程 borrow 当前 turn 的 session 资源（`TurnDeps` / `Materializer` / `ApprovalState` / `sink`），serve MCP `initialize` + `tools/list`（聚合内置 DuckDB 工具，外部 MCP / 技能工具随各源切片并入）+ `tools/call`（approval gate + `tools::dispatch`）。回连安全：256-bit token 经 env 注入桥接（不进 argv），首条消息验证，listener 单连接接受。framing = newline-delimited JSON-RPC（MCP 协议，桥接直通字节流，零翻译）。**审批两正交面**：ACP 面（`session/request_permission`，agent 自带工具，fail-fast）与网关面（MCP `tools/call`，经网关工具，复用 ADR-0080 分级审批 + 挂起）——两层管不同工具集，非冗余。`AcpEngine::run` 不接收 `TurnDeps`，保持纯 ACP 协议驱动；网关 server 是独立 API 对：`bind_gateway()` 非阻塞绑定随机 localhost 端口 + 铸 256-bit token（返回 `GatewayHandle { port, token, listener }`，调用者据此在 spawn 桥接前注入桥接描述符），`serve_connection(handle, ctx)` 阻塞驱动单连接生命周期（返回 `GatewayOutcome`）；由轮次编排层（`Session::ask_with_phase`）起停并与 `AcpEngine::run` 并行驱动。

## Context

ADR-0076 定双运行时 + app 所有的 MCP 网关，标记"未决（实施期）：桥接进程分发形态、网关进程 per-session vs 共享边界"。ADR-0081 定外部运行时 = 数据定义适配器引擎 + ACP 优先，标记"未决（实施期）：桥接进程形态、ACP `session/request_permission` 与网关审批对应"。本 ADR 决议这三点。约束前置：`tools::dispatch` 是 `pub(crate)`，签名 borrow `TurnDeps { &Connection, &mut WorkingSet, ... }` + `&mut dyn Materializer`——这些是 session 的活资源，DuckDB 连接不可跨进程持有，决定网关必须在 app 进程内。

## Why

1. **跨平台一致性**：localhost TCP 三平台（Windows / macOS / Linux）`std::net` 行为一致，零平台分支代码；命名管道 + Unix domain socket 双实现是双轨维护，违 DRY。回连通道是 toptopduck 内部传输，不值跨平台税。
2. **关注分离**：ACP 引擎（协议驱动）与网关（工具执行）经回连通道解耦，各自独立可测；`AcpEngine::run` 不接收 `TurnDeps`，保持纯 ACP 驱动（可单测 ACP 行为），网关 server 独立可测（dispatch + approval），编排层（`Session::ask_with_phase`）拼两者。三层无环依赖。
3. **安全模型匹配场景**：toptopduck 是单用户桌面 app，同机通常单用户；256-bit token + 单连接接受使同机 race 攻击（猜 token 或抢连）物理不可行。Unix socket 的 OS 文件权限 ACL 在多用户主机上更强，但其增益在桌面场景不兑现，不值得为它付双平台实现成本。
4. **桥接零依赖**：纯 std main 不 `use` lib → release LTO 把 lib + Tauri + DuckDB dead-strip 出桥接二进制；启动快（CLI per-turn spawn 它），攻击面小，零状态一致性责任。
5. **审批面正交**：经网关工具（内置 DuckDB + 外部 MCP + 技能）的唯一强制点在网关 `tools/call`（MCP 语义：工具调用是 `tools/call`，不需 permission）；agent 自带工具（claude-code 的 bash/edit 等，agent 自执行、不经网关）的唯一强制点在 ACP `session/request_permission`（app 经协议响应）。两层工具集不重叠，故非冗余。

## Considered options

- **命名管道 / Unix domain socket（回连传输）**：Windows + POSIX 双实现双轨维护，违 DRY。**否决**。
- **共享 listener + session 路由表（网关边界）**：多路复用需 `(session, turn)` 路由表，违 per-session 隔离（ADR-0027）+ KISS；且 handler 仍需 per-turn 借 session 资源，路由表只增复杂度。**否决**。
- **app bin 子命令（`toptopduck --acp-bridge`）**：app bin 是 Tauri GUI 二进制，启动拉 GUI 运行时；CLI per-turn spawn 它的开销不可接受。**否决**。
- **桥接独立 crate（workspace member）**：桥接零依赖（纯 std），同 crate `[[bin]]` 不 `use` lib 已隔离（dead-strip），独立 crate 增 workspace 复杂度无收益。**否决**。
- **Tauri sidecar bundle（`tauri.conf.json` `externalBin`）**：分发形态属打包期；`[[bin]]` 不自动进 Tauri 默认 bundle，过早引入 sidecar 配置耦合 Tauri 打包 + target_triple 后缀，违切片纪律。**否决**——留打包期。
- **length-prefixed framing**：要解析 + 重新封装，桥接不再是直通字节流 proxy。**否决**。
- **私有 JSON-RPC 协议（桥接翻译 stdio MCP ↔ 私有）**：桥接要解析 + 翻译，违"纯传输"。**否决**——用 MCP 协议让桥接零翻译。
- **双重 gate（同一工具集两层审批）**：若 ACP `request_permission` 与网关 `tools/call` 都 gate 同一工具集则冗余；实际两层面管不同工具集（agent 自带 vs 经网关），正交非冗余。**否决**冗余解读。

## Consequences

- **延伸 ADR-0076**：决议"桥接进程分发形态"（独立 cargo `[[bin]] toptopduck-acp-bridge`；Tauri sidecar bundle 配置留打包期）+ "网关进程 per-session vs 共享边界"（app 进程内 per-bridge-connection listener，handler borrow session 资源）。
- **延伸 ADR-0081**：决议"ACP `session/request_permission` 与网关审批对应"——两正交审批面（ACP 面 = agent 自带工具 / 网关面 = 经网关工具）；ACP 面 fail-fast 保留，网关面 `tools/call` gate 复用 ADR-0080。
- **校准 ADR-0080**：网关 `tools/call` gate 是经网关工具（内置 + 外部 MCP + 技能）的唯一强制点；内置工具零审批放行（Decision 1），外部工具逐次确认挂起（Decision 2），机制经 `ApprovalState::gate` 复用 issue #294 既落。
- **`AcpEngine::run` 签名不变**：网关 server 作为独立 API 由编排层起停；ACP 引擎只驱动 ACP 协议，工具执行全在网关 handler 线程。
- **未决（实施期）**：桥接 bin 生产路径解析（Tauri sidecar bundle vs `current_exe()` 同目录，打包期）；ACP 面 `decide_permission` 挂起策略（claude-code E2E 验证 `request_permission` 实际行为后定）；网关 `tools/list` 工具表聚合（内置 + 外部 MCP #301 + 技能工具）当前只落内置表，外部聚合随各源切片并入。
