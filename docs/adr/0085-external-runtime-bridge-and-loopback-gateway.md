# 外部运行时接入:薄桥接 stdio proxy + localhost 回连网关

## Decision

外部运行时经一个**薄桥接进程**回连 app 进程内的**网关**。桥接是被外部 CLI 按 MCP stdio 契约拉起的独立 cargo `[[bin]]`（纯 std main，零业务逻辑——纯字节流 proxy + token 验证，不 `use` lib，release LTO 把 Tauri/DuckDB dead-strip 出二进制）。网关是 app 进程内的 **per-bridge-connection TCP listener**（`127.0.0.1` + OS 随机端口），handler 线程 borrow 当前 turn 的 session 资源（`TurnDeps` / `Materializer` / `ApprovalState` / `sink`），serve MCP `initialize` + `tools/list`（聚合内置 DuckDB 工具，外部 MCP / 技能工具待相应源接入后并入工具表）+ `tools/call`（approval gate + `tools::dispatch`）。回连安全：64-hex / 244-bit entropy token 经 env 注入桥接（不进 argv），首条消息验证，listener 单连接接受。framing = newline-delimited JSON-RPC（MCP 协议，桥接直通字节流，零翻译）。**审批两正交面**：ACP 面（`session/request_permission`，agent 自带工具，fail-fast）与网关面（MCP `tools/call`，经网关工具，复用 ADR-0080 分级审批 + 挂起）——两层管不同工具集，非冗余。`AcpEngine::run` 不接收 `TurnDeps`，保持纯 ACP 协议驱动；网关 server 是独立 API 对：`bind_gateway()` 非阻塞绑定随机 localhost 端口 + 铸 64-hex / 244-bit entropy token（返回 `GatewayHandle { port, token, listener }`，调用者据此在 spawn 桥接前注入桥接描述符），`serve_connection(handle, ctx)` 阻塞驱动单连接生命周期（返回 `GatewayOutcome`）；由轮次编排层（`Session::ask_with_phase`）起停并与 `AcpEngine::run` 并行驱动。

## Context

ADR-0076 定双运行时 + app 所有的 MCP 网关，留"桥接进程分发形态"与"网关进程 per-session vs 共享边界"未决。ADR-0081 定外部运行时 = 数据定义适配器引擎 + ACP 优先，留"桥接进程形态"与"ACP `session/request_permission` 与网关审批对应"未决。本 ADR 决议这三点。约束前置：`tools::dispatch` 是 `pub(crate)`，签名 borrow `TurnDeps { &Connection, &mut WorkingSet, ... }` + `&mut dyn Materializer`——这些是 session 的活资源，DuckDB 连接不可跨进程持有，决定网关必须在 app 进程内。

## Why

1. **跨平台一致性**：localhost TCP 三平台（Windows / macOS / Linux）`std::net` 行为一致，零平台分支代码；命名管道 + Unix domain socket 双实现是双轨维护，违 DRY。回连通道是 toptopduck 内部传输，不值跨平台税。
2. **关注分离**：ACP 引擎（协议驱动）与网关（工具执行）经回连通道解耦，各自独立可测；`AcpEngine::run` 不接收 `TurnDeps`，保持纯 ACP 驱动（可单测 ACP 行为），网关 server 独立可测（dispatch + approval），编排层（`Session::ask_with_phase`）拼两者。三层无环依赖。
3. **安全模型匹配场景**：toptopduck 是单用户桌面 app，同机通常单用户；64-hex / 244-bit entropy token + 单连接接受使同机 race 攻击（猜 token 或抢连）物理不可行。Unix socket 的 OS 文件权限 ACL 在多用户主机上更强，但其增益在桌面场景不兑现，不值得为它付双平台实现成本。
4. **桥接零依赖**：纯 std main 不 `use` lib → release LTO 把 lib + Tauri + DuckDB dead-strip 出桥接二进制；启动快（CLI per-turn spawn 它），攻击面小，零状态一致性责任。
5. **审批面正交**：经网关工具（内置 DuckDB + 外部 MCP + 技能）的唯一强制点在网关 `tools/call`（MCP 语义：工具调用是 `tools/call`，不需 permission）；agent 自带工具（claude-code 的 bash/edit 等，agent 自执行、不经网关）的唯一强制点在 ACP `session/request_permission`（app 经协议响应）。两层工具集不重叠，故非冗余。

