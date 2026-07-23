# 前端错误呈现收口为 error-presentation 深模块 + kind 驱动前缀策略

## Decision

1. **错误呈现收口为 `src/lib/error-presentation/` 深模块**——把散落在 `src/api.ts`（9 个 `is*Error` 类型守卫 + 7 个子格式化器 + 4 个 detail 提取器 + `fmtError`/`errorDetail` + `describeReject` + `formatTurnFailure`/`turnFailureDetail`）与 `src/session/useSessionState.ts`（`errorVerb`/`flowFailedMessage`/`refreshFailedMessage`/`appErrorFrom`）的「IPC 拒绝 → `AppError`」转换整体搬入。`api.ts` 退回纯 `invoke` 边界（仅留 ~35 个 IPC 函数）。

2. **分层接口：上层组装 + 底层裸呈现**——上层 `toAppError(e: unknown, intl, kind: AppErrorKind, opts?: { refreshFailed?: boolean }): AppError` 组装 `AppError` 并决定前缀策略；底层 `fmtError`/`errorDetail`/`formatTurnFailure`/`turnFailureDetail` 保持公开（persist banner 与 TextualOutcomeCard 直接消费）。9 守卫 + 7 子格式化器 + verb 前缀逻辑下沉为模块私有。

3. **前缀策略由 `kind` 驱动，取代调用点选函数**——`toAppError` 内部 `switch(kind)`：`SessionFlowKind` 六值（load/rename/replace/delete/privacy/ask）加 `"{verb} failed: {message}"` 前缀；`shell`/`read` 裸输出；`opts.refreshFailed` 产出 `"{verb} saved, but refreshing the working set failed: {message}"`。exhaustiveness `default: never` 保留「verb 只对 `SessionFlowKind` 加」编译期不变量（types/error.ts 已立的 `SessionFlowKind ⊂ AppErrorKind`）。

4. **模块物理分片**——`guards.ts`（9 守卫，纯窄化无 intl）/ `format.ts`（`fmtError` 内核 + 7 子格式化器 + 4 detail 提取器 + `errorDetail`）/ `turn-failure.ts`（`formatTurnFailure` + `turnFailureDetail`）/ `app-error.ts`（`toAppError` + verb 前缀逻辑）/ `index.ts`（facade，仅 re-export 5 个公开函数 + 必要类型）。每文件 150–300 行。

5. **`AppError`/`AppErrorKind`/`SessionFlowKind` 留 `types/error.ts`**——值对象（`ErrorBanner` 渲染 + 多 hook 持有），非呈现逻辑；types/ 保持纯数据，lib/ 保持纯逻辑。

6. **`loadErrorDisplay` 不并入**——输入域是 `LoadOutcome::Error`（IPC 成功返回的错误分支），非 IPC reject；并入会让模块 reject/outcome 输入域混杂。留 `src/lib/` 独立。

## Context

「IPC 拒绝 → 用户可见 `AppError`」是同一领域概念，现状有两套并行实现：shell/read 层用 `describeReject`（kind=`AppErrorKind`，裸输出），session-flow 层用 `appErrorFrom`（kind=`SessionFlowKind`，加 verb 前缀）。二者底层都调 `fmtError + errorDetail`，差异仅 message 前缀。`appErrorFrom`/`flowFailedMessage`/`refreshFailedMessage`（verb 前缀 + locale 一致性承载点）无单元测试；`refreshFailedMessage` 在 `useSessionState` 内联两处（refreshServerState + handleAsk），逻辑重复。`fmtError`/`errorDetail`/9 守卫窄化已有 ~400 行覆盖（`fmtError.test.ts`），但守卫 + 格式化器 + 前缀散在 api.ts（1084 行，混 7 域 invoke + 错误呈现）与 useSessionState 两个文件——是已废弃的 `types.ts` barrel（issue #213）同类未处理项。错误契约仍在高频演化：近 15 个相关 commit 中 9 个反复修补这块（#120/#121/#125/#130/#131 类型化 + i18n、#139 verb 前缀、#194 合并 shellError），是全仓最高 churn 区。

## Why

