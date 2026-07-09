# 启动语义：ChatGPT 式（不自动 resume + 左栏全列表 + 新会话空态合并 + 不预创建实例）

## Decision

app 冷启动看到什么，定为 **ChatGPT 式**——**不自动 resume 上次会话、不预创建会话实例**，让用户主动选：

- **左栏**：加载**所有持久化 .duck** 会话列表（依赖后端 `list_sessions` IPC，ADR-0056 未定，落地前提）。
- **右侧 workspace**：**新会话空态**（hero 拖放区，与空状态合并）。
- **thread rail**：空。
- **QuestionBar**：禁用（无源）。
- **顶栏**：会话名空 / 「新会话」。

**不读 `last_session_id`**（不预设"上次活跃"），**不 `createSession`**（启动纯 UI 占位、零实例、零内存）。

**用户两条路径：**
1. **点左栏某会话** → resume（ADR-0034：读源 + ADR-0035 完整性校验 + eager 重放可重放链），进度归工作区（K）；撞 0035 源漂移**当场给诚实选择**（重建 / 中止，0035），因系用户主动点开，异常在预期内。
2. **拖入 / 选择文件**（到欢迎屏 hero 拖放区）或 **点左栏「+ 新建会话」** → `createSession` + 加源（一步到位），或先空会话进空态再加源 → 落入工作态。

**与空状态合并**：启动欢迎屏 = 「新会话空态 + 左栏列表」，两个"空态"层级合并为一个 UI（hero 拖放区在启动时即欢迎屏主体）。

## Context

ADR-0034（recipe 持久化 + eager resume）+ 0035（resume 完整性校验）+ 0060（左会话栏 ChatGPT 外壳）定了持久化与导航载体，但 **app 冷启动看到什么从未被任何 ADR 决策**。曾考虑「resume 上次活跃会话（`last_session_id`，app-config 记录）」，最终否决、选 ChatGPT 式——与 0060 刚定的 ChatGPT 外壳自洽，并消解 0035 在启动路径的复杂性。

## Why

1. **ChatGPT 外壳一致（ADR-0060）**——启动行为照搬 ChatGPT（不自动 resume、显示列表让用户选），比"自动恢复上次"与外壳自洽；0046 写作时未充分权衡的「2026 年 ChatGPT 心智」同样适用于启动行为。
2. **0035 启动路径复杂性消失**——不自动 resume 即不撞源漂移；ADR-0035 只在用户**主动点开**某会话时发生（用户预期的操作，撞异常可接受），不再是"启动就撞"的意外首屏。
3. **守 ADR-0017 诚实 + local-first 拥有感（ADR-0034）**——不替用户假设回到哪个；让用户主动选，呼应 0034「用户以真文件拥有数据」的拥有感（启动即见全部 .duck，用户挑）。
4. **不预创建守 ADR-0008 低内存**——启动零 DuckDB 实例、零内存，直到用户拖文件 / 点 + 才 `createSession`；若启动预创空实例、用户转身点左栏 resume 别的，空实例白占内存。
5. **与空状态合并简化 UI**——启动欢迎屏 = 新会话空态 + 左栏列表，两个"空态"层级合并，无需为"启动欢迎屏"与"会话内空态"分别设计。

## Considered options

- **resume 上次活跃会话（`last_session_id`，初选方案）**：与 0060 ChatGPT 外壳不一致 + 0035 启动路径复杂（启动撞源漂移）+ "上次活跃"定义 / quit 记录 activeSessionId / in-flight 记录等钩子纠缠。**否决**。
- **启动会话列表选择器（全屏强制选）**：每次启动强制选择，对非技术用户（ADR-0001）是摩擦。**否决**。
- **启动预创建空会话实例（沿用现状 `App.tsx` mount 即 `createSession`）**：用户转身 resume 别的则空实例白占内存，违 0008。**否决**——延迟到拖文件 / 点 + 才创建。
- **总是开新空会话（不显左栏列表）**：丢失持久化恢复入口，0034 持久化在冷启动场景白做。**否决**。
- **百分比进度**：0034 逐轮重放无连续进度，百分比造假违 0017。**否决**。
- **resume 进度进 query cache**：污染 0051 单一真相。**否决**。
- **空态作 rail 第三物种**：违 0047「物种 = 恒可见数据条目」，placeholder 有数据后消失。**否决**。
- **启动欢迎屏与新建空态分别设计**：UI 冗余，合并简化（本 ADR）。**否决**。

## Consequences

- **启动流程**：加载左栏（`list_sessions` IPC）+ 新会话空态 UI；**不 `createSession`、不 resume、不读 `last_session_id`**。
- **`createSession` 触发点**：拖文件到欢迎屏 = `createSession` + 加源一步到位（快捷）；点左栏「+」= 先 `createSession` 空会话进空态、用户再拖文件加源（两步）。两条都保留。
- **resume 触发点**：点左栏会话 → ADR-0034 流程，ADR-0035 校验当场给选择（0035 line 8），进度归工作区（K，复用 0059 `turn-progress` 模式）。
- **延伸 ADR-0034 / 0035**：resume 只由用户主动点开触发，不在启动路径；0035 异常在 resume 路径内呈现（0035 line 8 的"让用户决定重建或中止"）。
- **延伸 ADR-0038**：**不需要 `last_session_id` preference**（相比"resume 上次活跃"方案少一个字段）；启动偏好仅窗口几何 / 上次导出目录 / theme / locale（已有）。
- **延伸 ADR-0060**：启动是 0060 左栏 + 新会话空态的组合；与空态合并。
- **后端依赖（跨界 gap）**：`list_sessions` IPC（列出所有 .duck 元数据：会话名 / 最后修改时间 / working set 摘要）——ADR-0056 未定，是启动左栏 + 0060 左栏的共同落地前提。元数据字段与会话栏条目内容同源，一并定。
- **CONTEXT.md 不动**：启动语义是 UI / 生命周期实现，不引入领域术语（「会话」「resume」已在 CONTEXT.md）。
- **resume 前端反馈（已决，闭合 open item）**：套 0059 模式——`resume-progress` event（补 sessionId，0059 line 28 v1 遗留）+ 客户端 UI 态（不进 Query）+ 离散轮计数 `Replaying N/M`（不用百分比，0034 逐轮诚实）+ 进度归工作区。v1 切走 resume 中会话 = 中断 + 卸载（后台继续留 v2）；显式取消按钮；断裂显示断点 + 已物化（0034）。
- **空状态（已决，并入本 ADR）**：per-region 空态——rail = placeholder 提示（**非 rail 第三物种**——0047「物种」= 恒可见数据条目，placeholder 有数据后消失）；workspace = hero 拖放区；QuestionBar = 禁用。启动欢迎屏与新建空会话态的 workspace/rail/QuestionBar 完全相同，仅左栏是否高亮当前会话之别。
- **会话栏条目内容 + list_sessions 元数据**：见 ADR-0060（元数据字段为渲染条目服务）。
- **resume 反馈 / 空状态 / 会话栏条目 open item 已闭合**：见上「resume 前端反馈（已决）」「空状态（已决）」；会话栏条目见 ADR-0060。
- **被 ADR-0062 精确化（拖放落点二分）**：本 ADR 拖放路径补「有活跃会话 → 加源（0022 / 0040），无活跃会话（hero）→ createSession + 加源」。见 ADR-0062 R3。
- **被 ADR-0062 补（resume 后 viewedResult 初始化）**：本 ADR resume 路径补「重放完成后前端 setViewedResult ← thread 末个 Materialized」。见 ADR-0062 R5。
