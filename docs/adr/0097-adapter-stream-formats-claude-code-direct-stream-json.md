# 适配器流格式:claude-code 直连 + ClaudeStreamJson 第三格式

## Decision

1. **claude-code 适配器以原生 headless 直连接入，无状态语义与 codex 路径同构**。turn argv = `--print --output-format stream-json --verbose --no-session-persistence`，提问（全量窗口化上下文）为 stdin 文本喂入（与 codex 路径同一喂法、同一窗口装配器）；每轮新 spawn，不用 `--resume` / `--session-id`，`--no-session-persistence` 使 upstream 不落会话文件。resume / 运行时切换 / 窗口管理全在 app 侧（ADR-0076）。

2. **流格式枚举三值化**：`JsonEventStream` 更名 `CodexEventStream`（该值至今单主 codex，中性名掩盖私有词汇归属，且与 claude 官方输出格式名 stream-json 同名，易致 claude-code 适配器被误关联到 codex 解析器）；新增 `ClaudeStreamJson`（claude stream-json 词汇：`system` / `assistant` / `stream_event` / `result` 帧）。枚举值 = 解析器分派单位的不变量（ADR-0094 Decision 1）不变；wire tag 变更使既有目录缓存旧条目按损坏降级路径丢弃、重探测重建（缓存为可弃快照）。

3. **native 工具全阻断，网关独占工具面**。claude 自带工具（shell / 文件改写 / 联网检索 / 子代理等）不可用：`--disallowedTools` 显式 deny 清单 + headless 无审批交互时权限请求自动拒。审批 / 审计 / 物化命名边界同 ADR-0085 / ADR-0094 codex 路径（阻断面替代审批面）；`--permission-prompt-tool` 控制通道不接入——不为无合法用途的工具引入审批 UI 与控制面解析。

4. **MCP 注入经 `--mcp-config` + `--strict-mcp-config`**：内联网关桥接 server 描述符 JSON，`--strict-mcp-config` 使会话忽略机器自带 MCP 配置——用户机器级自配 MCP 不进入产品会话，外部工具经产品 MCP 配置面接入网关的唯一路径不变；桥接进程形态与 per-session 隔离复用现有。

5. **模型与思考强度经 stream-json 控制平面发现**：探测期 spawn 后发送控制帧 `control_request{initialize}`，从 success `control_response` 的 `models[]` 提取目录——`value`（别名）/ `resolvedModel`（实际解析模型名）/ `displayName` / `supportedEffortLevels[]`（per-model 思考强度值域）/ 能力位。该响应是 claude 唯一的目录通道（`system{init}` 数据帧仅携带当前模型）；provider 感知（第三方端点环境下回传实际模型集，实测），不产生 API 调用。探测 argv 基于 turn argv 追加 `--input-format stream-json`（探测同样不落 upstream 会话文件），spawn 后发 initialize 帧、收目录即退，对位 codex 经 `app-server` 探测的先例（ADR-0096 Decision 2 的 per-format 探测分派新增第三形态）。轮内不重复发现：每轮 `system{init}` 回传当前模型做诚实渲染；initialize 无响应降级空目录。

6. **注入字段新增 `effort_arg`**：`AdapterSpec` 新增 `Option` 字段 `effort_arg`（argv 形思考强度注入，claude = `--effort`），与既有 `model_arg`（claude 与 codex 均为 `--model`）平行；codex 的 `effort_config_key`（`-c` 配置面拼装）不变。思考强度值域 per-model 动态（来自 `supportedEffortLevels[]`），选择器按所选模型过滤。

7. **argv 最小集，无版本门控基建**：不带增强 flags（partial-messages 增量流式 / thinking-display 等）——flag 越少「未知 option 于参数解析期硬错」的面越小；显示增强随需引入时再随需引入版本探测门控。

## Context

claude-code 无原生 ACP 模式（实测 2.1.222：`--acp` 选项不存在，spawn 即错）——既有 ACP 通道不适用。claude-code 的 headless 模式（`--print` + `--output-format stream-json`）提供结构化 NDJSON 输出与 stream-json 控制平面（`control_request` / `control_response` 帧：initialize 目录发现、can_use_tool 审批、set_model 切换等），是 ACP 之外的唯一结构化接口。第三方 provider 生态（环境变量注入自定义端点）使静态模型目录失真——实测 `initialize` 控制响应回传 provider 解析后的实际模型集。

## Why

