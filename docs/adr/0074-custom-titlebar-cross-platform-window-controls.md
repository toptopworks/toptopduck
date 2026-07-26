# 自定义 titlebar：decorations:false + 跨平台 window controls（前端模拟 macOS 红绿灯）

## Decision

窗口装饰从系统原生 titlebar 切换为**自定义 titlebar**（`decorations: false` + 自绘窗控 + 拖动区）：

- **`tauri.conf.json`**：`decorations: false`（全局，所有平台丢系统装饰）。
- **`capabilities/default.json`**：加 `core:window:allow-{minimize,maximize,unmaximize,toggle-maximize,close,start-dragging}` + `os:default`（plugin-os）。
- **平台检测**：`@tauri-apps/plugin-os`（npm + cargo + `lib.rs` register），前端 hook `use-platform.ts` 做模块级缓存 + jsdom fallback（`platform()` 失败回退默认平台）。
- **`WindowControls` 组件平台分发**：
  - **macOS → `MacOSWindowControls`**（左侧）：三色圆点（red close / yellow minimize / green zoom），hover group 同时显形 × / − / +（纯 CSS `group-hover`），click → `getCurrentWindow().{close,minimize,toggleMaximize}()`。**省略**失焦灰显 + Alt+click（留后续）。
  - **Windows / Linux → `WindowsWindowControls`**（右侧）：min / max-restore / close 三按钮，`onResized` 同步最大化态切 glyph。
  - Linux 不 `return null`——全局 `decorations: false` 下 null 会让 Linux 无任何窗控；Linux 落 Windows 分支配 `WindowsWindowControls`。
- **位置**：macOS 红绿灯在 topbar 左上（视口真·左上，依赖 ADR-0073 的全宽 topbar），`SidebarToggle` 右移让出左侧保留区；Windows / Linux 的 `WindowsWindowControls` 在 topbar 最右。
- **绿键语义**：`toggleMaximize()`（跨平台与 Windows 路径一致），**非** fullscreen。

## Context

ADR-0060 的顶栏模型假设系统原生 titlebar（`decorations: true`），topbar 是原生 titlebar 之下的薄 chrome。自定义 titlebar（`decorations: false` + 自绘窗控 + `data-tauri-drag-region`）让窗口外壳视觉可控 + 跨平台一致，但代价是 window controls（close / minimize / maximize）从系统供给变为 app 责任——macOS 红绿灯、Windows 右侧三按钮、Linux 的处理都需自决。

本 ADR 收口 window controls 的**实现策略 / 平台检测 / 位置 / 保真度 / 绿键语义 / Linux 空缺**六项边界决策。topbar 升级为自定义 titlebar 触发 ADR-0073（session 名 + rail 折叠迁出 topbar）。

## Why

1. **全局 `decorations: false`**：全平台视觉可控 + 无启动装饰闪现 + 避免 `tauri.conf.json` 不支持平台条件化带来的 Rust `setup` 分支复杂度。
2. **路线 1（前端模拟 macOS 红绿灯）而非路线 2（原生 overlay）**：模拟方案跨平台一致 + 可逆（组件替换即可升级路线 2）；路线 2 要求 `decorations: true` + `titleBarStyle: Overlay` + `macOSPrivateApi` + Rust 平台分支 `set_decorations`，复杂度与 v1 收益不匹配；路线 1 → 路线 2 是组件替换 + Rust `setup` 增量，可逆。
3. **`plugin-os` 而非 `navigator.userAgent`**：Tauri 官方 purpose-built API；repo 已用 4 个 Tauri plugin（dialog / log / window-state / single-instance），加 plugin-os 是同模式；对 webview UA 漂移免疫；不手写 plugin 已封装的判断（DRY）。
4. **位置（macOS 左上 / Windows+Linux 右）**：macOS 平台惯例（红绿灯左上），非技术用户（ADR-0001）肌肉记忆只认这个；`SidebarToggle` 永远是「左侧保留区之后第一个」，仅 `WindowControls` 随平台换边，跨平台一致性最高。
5. **Linux 配 `WindowsWindowControls`（非 null）**：全局 `decorations: false` 下 `null` 会让 Linux 无任何窗控；Linux 桌面环境多样性（GNOME headerbar / KDE 传统 / Cinnamon）使「原生」本身模糊，自绘反而跨 DE 一致。
6. **保真度 F2（三色 + hover group 显形，省略灰显 + Alt）**：hover 显形是最高信号保真项（非技术用户点关闭前先 hover 确认，缺 × 最易被感知为「假」）；失焦灰显对单窗应用（ADR-0046）价值低（unfocused 态罕见）；Alt+click 是 power-user（YAGNI）。F2 是 80/20 切。
7. **绿键 = `toggleMaximize`（非 fullscreen）**：跨平台语义与 Windows 路径一致；toptopduck 渲染宽表（ADR-0045 Why#2）+ Vega-Lite 大图（ADR-0016 / 0033），用户要屏内最大工作区而非沉浸式独占屏；fullscreen 的独立 Space + 隐藏 dock 对非技术用户（ADR-0001）构成导航陷阱。

