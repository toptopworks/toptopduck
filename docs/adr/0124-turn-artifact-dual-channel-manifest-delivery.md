# 产物交付：双通道发现、清单入档与结果页单舞台呈现

## Decision

1. **产物发现走双通道，settle 时合并为单一产物清单。** 内置 loop runtime 注入 `present_files` 工具（运行时工具构造 + 分发面 + 系统提示强制条款——凡产生可查看结果的任务必须以该调用收尾），获得工具面可控的 MUST 级交付；全部 runtime（含外部 CLI）同时走回复文本扫描：markdown 链接、引号/反引号包裹路径、扩展名白名单约束下的裸路径三族正则，白名单限定交付物扩展名（pdf/docx/xlsx/pptx/html/htm/md），每 turn 清单上限 8 件。两通道产物在 turn settle 时去重合并为一份清单。

2. **产物清单入档 `TurnRecord`，settle 冻结、绝对路径存储、呈现期校验。** 清单在 Rust 侧 settle 后一次算出（非流式），作为 `TurnRecord` 新字段持久化（recipe schema 迁移；旧记录无字段即空清单，降级不显示）。条目存绝对路径与文件名；文件存在性是运行时事实，呈现期校验——文件被删则产物卡降级为不可打开，不回写清单。绝对路径防御未来共享工作区引入时的解析基准漂移（相对路径会把清单绑死会话 cwd 语义）。解析后落在会话临时工作目录内的命中，settle 时物化拷贝至 per-session 持久目录（会话目录的 `artifacts/` 子目录），清单存物化后路径——对齐派生源的既有 temp 迁移通道；用户目录中的绝对路径命中原位不拷（应用不复制用户文件）。

3. **结果页单舞台泛化，产物与结果互斥上位。** workspace 的选中状态泛化为 dataset | file 判别联合，最后点击的上位，不引入 tab 或并排分栏。自动打开分情形：turn 仅有产物（无 Materialized 结果）时展开 workspace 并自动打开 primary 产物（一次性触发，以校验签名入 key 防晚到候选重复消费）；两者并存时遵循既有结果提升语义，产物只展开不抢位。

4. **渲染矩阵按格式分层，信任边界收在 iframe 隔离壳。** HTML 经 asset 协议以 `iframe sandbox="allow-scripts"`（无同源）内嵌渲染——脚本可执行（交互式报告可用）但运行于 opaque origin，读不到应用页面与凭据；assetProtocol scope 限 per-session artifacts 物化目录，scope 外产物（含用户目录原位命中）自动降级为卡片+外部打开。md 经 IPC 读文本内嵌渲染（复用 prose 渲染器，不开 asset 面）。pdf/docx/xlsx/pptx 首版一律卡片+外部打开，应用内嵌留独立增强票。

5. **术语定名「产物」（artifacts），workspace 词汇不动。** `TurnRecord.artifacts`、rail 产物卡、票面域前缀「产物: 」；CONTEXT.md 词条首用即定义（turn 交付给用户的文件清单，与 Materialized 结果并列的内容类型）。workspace 是面板结构词，产物是内容词——概念混淆以词条分离消化，不为新内容改名既有结构。

## Context

多 runtime 混合：内置 loop runtime（工具面与系统提示均在应用控制内）与外部 ACP CLI（claude/codex 等，系统提示与工具面不可控）共存。turn 中生成的交付文件（报告 PDF/docx、HTML 页）此前零通道：rail 的 markdown 本地链接降级为纯文本，workspace 结果页仅认 Materialized 结果（SQL 表格）。外部 agent 进程以 cwd-aware spawn 启动，该 cwd 为会话临时工作目录（随会话关闭清除），回复文本中的相对路径具备确定解析基准。

## Why

1. **结构化产物通道只在自控工具面成立。** 同类产品的显式交付工具均以第一方 harness 为前提；内置 runtime 具备该地位（工具运行时构造 + 分发面 + 系统提示），外部 runtime 无落点——双通道各就各位，而非以单一机制勉强覆盖两个世界。
2. **交付是 settle 语义，清单是会话历史的一部分。** 完整回复文本与工具结果在 settle 时齐备；产物卡重启后仍在，要求清单入档而非渲染期重算。
3. **对话交付场景一次聚焦一个交付物。** 对话型产品的产物区均无 tab（tab 与文件树工作台场景绑定）；单舞台与既有选中机制、双视图联动、keep-alive 同构，diff 最小。
4. **不可信 HTML 的边界是隔离执行而非禁止执行。** agent 生成的 HTML 可能携带注入脚本，但全禁脚本会杀死交互式报告这一主要交付形态；opaque origin 隔离壳配合扩展名白名单与 asset scope，暴露面与同类内嵌渲染同级。
5. **artifact 在本仓首用即定义。** 行业主流义（文件产物）与反例（会话部件）并存，词条定义锁死主流义；workspace 词汇遍布 ADR 与代码，为内容词改名结构词无净收益。

## Considered options

- **单轨文本扫描**：对内置 runtime 主动放弃 MUST 级交付可靠性。**否决**。
- **turn 后目录 diff 自动发现**：产物归属、中间文件误报、快照时机三重工程负担。**否决**。
- **tab / 多面板并排呈现**：对话交付场景无此形态，破坏单舞台语义与布局。**否决**。
- **首版全内嵌渲染（pdf/docx/xlsx/pptx 渲染库）**：五个新依赖换首版非必需的保真度。**否决**。
- **相对路径清单**：未来共享工作区引入时历史清单静默解析漂移。**否决**。
- **temp 命中原位存储（不物化）**：临时工作目录随会话关闭清除，清单重启后全部降级为不可打开。**否决**。
- **`present_files` 注入外部 CLI**：外部 runtime 的系统提示与工具注入无落点，调用率不可控。**否决**。

## Consequences

- recipe schema 一次版本迁移；旧会话记录无清单字段，打开时降级为无产物卡。
- assetProtocol 启用并配置 per-session artifacts 物化目录 scope；CSP 增补 `frame-src asset:` 面。
- 物化引入 settle 期文件拷贝；会话删除连带清理物化产物（既有 per-session 目录删除语义）。
- CONTEXT.md 增「产物」词条。
- 增强票池（独立开票，非本决策范围）：PDF iframe 内嵌、docx 渲染库、file:// 扫描族、分屏对照、共享工作区引入时的词汇整理。
