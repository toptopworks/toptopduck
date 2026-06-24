# LLM: cloud API via BYOK; full datasets never leave the machine

## Decision

LLM 推理走**云端 API，用户自带密钥（BYOK）**，App 直连。本地 DuckDB 保留完整数据集；**仅 schema（表/列/类型）+ 最小样本行 + 自然语言查询**发送给 LLM。

## Context

text-to-SQL 必须让 LLM 看到 schema + 少量样本才能写出正确 SQL。需选定接入方式并**精确化"数据不出本机"的边界**——ADR-0001 的"仅 LLM 调用联网"在此细化为：完整数据集不出本机，但 schema/样本/查询会出。

## Why

1. **SQL 生成质量是产品命脉**，一线云端模型写 DuckDB SQL 远胜本地开源小模型。
2. **BYOK = 零推理基础设施/零计费**，契合桌面应用定位，无需后端。
3. **隐私故事仍成立**：完整数据集永不离开本地 DuckDB；外发仅 schema + 最小样本 + 查询，且样本量可调/可关。
4. 本地模型留作未来开关（v1 不背质量包袱）。

## Considered options

- **云端、我们托管 key**：用户零配置，但需后端/计费——桌面应用不合理。**否决**。
- **本地模型（Ollama 等）**：全隐私/离线，但 SQL 质量明显差、吃硬件、模型体积大。**否决（v1）**。

## Consequences

- 用户需**联网 + 自备 API key**（首次上手有摩擦，需好引导）。
- 外发内容 = schema + 样本 + 查询；**须在 UI 明示此边界**，并提供"样本量 / 关采样"控制以增强隐私。
- **API key 本地存储须安全**（OS keychain / Windows Credential Manager，禁止明文落盘）。
- 首选 SQL/结构化输出强的提供商（见 ADR-0007）。
- 接入形态校准（ADR-0019）：App 经**用户配置的可达 endpoint**访问 Claude——默认 Anthropic 直连，可配 `baseURL` 指向自有中转；载荷只发给承载 Claude 的该 endpoint，不额外经第三方。Bedrock/Vertex 异构签名留 v2。
