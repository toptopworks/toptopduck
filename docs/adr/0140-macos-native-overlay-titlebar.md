# macOS titlebar：原生 Overlay 红绿灯取代前端模拟

## Decision

1. **macOS 窗口装饰从 borderless 切原生 Overlay titlebar**：`decorations: true` + `titleBarStyle: Overlay` + `hiddenTitle: true`——红绿灯、双击标题栏缩放/最小化（含系统「双击标题栏」用户偏好）、绿键、失焦灰显、hover glyph 全部回归系统供给。
2. **接线**：`tauri.conf.json` 窗口项加 `titleBarStyle: "Overlay"` + `hiddenTitle: true`（两者仅 macOS 生效），`decorations: false` 保留为 Windows/Linux 基线；Rust `setup` 在 macOS 构建期以 builder 链 `.decorations(true)` 覆写——平台中性参数仍以 config 为单一事实源。
3. **前端退役**：`MacOSWindowControls`（模拟红绿灯）与 `WindowControls` 平台分发删除；macOS topbar 首元素为 `w-[78px]` 拖动区 spacer 保留原生按钮带；Windows/Linux 的 `WindowsWindowControls` 右侧三按钮与拖动区不变。

## Context

ADR-0074 路线 1 在 macOS 以前端模拟红绿灯承载窗控（borderless + 三色圆点组件）。borderless 窗口没有原生 titlebar 体系，双击标题栏的缩放/最小化只剩 webview 侧注入脚本的模拟路径，macOS 真机不生效；且即便修通，该路径只做 toggleMaximize，不读系统「双击标题栏缩放/最小化」用户偏好。ADR-0074 的 Considered 预留了触发器：macOS 用户报手感差距即切路线 2（原生 overlay）——本 ADR 即该触发落地。

## Why

1. **双击语义只有原生能供给**：缩放/最小化随系统偏好走，绿键/失焦灰显/hover glyph 系统级保真零维护成本；模拟方案在 borderless 上永远残缺，且修 webview 路径买不回偏好语义。
2. **Overlay 保住自绘 topbar 视觉**：透明标题栏 + 内容全尺寸铺满，topbar 观感与 Windows/Linux 自绘一致；只需左侧保留 inset 让位原生按钮。
3. **切换是组件替换级**：App.tsx 平台分支 + builder 一行覆写 + inset/组件互退，非深层重构，可逆。

## Considered options

- **维持模拟并修 webview 双击路径**：borderless 下注入脚本路径真机不可用，修通也只 toggleMaximize、不读系统偏好；失焦灰显/Alt 语义还得逐项补模拟。**否决**——残缺语义买不回来。
- **macOS 自挂 dblclick 处理器调 toggleMaximize**：无论系统「双击标题栏」偏好设缩放还是最小化都只做 toggleMaximize，与注入脚本的双击路径共存还有双触发相消风险，borderless 语义残缺面未变。**否决**——原生 Overlay 一次收齐语义。
- **Windows/Linux 一并切原生装饰**：两平台自绘已交付且无手感投诉；Linux DE 多样性（GNOME headerbar / KDE 传统 / Cinnamon）下「原生」本身模糊，自绘跨 DE 一致。**否决**——仅 macOS 切换，其余平台维持 ADR-0074。
- **原生红绿灯做 toolbar 对齐挪位（objc2 运行时改 frame）**：只为把按钮垂直居中进 40px topbar，需引入 objc2 依赖 + resize 期多写者争夺的补偿机制，复杂度与收益不成比。**否决**——保留系统默认带内居中，真机目检后再议。

## Consequences

- **`tauri.conf.json`**：窗口项 `titleBarStyle: "Overlay"` + `hiddenTitle: true`；`decorations: false` 为 Windows/Linux 基线。
- **`src-tauri/src/lib.rs`**：macOS 构建期 `.decorations(true)` 覆写（`#[cfg(target_os = "macos")]`）。
- **前端**：删 `src/shell/WindowControls.tsx` + `src/shell/MacOSWindowControls.tsx`；`App.tsx` macOS 分支渲染 inset spacer；`WindowsWindowControls` / `window-actions.ts` / `use-platform.ts` 保留。
- **capabilities 不变**：Windows/Linux 窗控仍需 window 权限；macOS 原生按钮不经前端 IPC。
- **i18n 不变**：`window.close` / `window.minimize` / `window.maximize` / `window.restore` 仍由 Windows/Linux 窗控消费。
- **测试面**：分发器/模拟红绿灯套件退役；macOS 放置与设置视图测试改钉 inset/drag-region 不变量。
- **未决（留真机验收）**：原生红绿灯在 40px topbar 内的垂直对齐观感与 inset 78px 精调值。
- **取代关系**：ADR-0074 的 macOS 腿被本 ADR 取代；其 Windows/Linux 腿、平台检测、capabilities、i18n 各项保留。
