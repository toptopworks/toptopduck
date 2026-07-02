# 前端状态管理：分层（TanStack Query 服务端态 + React 原生 UI 态）+ active/Viewed Result 分离 + per-tab 会话分片

## Decision

前端状态管理定为**分层架构**，并显式分离两个长期被混用的"当前"概念：

1. **分层——服务端态用 TanStack Query，客户端 UI 态用 React 原生，不引 store 库**：
   - **服务端态**（后端为真相：working set / active / thread / row pages / provider config）走 `@tanstack/react-query`——`useQuery` 读、`useMutation` 写、`invalidateQueries` 失效重拉。
   - **客户端 UI 态**（dialog 开闭 / `viewedResult` / loading / guidance 表单）走 React 原生（`useState` + 自定义 hooks + 必要时轻量 Context）。
   - **不引 Zustand / Jotai / Redux**——前端不持有可变领域状态（recipe / working set 真相在后端，ADR-0004 derive-only），无跨组件共享的全局可变态需求。

2. **active 与 Viewed Result 显式分离**：
   - **active**（CONTEXT.md 领域概念：LLM 隐式"作用于"的 Dataset）→ 走 Query（`activeDataset` IPC，服务端真相）。
   - **Viewed Result**（用户在 workspace 大舞台**正在查看**哪个 result pane，纯 UI 选择）→ 走 React 原生，**不进 cache**。
   - 二者语义不同：active 是分析语义（LLM 默认作用对象，ADR-0010 对用户基本不可见），Viewed Result 是 view 选择（用户点了哪个）。产出新结果时 Viewed Result 默认跟随（沿用"产出即选中"体感），但**重选历史结果只动 Viewed Result，绝不碰后端 active**。

3. **Viewed Result 持瘦引用 + 产出时乐观追加 thread**：
   - `viewedResult: { referenceName: string } | null`（仅一个字符串）。
   - `assumption` / `viz` 不独立持有——从 thread query 按 `outcome.Materialized.dataset.reference_name === viewedResult.referenceName` 反查派生（thread 是 turn 载荷的单一真相，`TurnRecord.outcome` 本就带 viz / assumption，见 types.ts）。
   - `handleAsk` 成功后：`queryClient.setQueryData(['session', sid, 'thread'], old => [...old, newRecord])` 把新 turn **乐观追加**进 thread cache（用户即时看到），Materialized 额外 `invalidateQueries(['session', sid, 'workingSet'])` + `['session', sid, 'active']`；后台重拉静默修正。
   - `latestResult` 胖快照（现状 `{ referenceName, assumption, viz }`）退役。

4. **多会话 per-tab 组件分片（ADR-0046 落地）**：
   - `App` 顶层仅持 `openSessionIds: string[]` + `activeSessionId: string`（顶栏 tabs 的元状态）。
   - 每 tab 渲染 `<SessionPane key={sessionId} sessionId={sid} active={...} />`，内部 `useState` / `useQuery` 自治——会话开关 ↔ 组件挂载卸载天然同构。
   - **切 tab**：非活跃 pane 用 CSS `hidden`（`display:none`）保留挂载——不卸载、不重建状态、后端 DuckDB 实例不动（守 ADR-0046「切 tab ≠ 卸载」）。
   - **关 tab**：从 `openSessionIds` 移除 → `<SessionPane>` 卸载 → useState 自然销毁；同时 `queryClient.removeQueries({ queryKey: ['session', sid] })` 整组释放该会话 cache。前后端语义对齐（关 tab = 落 recipe ADR-0034 + 卸 DuckDB ADR-0027 + 清前端态）。
   - queryKey 统一前缀：`['session', sessionId, 'workingSet' | 'active' | 'thread' | 'rows', referenceName?, offset?]`；provider config 等会话无关 query 用 `['provider']` 等无 session 前缀。

5. **v1 不加 turn id，Viewed Result 只指 Materialized**：
   - 非 Materialized 轮次（B 澄清 / C 拒绝 / D 取消，ADR-0028）无 `referenceName`，v1 不支持"点历史非 Materialized 卡片重看"——靠"最新轮次在 workspace 自然渲染"显示。
   - 不给 `TurnRecord` 加稳定 id（避免动 Rust 契约 + recipe 序列化，ADR-0036），出口保留：未来真实需求出现时纯追加 `turn_id`，recipe 已有 `format_version` 兜底前向兼容。

## Context

ADR-0046 Consequences 明确写"单 Tauri webview 内 React 状态持有多个会话"，但**怎么持有、怎么隔离、怎么随 tab 生灭**全部留白；ADR-0016（React + Vega-Lite）、ADR-0045（两栏 shell）、ADR-0049（shadcn 样式栈）定了框架 / shell / 样式栈，但**前端状态管理方案从未被任何 ADR 决策**——这是前端架构最后一块未定的根决策。现状 `App.tsx` 是纯 `useState` + `useCallback` 单组件，所有状态挤在顶层，靠 `refresh()` 在每次 mutation 后重拉 working set + active + thread 三路 IPC（手写服务端态镜像）；且当前是**单会话**实现，ADR-0046 多会话 tabs 尚未落地。本 ADR 收口状态管理架构，并为 0046 的"React 状态持有多个会话"提供具体形态。

## Why

