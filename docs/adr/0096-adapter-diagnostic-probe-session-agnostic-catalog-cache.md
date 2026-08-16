# 适配器诊断探测:会话无关一次性 CLI 探测 + 目录缓存

## Decision

1. **适配器探测是独立于 turn 路径的诊断通道**。设置页本机 CLI 子 tab 为每个已检测适配器提供「测试」动作：一次性 spawn CLI 进入协议模式 → 完成握手或目录查询 → 提取模型与推理强度目录 → 终止进程。探测通道只读、不驱动 turn、不产生 upstream 会话状态；与 turn 路径的通信面解耦。

2. **探测语义 per-format 分派，与 turn 路径同一分派维度**。`StreamFormat::Acp` 适配器：spawn → ACP initialize + `session/new` 握手 → 从响应 `config_options` 提取（复用 ADR-0095 的 `DiscoveredRuntime` 提取路径）。`StreamFormat::JsonEventStream` 适配器（codex）：spawn `codex app-server` → initialize 握手（`clientInfo` 复用 ACP 通道的 client 描述，服务端必填；握手完成前拒答一切请求）→ `model/list` RPC 遍历分页（每请求必带 `params` 字段，首页为空对象，后续页携带上一页 `nextCursor`，直至 `null`）→ 提取 per-model 目录。探测成功 = 握手或查询完成；进程存活但目录查询失败（含握手 RPC 错误）时降级——报启动成功 + 目录不可用，不整体判失败。

3. **codex 目录为独立 per-model 类型 `CodexModelCatalog`**。`model/list` 返回每个模型各自的 `supportedReasoningEfforts`（官方声明的顺序须保留）+ `defaultReasoningEffort`。定义独立的目录类型，不压扁进 `DiscoveredRuntime` 的全局扁平 `thought_levels`——并集呈现失真：全局集合允许用户选到当前模型不支持的强度。

4. **探测经单命令 IPC，后端持墙钟超时**。`probe_adapter(adapter_id)` 单命令承载整个探测生命周期，后端设墙钟超时（CLI 冷启动较慢，量级数十秒），超时返回结构化失败，绝不悬挂 UI。busy 态接入设置面板 close guard（与既有 IPC in-flight 拦截模式一致）。

5. **目录缓存为 app-data 独立文件，全部适配器入缓存**。探测结果连同时间戳写入 app-data 下独立文件 `adapter-catalogs.json`（`HashMap<adapter_id, entry>`，覆写该适配器条目）。探测点击是唯一写入点；turn 路径每轮握手产生的目录不回写缓存（写放大无收益，缓存语义是「用户显式验证的快照」）。不落 app-config：目录是观测快照而非用户意图，且 app-config 的前端乐观全量回写会静默碾压后端写入（并发写竞态），独立文件从结构上消除该竞态。

6. **选择器目录优先级：会话目录 > 全局探测缓存 > 空态**。Composer 的模型/强度选择器在当前运行时为外部 CLI 时：会话有 `cached_discovered`（首轮 turn 后的握手目录）优先——它是本轮 CLI 实际报告的真相；无则回落全局探测缓存（用户显式测试的快照）；再无则空态并展示引导（「去设置页测试以获取模型列表」）。时间戳仅展示用，不参与优先级逻辑。codex 选择器选模型后强度下拉只列该模型声明的 efforts（per-model 联动）；ACP 选择器维持全局扁平列表。

7. **选择与注入链路维持 ADR-0095 语义**。探测缓存只做选择器的数据源；用户选中值照常经 `set_session_model` / `set_session_thought_level` 落会话、turn boundary 生效、注入按 per-format 分派（ACP 协议参数 / codex argv flag）。IPC 边界不校验模型 ID——缓存过期产生的无效 ID 由 CLI 在 spawn 时报错，可观察。

8. **设置页与 Composer 分工维持 ADR-0091**。设置页本机 CLI tab 是管理面：检测列表 + rescan + 测试 + 目录展示。Composer 是纯选择面：运行时 chip + 模型/强度下拉（消费本 ADR 的优先级链）。运行时选择保持 per-session，不全局化。

## Context

设置页本机 CLI 子 tab（ADR-0091）目前仅展示检测状态（名称 + binary path + Detected 徽章），用户无法验证 CLI 是否真正可用——「装了 CLI、检测到了，但一发 turn 就报错」时缺少前置诊断手段。模型与思考强度目录（ADR-0095）目前只在会话首轮 ACP turn 的握手中产生，挂在会话上（`cached_discovered`）；设置页无会话上下文，且 JsonEventStream 适配器（codex）turn 路径无目录来源，选择器长期渲染只读 CLI 默认标签。

codex CLI 官方提供 `codex app-server` 进程接口（JSON-RPC over stdio，驱动其官方富客户端），其中 `model/list` RPC 返回完整模型目录（id / displayName / per-model supportedReasoningEfforts / defaultReasoningEffort）。该接口与 `exec --json` turn 路径是两个通信面——探测通道只使用前者做只读查询，ADR-0094 的原生直连 turn 形态不变。

## Why

