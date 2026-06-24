# Cross-source relationships: no proactive hint engine in v1 (LLM infers); cross-source JOIN/UNION must flag join keys

## Decision

1. **不做跨源关系提示引擎**：v1 不主动向 LLM 喂跨源 join-key 候选（如 `orders.customer_id ↔ customers.id`）；让 LLM 从列名 + 首 3 行样本（ADR-0026）自行推断，连接键歧义走 ADR-0018 兜底（默认选最像主/外键列 + 标注、高不确定则澄清）。

2. **跨源 JOIN/UNION 必带 join 键标注（恒暴露）**：凡 ≥2 源的 JOIN/UNION，必在 `assumption`（ADR-0009）标注所用 join 键 / 列对齐——**非仅歧义时**，哪怕看起来无歧义。复用 ADR-0010 可纠偏旁注渲染，零新契约 / 新机制。

## Context

ADR-0022 开了多源共享命名空间、ADR-0017 把 JOIN/UNION 列入 IN，使跨源 join 成为真实能力——而它是 text-to-SQL 最易错、且静默错即信任杀手（ADR-0017「自信的错误」）的环节。ADR-0018 已定「连接键歧义」处置，却未定：是否主动喂关系提示？跨源 join 这个高危场景如何防「自信但错」？

## Why

1. **名字启发式不增加信号**：一个检测 `<table>_id` / 同名列的提示引擎，信号源（列名）与 Claude 自行推断一致——列名能误导 LLM 就照样能误导引擎，边际收益≈0；且假阳性提示反可能误导。KISS/YAGNI。
2. **强制标注才是真正防线**：高危是「自信但错」的 join（无歧义、不触发 0018），提示引擎抓不住它（同源信号）；唯一能抓的是用户可见透明——跨源 join 键是决定性假设，恒标注让用户每次都能核验，把 ADR-0010 纠错回路铺满。
3. **延续 0018「暴露假设 > 沉默猜」哲学**：把跨源 join 这个最该暴露的假设，从「歧义时暴露」升级为「恒暴露」，复用既有 `assumption` 字段 + 旁注渲染，零新机制。
4. **噪音有界**：仅跨源 JOIN/UNION 强制（单源操作不动）；旁注形态（非阻断对话框）。

## Considered options

- **v1 上跨源关系提示引擎（名字启发式检测）**：信号同源于 LLM 自身推断，边际收益≈0 + 假阳性误导 + 复杂度。**否决（v1）**。
- **用户标注关系（外键式 ground truth）**：最准，但对非技术用户（ADR-0001）是摩擦硬伤，v1 YAGNI。**否决（v1）**。
- **仅歧义时标注 join 键（0018 现状）**：漏掉「自信但错」最危险场景。**否决（升级为恒标注）**。
- **跨源 join 不标注、纯靠 LLM**：沉默错 join 风险，违背诚实脊柱。**否决**。

## Consequences

- **校准 ADR-0018**：连接键标注从「歧义时」升级为「跨源 JOIN/UNION 恒标注 join 键 / 列对齐」（单源 join 仍按歧义时标注）。0018 Consequences 已追加校准指针。
- **延伸 ADR-0022**：多源共享命名空间使跨源 join 成真实能力；其 join 键正确性由本 ADR 的恒标注 + 0018 既有消歧兜底 + 0017 越界拒绝共同守。0022 Consequences 已追加指针。
- 实现侧：system prompt 须要求 LLM 对跨源 JOIN/UNION 必在 `assumption` 自陈 join 键；ADR-0010 历史视图渲染该标注为可纠偏旁注。
- **v2 增强触发条件**：若实测命名混乱源（`cust_id` vs `customer_id`）的错 join 频发，增强方向 = 工具侧名字启发式检测 → 作为「建议」喂 LLM（**仍走本 ADR 恒标注**，非替代）；用户标注关系仍不做（非技术用户硬伤）。
- 跨源关系提示引擎与用户标注关系均为已知 v2 候选，不阻塞 v1。
