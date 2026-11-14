# 出口代理豁免层：回环恒真直连与 OS 绕过名单判定

## Decision

1. **全出网面叠加统一豁免层，单 matcher 独占链。** 共享出口构造配方以 `Proxy::custom` 装配唯一 matcher（任何显式 `.proxy()` 调用即关闭 reqwest 隐式 system matcher，故该 matcher 返回 `None` 即直连）：豁免判定命中返回 `None` 直连；未命中把代理解析委托给构建时冻结的 hyper-util `Matcher::from_system()`——reqwest `system-proxy` 同源的 env 优先、OS 配置回落解析，不自管读系统代理配置。

2. **豁免判定语义。** 回环恒真（`localhost` 字面与 `IpAddr::is_loopback` 全段——127/8 与 ::1）；OS 绕过名单条目按 WinINET/macOS 通配语义：`<local>`（无点主机）、`*`（一切）、`*.domain` 与裸 `domain`（该域及其子域，点边界感知——`cache.corp` 不匹配 `xcache.corp`）、尾缀 `prefix.*`（Windows 默认名单的地址前缀，`10.*` 不匹配 `100.x`）。CIDR 条目不匹配——两 OS 默认名单无可命中本判定面的条目（macOS 的 link-local `169.254/16` 为唯一近似项），真配置出现需求时再加 ipnet 支撑的匹配。

3. **名单读取腿。** Windows 读 WinINET `ProxyOverride` 原文字符串（`HKCU` Internet Settings，与 hyper-util 自家 Windows 腿同一注册表面）；macOS 读 SCDynamicStore proxies 映射的 `ExceptionsList` 字符串数组（同 hyper-util 自家 macOS 腿的访问面）；其余目标无 OS 代理腿，豁免仅回环。读取不看代理启用旗标——无代理配置时一切本已直连，豁免判定无害。

4. **豁免先于解析、随首建冻结。** 豁免判定无条件先于代理解析生效——OS 名单与 `<local>` 对 env 代理同样生效（用户名单是字面承诺，不做腿别区分）；matcher 与名单快照随出口单例首次成功构建冻结（承 ADR-0139 的首建冻结姿势，mid-session 代理或名单变化不重读）。

## Context

ADR-0139 统一出口后，代理解析骑 reqwest `system-proxy`（hyper-util matcher）：env 腿行为正确（`egress_proxy_env` 集成钉），OS 回落腿存在两层缺口。其一，回环与名单豁免在该腿完全不生效——system-proxy 不读 `ProxyOverride`，回环也被代理接管。其二，hyper-util 0.1.20 的 Windows 腿虽已把 `ProxyOverride` 域条目转入内部 no 列表，但转换丢掉回环 IP、`<local>` 语义与尾缀通配（`127.*`/`192.168.*` 被当字面域），macOS 腿完全不读 `ExceptionsList`。命中面：用户带着「这些地址不走代理」（127.0.0.1、内网 host、`<local>` 类）的代理环境时，本地/内网 HTTP MCP server 连接、内网 LLM 端点的 provider 轮与 preflight 探测全部被推进系统代理——代理不转发到其自身不可达的客户端内网地址，连接直接失败。

## Why

1. **名单是用户配置的字面承诺**：绕过名单存在的意义就是「这些地址必须直连」，任何代理来源（env 或 OS）都不该覆盖它。
2. **单缝单点修**：全出网面已收敛于出口模块（ADR-0139），豁免层落在共享构造配方一处，双面（async/blocking）同构生效。
3. **委托而非自管**：代理选择继续吃 crate 的 env→OS 解析（冻结快照），只叠豁免判定——比全自管读系统配置少一个要维护的解析面。

## Considered options

- **仅回环豁免（最小止血）**：内网 host 仍被推进代理，名单缺口留存。**否决**。
- **仅 Windows 单腿先修**：macOS 名单环境照旧失败，双腿同构的边际成本很小。**否决**。
- **registry/SCDynamicStore 全自管解析**：重造 crate 已有的 env→OS 解析与代理优先级，维护面大。**否决**。
- **等上游补齐 hyper-util**：Windows 域条目已修但回环/`<local>`/尾缀通配与 macOS 全缺，时间线不可控。**否决**。

## Consequences

- 出口模块新增豁免层：纯判定函数 + cfg 平台读取腿 + `Proxy::custom` 委托 matcher，两面各插一行 `.proxy()`；依赖直接化声明三处（hyper-util `client-proxy`/`client-proxy-system`、windows-registry、system-configuration）皆为依赖图既有包，零新增编译。
- 测试面：回环半机器钉——`egress_proxy_env` 扩展为双半（远端探针绝对形式经 env 代理 + 回环 origin-form 直连，同一冻结快照），豁免失效则回环请求撞进捕获端挂红；名单判定语义表（通配四形、点边界负例、双分隔符、大小写）由出口模块纯函数单测钉。
- OS 读腿 CI 不可测（承 ADR-0139 对 OS 回落缝的定性），人工验证配方：先确认环境无 `HTTP_PROXY`/`HTTPS_PROXY`（用户级代理变量会把 env 腿误判为 OS 腿）；系统代理指向本地观察端，`ProxyOverride`/`ExceptionsList` 配入含 `127.0.0.1`、某内网 host 与 `<local>` 的名单；发起 preflight 探测或 MCP remote 连接——名单内 host 观察端不见请求（直连）、名单外 host 观察端见请求；反向对照为清空名单后原名单内 host 变为经代理（观察端见请求或连接失败）。
- env 语义注记：OS 名单与 `<local>` 先于 env 代理生效（豁免无条件）；env 惯例本只认 `NO_PROXY`（其语义经委托的 crate matcher 原样保留），本仓取「名单恒生效」的统一判定。
- **校准 ADR-0139**：Decision 3 的「无需任何代理判定补齐工程」读作「判定补齐以出口缝上的豁免 overlay 落地（本决策）」——不变面：单缝收敛、env 优先 OS 回落姿势、首建冻结快照、MCP 链全异步化；该决策 Consequences 的 env 腿钉与 OS 回落人工配方继续有效。
- 非目标：PAC/WPAD 支持、app 内代理配置轴、mid-session 名单或代理重读、Linux 腿（编译栈无 OS 代理读取面）。
