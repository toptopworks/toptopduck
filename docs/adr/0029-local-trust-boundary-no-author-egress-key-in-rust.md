# Local trust boundary: zero author data-egress (invariant), no persistent at-rest user data, API key confined to Rust core

## Decision

在 ADR-0006（云端外发边界）与 ADR-0012（纯内存会话）之外，补三条**本地信任边界**不变量：

1. **网络外发不变量**：用户源数据（prompt / schema / 样本 / SQL / 结果）的**唯一外发出口 = 用户配置的 LLM endpoint**（ADR-0006/0019）；App **对作者零数据外发**——无分析、无遥测、无含数据的崩溃上报。**不变量，非配置项。** 唯一例外：**不携带用户数据的运维外发**（Tauri 自动更新拉清单，ADR-0008），单独披露、允许。v1 **不预留遥测通道**。

2. **本地落盘边界**：默认**零用户数据持久落盘**为不变量。ADR-0012 L5/L27 已允许 DuckDB 透明 temp-spill；本 ADR **精确化其隐私框架 + 补 0012 未涉规则**：
   - **DuckDB 瞬态 spill**（0012 已允许）：指向**每会话独立临时目录**、**会话结束清除**、UI 披露（「大查询中间结果可能瞬态写临时目录、会话结束清除」）。精确化 0012「纯内存」承诺为「**不持久落盘 + 会话结束清除**」，非「零磁盘写入」——spill 是会话级临时工作内存的延伸。
   - **崩溃 minidump**（0012 未涉）：可写本地、**绝不自动上传**（延续不变量 1）、含内存数据→视为敏感 at-rest、短期留存/清理、用户分享前警示「可能含数据」。
   - **诊断日志**（0012 未涉）：默认**不写源数据值**（prompt 内容 / 样本 / 结果行）；verbose/debug 日志须 opt-in 且脱敏。

3. **key 进程隔离**：解密后的 key **仅存 Rust 核心进程，前端永不持有**。前端首次输入经 IPC 交 Rust 存 keychain（ADR-0006）；此后前端只经 IPC 触发推理（「key 配了吗」只回布尔，不回 key 本身）；**Rust 从 keychain 取 key、由 Rust 发起对 LLM endpoint 的 HTTP 调用并附 key**、只把结果回前端。Tauri capability/allowlist（ADR-0008）**禁用 webview 直访 keychain 与任意 HTTP**——强制经 Rust command。

## Context

ADR-0006 钉了云端外发边界（仅 schema+样本+查询出本机、完整数据集不出）与 key 存储（OS keychain、禁明文），ADR-0008 提了 Tauri allowlist 强化 key 存储，ADR-0012 钉了纯内存会话（并默认允许 temp-spill）。但三处未定：「仅 LLM 联网」是否**数据外发硬边界**（还是产品措辞）、本地是否有 **日志 / minidump / 已允许的 spill** 落盘、**key 解密后是否进 webview**——是本地优先（ADR-0001）信任脊柱下的未闭合依赖。尤其：ADR-0011/0017 已标 prompt 注入为软保证局限，若 webview 持 key + 有任意 HTTP 出口，注入即可偷 key 外发——需硬隔离闭合。

## Why

1. **「仅 LLM 联网」是信任脊柱**——零作者数据外发钉成**不变量而非配置项**（配置会被未来工程师「无害地」打开）；运维外发按「无用户数据」劈线单独披露，避免「零网络外发」与自动更新自相矛盾。
2. **崩溃上报是最大暗礁**——dump 含内存真数据（ADR-0011），自动上报 = 把用户数据发去作者服务器 = 直接破不变量 1；故本地写、不外发、分享前警示。
3. **默认零持久落盘 + spill 措辞精确化**——强制纯内存会实质阉割大表分析（硬卡 `memory_limit`，ADR-0005）；0012 已允许的 spill 是会话级临时工作内存延伸、瞬态、自动清除，与「持久落盘」性质不同；精确化为「不持久 + 会话结束清除」而非「零写入」，堵住未来读者对「纯内存扛不扛一次 10GB join」的质疑。
4. **key 关在 Rust = 硬化注入向量**——即便 webview 被 prompt 注入（ADR-0011/0017 软保证局限），它既无 key 可偷、也无任意 HTTP 出口可发；双锁。付 Rust 发 HTTP + 流式回传（经 Tauri event/channel）的代价，是**安全边界高于实现便利**。

## Considered options

- **数据外发改配置项**（默认关、可开遥测）：信任一旦破不可逆，配置易被无害地打开。**否决**。
- **把自动更新也并入「零外发」封死**：与真实更新需求自相矛盾；按「无用户数据」劈线更诚实。**否决**。
- **崩溃 dump 自动上报含数据**：直接破不变量 1。**否决**。
- **DuckDB 强制纯内存（禁 spill）**：隐私增益微薄（会话结束即删、非用户可读日志、威胁仅磁盘取证），却实质阉割大表分析；且与 0012 已允许的 spill 冲突。**否决**。
- **诊断日志默认全量记**（debuggability）：违背本地优先隐私主张。**否决**。
- **前端持 key 直接 fetch LLM**（流式便利）：把 BYOK 安全交给最不可信层；注入即可偷 key 外发。**否决**。
- **预留遥测通道待 v2 开**：预留 = 留破口；未来要加须独立 ADR（显式 opt-in + 用户可见载荷 + 只发无源数据栈迹）重新过界。**否决（v1）**。

## Consequences

- **校准 ADR-0006**：key 存储从「OS keychain、禁明文」延伸为「解密后仅存 Rust 核心进程、前端永不持有、HTTP 由 Rust 发起并附 key」；并确立「对作者零数据外发」为不变量（用户源数据唯一外发出口 = 本 ADR 定义的 LLM endpoint）。0006 Consequences 已追加校准指针。
- **校准 ADR-0008**：Tauri capability/allowlist 精确化为「禁用 webview 直访 keychain 与任意 HTTP，强制经 Rust command」；自动更新清单拉取为允许的运维外发（不携带用户数据）。0008 Consequences 已追加校准指针。
- **校准 ADR-0012**：0012 已允许的「透明 temp-spill」隐私框架精确化为「每会话独立临时目录 + 会话结束清除 + UI 披露」；「纯内存」承诺措辞校准为「不持久落盘 + 会话结束清除」（非零磁盘写入）；并补 minidump（本地不外发）/ 诊断日志（默认脱敏）两条 0012 未涉规则。0012 Consequences 已追加校准指针。
- **校准 ADR-0011**：prompt 注入软保证的最小防御新增一条**硬措施**——key 仅存 Rust 核心进程、webview 无任意 HTTP 出口，注入即便成功也无法偷 key 外发（硬隔离一条注入后果，补 0011 软保证姿态的短板）。0011 Consequences 已追加校准指针。
- 实现侧：LLM HTTP 客户端在 Rust 核心实现（非 webview fetch）；流式响应经 Tauri event/channel 回传前端；keychain 访问封装在 Rust command；allowlist 收紧。
- UI 须披露：仅 LLM endpoint 收数据外发、大查询可能瞬态 spill 临时目录（会话结束清除）、minidump 含数据（分享前警示）。
- v1 不预留遥测通道；未来若加须独立 ADR（显式 opt-in + 用户可见载荷 + 只发无源数据栈迹）。