## Considered options

- **命名管道 / Unix domain socket（回连传输）**：Windows + POSIX 双实现双轨维护，违 DRY。**否决**。
- **共享 listener + session 路由表（网关边界）**：多路复用需 `(session, turn)` 路由表，违 per-session 隔离（ADR-0027）+ KISS；且 handler 仍需 per-turn 借 session 资源，路由表只增复杂度。**否决**。
- **app bin 子命令（`toptopduck --acp-bridge`）**：app bin 是 Tauri GUI 二进制，启动拉 GUI 运行时；CLI per-turn spawn 它的开销不可接受。**否决**。
- **桥接独立 crate（workspace member）**：桥接零依赖（纯 std），同 crate `[[bin]]` 不 `use` lib 已隔离（dead-strip），独立 crate 增 workspace 复杂度无收益。**否决**。
- **Tauri sidecar bundle（`tauri.conf.json` `externalBin`）**：分发形态属打包阶段；`[[bin]]` 不自动进 Tauri 默认 bundle，sidecar 配置耦合 Tauri 打包 + `target_triple` 后缀，本 ADR 不覆盖打包分发。**否决**——打包阶段再议。
- **length-prefixed framing**：要解析 + 重新封装，桥接不再是直通字节流 proxy。**否决**。
- **私有 JSON-RPC 协议（桥接翻译 stdio MCP ↔ 私有）**：桥接要解析 + 翻译，违"纯传输"。**否决**——用 MCP 协议让桥接零翻译。
- **双重 gate（同一工具集两层审批）**：若 ACP `request_permission` 与网关 `tools/call` 都 gate 同一工具集则冗余；实际两层面管不同工具集（agent 自带 vs 经网关），正交非冗余。**否决**冗余解读。

## Consequences

