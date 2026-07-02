# 前端 i18n：zh-CN/en-US 双语 + 四层翻译边界（canonical 不翻）

## Decision

前端 i18n 范围与机制定下六块：

**（1）语种范围（Q1）**
- v1 = **zh-CN + en-US**，i18n 骨架从 v1 内建（字符串全抽离、ICU MessageFormat、locale 作 ADR-0038 preference）。

**（2）四层翻译边界（Q2）**——toptopduck 的内容分四层，每层一条规则，混了就越界：

| 层 | 例子 | 规则 |
|---|---|---|
| ① UI chrome | tab 名、Settings 标签、stale 披露横幅、viz 退化披露、outcome 语义文字 | 全翻，按 locale bundle |
| ② 系统格式 | 日期、千分位、小数点 | 仅展示层 locale 化，底层数据不变形；**数据表单元格保持原样**，只 chrome 元信息（"上传于…"）按 locale 格式化 |
| ③ LLM 生成内容 | 回答正文、assumption、澄清（B 轮，ADR-0048）、越界拒绝（ADR-0017） | 跟 locale 走 |
| ④ 永不翻译（硬线） | 用户逐字提问（ADR-0039）、生成的 SQL（ADR-0009）、`result_N` 引用名（ADR-0037）、数据集内容、Recipe/DuckDoc 格式（ADR-0034/0036） | locale 无关，恒定 |

- ICU MessageFormat 占位符插值是**硬要求**——UI 拼接"作用于 `result_1`"时，模板翻（"作用于 {ref}"/"acting on {ref}"），但 `{ref}` 值（`result_1`）**原样透传、不经翻译管线**。

**（3）两套词汇，单向喂养（Q3）**
- **Canonical（ubiquitous language）**——CONTEXT.md / 代码标识符 / Recipe / LLM system-prompt 词汇表——locale 无关、恒定。
- **Display label（UI 标签）**——i18n bundle——按 locale 翻译。
- 单向：canonical 是 bundle key 的来源，**反向不成立**——翻译包永远不能回写 canonical。
- LLM 的**引用层 locale 无关、叙述层 locale 化**：用 locale prose 写回答，但引用领域实体一律用 canonical 稳定身份（`result_1`）。
- CONTEXT.md 本身不是可翻译产物（双语契约，locale 无关，属第④层）。

**（4）canonical prompt + locale 指令（Q4）**
- `CAPABILITY_BOUNDARY_PROMPT`（`src-tauri/src/provider/prompt.rs`）**保持单语 canonical**（留 zh，零改动）；`render_schema_context` 的标签**也留 canonical zh**（模型可见、用户不可见的元数据）。
- **唯一**随 locale 变的：拼一段 `response_locale_directive(locale)`，追加"用 {locale} 回复；SQL 与引用名（如 result_1）保持原样"。
- 组装：`build_system_prompt(request, locale) = CAPABILITY_BOUNDARY_PROMPT + response_locale_directive(locale) + render_schema_context(request)`。
- **locale 在 Rust 侧从 ADR-0038 配置解析**——编排器组装 prompt 时读配置；**`ProviderRequest` 不加 locale 字段**；frontend 不经 IPC 传 locale。
- 边界定性：locale 是 preference（ADR-0038），不是用户数据；其进 prompt 不违 ADR-0006，schema context（样本/列名）不受 locale 影响，ADR-0011 隐私保证原封不动。

**（5）locale 生命周期（Q5）**
- locale = ADR-0038 preference，**与 theme 同 store**；0038 结构不变，只加一个 key。
- 默认**跟随系统**（启动读 OS locale），Settings 给 zh-CN / en-US / 跟随系统 三态——结构与 0050 主题三态 toggle 平行（DRY）；"跟随系统"每次启动重读 OS locale。
- 强制：`zh*`→zh-CN、`en*`→en-US、**其余 → en-US fallback**；持久化值损坏/未知 → 同样回落 en-US，永不 crash。
- **locale 不进 Recipe**（app 级，非 session 级）；**切换 locale 不重译历史**——老轮次回复保持生成时的语言原貌，只有新轮次用新 locale（ADR-0039 逐字原则在 i18n 下的延伸）。

**（6）实现骨架（Q6）**
- 库 = **react-intl（FormatJS）**——ICU 原生（Q2 硬要求零插件满足）、无构建步骤（不碰 Vite 配置）、`Intl.*` 同宗。
- catalog = `src/locales/zh-CN.json` + `src/locales/en-US.json`，**Vite 构建期静态 import** 进 bundle，不走 CDN / lazy fetch（local-first 硬约束）。
- 第②层格式化 = `Intl.NumberFormat` / `Intl.DateTimeFormat`，经 `useFormatters()` hook，与字符串 catalog 同住 i18n 模块但职责分离；数据表单元格不经过它。
- `useLocale()` hook 与 0050 `useTheme()` **同形**，经 Tauri IPC 读写 0038；根节点 `<IntlProvider>` live 重渲、无需重启。
- 防漂移：`@formatjs/cli extract` 进 CI，强制 en catalog key 集合 == zh catalog。

## Context

ADR-0049（样式栈）、0050（视觉系统主题）、0051（前端状态分层）已落地，前端骨架只剩 i18n 这一根跨切面关切未决。更关键的是：`src-tauri/src/provider/prompt.rs` 的 `CAPABILITY_BOUNDARY_PROMPT` 是一个 `pub const &str`、整段硬编码中文（能力边界 + 输出契约，40 行），`render_schema_context` 的标签（"引用名"/"行数"/"列"/"样本"…）也是 Rust 侧硬编码中文——**当前架构已内嵌一个 locale 决策（system prompt 冻结 zh）**，prompt 组装完全在 Rust 侧。i18n 不能只覆盖 UI chrome，必须决定 locale 如何进 prompt。本 ADR 收口这六块。