1. **分层契合现有隐含模式 + 多会话降复杂度**——现状 `refresh()` 手写失效重拉正是 TanStack Query 的 `invalidateQueries` 靶子；多会话下 N 个 alive 会话各有 working set / thread / loading，`queryKey` 按 sessionId 分片 + 切 tab 命中 + 关 tab GC 比手写 per-session useState 状态机省一大块。客户端 UI 态无跨组件共享痛点，加 store 库是 YAGNI。
2. **active / Viewed Result 分离守领域语义**——CONTEXT.md 的 active 是"LLM 未显式指明时所作用"（分析语义），用户"在看哪个 result pane"是 view 选择；强行共用会在"点历史结果"时被迫二选一（误改后端 active 是语义错，分裂状态是该显式分裂）。`handleSelectResult` 现状只动前端不调后端，已隐含分离——本 ADR 把隐含架构显式化。
3. **瘦引用消除双重真相**——`latestResult` 的 assumption / viz 与 thread 里同一份载荷分两处持有，迟早走样（未来 thread 带 stale 因果标记时更甚，ADR-0025）。瘦引用让 thread 成为 turn 载荷唯一真相；乐观追加（`setQueryData`）保住"产出即时显示"体感，胖快照最后一点优势消失。
4. **per-tab 组件同构会话生命周期**——会话开关 ↔ 组件挂载卸载一一映射，关 tab 零清理代码（卸载自动释放 + 一句 removeQueries），切 tab `hidden` 保活守 ADR-0046；顶层 Map 方案等于自造一套 React 已有的状态生命周期管理。
5. **不加 turn id 守 YAGNI**——B / C 轮罕见（ADR-0018 窄门槛）且即时性强，"重读历史澄清文本"非一等动作（ADR-0045 Why#3"重开历史结果"针对 Materialized）；加 id 要动 Rust `TurnRecord` + recipe 序列化，为 v1 罕见需求付不对称代价。
6. **lean 契合 ADR-0008 / 0049**——TanStack Query 是逻辑库非 UI 库、体积小；不引重型 store，与 Tauri 低内存动因 + shadcn copy-in lean 栈一致。

## Considered options

- **全 React 原生（沿用 useState + refresh cascade）**：KISS 到极致，但多会话 tabs（0046）下手写 N 会话缓存失效逻辑是自找麻烦，且 latestResult 胖快照双重真相持续。**否决**。
- **引入 Zustand / Jotai 统一管所有态**：把服务端态也塞 store，绕开 Query 的失效 / 缓存语义自造一套；前端无跨组件全局可变态需求，过度设计。**否决**。
- **顶层 `useState<Map<sessionId, SessionUiState>>` 持有多会话**：手写 Map + 关 tab 手动删条目，等于自造 React 组件生命周期；漏删易残留。**否决**。
- **per-session Context provider 套每个 tab**：在 per-tab 组件自治之上多套一层 provider，无额外收益。**否决**。
- **Viewed Result 胖快照（保留 latestResult 形态）**：thread 重拉前能立即渲染——但 setQueryData 乐观追加已解决这点，胖快照优势消失、双重真相留存。**否决**。
- **加 turn id 支持重读历史非 Materialized 轮次**：为 v1 罕见需求动 Rust 契约 + recipe 序列化。**否决（v1）**，出口保留。

## Consequences

- **新增依赖**：`@tanstack/react-query` 入 dependencies；`QueryClient` 在 `main.tsx` 顶层 `QueryClientProvider` 包裹。
- **App.tsx 重构**：由单组件顶层 useState 重构为「顶栏 tabs（`openSessionIds` + `activeSessionId`）+ per-tab `<SessionPane>`」；`refresh()` / `useSimpleMutation` / `latestResult` / `handleSelectResult` 退役为 Query + setQueryData + 瘦 viewedResult。
- **`latestResult` 退役**：assumption / viz 改从 thread query 派生；`handleSelectResult` 简化为 `setViewedResult(referenceName)`。
- **闭合 ADR-0046 open item**：「单 Tauri webview 内 React 状态持有多个会话」落地为 per-tab `<SessionPane>` 组件自治 + queryKey 按 sessionId 分片 + 关 tab removeQueries；0046 待追加反向指针。
- **延伸 ADR-0045**：shell 重构（两栏 + workspace tabs）的前提状态架构就位；`App.tsx` 单列 → 顶栏 tabs + SessionPane（内含两栏）的重构路径明确。
- **延伸 ADR-0010 / 0028**：active / Viewed Result 分离让"点历史结果重演"（0045 Why#3）只动前端 viewedResult、不动后端 active——守 0010 隐式链式对用户不可见。
- **query 粒度**：working set / active / thread 各一个 per-session query；row pages 用 `useQuery(['session', sid, 'rows', referenceName, offset])` + `placeholderData: keepPreviousData` 分页；provider config 会话无关。
- **未决（留 0051 内或后续）**：
  - **Q5 流式通道**：v1 `ask` 是阻塞式 IPC（等 outcome，ADR-0009 / 0021），非流式；未来 LLM token 流 / SQL 执行进度若引入，走 Tauri event → `queryClient.setQueryData` 增量更新 thread，或在 query 之外加独立 event store——届时细化。
  - **Q6 recipe 同步 invalidate 时机**：换源级联失效（ADR-0025）/ source replacement 后哪些 query 要 invalidate、resume 重开时 cache 冷启策略，在实现期钉死具体规则。
  - tab 拖拽重排、会话命名 UI（继承 0046 未决）。
