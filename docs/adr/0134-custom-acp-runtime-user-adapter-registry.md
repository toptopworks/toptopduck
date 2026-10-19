# 自定义 ACP 运行时：用户态适配器注册表与合并投影

## Decision

1. **AdapterSpec 所有权迁移。** per-CLI 适配器定义从 `&'static` 字段（编译期静态注册表）迁移为 owned（`String` / `Vec<String>` / `BTreeMap`），`AdapterId` 去 `Copy` 随迁；内置表从 const 数组改为 `LazyLock<Vec<AdapterSpec>>`，构造器仍是字段唯一来源（零重复、无 constructor/entry 漂移）。用户态行是运行时数据，owned 是其可表达的前提；spawn 两面（`spawn_piped` / `spawn_turn`）的 argv/env 形参随之 owned 化，五构造器外的调用点签名不变。

2. **用户态注册表 `user-adapters.json`。** OS app-data 下独立文件（与 catalog cache 同根解析、同 temp 回退），`format_version: 1` 版本路由——非 1 拒绝（ADR-0036 先例），原子写（temp + fsync + rename）+ **私有权限**（Unix 0600、chmod 在 rename 前使终文件从未以宽权限存在；Windows 默认 ACL 不特殊化）——env 可含明文 key。行 schema：`id`（`user:<8位hex>`，create 时铸造、碰撞重掷）、`name`、`command`（**严格单 token**：非空、无空白、无引号——表单即时拒绝 + IPC 后备校验双层）、`args[]`、`env{}`（BTreeMap，序列化 diff 稳定）、`enabled`、`stream_format`（schema 存储，但仅接受 `"acp"`——非法值解析报错；未来放宽只需放开校验，schema 不动）。

3. **读失败分层（与 sidecar honest-degrade 故意分叉）。** picker 面（`list_adapters` → `load_for_picker`）**永不拒绝**：注册表损坏 / 更高版本时内置行照常、user 行缺席、一次 warn 可诊断——`list_adapters` 的 never-refuses 不变量不破。管理面（`list_user_adapters`）**显式报错**且原文件字节不动——用户输入不可静默丢（catalog cache 可整弃因为它是可弃快照；注册表是用户创作，两语义故意分叉）。

4. **command 解析面。** 裸名走 `which` PATH 扫描（PATHEXT 补全仅此路径，现行为）；绝对路径 **verbatim** 使用（is-file 判定，无 PATHEXT 补全）——`detect_adapter` 单消费点扩绝对路径分支，内置名恒裸名故零行为变化；填错（两种形态都解析不到）走 probe `NotDetected` → 前端 fail_cli 三态。浏览文件选择器（`dialog.open`）绕开手输，选出的绝对路径直填 command 字段。

5. **合并投影 + 统一字母序。** 解析（`resolve_adapter`）与投影（`scan_adapters`）数据源 = v1 表 ++ 用户态行；全列表按 `display_name` **字母序统一混排**（字节序；同名以 `id` 稳定 tiebreak），比较器单点、picker 投影与管理面共用（两面不可漂移），Rust 投影层定死、前端 renders verbatim 自动继承。**策展数组序退役**：`V1_ADAPTERS` 数组退为注册序，展示序职责移交给投影层（ADR-0083 校准）。`enabled: false` 不进 picker 投影，但**仍可解析**——已命名它的会话 / `default_runtime` 继续工作，禁用是 picker 可见性问题不是解析问题。

6. **env 注入面。** `AdapterSpec` 增 `env`（内置恒空）；turn spawn（ACP / codex / claude 三驱动）与 probe `spawn_child` 共用同一注入点——env 是 spec 数据非代码，ADR-0081 零 per-CLI 代码不变量保持。

7. **删除与悬空引用。** 删除 user 行同时清 catalog cache 对应键（`AdapterCatalogStore` 增 remove 面，RMW 同锁、其余键不动、缺键 no-op）——探测缓存不比其 id 活得久。被 `default_runtime` 引用的行删除后走既有降级语义：字段保留、per-start 降级内置、重建同 id 恢复（ADR-0098 Decision 3 原样覆盖，不新开面）。

## Context

adapter 目录是编译期静态注册表：`AdapterSpec` 全 `&'static` 字段、五个内置构造器、`V1_ADAPTERS` const 数组、`list_adapters` 投影 verbatim——上游加一个 CLI = 发一次版。用户装了任意 ACP 兼容 CLI（生态里 ACP 已是事实标准面）无法接入。仓内既有件：`probe_adapter`（一次性 spawn + 握手 + 超时 + stderr tail）即测试连接的 Rust 面；`detect_adapter` 的 `which` PATH 扫描可复用于裸名 command；ACP 通道的 model/effort 走握手后 `session/set_config_option`（`model_arg`/`effort` 恒 `None`）——用户行零 per-CLI 注入面。缺口三件：`AdapterSpec` 无用户态行；`process::spawn_piped`/`spawn_turn` 无 env 注入面；无用户态持久化。一刀补齐三件，限 ACP 通道。

