# 适配器流格式:ACP + codex 原生 JSON 事件流双格式

## Decision

1. **流格式成为 AdapterSpec 的数据维度**：新增 `stream_format` 字段（枚举：`Acp` | `JsonEventStream`），引擎按流格式分派到对应解析器。per-format 分派不是 per-CLI 代码——多个 CLI 可共享同一格式，加一个 CLI 不碰引擎，加一种格式才加一个解析器（ADR-0081 零 per-CLI 代码不变量保持）。

2. **codex 适配器改为原生直连，退役 codex-acp 桥接形态**：检测名由 `codex-acp` 改为 `codex`；启动形为 `codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only`，prompt 经 stdin 喂入。codex 无原生 ACP 模式，此前的桥接包依赖（用户须额外安装 `codex-acp`）整体移除——装 codex CLI 即可检测。

3. **无状态不变**：不用 `exec resume`、不持 upstream thread；每轮新执行，窗口装配器产出的全量窗口化上下文（schema 前言 + 技能提示 + 历史 + 提问，与 ACP 路径同一装配器）拼为文本喂入 stdin。

4. **网关桥接经 codex 原生 MCP 配置注入**：拉起时以配置覆盖注入网关桥接的 MCP server 条目，codex 自行拉起桥接进程回连网关。桥接进程形态、per-session 隔离、网关强制边界（审批 / 审计 / 物化命名）与 ACP 路径完全一致——注入通道不同，边界同构。

5. **审批与沙箱**：`exec --json` 无 `session/request_permission` 协议级预检，审批强制点落在网关桥接调用层的 inline 审批（reject → 工具调用以错误返回，agent 自纠）。codex 的 native 工具（shell / 文件改写）经 `--sandbox read-only` 全平台统一阻断——数据分析轮次中 codex 的一切数据操作走网关工具面，native shell 无合法用途。exec 形态对 native 工具的防护强于 ACP 路径（硬阻断 vs 逐调用审批）。

## Context

ADR-0081 定外部运行时「传输优先 ACP」——优先非排他，决策时已预留非 ACP 场景。落地后暴露一个具体摩擦：codex CLI 无原生 ACP 模式，适配器只能检测第三方桥接包 `codex-acp`——用户装了官方 codex CLI 却因缺桥接包而检测不到，且桥接包的额外安装是多余的用户动作与版本面。codex 自身具备直连条件：`exec --json` 提供结构化 JSONL 事件流（会话 / 轮次 / 推理 / 工具调用 / 消息 / 错误 / 用量各类型齐备），且原生支持 MCP server 配置（`codex mcp add` + 配置文件 `[mcp_servers.xxx]`）与运行时配置覆盖（`-c` flag）。

## Why

1. **零额外安装**：检测面落在用户本来就会安装的官方 CLI 上；桥接包依赖与其版本维护面消失。
2. **零 per-CLI 代码不变量保持**：流格式是数据字段，引擎 per-format 分派。今天两种格式，明天第三种只是再加一个解析器，五个适配器无一分叉。
3. **网关边界无损**：桥接注入通道从 ACP `session/new` 描述符换为 codex 配置覆盖，形态不同但语义同构——工具调用仍全部经桥接回网关，审批 / 审计 / 物化命名无一旁路。
4. **read-only 沙箱焊死审批缺口**：无 `request_permission` 意味着 native 工具没有协议级预检；与其补一层 codex 特有的审批 plumbing（per-CLI 代码），不如直接阻断——数据分析场景的工具面本就只有网关，native shell 被阻断不损失任何能力，还免去平台沙箱差异（Windows 上 codex 无 OS 级沙箱、workspace-write 会退化为粗粒度拒绝）。
5. **无状态与 resume 正交保持**：不持 upstream thread，resume / 运行时切换 / 窗口管理全在 app 侧（ADR-0076），与 ACP 路径同构。

## Considered options

