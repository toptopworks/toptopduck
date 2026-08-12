# provider/model 选择入口:移至对话区 QuestionBar 边,ProfileSwitcher 退役

## Decision

日常切换 provider/model 的入口从 top bar（`ProfileSwitcher`，issue #154）移至对话区 `QuestionBar` 边：图标触发器（lucide 统一入口图标）→ hover tooltip（`"{provider} · {model}"`，无 key 追加未配置标记）→ click popover 面板（provider 下拉 + model 下拉 + key 状态 + 「打开设置」入口）。popover 为 copy-in shadcn primitive（ADR-0049）。`ProfileSwitcher` 退役。model 切换写回 `profile.model`，不独立化。

## Context

ADR-0065 把 profile 管理收口到 Settings 覆盖视图，ADR-0064 把日常切换落在 top bar `ProfileSwitcher`（issue #154）。但提问发生在对话区，切换 provider/model 应邻近提问地；top bar 切换与提问区分离，焦点跳转。model 绑死 profile，切 model 要进 Settings 改 profile 或建第二个 profile，摩擦高。

## Why

1. **对话区是提问发生地**：切换放 `QuestionBar` 边，提问前顺手切，免去 top bar 与对话区之间的焦点跳转。
2. **图标 + tooltip + popover 三态分层**：默认图标省 `QuestionBar` 宽度；hover tooltip 轻量预览；click popover 承载完整选择 + key 状态 + 设置入口。轻预览与重操作分层，避免常驻下拉挤占输入区。
3. **model 写回 profile.model 最简**：model 是 per-profile 的（不同 provider 支持不同 model 集，全局活跃 model 跨 provider 无意义）；切 model 写回该 profile 的 `profile.model`，`live_config` 读法不变，不引新存储。
4. **ProfileSwitcher 退役减冗余**：日常切换由对话区 popover 承载；active 状态由触发器 tooltip 显示，信息不丢。
5. **信息架构对齐主流 agent composer**：面板结构（provider 下拉 → model 下拉 → key 状态 → 打开设置）对齐主流 agent composer 的选择器；视觉与文案走本项目栈——lucide 图标（不用 provider logo，避商标）、ADR-0052 catalog、领域语言用「接入档案/协议」（`_Avoid_: provider`）。

## Considered options

- **保留 ProfileSwitcher + 对话区 popover 双入口**：冗余、双处状态同步。**否决**。
- **对话区内联两下拉常驻（不点开）**：占 `QuestionBar` 宽度，输入区被挤。**否决**。
- **model 独立化**（从 profile 拆出，引全局活跃 model / per-session override）：app-config schema 变更 + `ProviderConfigSource::model()` 来源重写；而 model 是 per-profile 的，全局活跃 model 跨 provider 无意义。**否决**。
- **手写 popover disclosure**（仿 `ProfileSwitcher` 的 containerRef + click-outside）：对静态菜单够用，但 popover 内是表单，focus trap / 键盘导航的 a11y 手写易漏。**否决**——copy-in shadcn popover primitive（ADR-0049 栈内增量）。

## Consequences

- **校准 ADR-0064**：model 仍是 profile 字段（不独立化）；对话区切 model 写回 `profile.model`，`live_config` 读法不变；`ProfileSwitcher`（issue #154）退役，日常切换入口移至对话区（本 ADR）。
- **校准 ADR-0065**：top bar 因 `ProfileSwitcher` 退役精简；日常切换入口在对话区 `QuestionBar` 边（本 ADR）。
- **copy-in shadcn popover primitive**：`src/components/ui/popover.tsx`（ADR-0049 栈，纯 Radix 包装）。
- **DRY 原子字段组件**：抽 `ProviderPresetField` / `ProviderEndpointFields` / `ProviderKeyField`，`ProfilesSection`、对话区 popover、首跑引导共享；具体形态属实现，不单独立 ADR。
- **provider preset 常量**：前端常量（不进 app-config，ADR-0038）；preset 隐含 protocol、Custom 暴露 protocol RadioGroup；字段含「获取 key」链接（信息架构对齐主流 byok 设置面板）。具体 preset 列表与字段进 issue。
- **key 未配的诚实提示**：popover 显示未配置标记 + 「打开设置」入口（ADR-0019 诚实门槛）。
- **被 ADR-0092 校准**：本 ADR 引入的 `ColdStartHero` 三态诚实门（no-profile / no-key / ready CTA）随 `ColdStartHero` 退役——诚实门改由 shell 级 `QuestionBar` 的 submit-time 判定承载（built-in 无 key → redirect Settings；external adapter 不可选 → picker disabled）。`QuestionBar` 上提 shell 级，picker 在无 session 时使用 shell-level pending runtime state。见 ADR-0092。
