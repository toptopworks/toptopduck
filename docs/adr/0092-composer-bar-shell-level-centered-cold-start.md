# Composer bar 上提 shell 级：居中冷启动 bar + 首次提交创建会话

## Decision

1. **`QuestionBar` 从 `SessionPane` 上提到 shell（`App.tsx`）级。** bar 成为 shell 级组件，单实例永不 unmount/remount；`SessionPane` 不再拥有自己的 bar，收窄为 thread rail + workspace 渲染器。bar 的位置由 `activeSessionId` 驱动——`null`（无活跃会话）时居中于主区域，非 `null` 时在 conversation 列底部。CSS transition 驱动位置过渡，无组件替换。

2. **冷启动 / 无活跃会话时 bar 居中，取代 `ColdStartHero`。** 主区域显示一行居中问候语 + 居中 bar；session header / thread rail / workspace panel 全隐藏。`ColdStartHero` 组件及其三态诚实门（ADR-0071 的 no-profile / no-key / ready CTA）退役。空态主区域（bar 周围空白）接受文件拖放，触发 `createSession` + 加源（ADR-0061 拖放路径不变，载体从 hero 换成空态区域）；bar 本身不响应拖放。

3. **会话在首次提交时创建——不预创建。** ADR-0061「不预创建实例」保留。冷启动不调 `createSession`；用户在居中 bar 打字提交时，shell 层执行 `createSession`（ADR-0089 立即持久化）+ 首轮提问。`activeSessionId` 从 `null` 变为新 session id → bar 从居中过渡到底部 → session header / rail / workspace 出现。`createSession` 立即打开 DuckDB 实例（`store.create()`），不预创建使冷启动零 DuckDB 实例、零内存。

4. **诚实门在 submit 时判定。** bar 恒定可输入（不 disable），submit 行为按 runtime + 配置状态分流：built-in runtime 选中且有 profile 且有 key → `createSession` + 设 built-in + 执行首轮；built-in 选中但无 profile 或无 key → 打开 Settings Runtime tab（不创建会话）；external runtime 选中且 adapter detected → `createSession` + 设 external + 执行首轮。external adapter 未检测到的 runtime 在 picker 内 disabled（不可选）。

5. **sidebar「+」= 回到居中空态导航，不创建 session。** 点击「+」设 `activeSessionId = null`，显示居中 bar + 问候语。已有 keep-alive 会话不受影响（mounted hidden，in-flight turn 继续跑）。

6. **keep-alive 保留（ADR-0051），bar 的 per-session state 上提到 shell 层路由。** bar 的 `loading` / `phase` / 输入草稿 `value` 按 `activeSessionId` 路由——每个 keep-alive 会话各有自己的 bar 状态，bar 只渲染活跃会话的状态。`loading` / `phase` 经 `useSessionState`（TanStack Query 按 sessionId 分片）读取；输入草稿住 shell 层 `Record<sessionId, string>` + null 态冷启动草稿。runtime picker 在无 session 时使用 shell-level pending state（`RUNTIME_CHOICE_DEFAULT` 初始值），submit 时传入 `createSession`。Skills / MCP triggers / ContextPanel / AuthModeChip 在无 session 时显示空挂载集 / 默认值，用户选择存 shell-level pending state，`createSession` 后一次性 apply。bar 跨冷启动与会话内控件一致——同一组 composer 控件，无降级。

## Context

ADR-0087 把 DuckDB 从唯一引擎降为默认工具——一个会话可能全程不使用 DuckDB（用外部 MCP 工具完成分析）。ADR-0079 把能力边界降为默认技能集语义。这使 ADR-0061 的 `QuestionBar: disabled（无源）` 约束失去前提：无数据源时用户仍可提问（agent 用可用工具回答或诚实拒绝）。

`ColdStartHero`（ADR-0071）的三态诚实门（no-profile / no-key / ready CTA）以「New session」按钮为终端动作——用户先创建空会话进 SessionPane，再在 SessionPane 的 bar 里提问。这与 agent composer 的「直接输入即开始」心智不一致。ADR-0081 引入双运行时（built-in BYOK + external CLI adapter）后，「能跑」的条件不再仅是 BYOK profile + key——用户可能无 profile 但有检测到的 external adapter。

`QuestionBar` 当前住 `SessionPane`（ADR-0045/0051），是 per-session 组件。冷启动无 session → 无 bar → 需要一个独立的 hero 组件引导用户创建 session。如果 bar 上提到 shell 级且恒定渲染，hero 的存在理由消失——bar 本身就是入口。

## Why

1. **bar 一致性消除首屏到会话内的体验断层。** shell 级单实例使 bar 跨冷启动（居中）与会话内（底部）恒定一致——同一组控件、同一 DOM 节点、零组件替换。per-SessionPane 双实例方案在首次提交时必然有 unmount/mount 过渡（焦点丢失、视觉闪烁），无法达成一致性目标。
2. **首次提交创建会话消除「先创建再提问」的摩擦。** 用户在居中 bar 打字提交那一刻会话才被创建——与「直接输入即开始」心智对齐。不预创建守 ADR-0061 + ADR-0008（冷启动零 DuckDB 实例）；`createSession` 立即打开 DuckDB 实例（`store.create()`），预创建会使冷启动白占内存。
3. **submit 时诚实门保留 ADR-0019 的诚实引导价值。** bar 恒定可输入（不 disable），但 submit 按配置状态分流——no-key 提交 redirect 到 Settings 而非创建一个会话后因 LLM 无 key 首轮即失败。诚实门从 hero 的三态 CTA 迁移到 bar 的 submit-time 判定。
4. **双运行时使诚实门判定不再仅依赖 BYOK profile + key。** 用户可能无 profile 但有检测到的 external adapter——picker 内可选 external runtime，submit 时用 external 执行。picker 内 adapter 不可选时 disabled，从源头阻止无效提交。
5. **sidebar「+」作为导航（非创建）与首次提交创建语义自洽。** 「+」回到居中空态（`activeSessionId = null`），已有会话 keep-alive 不受影响；用户在居中 bar 提交才创建新会话。
6. **keep-alive 对 in-flight turn 的处理是自然的。** 单活跃会话下切走一个有 in-flight turn 的会话没有满意选项（取消丢工作 / 阻塞锁死 / 后台继续但丢实时 progress）；keep-alive 使 in-flight turn 在 hidden pane 内继续跑、progress 事件实时更新 query cache，切回即时显示当前状态。