## Why

1. **zh/en 是已证刚需**——CONTEXT.md 双语、ADR 中文、0050 目标"非技术用户零配置"；i18n 骨架从 v1 内建，为将来增语种留通路而不付当下投机成本。
2. **第④层硬线是 ADR-0037/0009/0004 的直接推论**——`result_N` 是稳定身份、SQL 是执行对象、数据集 source-readonly（ADR-0004 derive-only）。翻译它们 = 碎裂身份、污染数据。ICU 占位符透传是这条线在机制上的落地。
3. **canonical 不翻保护 ubiquitous language**——CONTEXT.md 是双语契约、locale 无关的真相源；翻译者"好心"把 `result_1` 翻成"结果_1"会让 SQL 引用、UI 显示、用户口述三方失配。两套词汇单向喂养堵这个失败模式。
4. **canonical prompt + locale 指令而非全翻**——Claude 多语，prompt 语言与 response 语言可解耦；全翻 40 行能力边界 = 两处维护、内容测试×2、零质量收益（DRY/YAGNI）。locale 在 Rust 侧解析契合 ADR-0029"Rust 拥有发往云端的一切"，`ProviderRequest` 数据契约保持纯净。
5. **历史不重译是 ADR-0039 逐字原则的延伸**——重译 = 篡改逐字句柄 + 批量额外云端推理（违 ADR-0006 最小联网）+ 诚实性损失。locale 只向前生效。
6. **react-intl 三件事的交集**——ICU 原生（硬要求零插件）、无构建步骤（不碰 Vite 配置，本仓库配置保护约束下的实质红利）、`Intl.*` 同宗（字符串与格式化心智一致）。i18next 最重对抗 KISS、Lingui 构建步骤撞配置保护、手搓违"骨架内建"且 zh 无复数是侥幸非设计。

## Considered options

- **第③层只翻 chrome（LLM 回固定语言）**：用户中文问、LLM 英文答，半中半英，非技术用户体验崩。**否决**。
- **第②层连数据表内容也按 locale 格式化数字**："显示 1,5 但复制出 1.5"的认知裂缝 + 数值对齐/粘贴语义受影响。**否决**——数据表保持原样，仅 chrome 元信息 locale 格式化。
- **全翻 `CAPABILITY_BOUNDARY_PROMPT` + `render_schema_context`**：两处维护、ADR-0017 内容测试要 locale 参数化、漂移风险、零模型质量收益。**否决**——canonical 单语 + locale 指令。
- **`render_schema_context` 标签切 en（贡献者可读性）**：纯文案、不影响架构；选留 zh 以零改动优先（现有测试全过）。**否决（v1，留 zh）**。
- **locale 经 IPC 由 frontend 推给 Rust（`ProviderRequest` 加字段）**：让 frontend 半塑 prompt，模糊 trust root 边界。**否决**——Rust 从 0038 自取。
- **切 locale 批量重译历史**：违 ADR-0039 逐字 + 违 ADR-0006 最小联网 + 诚实性损失。**否决**——locale 只向前生效。
- **fallback 选 zh-CN**：对不支持 OS locale（de-DE/ja-JP），zh 不是最少意外兜底。**否决**——en-US fallback。
- **i18next + react-i18next + i18next-icu**：最重、"框架感"对抗 KISS、ICU 是外挂插件多一层。**否决**。
- **Lingui**：构建步骤（Vite 插件 + macro + CLI 编译）撞本仓库 lint/JS 配置保护约束。**否决**。
- **手搓 ~50 行 context + JSON**：v1 表面小看似可行，但违 Q1"骨架内建"——出现复数/第三语种即返工；zh 无复数是侥幸。**否决**。

## Consequences

- **prompt.rs 增量**：新增 `response_locale_directive(locale: Locale) -> &'static str` 与 `build_system_prompt(request, locale)` 拼接点；`CAPABILITY_BOUNDARY_PROMPT` 与 `render_schema_context` **零改动**——现有 7 个 `assert!(p.contains("预测"))` 类内容测试全过，仅新增"locale 指令正确拼接"一条测试。
- **ProviderRequest 契约不变**：`question/history/datasets/active` 维持原样；locale 不进数据载荷。
- **ADR-0038 增一个 locale 字段**：与 theme preference 同 store、同生命周期；结构不变。
- **前端增量**：`react-intl` 入 deps；`src/locales/{zh-CN,en-US}.json` 两份 catalog；`<IntlProvider>` 根节点；`useLocale()`（镜像 `useTheme`）+ `useFormatters()`（绑 `Intl.NumberFormat/DateTimeFormat`）hook 进 src。
- **CI 增量**：`@formatjs/cli extract` + 强制 en/zh catalog key 集合相等的检查，漏译无法合并。
- **0050 Settings `Dialog` 增一个 locale `Select`**：与主题 toggle 同面，不开新 surface。
- **UX 后果（须文档化）**：切 locale 仅向前生效——老轮次回复保持原语言、不重译；这是 ADR-0039 逐字原则的推论，非 bug。
- **CONTEXT.md 不动**：i18n 不引入新领域术语——locale 是 0038 preference、非领域概念；四层边界涉及的 `result_N`/SQL/Recipe 全是已定义术语。
- **未决（留实现期）**：catalog key 命名空间细则、`@formatjs/cli` 抽取的 CI 集成方式、Settings locale `Select` 的精确文案。