## Considered options

- **路线 2（原生 overlay：macOS `decorations: true` + `titleBarStyle: Overlay` + `macOSPrivateApi`）**：原生手感最佳但要求平台条件化 decorations（`tauri.conf.json` 不支持，须 Rust `setup` 里 `set_decorations`）+ 启动闪现风险 + 复杂度与 v1 收益不匹配。**否决**——路线 1 模拟满足 v1 保真度需求，若 macOS 用户报手感差距再 supersede 升级路线 2。
- **`navigator.userAgent` / Rust `cfg!(target_os)` 做平台检测**：前者零依赖 + jsdom 原生，但手写 plugin-os 已封装的判断、UA 是 webview 实现细节有漂移风险；后者编译期 truth 但 command + async + 初载时序接线重。**否决**——plugin-os 是 Tauri 官方 API（repo 已用 4 个 Tauri plugin，一致），模块级缓存更简，DRY。
- **Linux `return null` / 平台条件化原生装饰**：前者假设 `decorations: true`，全局 `false` 下 Linux 无任何窗控（残缺）；后者破全局 `false` 纪律、引入 Rust 平台分支（与路线 2 同理）。**否决**——Linux 配 `WindowsWindowControls`，守全局 `false` 纪律。
- **保真度 F1（无 hover 显形）/ F3（含失焦灰显 + Alt+click）**：前者最大化「模拟感」代价、背叛路线 1「可接受模拟」前提；后者失焦灰显对单窗应用价值低、Alt+click power-user YAGNI、引入命令分发抽象比直调 `getCurrentWindow` 重。**否决**——F2 是 80/20 切（hover 显形是高信号低保真项，纯 CSS `group-hover`），F2 → F3 是增量不重构。
- **绿键 = fullscreen / 原生 macOS zoom（用户尺寸 ↔ 理想尺寸）**：前者跨平台语义分裂（Windows 是 maximize）、fullscreen 独占 Space 碍事、对非技术用户构成导航陷阱；后者 Tauri API 无直接对应。**否决**——`toggleMaximize` 跨平台一致且语义清晰。
- **macOS 红绿灯也放右侧（同 Windows）**：违 macOS 平台惯例，非技术用户肌肉记忆撞墙。**否决**。

## Consequences

- **`tauri.conf.json`**：`decorations: false`（全局）。
- **`capabilities/default.json`**：加 `core:window:allow-{minimize,maximize,unmaximize,toggle-maximize,close,start-dragging}` + `os:default`（plugin-os）。
- **新依赖**：`@tauri-apps/plugin-os`（npm，匹配 `@tauri-apps/api` ^2）+ `tauri-plugin-os`（cargo）+ `src-tauri/src/lib.rs` register（现有 plugin 列表 L137-166 末尾）。
- **新文件**：`src/shell/WindowControls.tsx`（平台分发入口）+ `MacOSWindowControls.tsx` + `WindowsWindowControls.tsx`（现 `WindowControls.tsx` 的 Windows 逻辑抽出）+ `src/shell/use-platform.ts`（`platform()` + 模块缓存 + jsdom fallback）。
- **`App.tsx` topbar**：挂 `data-tauri-drag-region` + 挂 `<WindowControls />`（macOS 平台条件下挪到首位、`SidebarToggle` 前）。
- **i18n（ADR-0052）**：window-control 的 aria-label 走 `intl.formatMessage`（非硬编码英文）；id 命名 `window.close` / `window.minimize` / `window.maximize` / `window.restore`；`zh-CN.json` + `en-US.json` 手动加 key（勿跑 `i18n:extract`，会 trim 破坏手维护的 `en-US.json`）。
- **关联 ADR-0067**：topbar 仍作 layout-only 语义类；`WindowControls` 用 Tailwind utility + ADR-0050 token，不增 `styles.css` 规则。
- **关联 ADR-0052**：window-control aria-label 入 i18n 四层不变量。
- **关联 ADR-0068**：窗口几何 advisory state 不变；`onResized` 既已通过 `useAppConfigState` 持久化几何，自定义 titlebar 不改其语义。
- **关联 ADR-0054**：`minWidth` / `minHeight` 兜底不变；自定义 titlebar 不改窗口尺寸策略。
- **关联 ADR-0073**：topbar 承载 window controls + drag region（shell-wide chrome）；session-scoped chrome 迁出见 0073。
- **CONTEXT.md 不动**：window controls / titlebar / 红绿灯是 UI chrome 实现，非领域术语（遵循 ADR-0060 行 72 / ADR-0068 行 57 先例）。
- **未决（留实现期）**：红绿灯精确尺寸 / offset / hover glyph 字形细节；是否升级 F3（失焦灰显 + Alt+click）以回应 macOS 用户手感反馈；是否 supersede 路线 2（原生 overlay）若 macOS 成主力发布平台。
- **可逆性**：路线 1 → 路线 2 是组件替换（`MacOSWindowControls` → 原生 overlay）+ Rust `setup` 增量 + `tauri.conf.json` 平台条件化，非深层重构；届时新开 ADR supersede 本 ADR。
