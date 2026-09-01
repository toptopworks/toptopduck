# 前端错误边界与降级分层：分区 ErrorBoundary（L2）+ 顶层兜底（L3），与 L0/L1 既有路径不重叠

## Decision

前端降级定下**四层契约**，本 ADR 新增 **L2 渲染层 ErrorBoundary + L3 顶层兜底**，与既有 L0/L1 路径各守其位、不重叠：

**分层模型：**

| 层 | 路径 | 触发 | 落点 |
|---|---|---|---|
| L0 数据/契约 | 0033 Vega 退化 / 0015 load error / 0030 truncation | 数据级失败 | ResultView try/catch、loadErrorDisplay、Failed outcome |
| L1 操作/异步 | IPC error / cancel / persist-error | handler async | setError 红字、Cancelled outcome、横幅 |
| **L2 渲染（新增）** | **render 阶段 throw** | 组件 map 炸、数据运行时变形 | **分区降级卡** |
| **L3 顶层兜底（新增）** | L2 边界自身 throw / shell 级异常 | 罕见 | 整页降级卡 + 重载 |

**（1）分区粒度**
- 关键区域各包 ErrorBoundary：**workspace 结果区（ResultView）** / **Thread rail** / **SessionPane 会话级**。
- **顶层 ErrorBoundary** 作最后防线（shell 骨架级 throw）。
- 否决单一顶层边界（≈ 白屏等价）与每组件都包（噪音）。

**（2）降级语义**
- 降级卡 = 友好文案 + "重试"按钮 + 可展开"技术详情"（dev 模式/折叠，守 ADR-0017 诚实——不藏着但不吓人）。
- **重试 = 区域重试 epoch（state bump）+ `resetQueries` 该区域服务端态**（0051 的 thread/rows/workingSet query；用 reset 而非 invalidate——invalidate 会 stale-then-refetch，remount 先用致异旧数据渲染会再次 throw。校准：remove 同样不够——region 边界不卸载 query observer（observer 在边界外的 useSessionState），remove 后没有重拉驱动；且 cache 通知经 notifyManager 微任务批处理、晚于边界的同步 error-clear 重渲染，remount 撞上父组件旧 JSX 快照（仍携致异数据）立即再 throw，降级卡死锁。reset 同时清数据并主动重拉仍挂载的 observer；epoch bump 把父组件拉进同一 React 批，批内自上而下重渲染使 useQuery 同步读到 reset 后的 pending 态，边界以干净快照重挂）。
- 区域内客户端 UI 态（如分页 offset）随 remount 丢弃；会话级 UI 态（viewedResult）保留。
- shell 骨架（header / 会话 tabs / QuestionBar）恒保——降级卡只替换崩掉的那一块。
- 重试后仍致异：降级卡保持、不再无限重试；持续致异由 L3 兜底接（"重开会话/重载"出口）。

**（3）分层契约**
- **0033 Vega try/catch 保留在 `ResultView` 内部**——Vega 失败有精确语义（退化表格 + 披露），丢给 ErrorBoundary 会丢失退化能力。
- **ErrorBoundary 只接 render 阶段 throw**——React 技术事实：ErrorBoundary 不 catch event handler / `useEffect` / async / Promise rejection，故 L1 操作级与 L0 的 Vega（useEffect）**技术上不可能被边界接住**，天然不重叠。
- **不把 ErrorBoundary 当兜垃圾筐**——业务错误（IPC 拒绝 / 越界拒绝 ADR-0017 / cancel）继续走 L1 精确语义，不上抬到 L2（上抬丢文案前缀、outcome 类型、诚实拒绝语义）。

## Context

ADR-0045（shell）/ 0051（状态分层）/ 0033（Vega 退化）/ 0015（load error）/ 0034（persist-error）/ 0021（cancel）各自定义了单点降级路径，但**渲染级异常（React render throw）的兜底从未被任何 ADR 决策**——`App.tsx` 顶层零 ErrorBoundary（grep 全空），渲染异常 = 整树卸载 = 白屏。非技术用户（ADR-0001）遇白屏即流失；Tauri 桌面单页无 URL 可刷、非技术用户不一定懂"重载窗口"。本 ADR 收口渲染级兜底，并显式钉死四层不重叠的分层契约——避免实现时把 ErrorBoundary 滥用成兜垃圾筐（吞掉 L0/L1 的精确语义）。

## Why

1. **ADR-0001 非技术用户**——白屏 = 不可挽回流失；分区边界让"局部降级、全局保活"，用户可继续操作未崩区域。
2. **单一顶层边界 ≈ 白屏等价**——崩了整页替换、shell 全丢；分区才能保住 header/tabs/QuestionBar。
3. **0051 per-tab 隔离诉求**——SessionPane 级边界让"崩的那个 tab 降级、其余 alive 会话正常"。
4. **React ErrorBoundary 技术事实使分层部分强制**——它只接 render throw，event handler/useEffect/async 天然不 overlap，分层不靠纯约定。
5. **0033 Vega 退化语义珍贵**——"失败→退化表格"比"失败→出错卡"体验高一档，必须保留 ResultView 内部 try/catch，不上抬。
6. **不吞业务错误语义**——IPC 拒绝/越界拒绝/cancel 各有精确文案与 outcome，ErrorBoundary 给不了这些，上抬 = 语义损失。

