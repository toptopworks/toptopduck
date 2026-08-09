# 会话创建即持久化:管理目录 + 自动绑定 + per-session 目录结构 + 首轮自动命名

## Decision

1. **`createSession` 即绑定 .duck——消灭纯内存阶段。** 新建会话时立即生成 UUID、创建 per-session 目录、写入初始 recipe。session 从存在起即处于绑定态，`duck_path` 恒为 `Some`，`RecipePersister` 的 `None -> Some` 状态转换从代码路径中消失。ADR-0034 Decision 5 的「每轮终态自动追加」从 `createSession` 起即生效——不再依赖用户主动首次保存。

2. **管理会话目录——app 管理、用户可见、可配置。** 所有会话存于一个 app 管理的目录，默认 `<Documents>/toptopduck/sessions/`（平台惯例的 Documents 子目录，非隐藏 `%APPDATA%`）。设置中显示当前路径 + 「更改…」+「在文件管理器中打开」。改目录后新会话进新目录，旧会话留原处——不做自动迁移（YAGNI）。根 `toptopduck/` 预留 `sessions/` 子目录层级，为未来扩展（技能库等）留结构空间，不预创建空目录。

3. **Per-session 目录结构。** 每个会话是一个自包含目录 `{sessions}/{uuid}/`，内含固定名 `session.duck`（recipe）与可选 `assets/`（派生源，ADR-0087 D2）。取代 ADR-0087 的扁平 `{duck_stem}.assets/` 模式。复制 / 移动 / 删除一个目录 = 完整会话。`session.duck` 固定文件名——显示名在 recipe header 中，sidebar 是主交互面；UUID 目录名是稳定身份，不随显示名变化。

4. **自动命名——首条提问截断做标题，源做 hover 副提示。** 创建时显示名为占位符（如「新会话」）；首个达终态的轮次一次性将显示名更新为首条提问的有界截断（ADR-0039 同款截断规则），之后永不自动改名（用户可手动 rename）。源文件名不进主标题，仅作 sidebar 条目的 hover tooltip 副提示。统一规则覆盖所有会话类型——DuckDB 中心、纯 MCP / 技能、混合——不依赖源文件存在。

5. **「Save as .duck」语义改为「另存为」；「Open .duck」语义改为导入。** 「另存为」= 将当前 session 目录的内容导出为副本到用户选的位置（recipe + 派生源），原会话不动。「Open」= 将外部 .duck（或 per-session 目录）导入 `sessions/`：复制进新 `{uuid}/` 目录后 resume。sessions/ 是会话的单一真相源——原地打开外部 .duck 会使 sidebar（扫描 sessions/）看不到该会话，破坏 Chat 风格心智。

6. **空会话 close 时自动清理。** `close_session` 时检测 timeline 是否完全为空（无轮次 AND 无源生命周期事件 AND 无技能生命周期事件）；是则删除 per-session 目录，sidebar 不残留。非空会话（有任何内容）照常保留。

## Context

ADR-0034 Decision 5 定「每轮终态自动追加 + 原子写」，但未覆盖 .duck 文件的初始创建时机。实现中采用两阶段模型：session 先以纯内存态存在（`duck_path = None`），用户主动点「Save as .duck」后才 `bind_duck` 创建 .duck 文件，此后每轮终态自动追加。tooltip 明示两阶段：「Save the current session as .duck (auto-saves each turn after)」。

两阶段模型存在三个问题：(1) 纯内存阶段崩溃丢失全部工作——违反 ADR-0034 longevity-local 的「永不丢工作」承诺（ADR-0034 Context 原文描述的场景正是「做一晚上链式分析、关掉全没」）；(2) 手动保存与 ADR-0060/0061 的 Chat 风格心智冲突——ChatGPT 不要求用户手动保存对话；(3) `None -> Some` 状态转换是前端「已保存 / 未保存」两态 UI 与后端 `save_if_bound` no-op 分支的 complexity 来源。

## Why

1. **longevity-local 要求从创建起即持久。** 纯内存阶段是 longevity 承诺的反例——用户做了一晚上分析、崩溃了、全丢。消灭纯内存阶段使崩溃窗口始终 = 当前在飞那一轮（ADR-0034 已有设计），而非「从未保存 = 全丢」。
2. **Chat 风格心智要求零摩擦。** ADR-0060/0061 选了 ChatGPT 式导航和启动——ChatGPT 不要求手动保存。两阶段模型从传统文件编辑器（Word / Excel）借来心智，与 Chat 风格冲突。自动持久化让用户拖文件即开始分析，不需要先回答「存哪」「叫什么」。
3. **消灭状态转换简化代码。** `duck_path: None -> Some` 消失后，`save_if_bound` 不再有 no-op 分支，前端不需要「已保存 / 未保存」两态区分，`bind_duck` 的手动触发路径消失。session 恒在绑定态——一个状态，而非两个。
4. **管理目录是单一真相源。** sidebar 扫描 `sessions/` 即得到全部会话。原地打开外部 .duck 不在 sessions/ 中，sidebar 看不到——导入（复制进 sessions/）使所有会话在一处可见。
5. **Per-session 目录自包含可移植。** ADR-0087 使会话不再是单个 .duck 文件（`.duck` + `.assets/` 对）。per-session 目录让复制 / 移动 / 删除一个目录 = 完整会话，消灭「复制时漏 .assets」的隐患。
6. **UUID 目录名 + 固定 session.duck 消灭 rename 链。** 显示名变化不需要 rename 文件 / 更新 single-writer registry canonical path / 处理非法字符 / collision detection。目录名是 UUID（稳定身份），session.duck 是固定名，显示名在 recipe header 中。

