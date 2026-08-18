# 运行时接入前提:BYOK 档案集可空 + 默认运行时起步

## Decision

1. **BYOK 档案集可为空，零档案是合法持久状态**。`ProviderConfig` 不再保证非空档案与恒存骨架：首装不种默认骨架档案；`normalize()` 见空列表不再重种（诚实降级目标从「骨架」改为「保持空」）；`active_profile` 由非 Option 改为 `Option<ProfileId>`，空档案集时为 `None`，悬空指针的修复目标同为 `None`。「新建档案」表单预填默认值（anthropic + 直连 + 缺省 model）的便利留交互层，持久层不种骨架。既有 app-config 文件中的骨架档案保留原样不清洗（app 未发布，沿 ADR-0038/0064 不写迁移器先例）。

2. **新会话与 resume 的起步运行时 = 默认运行时（app-config 显式字段）**。`default_runtime: BuiltIn | External(adapter)`，全新安装缺省 `BuiltIn`；与活跃接入档案同性质的机器级偏好（ADR-0038 preferences-only 模型合规）。新会话创建与 resume 后的第一轮都起步于它；`reset_runtime_choice` 的 resume 回落点从硬编码内置改为默认运行时（会话级姿态不跨 resume 的既有行为不变——审批、MCP 启用、运行时选择同批重置，仅运行时选择的回落点从硬编码变为显式默认）。会话内切换运行时不回写默认。

3. **起步做解析降级，偏好不销毁**。默认指向的适配器在目录中不再 `detected` 时，该次起步（新会话创建 / resume）降级为内置运行时，`default_runtime` 字段保持原值——环境恢复（重装 CLI）后自动复效；不静默替换为其他 detected 适配器（用户选择的是具体 CLI，非「某个外部运行时」）。降级后内置侧也未就绪时由提交时门兜底（Decision 4），不为该状态加配置写时校验。

4. **提交时诚实门维持按所选运行时分流（ADR-0092 Decision 4），零档案态激活其「无 profile」分支**。门以所选运行时的就绪性为准——内置就绪 = 存在活跃档案且该档案 keychain 有 key；外部就绪 = 适配器 `detected`（未 detected 的运行时在 picker 内不可选，ADR-0092 现状）。内置选中而未就绪（零档案或无 key）→ 重定向 Settings 运行时 section、落「API 接入配置」tab（「本机 CLI」tab 并列可见，ADR-0091）。就绪判定用既有目录缓存（ADR-0096），不在提交路径做现场探测——缓存滞后由「本机 CLI」tab 的 rescan 兜底。冷启动 pending 运行时初始值 = 默认运行时的解析结果（衔接 Decision 2/3，校准 ADR-0092 Decision 6 的 `RUNTIME_CHOICE_DEFAULT` 常量初始值）。输入不被拦（ADR-0092 现状形态）。

## Context

双运行时架构（ADR-0076/0081/0085）落地后，外部 CLI 运行时成为与内置对等的选择面：CLI 的鉴权与凭据由 CLI 自身管理（订阅 / 登录归 CLI 进程），不经 app——仅使用外部 CLI 的用户对 BYOK 档案没有需求。但现状把「恒有一个活跃接入档案」作为硬不变量固化：`ProviderConfig::defaults()` 首装种入无 key 的 anthropic 骨架档案，`normalize()` 见空列表即重种骨架并强制 `active_profile` 指向真实档案。同时新会话与 resume 的起步运行时硬编码为内置（`runtime_choice` 缺省 `None`，resume 经 `reset_runtime_choice` 回内置）——零 BYOK 用户每个会话起步于一个不可用的运行时。既有提交时门（ADR-0092 Decision 4）按所选运行时分流且已含「built-in 选中但无 profile → Settings」分支，但零档案态在现行配置模型下不可表示（骨架恒在），该分支为不可达分支；冷启动 pending 运行时初始值为常量（Decision 6），无默认运行时概念。

## Why

