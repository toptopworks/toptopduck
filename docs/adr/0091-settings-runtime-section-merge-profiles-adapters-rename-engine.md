# 设置页信息架构:运行时 section 合并接入档案与适配器 + Engine 改名数据库引擎

## Decision

设置页（ADR-0065/0075 覆盖视图）的 nav 分区信息架构重定如下：

1. **合并 Profiles 与外部适配器管理为「运行时」section**：原 Profiles section（ADR-0065 分区列表）升级为「运行时 (Runtime)」，内含两个子 tab——「API 接入配置」（原 Profiles 的 BYOK Profile CRUD，内容不变）与「本机 CLI」（外部 ACP 适配器检测列表 + rescan 按钮，从 Composer popover 迁入）。子 tab 为设置面板内的新导航层级：面板顶部两个 tab 切钮，点切换显示对应子内容，同一时刻仅一 tab 可见。

2. **Engine section 改名「数据库引擎」**：原 Engine section 改名为「数据库引擎 (Database Engine)」，消除与「运行时」的术语碰撞（CONTEXT.md「运行时」词条 _Avoid_: 引擎(engine)——易与 DuckDB 引擎混）。内容不变（DuckDB 四项引擎默认值）。

3. **Composer popover 精简为纯选择器**：外部运行时段移除 rescan 按钮与未检测适配器的灰显行，仅渲染 `detected === true` 的适配器供选择；底部增加「管理外部运行时 →」文字链接，点击打开 Settings 运行时 section 并落到「本机 CLI」tab。Built-in 段的「打开设置」入口保持打开 Settings 运行时 section 并落到「API 接入配置」tab。两个入口各自指向语义对应的子 tab，不做动态判断。

4. **nav 顺序调整**：`General / 运行时 / Skills / MCP / 数据库引擎 / Privacy`。运行时（原 Profiles）从第 4 位提前至第 2 位（紧随 General），因其为首次使用必配项且配置频率高于 Skills / MCP。

## Context

ADR-0065 定设置覆盖视图含 nav 分区 General / Profiles / Engine / Privacy，后增 Skills（#362）、MCP（#387）。ADR-0071 将日常 provider/model 切换入口移至 Composer popover，Profiles section 降为纯管理面。ADR-0076/0081/0085 引入双运行时架构后，Composer popover 承载了运行时选择（ADR-0083 per-session runtime picker），其 External 段含适配器检测列表 + rescan 操作。适配器管理操作（检测、重扫描）与管理面（Settings）分离，驻留在日常选择器（Composer）中，职责混叠。同时 nav 中 Profiles 与 Engine 并列，而 Engine 是泛词、与引入后的「运行时」存在术语碰撞风险（CONTEXT.md 已标记）。

当前 V1 适配器已扩展至 5 个（claude-code / gemini-cli / codex / qwen-code / opencode），适配器管理面板有足够内容密度支撑独立子节。

## Why

1. **职责分离——选择 vs 管理**：Composer popover 是日常轻量选择器（选运行时、切 profile/model），Settings 是低频重管理面（CRUD、检测、配置）。rescan 与检测状态展示属管理操作，留在 Composer 使日常选择器承载了不属于它的管理职责。迁移后 Composer 纯做选择（从可用项中选），Settings 纯做管理（维护可用项集），职责边界清晰。
2. **术语消歧——Runtime vs Engine**：CONTEXT.md「运行时」词条已标注 _Avoid_: 引擎(engine)——易与 DuckDB 引擎混。nav 中同时出现 Runtime 和 Engine 使用户难以分辨。Engine 改名为专名「数据库引擎」，两个专名并列零碰撞；运行时保留精确领域术语不降级。
3. **信息密度——适配器子节已有分量**：5 个适配器的检测列表（名称 + binary path + detected/not installed 状态）+ rescan 按钮，构成一个有实质内容的管理子节，不再是空面板。
4. **nav 顺序反映使用频率**：运行时配置（Profile + 适配器）是首次使用必经路径，配置频率高于 Skills / MCP（工具扩展，进阶用户）；提前至第 2 位减少首次配置的导航距离。
5. **子 tab 而非垂直堆叠**：Profiles（master-detail 重布局）与适配器管理（轻列表）内容密度不对称。子 tab 令每个子节独占面板空间，避免重布局挤压轻列表；同时子 tab 是设置面板内的新导航层级，不新增 nav 条目。