## Considered options

- **保留两阶段模型（用户手动首次保存）**：纯内存阶段崩溃丢全部工作 + 与 Chat 风格心智冲突。**否决**。
- **延迟绑定（首个源生命周期事件或首轮终态时才绑定）**：恢复 `None -> Some` 状态转换；首轮前的源生命周期事件不被持久化（用户加源后崩溃丢源）。**否决**。
- **隐藏 app 数据目录（`%APPDATA%` / 内部 SQLite）**：ADR-0034 已否决——制造「我的数据去哪了」不透明。**否决**。
- **首次运行向导让用户选目录**：首次启动摩擦，非技术用户（ADR-0001）被「选目录」拦住。**否决**。
- **改目录时自动迁移已有会话**：移动 .duck + 改路径引用 + 处理打开态会话的复杂度，v1 不成比例。**否决（v1）**。
- **扁平结构（`.duck` + `.assets/` 并列在 sessions/ 根）**：50 会话最多 100 个目录条目 + UUID 配对无法在文件管理器辨认；复制会话需复制两个条目。**否决**。
- **.duck 文件名跟随显示名（显示名变化时 rename 文件）**：rename 链条 = 文件 rename + single-writer registry canonical path 更新 + 非法字符消毒 + collision detection，一整条新复杂度链。**否决**。
- **命名从首个源文件名推导**：不覆盖纯 MCP / 技能会话（ADR-0087——一个会话可能全程不使用 DuckDB）；同一源多次分析重名。**否决**。
- **命名回退链（源优先 > 提问截断 > 占位符）**：需要优先级判断 + 「名字是否仍是占位符」检测；统一用首条提问截断更简洁，源信息做 hover 副提示不丢。**否决**。
- **recipe 加 `name_is_placeholder: bool` 区分占位符与用户已命名**：schema 变更（format_version bump）不值得——首轮终态一次性触发（检测 timeline 之前无轮次）是确定性事件，无歧义。**否决**。
- **原地打开外部 .duck（绑定原始路径、写回原文件）**：sessions/ 是 sidebar 的扫描根，原地打开的会话不在其中 → sidebar 看不到 → 破坏「所有会话在一处」。**否决**。
- **不清理空会话**：sidebar 堆积「新会话」条目。**否决**。
- **移除「Save as .duck」按钮**：导出 / 分享需求无入口。**否决**——保留但语义改为「另存为」。

## Consequences

- **校准 ADR-0034**：Decision 5「每轮终态自动追加」的绑定时机从「用户主动 save」提前到 `createSession`；纯内存阶段消灭。.duck 位置从用户选（save dialog）改为管理会话目录。`bind_duck` 从用户触发的首次持久化路径变为 createSession 内部的自动调用。ADR-0034 已加反向指针。
- **校准 ADR-0061**：`list_sessions` 的扫描根从全盘 .duck 文件变为 `sessions/` 管理 子目录；每个会话是一个 per-session 目录（`{uuid}/session.duck`）。启动行为（Chat 风格、不自动 resume、不预创建实例）不变。ADR-0061 已加反向指针。
- **校准 ADR-0087**：Decision 4 派生源持久化路径从 `<duck_stem>.assets/`（.duck 同级）变为 per-session 目录内的 `assets/` 子目录。`migrate_derived_sources` 的路径构造从 `{duck_dir}/{duck_stem}.assets` 变为 `{session_dir}/assets`。ADR-0087 已加反向指针。
- **不改 ADR-0035**：resume 完整性校验（源指纹 + 内容指纹）不变——派生源仍在 per-session 目录内、relative_path 语义不变（相对于 session 目录）。
- **CONTEXT.md 不变**：领域模型（Session / Recipe / Turn 等）不变。持久化触发机制（自动 vs 手动）和目录结构是实现层，非领域层。
- **recipe 格式不变**：不升 format_version——recipe schema 字段不变，session_name 行为变化（自动设置 vs 用户手动）不改字段定义。
- **`createSession` IPC 行为变化**：从纯内存创建变为内存创建 + 目录创建 + 初始 recipe 写入。`createSession` 现在做 I/O（创建目录 + 写 .duck），需处理磁盘失败。.duck 是几百字节文本，性能影响可忽略。
- **`save_as_duck` IPC 语义变化**：从「首次持久化绑定」变为「另存为副本」——复制 session.duck + assets/ 到用户选的位置，不改变原会话的绑定。
- **single-writer registry（ADR-0035 Decision 3）不变**：canonical key 仍是 per-session 目录的 canonical path。createSession 时 `try_acquire` + `bind`；close 时 `release_key` + `Session::Drop`。
- **前端「已保存 / 未保存」两态 UI 消失**：session 恒在绑定态，无需区分。`persistenceBusy` 状态简化——只在「另存为」导出时短暂 busy。
- **留实现期**：默认目录的平台 API 获取（Tauri path resolver）、UUID 生成（`uuid` crate）、close-time 空会话检测的具体 IPC 返回值、首次截断的字符上限对齐 ADR-0039、「另存为」导出时派生源缺失的提示文案。
