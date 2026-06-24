# LLM reachability & v1 user scoping: BYOK over Anthropic protocol with configurable baseURL

## Decision

v1 把目标用户**诚实收窄**为"已具备 Claude 可达接入"的用户——主要通过 **Anthropic 原生协议**接入（Anthropic 直连 key，或经用户自有、兼容 Anthropic 协议的中转网关）。接入形态固定为 **Anthropic 原生协议（`x-api-key` 鉴权）+ 可配 `baseURL`**；**不**在 v1 实现 Bedrock（AWS sigv4）/ Vertex（GCP OAuth）的异构签名（直接用 Bedrock/Vertex 原生签名的企业 v1 需自套 Anthropic 兼容层，或待 v2）。网络接入要求作为**诚实准入门槛**在首次引导与产品定位中明示；**不为大陆纯小白用户做接入兜底**（留作 v2 扩展点）。

## Context

ADR-0006/0007 锁 BYOK + 直连 Claude，0006 自陈"SQL 生成质量是产品命脉"、需"联网 + 自备 key"。但目标用户主要为大陆（全中文文档、ADR-0016 显式把 CN 市场列为考量），而 Anthropic API 在大陆不可直连——对非技术用户（ADR-0001）是不可逾越的硬障碍。整套 text-to-SQL 命脉（0002/0006/0007/0009/0016）依赖"能稳定访问 Claude"这一物理前提，此前却无任何 ADR 正视。

## Why

1. **三方冲突无法同时满足**：ADR-0007（单 Claude = 质量命脉）、ADR-0001（服务非技术用户，含大陆小白）、ADR-0006/0011（隐私依赖可信 provider，载荷只发 Anthropic）——大陆场景下要 Claude 质量则不可达；要大陆小白可达则须放开 provider 或引入第三方中转，从而打穿隐私模型（载荷经不可信第三方，0011 的诚实披露失效）。
2. **"可配 baseURL"对大陆小白仍不够**：不解决中转来源（小白无稳定可信中转）、打穿隐私（第三方中转看到 schema + 3 行真样本 + 列名）、且稳定性/合规不受控。故大陆小白留作 v2 扩展点，而非 v1 用低质量模型或自带后端中转来硬上。
3. **诚实收窄优于假装可达**：与其让用户下载后卡在接入上受伤，不如把网络门槛作为诚实准入声明（呼应 0011/0017 诚实哲学），先在"已可达"用户群上把质量/隐私做到极致。
4. **Anthropic 协议 + 可配 baseURL 守住 0007 薄抽象**：绝大多数自有中转兼容 Anthropic 协议，baseURL 可配即覆盖主力场景；Bedrock/Vertex 异构签名是 v2 复杂度，不在 v1 预付（YAGNI）。

## Considered options

- **放宽为多 provider（含 DeepSeek/GLM 等大陆可用模型）**：唯一让大陆小白真正可达，但重评 0007 单 Claude 质量承诺、多模型质量参差、0011 须按家重做。**否决（v1），留作 v2 扩展点**。
- **提供官方托管中转（自带后端/计费）**：小白零配置，但违背 0006（BYOK + 无后端）、载荷经第三方、退化为轻量 SaaS。**否决**。
- **v1 全 endpoint 形态（Bedrock/Vertex/Anthropic 并存）**：覆盖最广，但三套异构签名打破 0007 薄抽象 + YAGNI。**否决（v1）**。

## Consequences

- **校准 ADR-0001**：v1 目标用户含前置条件——"具备 Claude 可达的网络接入"；大陆纯小白市场明确不在 v1 范围。
- **校准 ADR-0006**："直连"语义明确为"经用户配置的可达 endpoint（默认 Anthropic 直连，可配 baseURL 指向自有中转）"；载荷**只发给承载 Claude 的那个 endpoint**，不额外经第三方——若用户自有中转，隐私由用户自负，App 不额外背书。
- **校准 ADR-0007**：薄抽象的 v1 形态 = 单一 Anthropic 协议 + 可配 baseURL；Bedrock/Vertex 异构签名为 v2 扩展点，不阻塞 v1。
- **校准 ADR-0011**：诚实披露面扩——须明示"网络接入要求"与"若用自有中转，载荷经过该中转、其留存/训练政策由用户自负、不受 App 控制"。
- v2 触达大陆小白需在"多 provider"或"合规中转"上另开 ADR。
