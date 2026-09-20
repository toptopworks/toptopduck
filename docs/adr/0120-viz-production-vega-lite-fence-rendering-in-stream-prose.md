# Viz 生产：vega-lite fence 流内渲染与 vega-chart 内置技能

## Decision

1. **图表生产端定为流内 fence 表面。** 技能教 agent 在 terminal prose（body——轮末终端文本，经 markdown 管道渲染）中产出 ` ```vega-lite ` fence——单条 fence 一图，内容为自包含 Vega-Lite JSON（数据内联）。渲染端 = 前端 markdown 管道识别 fence → 既有 decode 门禁（JSON 解析 + mark 白名单）→ VegaChart 渲染，失败按 ADR-0033 披露原则降级披露。图表是 prose 内容的组成部分，任意多图与文字穿插；不与结果/晋升链结构化关联。

2. **wire 契约与结果卡槽位不动。** 工具调用契约维持无 viz 意图通道，`Materialized.viz` 结果卡槽位维持现状（无生产者），`ChartKind` 闭合枚举不动。fence 路线是纯新增表面（前端 markdown 管道 + 技能侧），不触碰 Rust turn 投影。

3. **mark 白名单扩 `rect`（heatmap）。** 前端 `WHITELISTED_MARKS` 增 `rect`，语义为六类图型名实相符地覆盖 heatmap（`rect` 形态本已可经 `square` 点阵与无顶层 mark 的分层 spec 渗透，排除标准形态的约束力本就不完整）。降级披露的 unsupportedMark catalog 消息同步扩词。

4. **流式单一规则：live 占位，settled 渲染。** live 轮 prose 中的 vega-lite fence 一律轻量占位（不解析、不判失败、不显示生成中的源码）；轮次 settle 后 fence 才走 decode → 图表或降级。占位渲染遵守 markdown 管道的模块级 components identity 契约。

5. **数据护栏为教学约束，消费端零数据量闸门。** 技能教「先 SQL 聚合、每图内联数据 ~150 行护栏」（护栏防原始行内联爆输出帽，非目标值；类目图天然 ≤20 行，日粒度折线与中型热力图为触界场景）。渲染端不设行数闸门——爆帽发生在生产侧（agent 写 body 时），渲染端闸门时已晚且把能渲染的图错降级。

6. **fence 语言只认 `vega-lite`。** 其它语言或无语言 fence 走既有代码块纯文本呈现，不猜测、不渲染。完整 Vega（radar / 词云 / 力导向）不在 v1 表面。

7. **内置技能 `vega-chart`，CLI 伴随关系可选化。** 内置技能定义的 CLI 伴随关系显式建模为可选项：有伴随者维持「伴随 CLI 启用 ∧ 已物化 ∧ 文件存在」的自动包含判定；无伴随者（首个即 `vega-chart`，纯知识技能）按「已物化 ∧ 文件存在」纳入新会话自动包含。技能单文件、双语（en-US / zh-CN 随响应 locale），不启用 references 多文件物化。

## Context

ADR-0016 定义了 viz 意图与白名单，ADR-0033 补触发与退化披露，但生产端从未接线：工具调用契约只有 ToolCalls / Text 两形态，LLM 无表达图表意图的通道，turn 投影恒产 `viz: None`，全库唯一 `VizSpec` 构造点在契约测试——消费端（decode 门禁 / VegaChart / 主题桥 / 降级披露）完整空转。实际诉求是对话中生成「文字 + 多图表」报告：`Materialized.viz` 是单数槽（一 turn 一图），且 external 运行时（ACP）路径需工具桥接才能喂结构化通道。

## Why

1. **fence 是全部运行时的公共出口。** terminal text → body → markdown 管道（内置 rig 与 ACP 外部 agent 同路），一处接入全部生效；结构化通道路线对每个外部运行时都要网关桥接。
2. **多图报告天然成立。** fence 是 prose 的组成部分，任意穿插；单数 viz 槽做报告还需把字段改列表、扩 wire 契约。
3. **消费端全链复用。** decode 门禁 / VegaChart / ADR-0050 主题桥 / ADR-0033 披露都是现成语义，新增表面只在 markdown 管道一处；技能侧走既有挂载/调用/启用轴治理（ADR-0118/0119）零新通道。
4. **技能优于 prompt 注入。** 按需展开（invoke_skill 单次付清随历史驻留）优于每轮常驻；内置技能治理（启用开关 / 用户可编辑 / hash 漂移跟踪）白得。

## Considered options

- **emit_chart 元工具（结果卡槽生产者）**：需 Rust 工具注册 + 轮内状态收集 + turn 投影接线；外部 ACP 运行时需逐个网关桥接；多图报告需 viz 槽改列表。**否决**——改动面与当前诉求不匹配，结果卡槽位维持闲置，未来该诉求真实时重评。
- **prompt 组装 seam 硬编码注入**：每轮常驻上下文成本；失去技能治理全链。**否决**。
- **live 期间渐进渲染已闭合 fence**：spec 逐 delta 重解析产生新对象身份，embed 反复重嵌；需 identity 稳定化技巧压制。**否决**——settle 齐现，阅读主体是文字。
- **渲染端数据量硬闸（decode 时拒绝超行数 spec）**：爆帽发生在生产侧，闸门时已晚；把能渲染的图错降级为表格，双输。**否决**——护栏只在技能教学。
- **references/ 多文件渐进披露**：内置物化与 baseline hash 是单文件语义，多文件需扩展 reconcile 治理基线；v1 教学面（7 mark、无交互）无大示例库需求。**否决**——压力真实再扩。
- **收 `vega` 完整版 fence 或猜测渲染其它语言**：完整 Vega 超出 Vega-Lite 语义的渲染组件与门禁；猜测渲染违背诚实呈现。**否决**。
- **内置技能定义维持 CLI 伴随 1:1 假设 + 豁免分支特判**：豁免分支把「无伴随」当异常路径；显式可选字段让判定按声明分发，未来内置技能零摩擦进出。**否决**——结构声明优于特判。

## Consequences

- decode 门禁同时服务两条入口：结果卡（wire 结构含 `kind`）与 fence（裸 JSON 无 `kind`）。
- 流中图表卡与工作区联动（点击跳转关联结果）及放大查看、报告导出（Vega 视图序列化路线已识别）留尾。
- 结果卡 `viz` 槽位（ADR-0016/0033 原设计）继续闲置；若未来结果卡图表诉求真实，emit_chart 路线按本 ADR Considered 记录重评。
- **校准 ADR-0016**：白名单增 heatmap；图表生产表面增流内 fence 一路，结果卡槽位与降级/主题路径不变。
- **留实施期**：白名单增 `rect` 与 catalog 扩词、markdown 管道 fence 渲染分支与 live/settled 通路、内置技能可选伴随字段与自动包含判定分发、现有三个伴随定义补字段（行为不变）、`vega-chart` 双语定义文案。
