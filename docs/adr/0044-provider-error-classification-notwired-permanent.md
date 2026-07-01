# Provider 错误分类：NotWired（permanent）vs Unavailable（transient）—— HTTP 401/403 归 NotWired

## Decision

provider 层把"本轮没拿到回复"的原因分**两档**，对应 `ProviderError` 的两个变体，决定进不进 ADR-0028 的单预算重试回路：

- **`NotWired`（permanent，不进回路、不消耗预算）**：立即落为 failure-outcome（ADR-0028 的 C 类），提示用户配置有效 key。三种来源：
  1. 无 API key 存储（ADR-0029 不变量 3）；
  2. **存储的 key 被端点拒绝——HTTP 401/403**；
  3. 无 provider wired（`UnwiredProvider`，测试/未接线态）。
- **`Unavailable`（transient，进回路）**：网络抖动 / 配额 / 畸形输出（契约违反）等可恢复失败——走 ADR-0028 单预算重试回路（默认 2 次），耗尽落 failure-outcome。

**认证失败（401/403）归 `NotWired`**：key 在一轮内不会变，重试必撞同一堵 401 墙，只会空耗用户时间。

## Context

ADR-0028 定义了 C 失败轮的**单预算重试回路**与四类 outcome，但没显式规定"provider 层哪些错误进回路、哪些不进"。#29 接入真实 Anthropic 端点后，**首次出现 HTTP 认证失败路径**（401/403）——此前 fake provider / UnwiredProvider 只有无 key 一种 permanent 态。`provider/mod.rs` 的 `ProviderError` 两变体注释已说明分类，但缺 ADR 层的决策归档。

## Why

1. **认证失败与"资源上限/超时"同构**：ADR-0028 已判定"重试必撞同墙"的失败（资源上限/超时）不进回路；认证失败同构——同一 key 重试结果不变，归 permanent 一致。
2. **两档够用（YAGNI）**：provider 失败只分"能恢复 vs 不能恢复"，第三档（如"立即告知但可重试"）是易错元判断且无收益。
3. **守 ADR-0028 预算语义**：单预算回路只服务可恢复失败，permanent 错误明确不消耗预算——否则 3 次 401 烧光预算才告知用户，UX 退化。

## Considered options

- **401/403 归 `Unavailable`（进重试回路）**：必撞同墙、空耗预算与用户时间。**否决**。
- **新增第三变体 `AuthRejected`**：与 `NotWired` 行为完全一致（permanent、不重试、提示配 key），多一档无新行为。**否决（YAGNI）**。
- **保留 `Unavailable` doc 仍列 "auth" 为 transient**：与 401→NotWired 的实际映射矛盾，误导后续实现者。**否决**（本 ADR 落地同步修正 doc）。

## Consequences

- **校准 ADR-0028**：C 失败轮单预算重试回路**只消耗 `Unavailable`**；`NotWired` 不进回路、不消耗预算，直接落 failure-outcome。0028 Consequences 已追加交叉指针。
- provider 实现须把 HTTP 401/403 映射为 `NotWired`（`anthropic.rs` 已如此）；其他 5xx / 网络 / 解析失败归 `Unavailable`。
- `NotWired` 的 `Display` 文案统一提示"配置有效 key"，对三种来源（无 key / 被拒 / 未 wired）一视同仁——不泄露是哪一种，避免给攻击者端点探针信号。
- 本 ADR 不改变 ADR-0028 的四类 outcome 划分，只补全"provider 错误如何映射到 C 失败轮的进/不进回路"。