1. **locality 是最大收益**——改错误措辞只读 `error-presentation`，不再跳 api.ts + useSessionState + ResultView 三处。
2. **接口即测试面**——`toAppError` 成为 verb 前缀/locale 一致性的唯一测试面，把 issue #139 修复点从无测私有函数提到可直测公共入口，补 `appErrorFrom`/`refreshFailed` 空洞；`fmtError`/`errorDetail` 既有 ~400 行覆盖平移不动。
3. **删除测试通过**——删掉模块，守卫 + 格式化器 + 前缀策略散回 api.ts + useSessionState，复杂度集中而非移动。
4. **kind 驱动前缀集中策略**——现状「调用点选 describeReject vs appErrorFrom」让前缀策略隐式分散在调用点；kind 驱动让其显式、可测、exhaustiveness 守卫。新增 `AppErrorKind` 成员时前缀归属有据可依。
5. **为 api.ts 按域拆分铺路**——错误呈现抽走后 api.ts 退回纯 invoke，后续按域拆分（session/ingest/dataset/thread/provider/persistence/app-config）的动机从「文件大」升级为「接缝清晰」。
6. **不与现有 ADR 冲突**——纯前端内部重组，行为等价；ADR-0051（前端分层，错误呈现归客户端呈现层）、ADR-0058（L1 拒绝走 handler-async 不进 ErrorBoundary）、ADR-0029（detail 不泄露 key）文本与契约零改动。

## Considered options

- **只收口上层 AppError 组装**（`describeReject`+`appErrorFrom`+`refreshFailed` → `toAppError`），底层 `fmtError`/守卫留 api.ts：留下跨模块依赖（`toAppError` 仍 `import { fmtError } from "../api"`），locality 只解一半。**否决**。
- **引入 `formatReject` 返回 `{message, detail}` 并私有化 `fmtError`/`errorDetail`**：需重写 `fmtError.test.ts` ~400 行高覆盖测试，收益仅「接口少一个入口」。**否决**。
- **单入口 `presentReject(e, intl, ctx)` 吃所有形态**：persist banner 产出非 `AppError`（Alert 内嵌文本），ctx 须承载自定义模板，把 UI 措辞关注点泄进错误模块。**否决**。
- **`loadErrorDisplay` 并入 error-presentation**：输入域 `LoadOutcome` 非 reject，并入让模块 reject/outcome 混杂。**否决**。
- **`formatTurnFailure` 排除在模块外**（输入域是 TurnFailure 值非 reject）：「后端错误 → locale 文本 + 折叠详情」是同一领域概念，分离按输入类型切非按概念切。**否决**。
- **单文件 `error-presentation.ts`**：~800 行贴 800 红线，错误契约高频演化，下一个错误类型即破线。**否决**。

## Consequences

- **新增**：`src/lib/error-presentation/`（`guards.ts` / `format.ts` / `turn-failure.ts` / `app-error.ts` / `index.ts`）；`toAppError` 公共入口。
- **`api.ts` 砍 ~720 行**（守卫 + 子格式化器 + detail + `fmtError`/`errorDetail` + `describeReject` + `formatTurnFailure`/`turnFailureDetail`），退回纯 `invoke` 边界（~360 行 / 35 个 IPC 函数）。
- **`useSessionState.ts` 砍 ~80 行**（`errorVerb`/`flowFailedMessage`/`refreshFailedMessage`/`appErrorFrom`），其调用点改调 `toAppError`；`refreshFailedMessage` 两处内联收口为 `toAppError(e, intl, kind, { refreshFailed: true })`。
- **行为等价**：当前无 `describeReject(SessionFlowKind)` 调用点（`describeReject` 仅用于 shell/read），kind 驱动前缀与现状等价；`appErrorFrom(SessionFlowKind)` → `toAppError` 逐 kind 对应。
- **测试**：`fmtError.test.ts` 仅改 import 路径（测试体零改动）；`describeReject.test.ts` 改测 `toAppError` + 新增 verb 前缀（#139 locale 一致性）与 `refreshFailed` 前缀断言。
- **关联 ADR-0051**：错误呈现归本 ADR 客户端呈现层（非服务端态、不进 TanStack Query）；`AppError` 经 `ErrorBanner` 渲染。
- **关联 ADR-0058**：L1 拒绝留 handler-async 路径不进 ErrorBoundary 的契约不变——`toAppError` 产出 `AppError` 经 `ErrorBanner` 渲染，不改变错误边界分层。
- **关联 ADR-0029**：守卫 + 格式化器维持 detail 不泄露 key 的契约（`fmtError` 永不把 detail 写进主消息）；本 ADR 仅搬迁，窄化与脱敏逻辑零改动。
- **正交 issue #213**：`types.ts` barrel 拆分是类型层；本 ADR 是逻辑层呈现模块，二者共同指向「按域/按关注点分片」同方向。