1. **骨架伪装就绪**：无 key 的骨架档案让「未配置」状态永不可见——用户打开设置永远看到一个形态完整的档案，只差 key；违背诚实准入哲学（ADR-0019/0092 的不假装 ready）。零档案获得合法语义（CLI-only 用户形态）后，它不应再是待修复异常态。
2. **起步可用性**：缺省硬编码内置在零档案下起步即不可用，用户第一动作被迫是切运行时；显式默认字段一次设定同时修复新会话与 resume 两个起步点。
3. **显式偏好优于隐式延续**：last-used 把未表达过意图的一次切换静默延续到所有新会话，可预期性差、行为难归因；显式字段与 app 一贯的显式诚实风格一致（keychain 只暴露布尔、honest-degrade 先例）。
4. **行为降级不销毁配置**：环境缺失（CLI 卸载）只影响本次起步解析，不动用户偏好——重装自动复效；写时校验清字段不可逆，在重装场景下丢配置。
5. **引导面零新增**：双未配置（无活跃档案且无 detected 适配器）用户的引导走 ADR-0092 已定的 Settings 重定向，目标界面即 ADR-0091 运行时 section 的两子 tab（API 接入配置 / 本机 CLI）——天然双路并列；本 ADR 不新增引导面，仅补判定信号源（目录缓存）与起步解析的衔接。

## Considered options

- **保留骨架 seeding（允许删到 0 但 normalize 重种 / 仅首装种）**：伪装就绪状态回归；「删除」与「重种」互斥使空态不可持久表达。**否决**。
- **last-used hint 起步（记住上次使用的运行时）**：隐式延续未授权意图——「上次」可能是一次性实验，被静默应用到所有新会话。**否决**。
- **维持硬编码内置起步**：零档案下起步即不可用。**否决**。
- **默认指向缺失时写时校验清回内置 / 保留 External 硬起步、失败时报错 / 静默换第一个 detected CLI**：前者销毁偏好不可逆；中者起步即不可用；后者替用户做未授权选择。**否决**——起步解析降级内置 + 字段不动。
- **提交时门弹二选一引导对话框 / onboarding wizard**：重复 Settings 运行 section 两子 tab 的既有界面；冷启动三态引导卡刚被退役（ADR-0092），不再造引导面。**否决**。
- **门判定现场探测 CLI**：提交热路径引入进程探测延迟；缓存滞后为低频路径，rescan 已兜底。**否决**。

## Consequences

- **校准 ADR-0064**：`ProviderConfig` 不变量变更——`profiles` 可为空、`active_profile` 为 `Option`；`normalize()` 的非空重种 + 悬空回退首项不变量废除，改为空列表保持空、悬空指针归 `None`；IPC view 的 effective 回退链随之调整（实施期）。
- **校准 ADR-0092**：Decision 4 的分流结构不变，零档案合法化使其「built-in 选中但无 profile → Settings」分支从不可达变为可表示（文字无需改，语义生效）；Decision 6 的冷启动 pending 运行时初始值从 `RUNTIME_CHOICE_DEFAULT` 常量改为默认运行时的解析结果。
- **运行时选择的 resume 重置回落点变更**：`reset_runtime_choice` 的回落从硬编码内置改为默认运行时解析结果（审批、MCP 启用的 resume 重置行为不变）。
- **校准 ADR-0019**：准入门槛从「BYOK 可达」单路扩为双路（配置 BYOK 或安装本机 CLI），诚实准入与引导哲学不变、两路并列。
- **内置运行时就绪定义固化为「存在活跃档案 ∧ 该档案 keychain 有 key」**——由既有快照（per-profile has_key + probe catalog）推导，不新增 IPC。
- **app-config schema 变更**（`active_profile` Option 化 + 新增 `default_runtime`；format_version bump 与否实施期定）。
- **ADR-0095 机制不变**：模型/思考强度的未选择态（`model: None` 等，不注入、运行时按自身默认执行）语义不变；选择器「默认（推荐）」是未选择态的显示文案而非新概念——四态显示规则属实现规格，不入本 ADR。
- **CONTEXT.md**：「接入档案」词条校准（档案集可空、活跃至多一、仅驱动内置运行时）；新增「默认运行时」词条。
- **未决（实施期）**：默认运行时的写入口形态（Settings 控件与 Composer 快捷动作的取舍与样式）；模型按钮四态的具体文案与状态规则；`default_runtime` 的解析时机（新会话创建时求值 vs 首轮提交时求值）与 IPC 形态；既有骨架档案在 UI 的呈现（不清洗但可见可删）。
