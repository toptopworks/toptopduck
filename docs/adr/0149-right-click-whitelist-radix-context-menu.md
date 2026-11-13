# 右键菜单：全局白名单放行，Radix ContextMenu 封装

## Decision

桌面壳右键策略为**全局白名单放行**：document 级 `contextmenu` 监听放行三类——文本编辑区（`HTMLInputElement` / `HTMLTextAreaElement` / `contenteditable`）、非空文本选区、已被自定义面 `preventDefault` 的事件（`event.defaultPrevented` 豁免——Radix 触发面的 `preventDefault` 先于 document 层生效，豁免即互斥，无需菜单容器选择器协调）；其余一律 `preventDefault()` 静默。自定义右键菜单以 **Radix `ContextMenu` primitive** 封装（`src/components/ui/context-menu.tsx`，视觉词汇随 `dropdown-menu`，常规 popover 档，不进 inverted 档——inverted 档边界=瞬态提示专用，见 `DESIGN.md`）。composer 等编辑区保留原生编辑菜单，不重造复制粘贴。

## Context

WebView2 默认开启原生右键菜单，应用壳此前无任何 `contextmenu` 处理：空白区、面板行、消息正文一律弹浏览器菜单，Reload/Print 等条目在桌面壳内语义错误。有管理动作的面（如工作集行）的动作只挂悬浮控件，右键手势闲置。编辑区的原生编辑菜单是能力（复制/粘贴/输入法），必须保留。

## Why

1. **静默优于错误菜单**：浏览器条目（刷新/打印/检查）在桌面壳内无意义甚至误导，白名单外的静默是打磨底线；同时静默策略让新增面板天然收敛——不挂菜单即静默，挂面即接管，无逐面禁用。
2. **编辑与选区是本能手势**：输入区右键复制粘贴、消息选区右键 Copy 是高频习惯，全局收编若砍掉它们等于把打磨做成残废；选区放行一条判断即保住。
3. **语义与键盘白拿**：`role=menu` 语义、键盘漫游、子菜单 grace area 与切换延迟由 Radix Menu 内建——自研要在子菜单指针行为上重造这套已发布的复杂度，且通常砍掉键盘漫游。

## Considered options

- **保留原生菜单不收编**（现状）：浏览器条目在桌面壳内语义错误，有动作的面右键继续闲置。**否决**。
- **纯 opt-in 不全局禁用**：只在挂自定义菜单的面 `preventDefault`，其余放任。WebView2 下 opt-in 之外区域照弹浏览器菜单——不同于默认无菜单的 Electron 宿主（opt-in 之外天然静默），打磨目标落空。**否决**。
- **自研菜单组件**：为子菜单指针行为（grace area、切换延迟）付出整套手写实现，代价通常是键盘漫游与完整 menu 语义的缺失。**否决**。
- **消息选区自定义交互面**（in-selection 判定 + 区域操作面）：产品上限更高，但初始实现成本不成比例，且选区右键放行原生 Copy 已覆盖本能手势。**否决**——选区右键放行原生 Copy。

## Consequences

- `event.defaultPrevented` 豁免使策略与 Radix 面零协调：新增挂载面无壳层登记步骤。
- 白名单外静默是全局行为变更：右键行为从「处处原生菜单」翻转为「处处静默，白名单与挂载面例外」。
- 首个挂载面为工作集行（重命名/换源/删除）。
- 选区右键在所有非编辑区都是原生 Copy；自定义选区操作面（引用到 composer 等）留待后续票。
- 键盘触发（`Shift+F10` / ContextMenu 键）暂缺：可见控件（pill 等）兜底 a11y；某动作仅剩菜单路径时须随该面提供键盘触发。
- macOS `Ctrl+click` 并发 click 与 `contextmenu` 双事件，挂载面属真机手核项。
