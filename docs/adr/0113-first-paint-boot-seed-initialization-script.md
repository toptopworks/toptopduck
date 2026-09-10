# 首绘种子：主窗口经 initialization script 注入 theme/locale，IPC 全量为权威

## Context

主窗口渲染不等 app-config：前端同步 `render(<App/>)`，`appConfig` 以 `null` 起步、mount 后一次性 `getAppConfig` IPC 拉取。IPC 往返返回前，主题按「system」解析、locale 按 OS locale 解析——持久化值与系统解析值不一致（如持久化 `dark` + 系统 light、持久化 `zh-CN` + 英文系统）时，首绘呈现系统侧外观，IPC 到达后可见翻转；locale 目录闪变比主题更可感。

Rust 侧 `setup` 启动时已读 app-config（ADR-0038 honest-degrade 读路径），数据就位，缺的只是首绘前的投递通道。首绘正确性只能在页面脚本运行前建立——时序不定的通道（page load 后 eval）与首帧竞态，不可用。

## Decision

1. **载体 = `create: false` + builder 挂脚本。** `tauri.conf.json` 主窗口定义保留为声明式模板（`windows[0]` 加 `create: false`），`setup` 内经 `WebviewWindowBuilder::from_config` 创建并挂 `.initialization_script()`。窗口参数以 tauri.conf.json 为唯一事实源，Rust 侧零参数拷贝；config 查找按 label 非索引；构建失败传播（与框架自建窗口同失效模式）。

2. **契约 = 窄 payload 无条件注入。** 脚本赋值全局 `window.__TOPTOPDUCK_BOOT_SEED__`（命名沿用 tauri 生态的双下划线全局惯例），值为扁平 JSON `{theme, locale}`——两字段复用 `Theme`（ADR-0050）/ `LocalePreference`（ADR-0052）枚举序列化，wire 字面量与 `get_app_config` IPC 同构（构造性对齐，无平行字符串映射可漂移）。注入值取 `live.load()` honest-degrade 结果且**无条件**：读失败回落 defaults（`system` / `system`）与通道前 null 回退语义零差，「全局缺失」只剩「脚本没跑」一种含义。payload 值域只有枚举变体、无自由文本，脚本无注入面。

3. **优先级与失效 = IPC 全量 > 种子 > 系统默认。** 种子仅作 `theme` / `locale` 的 null 期初值；`getAppConfig` 到达后整体覆盖，`commitAppConfig` 乐观提交契约（ADR-0068）不变。前端消费缝以枚举白名单校验全局——任一字段非法则整种子弃用，回退现状 `null` 行为（不新增用户可见错误面）；未知多余键容忍，对齐 app-config serde 读（无 deny_unknown_fields）。

## Why

1. **时序唯一性**——initialization script 在任何页面脚本前执行，是 webview 面上唯一「首绘前」通道；`on_page_load` 后 eval 与首帧渲染竞态，不满足约束。
2. **参数零拷贝**——`create: false` 模板路线让窗口参数留在 config 单点，「等价迁移」的回归面退化为单字段核验。
3. **wire 同构**——复用枚举 serde 使种子与 IPC 全量的字面量一致由构造保证，前端白名单与 locale 既有边界守卫同轴。

## Considered options

- **config 原生 initialization script 字段**：所用 tauri 版本的 `WindowConfig` 无此字段，路径不存在。**否决**。
- **`on_page_load` + `eval`**：时序不定，与首帧竞态。**否决**。
- **参数全量迁入 Rust builder（清空 `windows[]`）**：9+ 字段抄写回归面，无行为收益。**否决**。
- **仅非默认值注入**：多一条分支，「全局缺失」语义含混（没注入 vs 注入失败）。**否决**。

## Consequences

- 主窗口创建从「框架按 config 自动建」变为「setup 内显式建」：`setup` 后半段起才可见 main 窗口（2s 可见性兜底、single-instance 聚焦路径等在创建点之后，不受影响）；后续 setup 内新增代码若引用 main 窗口，须排在创建点之后。
- setup 对 app-config 的读取收敛为一次（`live.load()` 单调，sessions_dir 解析与种子脚本共享）。
- 前端 `useAppConfigState` 返回面新增 `bootSeed` 字段（null 期为种子、否则为 null）；`theme` 派生链变为「IPC 全量 > 种子 > system」三级，locale 链同形。
- 首绘时序（脚本注入 → 首帧）在 jsdom 与单测面不可观测；外观首绘、目录语言、window-state 几何恢复的验收面在真机。
- CONTEXT.md 不动：boot seed 是投递通道，非领域概念，无领域词增减。