## Considered options

- **垂直堆叠两块（不用子 tab）**：Profiles master-detail + 适配器 SettingsCard 纵向共存于一面板。内容密度不对称致视觉重心偏上、适配器区被挤底部。**否决**。
- **保持 Profiles 与适配器为分立 section**：nav 中并列两个相关 section（Profiles + Adapters），违「统一管理」目标。**否决**。
- **rescan 留 Composer 不迁移**：Composer 仍含管理操作，职责混叠不变。**否决**。
- **Composer 外部段仍显示未检测适配器（灰显 Not installed）**：日常选择器展示不可选项增加噪音；未检测状态已在 Settings 管理面可见，Composer 不需重复。**否决**——仅显示已检测。
- **Engine 改名 DuckDB（专名）**：比「数据库引擎」更精确，但产品名入 nav 标签的必要性不足；「数据库引擎」已有足够消歧前缀且更面向用户。**否决**。
- **运行时改叫「执行模式」**：「模式」暗示全局开关，而运行时选择是 per-session（ADR-0083）；且放弃已锚定的领域术语。**否决**。
- **tab 标签用「API 提供商」**：CONTEXT.md「接入档案」词条 _Avoid_: 提供商(provider)——多家共用同一协议，一个 provider 可有多 Profile，「提供商」暗示一对一误导。**否决**——用「API 接入配置」。

## Consequences

- **校准 ADR-0065**：分区列表由 `General / Profiles / Engine / Privacy` 变为 `General / 运行时 / Skills / MCP / 数据库引擎 / Privacy`；Profiles 升级为运行时（含子 tab），Engine 改名数据库引擎。
- **校准 ADR-0071**：Composer popover 的 provider picker 职责收窄——Built-in 段保持不变（profile/model/key + 打开设置），External 段移除 rescan + 未检测灰显行、改为纯检测到的适配器选择列表 + 「管理外部运行时 →」链接。ADR-0071 的 popover 形态、tooltip、profile/model/key 交互不变。
- **校准 ADR-0075**：逐控件持久化模型不变；子 tab 是面板内导航层级，不引入新的持久化或 draft 语义。rail 外壳（顶部返回 + 图标 nav + 底部连接状态行）不变；连接状态行点击目标从 Profiles section 改为运行时 section「API 接入配置」tab。
- **子 tab 是设置面板内新导航模式**：现有面板均为扁平单内容区（PaneHeader + 卡片）；运行时 panel 引入 tab switcher，后续面板如需同样模式可复用。tab 状态不持久化（面板切走再切回回到默认 tab「API 接入配置」）。
- **nav 顺序变更**：SETTINGS_SECTIONS（`sections.ts`）重排为 `["general", "runtime", "skills", "mcp", "database-engine", "privacy"]`；section id `profiles` → `runtime`、`engine` → `database-engine`，涉及 SettingsSection type、SectionIcon、SectionLabel、i18n key（`settings.nav.*`）全链路更新。
- **CONTEXT.md 不变**：「运行时」「适配器」「接入档案」已入 glossary；子 tab 标签（「API 接入配置」「本机 CLI」）是 UI 标签非领域概念，不入 glossary。
- **未决（实施期）**：子 tab 组件形态（copy-in Radix Tabs 或自建 button 切换）、icon 选择（运行时拟 Cpu、数据库引擎拟 Database）、i18n key 命名（`settings.nav.runtime` / `settings.nav.databaseEngine` / `settings.runtime.tab.*` / `settings.runtime.adapters.*`）、Composer 链接落 tab 的 IPC 参数或 URL state 传递方式。
