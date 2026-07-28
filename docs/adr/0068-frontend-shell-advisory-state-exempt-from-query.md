# 前端 shell 层状态归属:advisory state 保持 React 原生,不进 TanStack Query

## Decision

前端 shell 层(非 session 级)的状态**豁免 ADR-0051 的 Query 模型**,保持 React 原生 `useState` + 手工 refresh,不进 TanStack Query:

1. **shell 层三组 fetch 全走 React 原生**
   - `list_sessions`(sessions 列表,`sessionsEpoch` 计数器触发重拉)
   - `get_app_config` / `set_app_config`(app-config 容器)
   - `get_provider_config`(`refreshKeyStatus`,mount + switch profile 两处)
   - 写路径(`commitAppConfig` / `setProviderConfig`)直接调 IPC,不走 `useMutation`

2. **advisory state 定性**——shell 层持有的是「前端为 UI 方便持有的咨询副本」,非「后端运行时真相镜像」:
   - sessions 列表从 recipe + mtime 派生元数据(ADR-0061),非会话运行时真相(运行时真相是 openSessions 的活实例)
   - app-config 是 preference 容器(ADR-0038)
   - provider config 的 has_key 是从 active_profile 的 keychain slot 派生的布尔指标(ADR-0029/0064)

3. **app-config 混合容器不拆分**——app-config 同时装 preference(theme / locale / active_profile)+ 客户端 UI 态(sidebar_collapsed / rail_collapsed / window 几何)+ provider 派生(has_key),**整体当 React advisory state**,不按字段拆分走不同状态机制。

4. **ADR-0051 line 8 的 provider config 指令被本 ADR 精确化**——0051 落地时(早于 0064)provider config 是独立服务端态;0064 之后 active_profile 进 app-config,provider config 的状态边界被 app-config 容器吸收,不再独立走 Query。

## Context

ADR-0051 收口前端状态分层为「服务端态走 Query + 客户端 UI 态走 React 原生」,line 8 明列 provider config 为服务端态,line 67 明说 shell rail 折叠状态(0054)属客户端 UI 态不进 Query。但 0051 聚焦 session 级(working set / active / thread),**未讨论 shell 层**(sessions 列表 / app-config / provider config 的 has_key)的状态归属。

现状代码 shell 层全走 `useState` + 手工 refresh,`App.tsx:299-301` 注释明确「the persisted sidebar list is advisory state held in React, not TanStack Query, mirroring how app-config is fetched」——是有意设计,非遗漏。但这个豁免从未被 ADR 记录,且与 0051 line 8(provider config 进 Query)字面冲突;0064 之后 active_profile 进 app-config,使 app-config 成为「preference + 客户端 UI 态 + provider 派生」的混合容器,0051 的单字段定性不再适用。本 ADR 收口 shell 层状态归属。

## Why

1. **advisory state 语义不同于 server truth**——sessions 列表是派生元数据(0061,从 recipe + mtime 派生)、app-config 是 preference(0038)、provider has_key 是派生布尔(0029/0064);它们不是后端运行时真相的镜像,与 working set / active / thread(后端真相)不同类,0051 的「服务端态走 Query」针对的是后者。

2. **app-config 高频小字段写违 Query 失效模型**——window 几何持久化 `onResized` debounce 500ms 写 width / height / x / y(0054),若整体走 Query,每次写后 `invalidateQueries(appConfig)` 逼所有消费者(sidebar / topbar / profile switcher)重拉,而它们不关心几何字段——sidebar 闪动、性能退化。

3. **shell 层单消费者无共享 cache 收益**——Query 的价值是多消费者共享 cache + 自动失效;shell 每个 fetch 是单消费者一次性 mount + 用户动作后手工 refresh,无多消费者场景,`sessionsEpoch` 计数器作为手工 invalidate 已足够。

4. **provider has_key 调用点稀疏**——`refreshKeyStatus` 仅 mount 一次 + switch profile 后一次(0065 switcher 提交),`useState` + `useCallback` 零损失。

5. **容器拆分破坏统一写口**——`commitAppConfig` 是几何 / collapse / profile / settings 的统一乐观写口(不回滚,磁盘真相由 live_config fresh 读兜底);按字段拆分(preference 走 Query、UI 态走 useState、provider 走 Query)会让写路径分裂,同一 `setAppConfig` IPC 被三种状态机制各持一份,引入同步负担。

## Considered options

- **整体走 Query(sessions + app-config + provider 都进)**:违 0051 line 67(collapse 不进 Query)+ 几何高频写致消费者重拉闪动。**否决**。
- **按字段拆分(preference 走 Query / UI 态走 useState / provider 走 Query)**:app-config 容器被拆碎,`commitAppConfig` 统一写口被迫分裂,同一 IPC 多状态机制同步负担。**否决**。
- **provider config 单独走 Query(守 0051 line 8 字面)**:0064 后 active_profile 进 app-config,独立 provider config query 与 app-config 写不同步,引入双真相(切换 profile 后 provider query 仍持旧 has_key 直到自身失效)。**否决**。
- **sessions 列表单独走 Query,app-config 保持 useState**:`sessionsEpoch` 计数器换 `invalidateQueries` 收益边际(单消费者),但增加两套状态机制混用,心智负担。**否决**。

## Consequences

- **shell 层维持现状**:sessions 列表 + `sessionsEpoch` 计数器、app-config + `commitAppConfig` 统一写口、provider config + `refreshKeyStatus` 手工 refresh,均不改。
- **回写 ADR-0051**:line 8 的 provider config 指令被本 ADR 精确化(0064 后 active_profile 进 app-config 容器,provider config 不再独立走 Query);line 67 的 collapse / 几何不进 Query 仍成立,本 ADR 将其扩展到整个 app-config 容器。
- **关联 ADR-0038**:app-config preference 模型不变,本 ADR 钉死其状态机制(React 原生)。
- **关联 ADR-0054**:shell collapse / 几何持久化作为 app-config 字段,随容器走 React 原生,不进 Query。
- **关联 ADR-0060**:sessions 列表(`list_sessions` 派生元数据)随 shell 层走 React 原生。
- **关联 ADR-0064**:active_profile 进 app-config 后,provider config 状态边界被容器吸收,本 ADR 记录此演化的状态归属。
- **未决(留实现期)**:shell 层若出现多消费者共享同一 advisory state(如多窗口、或 sidebar 与 topbar 各自独立 fetch 同一数据),重新评估该子项是否拆出走 Query;v1 单窗口无此场景。
- **出口保留**:若未来 advisory state 出现一致性 bug(如 sessions 列表与磁盘不同步),可作为该子项拆出走 Query 的触发点。
- **CONTEXT.md 不动**:shell 层 advisory state 是实现/状态管理决策,不引入新领域术语——app-config(0038 preference)/ sessions(0060 派生元数据)/ provider config(0029/0064)全是已定义术语。
- **被 ADR-0075 澄清(设置侧调用,契约不变)**:设置侧调用 `commitAppConfig` 的 surfacing 与**逐控件持久化模型**(即时 / 失焦提交失败 = 补偿写回退 + 行内错;显式保存失败 = 仅行内错;全局 draft 退役)见 ADR-0075;本 ADR 的乐观-不回滚契约不变。