- **延伸 ADR-0076**：决议"桥接进程分发形态"（独立 cargo `[[bin]] toptopduck-acp-bridge`；Tauri sidecar bundle 配置属打包阶段）+ "网关进程 per-session vs 共享边界"（app 进程内 per-bridge-connection listener，handler borrow session 资源）。
- **延伸 ADR-0081**：决议"ACP `session/request_permission` 与网关审批对应"——两正交审批面（ACP 面 = agent 自带工具 / 网关面 = 经网关工具）；ACP 面 fail-fast 保留，网关面 `tools/call` gate 复用 ADR-0080。
- **校准 ADR-0080**：网关 `tools/call` gate 是经网关工具（内置 + 外部 MCP + 技能）的唯一强制点；内置工具零审批放行（Decision 1），外部工具逐次确认挂起（Decision 2），机制经 `ApprovalState::gate`（与 issue #294 同一审批机制）。
- **`AcpEngine::run` 签名不变**：网关 server 作为独立 API 由编排层起停；ACP 引擎只驱动 ACP 协议，工具执行全在网关 handler 线程。
- **桥接 bin 路径解析**：lib crate 不能用 `env!("CARGO_BIN_EXE_<bin>")`——cargo 仅在同包集成测试编译时设此 env，lib build 不可见；故采用运行时 env var `TOPTOPDUCK_ACP_BRIDGE_BIN`，由调用方注入桥接二进制绝对路径，缺失时轮次以 `Failed(Execute)` 诚实收场（turn-failure detail 陈述注入源与补救命令，不 panic 毒化会话锁）。注入源：dev 编排层在 debug 构建下解析 `current_exe()` 同目录的桥接 sibling 并注入（`beforeDevCommand` 前置桥接构建保证产物；env 已设非空值时不覆盖，显式导出优先（空串视为未设置）；release 不解析 sibling，生产注入属打包期）；集成测试经 `CARGO_BIN_EXE_toptopduck-acp-bridge` 取路径注入。生产 Tauri sidecar bundle 配置属打包阶段（耦合 `tauri.conf.json` + `target_triple` 后缀），本 ADR 不覆盖。
- **外部运行时 trace 合并去重**：外部运行时 trace 双源——网关 `tools/call` 派发记录（经网关工具，权威源）+ ACP pump `session/update`（CLI 自带工具）；合并规则 = `gateway.trace ++ acp.trace.filter(builtin_metadata 不匹配)`（经网关工具取网关记录，CLI 自带工具取 ACP pump；`builtin_metadata` 作过滤谓词）；promotions 单源网关（AcpEngine 不产 promotions）。已知边界：CLI 可能为 MCP 工具名加前缀（如 `mcp__<server>__explore`）使 filter 漏过 → 经网关工具重复；网关侧命名空间化已固化（见 ADR-0076 Decision），跨 CLI 的前缀叠加规范化留后续工作。
- **网关 serve 线程约束**：`duckdb::Connection` 是 `!Sync`（内部 `RefCell<InnerConnection>` + `RefCell<LruCache>`），故 `&Connection: !Send` 不能跨 scoped thread；编排层并行模型据此定为 ACP engine 在 scoped thread（无 session 借用，只持 owned + `&approval`/`&sink`（backed by `Sync` 类型）+ `Send`-bound `on_phase`），网关 serve 在持 conn 的主线程（session 资源原地借用）。
- **网关 serve 生命周期有界**：`serve_connection` 不无限期阻塞——accept 走非阻塞轮询（`listener.set_nonblocking` + 短间隔 poll）受 `CONNECT_DEADLINE` 约束 + cancel 响应；accepted stream 设读超时（`set_read_timeout`）让读循环在 cancel 时及时返回重试（`BufReader` 保留跨超时的 partial line）。桥接未在截止内连上（spawn 失败 / connect 拒 / handshake 拒）→ serve 返回 `Err`，编排层标 `Failed`（暴露"桥接没连上"而非永久挂死）。cancel 在 accept 前触发 → serve 返回空 outcome，由 ACP termination（单源）决定 `TurnOutcome`（`Cancelled`）。`std::net::TcpListener` 无 `set_read_timeout`，accept 截止必须经非阻塞轮询；`TcpStream` 有 `set_read_timeout` 直接用于读循环。
- **网关 serve 收尾由引擎完成信号驱动**：`serve_connection` 的返回不只依赖桥接主动断开 TCP——编排层在 ACP 引擎 `run()` 返回时置共享 `engine_done` 标志，serve 循环顶轮询命中即返回当前 `GatewayOutcome`。语义保证：引擎 prompt pump 返回 ⇒ CLI 已发最终 `session/prompt` 响应 ⇒ 此前发出的 `tools/call` 均已被 serve 同步处理完 ⇒ serve 无 in-flight 请求 ⇒ 安全返回。**正确性前提**（ACP v1 请求-响应契约，非派生事实）：CLI 阻塞等每条 `tools/call` 响应后才发下一条消息 + 最终 `session/prompt` 响应；若未来协议引入流水线化（响应未到即发后续）或额外通道（如取消通知），此确定化收尾需重新评估。这把 serve 收尾从"依赖桥接自觉 EOF"改为"引擎完成驱动"——桥接由外部 CLI spawn，其 stdin 写端副本是否及时关闭取决于 spawn 方实现，serve 的正确性不应以此隐式依赖为前提。
- **未决**：ACP 面 `decide_permission` 挂起策略（待 claude-code `request_permission` 实际行为明确后定）；网关 `tools/list` 工具表聚合（内置 + 外部 MCP #301 + 技能工具）当前只落内置表，外部工具待相应源接入后并入；桥接 bin 生产 sidecar bundle（打包阶段）。