1. **无状态同构**：窗口装配器与 upstream 会话状态是两套上下文管理，全量窗口喂入再 resume 叠加致上下文不可控；每轮 spawn 使 resume / 切换 / 并发会话语义全留 app 侧（ADR-0076 不变量，codex 路径已验证）。
2. **阻断而非审批**：数据分析轮次的数据操作走网关工具面，claude native 工具无合法用途；审批 UI 只会批准永不该用的调用。headless 自动拒 + 显式 deny 清单以零 plumbing 达成与 codex read-only 沙箱同构的阻断面。
3. **命名消歧**：枚举值与解析器一一对应，`JsonEventStream` 与 `ClaudeStreamJson` 同名会致 claude-code 适配器被误关联到 codex 解析器；更名成本一次付清（缓存丢弃重探测走既有降级路径）。
4. **控制平面发现优于静态集与自由输入**：目录 provider 感知、零 API 成本、含 per-model 思考强度值域；静态集在第三方 provider 下失真，自由输入弃既有选择器目录形态。
5. **strict MCP 落实网关独占工具面**：机器自带 MCP 若放行即旁路网关审计，与「工具调用全部经网关」的结构性承诺冲突。

## Considered options

- **持久进程 + `--session-id`/`--resume` 锚定 upstream 会话 / 每轮 spawn 但 `--resume` 续 upstream**：违 ADR-0076 运行时无状态；upstream 上下文与 app 侧全量窗口叠加不可控；持久进程另需空闲释放与唤醒重连的生命周期管理。**否决**。
- **`--permission-prompt-tool stdio` 映射分级审批（can_use_tool 双向通道）/ 混合放行只读 native 工具**：为无合法用途的工具开审批面并引入 claude 特有控制帧解析（per-CLI plumbing）；只读探查在工作集为 DuckDB 数据集而非文件的领域无增益。**否决**。
- **保守增值不更名（`JsonEventStream` 实指 codex）/ 中性特征名成对命名**：前者名字持续误导（claude 官方输出格式名同为 stream-json）；后者为至今无第二主的「共享」意图付可读性，推测性泛化。**否决**——更名 + 按主命名。
- **静态模型别名目录 / 模型自由输入无目录 / 探测实跑问询产目录**：静态集在第三方 provider 下失真（实测回传为 provider 解析集）；自由输入弃选择器目录形态；问询无可靠通道且产生 API 调用成本。**否决**——控制平面 initialize 发现。
- **turn argv 用 stream-json 输入（统一帧格式预留控制通道）**：轮内控制面已被无状态与阻断决策消除，预留无消费者。**否决**。
- **增强 flags（partial-messages 增量流式等）+ `--version` 探测门控基建**：为当前不需要的显示增强引入版本门控复杂度与硬错面。**否决**——最小集，随需再引入。

## Consequences

- **校准 ADR-0095**：发现策略按格式三分化——`Acp` 握手 `config_options` 动态发现；`CodexEventStream` 与 `ClaudeStreamJson` 的 turn 路径均无动态发现（目录经探测缓存），但 `ClaudeStreamJson` 的探测通道为 stream-json 控制平面 `initialize`。「JsonEventStream 无动态发现」表述收窄至 codex 路径；`effort_config_key` 的「JsonEventStream 注入」表述由 argv 形 `effort_arg` 平行字段泛化。
- **延伸 ADR-0094**：流格式集扩为三值，`JsonEventStream` 更名 `CodexEventStream`；零 per-CLI 代码不变量与 per-format 分派不变。
- **延伸 ADR-0096**：探测语义 per-format 分派新增 `ClaudeStreamJson` 形态——spawn + `control_request{initialize}` 收目录即退（无握手 RPC 链、无 API 调用）。
- **目录缓存兼容**：`stream_format` wire tag 变更（`json_event_stream` → `codex_event_stream`）使旧条目按损坏降级丢弃，重探测重建。
- **解析容错**：解析器须容忍未知 `system` subtype 帧混流（会话钩子等来源的帧与业务帧同流，实测）。
- **cancel 为进程信号路径**：无协议级轮中止（同 codex）；cwd 与窗口装配对齐 codex 路径。
- **CONTEXT.md 不变**：流格式、控制平面、探测目录均为实现概念非领域概念；运行时 / 适配器 / 网关词汇表已足。
- **未决（实施期）**：事件帧到 TurnPhase / TraceEntry / Termination 的完整映射；`--disallowedTools` deny 清单与 headless 自动拒的覆盖面实测；`initialize` 响应在未登录 / 异常环境下的形态；claude-code 适配器的 real-CLI 端到端验证。
