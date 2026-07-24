# Frontend settings: in-app overlay view, not a modal dialog

## Decision

设置面板作为**应用内全屏覆盖视图**（in-app overlay view），而非模态 Dialog。打开设置 = shell 在 session shell 之上并列渲染 `<SettingsView/>` 覆盖层（`{settingsOpen && <SettingsView/>}`），session sidebar + topbar + keep-alive session pane 仍挂载、靠 `.shell.settings-mode` CSS（`display:none`）隐藏；左上角「‹ Back to app」退出、移除覆盖层即恢复原 session shell 与原 activeSession（组件树未卸载，in-flight turn 不中断）。设置视图自带 header（返回按钮 + 「Settings」标题），主 top bar 在设置视图内隐藏；左侧为设置分类导航（General / Profiles / Engine / Privacy），右侧为选中分类内容。非模态、无遮罩——就是当前视图。设置内的确认类弹窗（如删除 profile）仍用 Radix AlertDialog。

## Context

现有 SettingsDialog 是 Radix 模态 Dialog（max-w-xl 单页滚动）。ADR-0064 引入多 profile 管理——profile 是多实体、需列表 + CRUD + 主从布局，单页模态 Dialog 拥挤；且 top bar 新增 profile 快速切换下拉，设置面板聚焦「管理」而非「切换」。业界主流桌面 AI 助手（ChatGPT 桌面版、codex 桌面版）的设置均为应用内覆盖视图 + 返回导航，而非小模态弹窗。

## Why

1. **多 profile 管理需独立空间**：profile 列表 + 展开编辑表单 + CRUD 纵向占用大；模态 Dialog（哪怕变宽）仍是浮层、内容拥挤；覆盖视图给设置独立的探索空间。
2. **返回导航优于 ✕ 关闭**：设置是一个可探索的独立视图（多分类、多 profile），「‹ Back to app」的导航语义比「✕ 关闭弹窗」更贴合——用户在设置里浏览多个分类，不是「改一个值就走」。
3. **session sidebar 隐藏的合理性**：设置视图有自己的左导航（设置分类），与 session sidebar 并列会双导航冲突；隐藏 session sidebar、返回恢复，语义干净。keep-alive session 在设置期间不受影响（视图切换不碰 session 生命周期）。
4. **top bar 隐藏的合理性**：设置视图内不需要 profile 快速切换（Profiles tab 即可管理）、不需要 session 相关控件；自带 header 足够。返回应用后 top bar 恢复、profile 下拉可见。

## Considered options

- **模态 Dialog 变宽（max-w-2xl）+ 左 tab**：最小改动（现有 Radix Dialog），但浮层承载多 profile 主从布局拥挤；✕ 关闭语义弱于返回导航。否决。
- **独立 OS 窗口**：桌面应用开多窗口不自然、焦点分散、与单窗口 shell 模型（ADR-0045/0060）冲突。否决。
- **保留 session sidebar、设置只占主工作区**：双左导航（session sidebar + 设置分类导航）并列冲突；设置视图失去独立感。否决。
- **URL 路由（/settings）**：Tauri 单窗口应用无 URL 路由基础设施；状态切换视图（settingsOpen）足够，不必引入路由层。否决（YAGNI）。

## Consequences

- **shell 层并列渲染 + CSS 隐藏**：settingsOpen 时 shell 在 session shell 之上并列渲染 `<SettingsView/>` 覆盖层（`{settingsOpen && <SettingsView/>}`），session sidebar + topbar + keep-alive session pane 不卸载、靠 `.shell.settings-mode > :not(.settings-overlay) { display:none }` 隐藏；SettingsView 含自己的 header（返回按钮 + 标题）+ 左导航 + 右内容。打开/关闭是覆盖层挂载/卸载 + CSS 类切换，非 Dialog open/close，也非 session shell 的 ternary unmount。
- **关联 ADR-0045/0054/0060**：设置视图覆盖时，session shell（two-pane 0045、collapse 0054、session nav 0060）整体不可见但状态保留；返回原样恢复。shell collapse prefs（0054）不进设置视图。
- **Radix Dialog 不再用于设置**：保留给其他场景（如 profile 删除确认用 AlertDialog）；现有 `SettingsDialog` 组件退役或重构为 `SettingsView`。
- **keep-alive session 不受影响**：设置视图是 shell 层覆盖，`openSessions` / `activeSessionId` 状态保留；切回立即恢复运行中的 turn（若在 flight）。
- **入口与退出**：top bar 齿轮（`settingsOpen=true`）进入；「‹ Back to app」（`settingsOpen=false`）退出；ESC 键也可退出（沿用 Dialog 的 ESC 习惯，虽无遮罩但保留键盘退出）。
- **i18n**：设置视图的 header / 导航 / 分类标题走 ADR-0052 catalog（`settings.*` keys），中英双语。
- **无障碍**：覆盖视图需管理焦点（进入时焦点移到设置视图、退出时还原触发元素），借用 Radix 的 focus-trap 思路（虽不用 Dialog primitive）。
- **与 ADR-0064 的边界**：0064 定义 profile 的后端模型与多协议；本 ADR 定义承载 profile 管理（及其他偏好）的前端视图形态。两者正交：profile CRUD 的具体交互（可展开卡片列表）属实现细节，不单独立 ADR。
- **被 ADR-0071 校准**：top bar 因 `ProfileSwitcher`（issue #154）退役精简；日常切换 provider/model 的入口移至对话区 `QuestionBar` 边的 popover。见 ADR-0071。
