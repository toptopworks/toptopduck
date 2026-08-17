# 运行时实现:BYOK Rust 原生循环 + ACP 优先 CLI 适配器

## Decision

**内置运行时 = Rust 原生 agent 循环**，驱动现有 Provider 层（ADR-0064 anthropic/openai 协议，用各协议**原生 tool-calling**）；key 永不出进程（ADR-0029 不变量完整）。**外部运行时 = 数据定义适配器引擎**：每 CLI 一个纯数据定义（bin / argv builder / 流格式 / MCP 注入方式），通用引擎统一做检测 / 启动 / 解析；传输**优先 ACP**（stdio JSON-RPC；MCP server 描述符经 `session/new` 注入；`session/update` 的 tool_call 系列天然映射执行轨迹）；**每轮恒 `session/new` + 喂全量窗口化上下文**，不持 upstream session handle（运行时无状态，ADR-0076）。v1 验证 ACP 三件套 claude-code / gemini-cli / codex；qwen-code 列二批。**执行级兜底**：步数上限（默认 24）+ 墙钟 watchdog（默认 120s，对齐 ADR-0021 `REQUEST_TIMEOUT`），触顶该轮 failed/cancelled；cancel = 整轮中止（内置：interrupt token 扩至循环；外部：ACP `session/cancel` + SIGTERM fallback）。

## Context

ADR-0076 定双运行时；本 ADR 定两运行时的实现形态。内置循环两候选：Rust 自写，或拉起第三方 agent 进程注入 BYOK 配置（key 经环境变量过界、循环借壳）。外部运行时两候选：per-CLI 定制协议 plumbing，或数据定义适配器引擎 + 标准传输优先。ACP（stdio JSON-RPC 开放标准）自 2026 年起被 claude-code / gemini-cli / codex / copilot 等原生支持，MCP 注入与工具调用通知在协议内。

## Why

1. **Rust 原生循环守 ADR-0029**：key 仅在 Rust 进程，不过界；借壳方案要把 key 经环境变量交给第三方进程，是隐私边界实质性放宽。两协议皆有原生 tool-calling，循环本身并非最高成本项。
2. **M 契约纪律靠 system prompt + 网关强制**：自建循环可精确控制工具表装配与晋升纪律；借壳循环只能依赖对方进程的 prompt 遵守度。
3. **数据定义适配器**：加一个 CLI = 一个文件变更，通用引擎零 per-CLI 代码；ACP 优先使三个顶级 CLI 共享一套传输解析，per-CLI 验证成本压到行为层（历史失效开关、权限请求处置）。
4. **无状态 session/new 每轮**：resume / 切换 / 窗口管理全在 app 侧，与运行时正交（ADR-0076）；ACP 的 `session/load`（upstream 持久会话）刻意不用。
5. **执行级兜底是盲重试废止（ADR-0077）后的安全网**：agent 可能不收敛，步数 + 墙钟是最后防线；取值对齐 ADR-0021 复用既有超时语义。

## Considered options

- **BYOK 借壳第三方 agent 进程（配置注入 + 环境变量 key）**：循环免费但 key 过界、重依赖第三方二进制、M 纪律靠他进程自觉。**否决**。
- **借壳与自建双提供**：双路径的 M 契约 / 审批语义双轨维护。**否决**。
- **per-CLI 定制 plumbing（不 ACP 优先）**：三套流解析 + 三套 MCP 注入 plumbing，新增 CLI 再逐个加。**否决**。
- **v1 验证国内优先 CLI（qwen-code 等）**：qwen-code 不支持 ACP、需定制传输，首批验证成本最高；ACP 三件套以最低成本覆盖高端 + 全球免费档。**否决**——二批补。
- **无执行级上限（靠 agent 自律）**：runaway 循环成本 / 时长无界，违 ADR-0005 谱系。**否决**。

## Consequences

- **校准 ADR-0064**：Profile/Provider 层降为内置运行时的接入层（取代立场见 ADR-0076）；preflight（ADR-0070）语义不变。
- **延伸 ADR-0021**：cancel token 从单 SQL 中断扩至整轮中止（循环 + in-flight 工具调用）；`REQUEST_TIMEOUT` 升为执行级墙钟默认值。
- **校准 ADR-0044**：provider 错误分类并入传输层重试语义（瞬时 / 永久分类保留，不上达 agent）。
- **key 分发边界**：外部运行时用其自身鉴权（其自有登录 / 配置），app 的 Profile key 不注入外部运行时进程。
- **未决（实施期）**：适配器引擎模块边界、桥接进程形态、ACP `session/request_permission` 与网关审批对应（自动选取允许项，无可选项 = fail-fast）。
- **被 ADR-0095 校准**：wire 类型扩展（`NewSessionResult.config_options`）与 `AdapterSpec` 新增字段（`model_arg` / `effort_config_key`）均为纯数据增量；ACP 路径握手后追加的 `session/set_config_option` 是握手扩展步骤，不引入 upstream session 状态——「每轮恒 `session/new` + 不持 upstream session handle」的无状态语义不变。
- **被 ADR-0094 / ADR-0097 校准**：初版 v1 三件套中的 codex 经实测无原生 ACP 模式，改经原生 `exec --json` JSON 事件流直连（ADR-0094）；claude-code 的 `--acp` flag 经实测不存在，自 ACP 适配器集合移除，改经 stream-json 直连接入（ADR-0097）。ACP 适配器集合现为 gemini-cli / qwen-code / opencode；「传输优先 ACP」由 ADR-0094 的流格式数据字段分派取代，零 per-CLI 代码不变量不变。