## Considered options

- **不引入 ErrorBoundary（维持现状）**：白屏风险留存，违 0001。**否决**。
- **单一顶层 ErrorBoundary**：崩了整页降级卡，shell 全丢，≈ 白屏等价。**否决**。
- **每组件都包**：边界噪音淹没信号、过度（YAGNI）。**否决**。
- **只 remount 不重拉数据**：数据致异（畸形 `RowPage`/`ThreadEntry`）立刻再炸、无限闪。**否决**——`remove` 后重拉是重试有效的必要条件。
- **无重试、只显示错误**：非技术用户卡死。**否决**。
- **区域崩 → 卸载整个会话**：过度，区域崩 ≠ 会话崩，违局部降级初衷。**否决**。
- **把 0033 Vega 失败丢给 ErrorBoundary**：丢失"退化成表格"语义、回归出错卡。**否决**——Vega try/catch 保留 ResultView 内部。
- **把 IPC error / cancel 上抬到 ErrorBoundary**：React 技术上不 catch event handler/async；即便硬接也丢失文案前缀/outcome 类型/诚实拒绝语义。**否决**。

## Consequences

- **前端实现**：新增 ErrorBoundary 组件（class component，`getDerivedStateFromError` + `componentDidCatch`）；分区包裹 ResultView / Thread / SessionPane；顶层包裹 App 根。降级卡组件（友好文案 + 重试按钮 + 可展开技术详情）。
- **重试实现**：onReset 内 `queryClient.resetQueries({ queryKey: ['session', sid, <region>] })` + 区域重试 epoch state bump（依赖 0051 落地）；用 reset 而非 invalidate / remove，确保 remount 不先用 stale 旧数据渲染而再次 throw（理由见 Decision 2 校准）。
- **与 0033 关系**：Vega `useEffect` try/catch（`ResultView.tsx:109`）**保留不动**；ErrorBoundary 只接 ResultView 内 Vega 之外的 render throw。
- **与 0051 关系**：SessionPane 级边界契合 per-tab 隔离；`resetQueries` 重试依赖 0051 queryKey 分片；viewedResult 保留契合 active/Viewed 分离。
- **嵌套边界的 React 19 限制（已知缺口）**：session 边界是 thread/result 边界的 React 树祖先。React 19 + TanStack Query（useSyncExternalStore）真实 App 树中，Query 驱动的 re-render 阶段 throw 会被外层 session 边界先 catch（降级整个 session）而非内层 region 边界；首渲染 throw 不受影响（region 边界正常 catch）。根因未定位（隔离测试不可复现）。由此 granular partition（一块崩只降级该块）在首渲染 throw 可靠、Query-driven re-render throw 不保证；黑盒测试据此断言「降级卡可见 + 会话隔离 + 重试」而非「region 精确 catch」。恢复 Query-driven 场景 granular 的前提是在隔离测试复现并定位根因，或重构边界为 siblings 拓扑。
- **与 0055 关系**：关 tab in-flight 场景的"前端 promise 孤儿"（`setQueryData` 打空 cache）仍归 0051/0055 处理，不上抬到 ErrorBoundary。
- **重试上限留实现期**：精确重试次数、降级卡技术详情的 dev/prod 策略非架构。
- **CONTEXT.md 不动**：降级分层是实现/可靠性决策，不引入新领域术语。
- **出口保留**：若某区域持续致异成常态，该区域可加"上报/反馈"出口（v2）；L3 顶层兜底的"重载"是否带"恢复未保存会话"留 v2。
- **被 ADR-0062 精确化（QuestionBar 骨架归类）**：本 ADR"shell 骨架（header / 会话 tabs / QuestionBar）恒保"中 QuestionBar 归"会话级骨架"（跨 rail + workspace），非整窗骨架；会话栏独立通底。另：本 ADR"会话 tabs"措辞待顺为 0060 左会话栏（0060 未提 0058）。见 ADR-0062 R1。
- **校准（region 重试机制）**：ADR-0114 退役工作区末轮文本态后，region 边界重试首次成为黑盒测试可达路径，暴露 removeQueries 实现下 region 降级卡的恢复死锁（Decision 2 校准所述），据此改定 resetQueries + 区域重试 epoch。已知缺口：epoch key 的同批重挂在 jsdom/act 下不可区分于无 key 实现（act 将 notifyManager 微任务时序拍平，删除 key 后重试测试全绿）——重试测试钉住 resetQueries 调用，不钉 key；删除 key 须凭 Decision 2 校准的时序论证，不能凭绿测试。
