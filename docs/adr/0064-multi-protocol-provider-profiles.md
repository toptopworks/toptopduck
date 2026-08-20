# LLM provider: multi-protocol profiles (anthropic + openai)

## Decision

v2 开放多协议多接入档案（Profile），取代 ADR-0019「单一 Anthropic 协议、否决多 provider」的收窄。Profile = 一套命名的接入组合 = 协议 + endpoint(`base_url`) + model + key；用户创建多个、命名、指定其一为活跃。支持两种协议：

- **anthropic**：Anthropic Messages 原生（`x-api-key` 鉴权）
- **openai**：OpenAI Chat Completions（Bearer 鉴权；覆盖 OpenAI 直连 / DeepSeek / GLM / Qwen / Ollama 等兼容端点）

协议抽象轴是「线协议」而非「provider 名」——v2 只两种线协议，多家端点共用同一协议，按协议抽象比按 provider 名抽象更简。结构化输出契约（ADR-0009）沿用裸 prompt + 裸 JSON 解析，不引入 tool-calling。活跃 Profile 全局单一、住 app-config（ADR-0038）、不进 `.duck`。Ollama 走 `openai` 协议的兼容端点，载荷外发语义与云端一致（ADR-0011 不变）；「loopback 端点放开样本窗口」留后续独立 ADR。

## Context

ADR-0007 锁单一 Claude + 薄抽象（`Provider` trait），ADR-0019 把 v1 诚实收窄为「已具备 Claude 可达接入」的用户、明确否决多 provider（含 DeepSeek/GLM 等大陆可用模型）留作 v2。现开 v2：用户需在多协议/多端点间切换——大陆可达走 DeepSeek/GLM/Qwen 的 openai 兼容协议；成本/选择走 OpenAI 直连；企业走自有网关。`Provider` trait（`provider/mod.rs:233`）本就协议无关，多协议是「配置 + 第二个适配器」而非重写。

## Why

1. **协议轴而非 provider 轴**：v2 只两种线协议，多家端点共用同一协议——按协议抽象比按 provider 名抽象更简。与 codex 按 provider 名分不同：codex 要支持各家原生协议，v2 只两协议，按协议足够。
2. **裸 prompt 兑现薄抽象**：openai 适配器是纯 HTTP 翻译层（messages 形状 + 鉴权 + 从 `choices[0].message.content` 取 text，`parse_reply` 复用），现有 anthropic 实现零改动。schema 强制（tool-calling）只解决格式合法、不解决语义正确（SQL 质量，ADR-0006 命脉），不预付其复杂度。
3. **全局活跃 Profile 保 `.duck` 可移植**：profile 是机器级接入偏好，与分析正交；若进 `.duck` 则跨机器移植时 profile id 可能不存在，破坏 ADR-0034/0036。
4. **Ollama 先走 openai 兼容端点**：多协议与「loopback 端点放开样本窗口」是正交关注点；本 ADR 只定义多协议，后者留独立 ADR。

## Considered options

- **tool-calling 强制契约**（每协议用原生 structured output / function calling）：格式合法性最稳，但破坏现有 anthropic 实现 + 每协议一套 schema + 只解决格式不解决语义。否决——等具体模型重试率告警再局部引入。
- **按 provider 名抽象**（仿 codex）：v2 只两协议，按协议更简。否决。
- **每会话记录活跃 Profile**（指针进 `.duck`）：灵活但 `.duck` 依赖 profile id，跨机器移植断裂。否决。
- **Ollama 原生 API + 本地隐私升级**（载荷不出本机 → 样本全发）：与多协议正交的第二棵决策树。否决——留后续独立 ADR。
- **版本迁移机制（v1→v2 自动转换）**：未正式发布、无线上用户，开发机残留旧 app-config 走现有 honest-degrade（ADR-0038）整体重置即可，不需迁移代码。否决。

## Consequences

- **supersede ADR-0019**：第 20 行「否决多 provider、留作 v2 扩展点」推翻——v2 正式开放；0019「诚实披露载荷外发」结论保留。
- **校准 ADR-0007**：薄抽象（`Provider` trait 协议无关）结论兑现，新增 openai 适配器为第二个实现；「单一 Claude 质量命脉」收窄结论推翻为「多协议、语义质量仍靠模型」。
- **校准 ADR-0006/0011**：载荷外发语义不变（仍 schema + 样本 + 列名）；Ollama 在本批同语义——载荷发给 loopback 物理不出本机，但不因此放开样本窗口（后者需主动检测 endpoint 是否 loopback，留后续）。
- **keychain 单 slot → per-profile slot**：account 从 `anthropic-api-key` 改为 `key-<profile_id>`；ADR-0029 不变量 3 保留（key 仍只进 keychain、解密后仅存 Rust、前端只看 `has_key` bool）。旧 `anthropic-api-key` entry 不迁移、不清理（孤儿无害）。
- **app-config provider schema 形状变更**：`ProviderEndpoint{base_url,model}` → `ProviderConfig{profiles:Vec<ProviderProfile>, active_profile:ProfileId}`；`ProfileId` 稳定不可改、`display_name` 可改（对齐 ADR-0037 `reference_name` vs `display_name` 二分）；`format_version` bump v1→v2 标记形状变更，残留 v1 文件 honest-degrade 整体重置（ADR-0038），诊断从 Parse error 提升为 VersionMismatch。
- **已知收窄风险**：弱模型（Ollama 小模型）对裸 JSON 契约遵守度差，重试率（ADR-0028）可能上升；落地后用重试率指标验证，某模型超标则针对该模型局部引入 tool-calling。
- **canonical prompt 语言**：结构化契约的 `CAPABILITY_BOUNDARY_PROMPT`（`prompt.rs:108`）为中文 canonical（ADR-0052 layer 4）；openai 协议模型对中文 prompt 遵守度需验证，必要时提供英文 canonical 变体（留后续）。
- **被 ADR-0070 校准**：profile 配置流程新增 preflight 环节；model 字段选择方式从手填升级为 list models 探测下拉（失败回退手填），profile schema 形状不变（model 仍是字段）。见 ADR-0070。
- **被 ADR-0071 校准**：model 仍是 profile 字段（不独立化）；对话区切 model 写回 `profile.model`，`live_config` 读法不变；`ProfileSwitcher`（issue #154）退役，日常切换入口移至对话区。见 ADR-0071。
- **被 ADR-0098 校准**：`ProviderConfig` 不变量变更——`profiles` 可为空、`active_profile` 为 `Option`；`normalize()` 的非空重种 + 悬空回退首项不变量废除（空列表保持空、悬空指针归 `None`）；IPC view 的 effective 回退链随之调整。见 ADR-0098。
