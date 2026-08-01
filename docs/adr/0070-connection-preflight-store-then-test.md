# 连接预检（preflight）：先存后测 + list models 主路径

## Decision

profile 配置流程引入连接预检：在 Settings 的 Profiles tab 编辑 profile 时，可发起一次「Test connection」预检。key 流向采用**先存后测**——set key（one-shot IPC 进 keychain，沿用现状）与 test connection（Rust 从 keychain 取 key 发测试请求）解耦成两个独立动作，test 不回滚 keychain。预检请求走 **list models 主路径**（`GET /models`，两协议各按 `base_url` 拼路径）+ **最小 messages ping fallback**（端点不实现 `/models` 时降级）；返回的 model 列表喂给 model 字段下拉，列表**不持久化**（内存缓存，不进 app-config）。

## Context

ADR-0064 开放多协议多 profile，但 profile 配置的唯一校验时机是第一次真跑 turn——base_url / key / model 任一错都只在 turn 失败时暴露（ADR-0044）。用户存了写错 base_url 的 profile，要等到提问才见失败、回 Settings 改完再试，摩擦高。需在配置时给一次「这套组合能不能跑」的早验。

## Why

1. **先存后测不扩信任边界**：set key 沿用 ADR-0029 的 one-shot IPC（前端→Rust→keychain，前端只收回 bool）；test 是新增 IPC，Rust 从 keychain 取已存 key 发请求。key 流向与现状一致，不引入「明文 key 跨 IPC 临时传递」的新路径。测失败留在 keychain 的 entry 是孤儿（profile id 稳定、不引用即无害），ADR-0064 已为同型孤儿 sanctioned。
2. **list models 一鱼两吃**：一次 `/models` 往返既验 key+endpoint+协议全对，又产出该 profile 支持的 model 列表，治「model 字段纯手填、用户得查文档」的摩擦。ping fallback 兜底「中转/自建网关不实现 /models」的兼容差异。
3. **set 与 test 解耦**：set 是纯存（即时、返回 bool，沿用现状语义）；test 是「用已存 key 验一次」。解耦让用户改 base_url/model 反复 test 时不用重输 key，且 set 语义不被 test 成败污染。

## Considered options

- **内存测试（验通过才存 key）**：前端交 key 经 IPC 给 Rust（不落 keychain，内存临时持有）→ 发测试 → 通过后用户再保存才进 keychain。心智上「验通过才存」对，但要扩一条测试专用 IPC + Rust 临时明文 key 生命周期管理，反复调参重测时 key 要么重输要么缓存；为微妙心智付双 IPC 代价不值。**否决**。
- **不用 key、只测 endpoint 可达性**（DNS/TCP/TLS）：完全不碰 key，但测不出「我的 key 对不对」——而那是用户最想要的。价值塌掉。**否决**。
- **统一最小 messages ping**（两协议都走 ping，不探 model 列表）：一致性高，但放弃 list models 的附带产出，model 字段仍手填。**否决**。

## Consequences

- **碰 ADR-0029 不变量 3**：key 流向不扩（one-shot IPC + Rust 发 HTTP），仅新增 test IPC（Rust 从 keychain 读已存 key）；不变量 3（key 仅存 Rust、前端只看 bool）保留。
- **新增 IPC `test_profile(profile_id)`**：Rust 读 profile 配置 + 从 keychain 取 key + 按 protocol 发 list models（失败降级 ping）+ 返回分类结果（成功 / key 错 / keychain 不可用 / endpoint 不可达（传输）/ endpoint 无效（bad scheme）/ 不兼容）；错误分类沿用 ADR-0044。校准：keychain 读取本身失败（锁定 / 服务关闭 / 权限撤销 / entry 损坏）独立分类为「keychain 不可用」，不与「key 错」混同——信任根不可用（ADR-0029）与 key 错误是两种修复路径，读路径与 clear_key_for 同形传播故障、不吞错。校准：bad-scheme 配置错误（`file:` / `data:` / scheme-less，#279）独立分类为「endpoint 无效」（`InvalidEndpoint`），不与「endpoint 不可达」（`EndpointUnreachable`，传输故障）混同——URL 本身无效（改协议）与 URL 有效但连不上（查 DNS/TLS）是两种修复路径。
- **model 列表不持久化**：list models 返回仅用于 model 字段下拉，内存缓存、不进 app-config（ADR-0038——app-config 只存偏好/指针，不存探测快照）；list 失败或未测时 model 字段回退手填。
- **已知收窄**：preflight 是「尽力早发现」非绝对保证——个别端点 `/models` 不校验 key（返回 200 即使 key 错），preflight 误报通过，第一次真 turn 仍按 ADR-0044 失败。诚实收窄，非隐藏 bug。
- **校准 ADR-0064**：profile 配置流程新增 preflight 环节；model 字段选择方式从手填升级为 list models 探测下拉（失败回退手填），profile schema 形状不变（model 仍是字段）。
