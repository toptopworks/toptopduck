# 出网栈收敛：上游 LLM 域单栈 reqwest 与 MCP 出网链全异步化

## Decision

1. **上游 LLM 调用域单栈 reqwest。** 轮次路径（loop_runtime 双协议 client，anthropic 与 openai chat-completions，rig 注入式）已骑 reqwest；preflight 双协议探针迁 `reqwest::blocking`——一次性请求、无流式、无逐读节拍需求，总超时语义够用，redirect 策略 `Policy::none` 与 client 单例语义等价迁移。

2. **MCP/gateway 出网链全异步化，ureq 退役。** MCP 传输（stdio / HTTP POST / SSE）与 aggregator、gateway 的 deadline 面整体迁 tokio 异步：SSE reader 的节拍轮询退役为 `select!`（读与停止唤醒竞争），HTTP 逐读上界退役为 `tokio::time::timeout`，gateway 的非阻塞 accept/read 轮询循环与 join 宽限期退役为原生取消语义。JSON-RPC 编解码、SSE 事件解析、分页折叠等纯逻辑原样保留——重写面收敛于 I/O 驱动壳。ureq 的全部承载面随之消失，依赖退役。

3. **代理语义统一为异步化的副产品。** ureq 退役后全出网面同骑 reqwest（`system-proxy`：env 优先、OS 配置回落），分裂（ureq 隐式 env-only vs reqwest env→OS 回落）由构造消解；无需任何代理判定补齐工程。

4. **协议扩展前向稳固。** rig 的 provider client 家族默认 HTTP 后端皆为 `reqwest::Client`（含未启用的 openai responses 面），未来第三协议落同一 reqwest 域，栈不再动。

## Context

MCP/gateway 出网链是 app 最后一块同步 IO 域（loop 域已经 ADR-0116 tokio 化），其上已长出三层「同步模拟异步」的补偿机制：SSE reader 以两秒逐读超时节拍轮询停止旗标（`SseClient::drop` 的 join 时延之界）、HTTP 逐读上界补偿 `spawn_blocking` 任务不可取消、gateway 以非阻塞 accept/read 轮询循环模拟多路复用（含平台级 WSAETIMEDOUT 特判）。MCP 规范的正典传输（streamable HTTP，POST 响应可为 SSE 流）已扛在同步面上；官方 Rust SDK 构建于 tokio，生态方向已定。另有一处未裁决的行为分裂：ureq 面隐式 env-only 代理与 reqwest 面 env 优先 OS 回落，GUI 进程无 env 代理变量时同机同配置两种出网行为（轮次路径走 OS 代理、MCP remote 与 preflight 直连）。

## Why

1. **结构税清算**：节拍器、逐读上界、轮询循环、join 宽限期全是「阻塞调用不可取消/不可多路复用」的税，每新增一个网络特性税加一层；异步面以 `select!` 与 drop-future 原生表达同一语义，补偿层整体不存在。
2. **早做的复利**：范式错配正在发生（税在累积），每往同步面投资一分（如代理工厂），将来迁移的表面积就多一分。
3. **重写面可控**：纯逻辑（协议编解码、事件解析、分页）与 I/O 驱动壳分层清晰，后者占比估三至四成；fake-server 集成测试资产走 wire 协议，换驱动不换协议即可复用。

## Considered options

- **全砍 ureq、MCP 以 `reqwest::blocking` 承载**：blocking 面无逐读超时（仅总超时与连接超时，且不暴露底层 socket），节拍与逐读上界不可表达，stop 响应性退化为无界。**否决**。
- **换官方 SDK（rmcp）弃自研传输**：legacy `2024-11-05` 两端点 HTTP+SSE 传输永久断供（既有 remote server 配置失能）；crates 通道依赖 `reqwest ^0.12` 与本仓 `0.13` 错位（未发布线才对齐）；协议纯逻辑已写完已钉住，SDK 节省的是最不需要重写的部分；aggregator、分级审批、probe 等自有层仍需适配重钉。**否决**——未来规范特性（subscriptions / tasks / caching）出现真实消费需求时重开。
- **只翻 MCP 传输、不翻 aggregator/gateway**：轮询循环与 recv_timeout deadline 面同属一个范式块，半翻则同步↔异步桥接复杂度从传输层搬到消费边界。**否决**——全链一起。
- **先做 ureq 面代理补齐工厂（hyper-util Matcher 同源判定 + per-destination agent 缓存）**：往即将重写的面上投资；本决策落地后代理统一免费达成。**否决**。
- **维持现状（不迁移不异步化）**：同步模拟税随每个网络特性累积，且代理分裂留存。**否决**。

## Consequences

- ureq 依赖退役，Cargo.toml 叙事清理；`provider/http.rs` egress 面随 preflight 迁移删码，文件收缩为 URL 校验与截断工具。
- preflight 迁 `reqwest::blocking` 为独立先行票（不在 MCP 链上，方向一致，可并行）。
- MCP/gateway 异步化大票切片交付：bounded-line 异步读面前置基建 → HTTP/SSE 传输 → stdio（tokio::process，Windows 进程树终止语义重钉）→ aggregator/gateway deadline 面 → ureq 退役收尾。
- **校准 ADR-0085**：网关 serve 的「`serve_connection` 阻塞驱动 + accept 非阻塞轮询 + `set_read_timeout` 读循环」读作出网链 tokio 化后由 `select!` / `tokio::time::timeout` 原生承载；不变面——回连 token 验证与单连接接受、newline-delimited JSON-RPC 桥接直通、`!Sync` 连接主线程原地借用的线程约束、serve 收尾由引擎完成信号驱动的语义保证。
- MCP 传输的 no-redirect 守卫语义原样保留；取消/停止响应性不劣于现状（select 语义应即时）。
- 代理语义统一为副产品：OS 级回落在 CI 不可测（runner 无代理配置），显式记缝并留本机人工验证步骤。
- 非目标：rmcp 换装（触发条件见 Considered）、第三协议启用。
