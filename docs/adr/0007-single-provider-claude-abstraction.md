# LLM provider: single provider (Claude) behind an abstraction

## Decision

v1 锁定**单一提供商 Claude**（SQL 与结构化输出能力一线），背后留**薄抽象层（Provider 接口）**——未来加提供商是"配置"而非"重写"。**不**为多提供商预先实现（YAGNI）。

## Context

BYOK 已定（ADR-0006）。需决定单家 vs 多家、选哪家。

## Why

1. 先在**一个模型上把"SQL + viz 规格"结构化输出契约调到最佳**——这是最难的部分；Claude 的结构化输出与 SQL 能力是一线水平。
2. **抽象层**保住未来扩展，但不为多提供商预先付复杂度（YAGNI）。
3. 单一目标模型 = 更可控的质量、更少的分叉测试。

## Considered options

- **多家可选 from day 1**：用户用现成 key，但各家 API/结构化输出可靠性不一，须维护多适配器、分模型分别调契约——v1 复杂度过高。**否决**。
- **写死且不抽象**：最快但锁死，未来改重。**否决**。

## Consequences

- 只用 Claude key 的用户直接受益；非 Claude 用户需新办 key（与 ADR-0006 的上手摩擦叠加）。
- **抽象层须定义清晰**：统一"SQL 生成 + viz 规格输出"契约，Claude 为其首个实现。
- **v1 默认 Sonnet 级（钉版本，如 `claude-sonnet-4-6`）**：SQL + 结构化输出一线、成本可控；用户可切顶级（Fable/Opus）/Haiku。选型须满足结构化输出可靠（耦合 ADR-0009 + ADR-0016）。
- 加提供商是未来扩展点，不阻塞 v1。
- 薄抽象的 v1 形态已落地（ADR-0019）：单一 Anthropic 协议 + 可配 `baseURL`；Bedrock/Vertex 异构签名为 v2 扩展点。