1. **探测通道与 turn 通道解耦是合理的分层**：诊断性验证（「这个 CLI 配好了吗」）不需要也不应该占用 turn 基础设施（会话锁、窗口装配、审批网关）；一次性 spawn + kill 是最小验证单元。
2. **per-format 探测分派延续零 per-CLI 代码不变量**：探测逻辑挂在流格式分派上（ACP 握手 / app-server 查询），与 turn 路径同一维度（ADR-0094/0095），新增 CLI 不碰探测代码。
3. **降级而非失败对登录态与版本面诚实**：`model/list` 是较新的 RPC，旧版 codex 或未登录状态下查询会失败——进程能启动本身已是有效诊断信息，目录不可用是可解释的次级状态，整体变红反而误导。
4. **独立文件缓存消除双写竞态**：探测 IPC 后端直写独立文件，不与前端 app-config 乐观全量回写共享载体，结构上不存在碾压窗口；app-data 语义（app 私有缓存，删除即失效无害）与目录数据性质吻合。
5. **全适配器入缓存补冷启动空窗**：会话目录只在首轮 turn 后存在；从未跑过 turn 的用户新建会话时选择器是空的。全局缓存（含 ACP 阵营）让用户测一次、处处可用，冷启动即有下拉。
6. **会话目录优先于缓存是新鲜度与稳定性的平衡**：会话内目录是本轮 CLI 实报的真相，缓存可能落后数个 CLI 版本；但会话目录缺席时缓存远好于空态。不做时间戳比较——会话目录天然权威，比较语义徒增复杂度。
7. **per-model 目录不压扁是对 CLI 声明的忠实呈现**：并集压扁会允许用户选出「模型 A + 模型 A 不支持的强度」组合，失败推迟到 spawn 报错；按模型联动在 UI 层就把非法组合排除。

## Considered options

- **探测结果只展示不缓存**：会话选择器拿不到探测收益，codex 选择器仍是只读标签，冷启动空窗不解决。**否决**。
- **探测缓存落 app-config**：目录数据与用户意图（theme/locale/endpoint）混载一个文件；前端对 app-config 是乐观全量回写，后端探测写入会被前端下一次任意提交以旧对象静默抹除，需引入额外的回灌同步义务。**否决**。
- **每轮握手目录回写全局缓存**：写放大（每轮一写 vs 用户显式点击一写），且污染「显式验证快照」的缓存语义。**否决**。
- **时间戳比较取新旧目录**：会话内目录本就权威，时钟比较无收益、多一套失效语义。**否决**。
- **per-model 强度并集压扁进全局 `thought_levels`**：允许非法组合、丢失官方顺序。**否决**。
- **codex 目录 RPC 失败判整体失败**：登录态与 CLI 版本差异被误报为「CLI 坏了」，进程存活这一有效诊断信息被丢弃。**否决**——降级。
- **运行时选择移入设置页全局化（Composer 只留模型/强度）**：运行时选择是 per-session 状态（ADR-0083/0095），全局化消灭会话级运行时能力或迫使「全局默认 + 会话覆写」双层结构；切换运行时是高频动作，移出 Composer 增加导航摩擦。**否决**——维持 ADR-0091 分工。
- **测试仅对 ACP 阵营提供（JsonEventStream 无按钮）**：codex 用户同样需要「装好了吗」的前置验证；app-server 通道已可提供完整目录。**否决**。
- **turn 路径整体迁移到 `codex app-server`**：重开 ADR-0094 的直连决策（`exec --json` 的事件流形态、read-only 沙箱、配置覆盖注入均绑定 exec 形态）。**否决**——app-server 仅用于诊断探测。

## Consequences

- **校准 ADR-0095**：三处。(1) Decision 2「JsonEventStream 无动态发现」收窄为「turn 路径无动态发现；诊断探测路径可经 app-server 查询目录」。(2) Considered options 中「per-adapter 全局缓存」否决项边界校准——否决的是自动发现路径每轮回写全局缓存的写入竞争；用户显式点击驱动的探测缓存写入不在其列。(3) Considered options 中「独立 IPC 拉取或事件流推送」否决项边界校准——否决的是自动拉取需要无人授权的 re-spawn；用户显式点击的探测是用户授权的 spawn，性质不同。
- **ADR-0094 不变**：turn 路径双流格式、codex 原生直连、read-only 沙箱、网关桥接注入均不动；`codex app-server` 是探测通道专用通信面，不进入 turn 分派。
- **ADR-0091 不变并增内容**：设置页本机 CLI tab 在检测列表基础上增加测试动作与目录展示；Composer 选择器维持纯选择面，数据源扩展为优先级链（会话目录 > 探测缓存 > 空态引导）。
- **codex 选择器从只读标签升级为真下拉**：依赖探测缓存存在；无缓存时维持只读 CLI 默认标签 + 引导文案。
- **新增持久化载体**：app-data 下 `adapter-catalogs.json`（无 format_version 需求——数据为纯缓存，解析失败按空缓存处理，首次探测重建）；损坏容错为 honest-degrade（目录空、选择器回落空态）。
- **探测超时与进程清理**：墙钟超时后强制 kill 子进程；探测进程绝不残留（与 turn 路径的 watchdog 语义对齐）。
- **CONTEXT.md 不变**：「探测」「目录缓存」是实现概念非领域概念；「运行时」「适配器」词汇表已足。
- **未决（实施期）**：探测墙钟超时具体值（数十秒量级，实测校准）；ACP 握手目录与探测缓存的 UI 展示形态（同面板并列 vs 折叠）；codex 未登录时 `model/list` 的实际失败形态实测。
