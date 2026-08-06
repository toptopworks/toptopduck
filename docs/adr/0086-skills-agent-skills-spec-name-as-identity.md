# 技能系统:Agent Skills 规范 + name 即身份

## Decision

1. **技能 = Agent Skills 规范目录 + 仅提示片段与 MCP 引用，不引新可执行面。** 一技能 = `<root>/<name>/SKILL.md`（YAML frontmatter + Markdown 正文），遵循 [Agent Skills 规范](https://agentskills.io/specification)。声明面仅两件：提示片段（SKILL.md 正文）+ 可选的 MCP server 引用（frontmatter `metadata` 命名空间扩展键 `toptopduck_mcp_servers`，逗号分隔 id）。**v1 不执行技能自带的 `scripts/`**——本地 Markdown 不跨信任边界带可执行代码。ADR-0076 的「技能声明的工具」第三类在 v1 校准为**聚合路径类**（技能 → 挂载 → MCP 启用 → 网关），非可执行面类。

2. **技能身份 = 规范 `name`**（kebab-case、≤64、等于目录名），不引入 uuid。每轮 `TurnProvenance.skills` 记 `Vec<{name, content_hash}>`，`content_hash` = SHA256(SKILL.md 整文件字节)。resume 诚实降级：name 在注册表缺失 →「已不存在」；hash 与当前不符 →「自该轮后已修改」；hash 空（v3→v4 迁移产物）→ 无基线、不触发。

3. **recipe format_version v3 → v4。** 新增 `RecipeEntry::Skill(SkillLifecycleEvent { kind: Mount|Unmount, name })`（与 `RecipeEntry::Source` 同构的 timeline 标记条，仅两态——技能内容变化非事件）；`TurnProvenance.skills` 由 `Vec<String>` 改为 `Vec<SkillProvenance>`。`v3_to_v4` 迁移把字符串数组转为 `{name, content_hash: ""}`——生产环境所有 recipe 该字段恒空，迁移是 no-op。单向不可逆（ADR-0082 范式）。

## Context

ADR-0076/0078/0079 留下技能机制未决。技能需同时满足：(1) 适配 Agent Skills 生态（外部 agent 技能可复用）；(2) 不破坏 toptopduck 的 local-first / BYOK / recipe-resume 不变量；(3) v1 不引入可执行代码面。Agent Skills 规范把技能定为目录 + `SKILL.md`、`name` 即身份——这框定了 (1) 的边界，也迫使 (2) 的「稳定 id + 可改 display_name」纪律在技能上让位（app 不掌控外部导入技能的 name）。

## Why

1. **规范原生保双向移植**：外部 agent 技能丢进 toptopduck 即作纯提示技能工作；toptopduck 技能（`metadata.toptopduck_*`）在他方 agent 被忽略仍工作。
2. **MCP server 引用复用既有网关 + 分级审批**（ADR-0080）：挂载 → MCP 启用 → 工具进聚合表，AC「工具经网关审批」自动满足，无需新审批路径。
3. **不执行 `scripts/` 保 v1 信任边界**：激活自带脚本需新 ADR（沙箱 + 审批 + 信任模型）。
4. **规范 `name`=身份是 spec 既定**：技能可从外部 agent 仓库软链导入，app 不掌控外部 name——照搬项目既有稳定-id 纪律需 sidecar 或写穿外部文件，两难皆否。
5. **content_hash 用项目既有 stale-degrade 范式**（ADR-0013/0041）：保 resume 审计保真；同机编辑 / linked 源更新 / 跨机缺失统一走诚实降级。
6. **整文件 SHA256 最诚实**：任一改动翻 hash，免维护「哪些字段影响行为」的作用域。
7. **必须升 format_version**（ADR-0036）：新 `RecipeEntry` 变体 + provenance 形状变是前向兼容断点，让旧 app 干净拒绝 v4 而非 serde-fail。
8. **迁移对所有真实 recipe 是 no-op**：生产环境无技能数据（`skills` 恒空），零成本保 serde 契约。

## Considered options

- **frontmatter 顶层 `mcp_servers` 字段**：违规范校验、断移植性。**否决**——走 `metadata` 扩展。
- **ad-hoc tool schema（frontmatter 携 `{name, input_schema}`）**：v1 无 handler 执行路径，网关路由/审批得新做。**否决**——留未来「带代码技能」ADR。
- **给外部运行时注入能力边界 prompt**：与 CLI persona 竞争、被忽视、毁「借成熟 agent 循环」初衷。**否决**——外部运行时降为工具面边界。
- **uuid sidecar（`<root>/.toptopduck/registry.json` 映射 name→uuid）**：保身份纪律但要维护 sidecar，且只为罕见 rename。**否决**。
- **写穿外部 SKILL.md 存 uuid**：mutate 外部技能、破坏软链只读语义、跨机 uuid 不一致。**否决**。
- **技能正文嵌进 `.duck`（跨机自包含）**：每个 `.duck` 携多 KB 正文、与注册表重复、且 MCP server id 仍是环境引用（嵌了技能也不完整）。**否决**——违「recipe = 源 + 轮次」边界；诚实降级更干净。
- **不升 format_version、靠 serde 容错**：旧 app 遇 `RecipeEntry::Skill` serde-fail 而非干净拒绝。**否决**。
- **全局 mute toggle（`AppConfig.muted_skills`）**：注册表保留技能但从「+」选择器隐藏，需新增配置字段 + 行尾 toggle UI + 选择器过滤逻辑。**否决**——技能管理只需 create/edit/delete，用户不想要的技能要么不导入要么删除。

## Consequences

- **CONTEXT.md**：「技能」「技能生命周期事件」词条磨锋利——补 Agent Skills 规范、目录即注册表、`name`=身份、Mount/Unmount 仅两态（内容变化由 content_hash 捕获、非事件）。
- **校准 ADR-0079**：ADR-0017 诚实拒绝是**内置运行时**的默认行为；**外部运行时**默认为工具面边界（CLI persona + 网关工具面），不注入能力边界 prompt。外部运行时是用户主动选择的 power mode，非默认姿态。
- **延伸 ADR-0076**：「技能声明的工具」第三类在 v1 校准为**聚合路径类**（skill → mount → MCP enablement → gateway），非可执行面类。
- **延伸 ADR-0078**：技能生命周期事件与源事件同构（恒可见、非轮次、进当前状态视图）；轮次记技能出处 + content_hash 供审计。
- **延续 ADR-0082**：recipe format_version v3→v4 单向迁移。
- **未决（实施期）**：技能根目录位置、导入对话框两段式钻取、设置页 SkillsSection UX、行内校验/冲突标记、effective 启用集合成、注入点不对称的实现细节。