## Why

1. **owned 迁移是最小充分改造**：用户行是运行时数据，任何「静态表 + 包装枚举」方案都要在包装层重演字段维护；owned 一次到位且构造器单源不变。const 损失无实质代价（表只在进程内读一次）。
2. **0600 而非 keychain**：MCP 的 keychain 面是 per-server secret 管理 UX（ADR-0029 语境）；runtime env 是整表 KV、通常非全 secret，文件私有权限 + 用户自管是同生态主流形态（各 CLI 自身 env 文件的普遍形态），keychain 化留待独立票。
3. **读失败分层的两难拆开**：picker 是「这次能否选」的面——拒绝会把用户锁死在无法起步的状态；管理面是「我的注册内容在哪」的面——静默空等于谎报注册表状态。两个不变量不同，分层是各自诚实的唯一解。
4. **字母序而非策展序**：合并表后策展序无处安放（user 行无策展位）；字母序是唯一对两源中立的序，且在 Rust 投影层定死后前端零排序逻辑。字节序而非 locale 排序：无需引入 locale 依赖，内置名全 ASCII 两者无差，跨平台确定。
5. **command 单 token + 浏览选择器**：单 token 让 command 免于 shell 解析语义（无引号 / 空格歧义），检测与 spawn 都吃同一原语；参数化需求全数由 `args[]` 数组承载（数组化 spawn 既有不变量）；浏览器选择器消掉绝对路径手输这一主要出错源。
6. **删除清 cache 是缓存卫生**：探测缓存 keyed by adapter id，行删除后残留条目既不可达又是下次同 id 重建的陈旧答案——删除事务顺手清键，缺键 no-op 无副作用。
7. **复用既有降级而非新面**：`default_runtime` 的悬空引用语义（ADR-0098 Decision 3）已覆盖「id 解析不到 → per-start 降级、字段不重写」；user 行删除产生的悬空与之同构，复用即零新代码路径。

## Considered options

- **`AdapterSpec` 保持 `&'static`、用户行走枚举包装**：包装层重演全部字段维护、解析处双形态分支，owned 迁移反而更小。**否决**。
- **picker 面同管理面显式报错（both refuse）**：注册表损坏会锁死 composer 起步路径，破坏 `list_adapters` never-refuses 不变量。**否决**。
- **管理面同 sidecar honest-degrade（静默空）**：用户注册内容静默消失且无诊断，用户输入不可静默丢。**否决**。
- **env 值入 OS keychain（MCP secret 先例）**：runtime env 非 per-row secret 管理语义，整表 KV 走 keychain 是 UX 错配 + 接线面翻倍。**否决**——0600 文件，keychain 化留待独立票。
- **localeCompare 语言感知排序**：Rust 投影层需引入 locale 排序依赖，跨平台结果不确定；内置名全 ASCII 两序无差。**否决**——字节序。
- **第一刀放宽非 ACP 通道（codex / claude 原生流）**：两格式有 per-CLI probe 面 / argv 事实（`probe_argv`、`model_arg`），用户行需暴露这些字段才有意义，表单与校验面翻倍。**否决**——限 ACP，`stream_format` schema 已存放宽只动校验。
- **probe cwd 锚定会话 temp**：无实证问题不开面；与内置五行 probe 同语义（继承 app cwd）保真。**否决**——不动。
- **管理面把内置行与 user 行合并一张可编辑列表**：内置行只读、user 行可写，混列表读写边界模糊；内置行已有检测 / 测试面板，user 行独立分区职责清晰。**否决**——「自定义运行时」分区。

## Consequences

- **校准 ADR-0083**：运行时 picker 数据源从「v1 表 verbatim 投影（数组序即展示序）」演进为「v1 ++ 用户态注册表合并投影、统一字母序」——数组退注册序，策展序职责退役。见 ADR-0083。
- `V1_ADAPTERS` 的「display order」注释退役为注册序说明；`scan_adapters_projects_the_v1_table_with_detection_state` 的 zip 断言按排序后投影适配（测试内以同一比较器排序后 zip）。
- 未来放宽 `stream_format`（第二刀）：只需放开 `parse_doc` 的 per-row 校验与投影处的 ACP 假设，schema 与存储不动。
- probe / turn 对 user 行零特殊分支：检测（裸名 / 绝对路径）、spawn（argv + env）、握手（set_config_option）全走既有共享面——ADR-0081 零 per-CLI 代码在用户行上同样成立。
- 非目标（本刀不做）：icon、advanced JSON 编辑、preset 目录、非 ACP 通道用户行、拖拽排序、CLI 安装管理。
- CONTEXT.md「运行时」词条随更（适配器来源两种）。
