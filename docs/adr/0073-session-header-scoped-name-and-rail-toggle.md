# 顶栏瘦身：session 名 + rail 折叠迁入 SessionPane header

## Decision

**两层 chrome 分离**：

- **shell-wide topbar** 只留 shell 级 chrome：会话栏折叠切换（左）+ header actions（Settings + 软上限 badge，右）+ window controls（ADR-0074）+ `data-tauri-drag-region`。**移除** session 名 + rail 折叠切换。
- **每 session 的 `.session-header`**（`SessionPane` 内，row 1 横跨 rail + workspace）承载 session-scoped chrome：rail 折叠切换 + 当前 session 名（只读，空名 fallback 到默认名）。同样挂 `data-tauri-drag-region`。

rail 折叠切换虽读 shell-wide 偏好（`railCollapsed`，ADR-0054 / 0068），但其渲染点迁入 `SessionPane`——rail 本身只存在于 `SessionPane` 内（冷启动 hero 无 rail），迁入后 toggle「present-when-relevant + 永远 enabled」，不再需要 topbar 时代的 `disabled={!activeSession}` 兜底。

## Context

ADR-0060 line 15 + line 75 把「当前会话名（只读）」放在全局 topbar 中部，前提是 topbar 为系统原生 titlebar 之下的薄 chrome 条。ADR-0074 把 topbar 升级为自定义 titlebar（`decorations: false`），topbar 需额外承载 `data-tauri-drag-region` + window controls，session 名若留下会让 topbar 同时混装 shell 级（窗口操作 / sidebar / settings）与 session 级（session 身份）两类 chrome，归属边界模糊。

两个既有事实催化这次归属重划：

1. **session 名是 per-session 数据**：保活多 pane（ADR-0051）下每个 `SessionPane` 有自己的名，pane 自渲染自身名比 topbar 读 `activeSession.name` 全局态归属更清晰（pane 不伸进全局 active-session state）。
2. **rail 折叠是 shell-wide 偏好但 rail 是 session-bound 结构**：toggle 控制的是 shell-wide 偏好，但被控对象（rail）只存在于 `SessionPane` 内；topbar 时代需 `disabled={!activeSession}` 兜底正是这个错配的症状。

## Why

1. **pane 自渲染自身 session 名**：session 名是 per-session 数据，pane 拥有自身渲染权，topbar 不再读全局 active-session state——归属清晰。
2. **rail toggle present-when-relevant**：rail 只在 `SessionPane` 内存在，toggle 进 session-header 后永远 enabled；topbar 时代的 `disabled` 兜底（冷启动无 rail）消除。
3. **topbar 升级为自定义 titlebar（ADR-0074）后专注 shell-wide chrome**：window controls + drag region + sidebar toggle + settings 全是 shell 级；剥除 session-scoped chrome 后 topbar 归属单一。
4. **两层 chrome 分离的可发现性**：shell 级 chrome（窗口操作 / 全局设置）与 session 级 chrome（session 身份 / rail 布局）在视觉与所有权上分层；跨 session 切换时 session-header 随 pane 切（保活，ADR-0051），topbar 不动。

## Considered options

- **session 名 + rail toggle 留 topbar（守现状）**：topbar 读 `activeSession.name` 全局态 + rail toggle 需 `disabled={!activeSession}` 兜底；自定义 titlebar（ADR-0074）让 topbar 同时混装 shell 级 + session 级 chrome。**否决**——pane 自渲染 session 名归属更清晰；rail toggle 进 session-header 消除 disabled 兜底。
- **混合（session 名进 session-header，rail toggle 留 topbar）**：两个 session 相关控件拆到两条 chrome 带；rail toggle 单留 topbar 仍需冷启动 disabled 兜底。**否决**——bundling 在 session-header 让 session-scoped chrome 内聚，避免 rail toggle 单独承受 topbar 时代的错配。
- **rail toggle 迁 sidebar（非 session-header）**：toggle 控制的 rail 不在 sidebar 内，控制点远离被控对象。**否决**——session-header 紧邻 rail（同 pane 的 row 1 ↔ row 2）。

## Consequences

- **修订 ADR-0060（部分）**：行 15（顶栏含当前会话名只读）/ 行 75 闭合项（顶栏布局细化：中 = 当前会话名）——session 名 + rail 折叠迁出 topbar，进 `SessionPane` 的 `.session-header`。ADR-0060 顶部加「部分被 0073 修订」blockquote（照 0060 ← 0072 先例）。
- **延伸 ADR-0062 R1**：`session-pane` 嵌套网格 rows 由 `1fr auto` 增为 `auto 1fr auto`（row 1 = session-header 横跨 / row 2 = rail + workspace / row 3 = questionbar）。ADR-0062 待追加反向指针。
- **topbar 收缩为 shell-wide-only**：sidebar toggle + header actions + window controls（ADR-0074）+ drag region；`styles.css` 的 `.topbar` 仍按 ADR-0067 作 layout-only 语义类保留（`grid-column 1 / -1` 全宽），视觉细节走 utility + token。
- **`railCollapsed` 偏好归属不变**：shell-wide、走 ADR-0054 / 0068 advisory state；仅渲染点从 topbar 迁到 session-header。每个 `SessionPane` 读同一 `railCollapsed` 值（保活下非活跃 pane CSS-hidden，仅活跃 pane 的 toggle 可见）。
- **drag region 扩到 session-header**：session-header 挂 `data-tauri-drag-region`（窗口级拖拽从 per-session 条也生效）；rail toggle 作 `<button>` 保持可点（不 drag）。
- **关联 ADR-0074**：本 ADR 的触发项（topbar 升级为自定义 titlebar）；window controls 的渲染点 + drag region 契约见 0074。
- **CONTEXT.md 不动**：topbar / session-header / rail toggle 是 UI chrome 实现，非领域术语（遵循 ADR-0060 行 72 / ADR-0068 行 57 先例）。