## Considered options

- **`SessionPane` 内双实例 bar（shell 级居中 bar + `SessionPane` 内底部 bar）/ 冷启动预创建空会话使 bar 恒为 `SessionPane` 的 bar**：双实例在首次提交时有 unmount/mount 过渡（焦点丢失 / 视觉闪烁），一致性目标无法达成；预创建使 `createSession`（立即打开 DuckDB 实例）在冷启动即触发，违 ADR-0061「不预创建」+ ADR-0008 低内存——用户转身切别的会话时空实例白占。**否决**。
- **单活跃会话（放弃 keep-alive ADR-0051）以简化 bar state 路由**：in-flight turn 切换处理三难——取消丢工作 / 阻塞锁死 / 后台继续但丢实时 progress（实质是后端 keep-alive 无前端保活，复杂度未减）。**否决**。
- **居中 bar 控件降级（只挂 runtime picker，Skills / MCP / ContextPanel / AuthModeChip 首屏不显示）**：bar 跨冷启动与会话内控件不一致，违 composer 一致性目标。**否决**。
- **无诚实门（submit 即创建 + 执行，不判 profile / key / adapter）**：no-key / no-adapter 用户首次 ask 即因 LLM 无 key 失败，违 ADR-0019 诚实引导。**否决**。
- **保留 `ColdStartHero` 三态 CTA 不改**：ADR-0087 使 DuckDB 不再必要，hero 的核心约束（无源 = 不可用）已过时；三态 CTA 与「直接输入即开始」心智不一致。**否决**。

## Consequences

- **`ColdStartHero` 退役**：组件（`src/shell/ColdStartHero.tsx`）及其测试（`src/shell/__tests__/ColdStartHero.test.tsx`）删除。App.tsx 中 `activeSessionId === null` 的渲染分支从 `<ColdStartHero>` 改为居中 `<QuestionBar>` + 问候语。
- **`SessionPane` 职责收窄**：失去 `QuestionBar` 及 bar 相关 state / 回调（`handleAsk` / `handleCancel` / `loading` / `phase` / composer 控件），变为纯 thread rail + workspace 渲染器。这些 state / 回调上提到 shell 层。
- **Shell 级 bar state 架构**：per-session 的 `loading` / `phase` 经 `useSessionState`（TanStack Query 按 sessionId 分片，ADR-0051）读取；输入草稿住 shell 层（`Record<sessionId, string>` + null 态冷启动草稿）；runtime picker 的 pending state 住 shell 层。Skills / MCP / ContextPanel / AuthModeChip 的 draft mode 具体行为细节留实现期。
- **Transition**：bar 居中 ↔ 底部由 CSS transition 驱动；`activeSessionId === null` → centered，非 `null` → bottom。trigger 是首次 submit 后 `createSession` 返回设 `activeSessionId`。
- **CONTEXT.md 不变**：`QuestionBar` / `ColdStartHero` 是实现概念，非领域术语。领域模型（Session / Turn / Recipe 等）不受影响。
- **校准 ADR-0061**：「QuestionBar: disabled（无源）」过时——bar 功能完整（ADR-0087 DuckDB 非必须）；启动空态从 hero 改为居中 bar；「不预创建实例」保留不变；hero 拖放区 → 空态主区域拖放。
- **校准 ADR-0045**：「底 = QuestionBar」从 `SessionPane` 内上提到 shell 级；bar 位置由 `activeSessionId` 驱动（居中 vs 底部），而非恒在 SessionPane 底部。
- **校准 ADR-0090**：Decision 3「QuestionBar 始终在 conversation 列内」精确化为「有活跃会话时在 conversation 列内，无活跃会话时居中于主区域（无 conversation 列——session header / rail / workspace 全隐藏）」。bar 宽度仍跟踪 conversation 列。
- **校准 ADR-0071**：`ColdStartHero` 三态诚实门（no-profile / no-key / ready CTA）退役；诚实门改由 shell 级 bar 的 submit-time 判定承载（Decision 4）。
- **校准 ADR-0051**：keep-alive 保留不变；bar 的 per-session state（`loading` / `phase` / 输入草稿 `value`）从 `SessionPane` 内 `useState` 上提到 shell 层按 `activeSessionId` 路由。
- **留实现期**：问候语文案（i18n key）、CSS transition 时序、draft state 的具体 state shape、composer 控件 draft 模式的 popover 行为细节、`SessionPane` 重构后 `handleAsk` / `handleCancel` 的回调上提路径。
- **被 ADR-0098 校准**：Decision 4 的分流结构不变，零档案合法化使「built-in 选中但无 profile → Settings」分支从不可达变为可表示；Decision 6 的冷启动 pending 运行时初始值从 `RUNTIME_CHOICE_DEFAULT` 常量改为默认运行时的解析结果。见 ADR-0098。