- **保留 codex-acp 桥接 + app 自动下载安装 / 安装指引文案（纯 UX 缓解）**：前者 app 主动联网下载第三方包越过隐私边界（app 主动联网仅 LLM 调用与用户启用的 MCP 工具）并引入安装基础设施（注册表探测 / 全局写权限 / 版本管理）；后者检测面仍依赖第三方桥接包，用户须手动装一个与 codex 本体分离的包，缓解不解决。**否决**——原生直连不需要任何安装层，也不留下检测面依赖。
- **双条目并存（native codex 与 codex-acp 各一适配器）**：同一运行时在选择器中出现两个身份，检测状态 / provenance 归属混叠。**否决**——直接替换。
- **`exec resume` 持 upstream thread**：resume / 切换 / 窗口管理与上游会话状态耦合，违 ADR-0076 运行时无状态。**否决**。
- **workspace-write / danger-full-access 沙箱（给 codex shell 权限）**：native 文件写绕过网关审批、FsAcl 可达性约束、result_N 物化纪律与会话管理目录所有权；未来文件生成能力（导出 / 报告）由工具面承载（内置网关工具或经网关的 MCP 工具，写入方为 app 进程），不下放运行时 shell。**否决**。
- **per-platform 沙箱变体（Unix workspace-write / Windows danger-full-access）**：需要平台变体机制而无收益（不需要 shell）。**否决**——read-only 全平台统一。

## Consequences

- **校准 ADR-0081**：「传输优先 ACP」落回字面——引擎支持多流格式（ACP + JSON 事件流），格式为 AdapterSpec 数据字段；codex 验证集由桥接包形态改为原生 exec 形态；零 per-CLI 代码不变量不变（per-format 分派）。0081 Context「ACP 自 2026 年起被 claude-code / gemini-cli / codex / copilot 等原生支持」对 codex 不成立（codex 无原生 ACP 模式），由本 ADR 的直连形态了结。
- **校准 ADR-0085**：三处。(1) 审批两正交面在 exec 形态退化为单面——ACP `request_permission` 面仅对 ACP 形态适配器存在，exec 形态的 agent 自带工具由 read-only 沙箱硬阻断取代（阻断面替代审批面）；网关面（MCP `tools/call` 分级审批）对两形态同构适用。(2) 桥接注入通道从 ACP `session/new` 描述符单一通道延伸出 codex 配置覆盖通道；桥接进程形态（纯 std proxy `[[bin]]`）与 per-session 隔离不变。(3) trace 双源合并规则按流格式泛化——权威源恒为网关 `tools/call` 记录，第二源为流格式自身的 native 工具事件（ACP pump `session/update` / exec 事件流 `command_execution` 等）；exec + read-only 下第二源实际为空（native 工具被阻断）。引擎完成驱动 serve 收尾的机制随流格式泛化（前提：CLI 阻塞等 `tools/call` 响应——codex 对 MCP 调用同样成立）。
- **ADR-0080 不变**：网关分级审批（内置放行 / 外部逐次确认 / 免确认姿态 / 会话级信任）作用于一切经网关调用，exec 形态直接适用，无新增审批语义；网关挂起等待用户的 UI 打断点对两形态同构。
- **CONTEXT.md 不变**：流格式是实现概念非领域概念；运行时 / 网关 / 桥接词汇表已足。
- **未决（实施期）**：事件流到 TurnPhase / TraceEntry / Termination 的完整映射（含 MCP 工具调用事件的实测形态）；stdin 窗口扁平化的分隔符形态；read-only 沙箱在无 OS 级沙箱平台上的实际行为验证；exec 对未信任目录的 trust 检查路径；codex 适配器的 real-CLI 端到端验证（替换既有桥接包形态的验证项）。
- **被 ADR-0095 延伸**：`StreamFormat` 不仅决定解析器分派，也隐含决定模型发现策略——`Acp` 从每轮握手 `config_options` 提取模型列表与思考强度选项，`JsonEventStream` 无动态发现。
