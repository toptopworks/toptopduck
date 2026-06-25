# .duck document as durable contract: format_version from day 1, forward-migrate / honest-refuse, contents boundary (secrets never), hybrid source paths

## Decision

1. **格式版本化从 v1 起**：每个 .duck 带 `format_version`（v1 = 1）。打开按版本路由：等于本 app 版本 → 正常；**低于**（老文件、新 app）→ **向前迁移**（纯 recipe → recipe 变换：加字段填默认、改语义做映射）后开；**高于**（新文件、老 app）→ **诚实拒绝**「此文件由更高版本制作，请升级 app」（ADR-0017 能力边界的格式层镜像）。迁移持久化走 KISS：内存迁移 + 0034 正常自动写盘落迁移后形式；不默认备份原始（YAGNI）。

2. **内容边界（IN / OUT）**：
   - **进 recipe**：`format_version`、session 名、源引用（路径 + 规整参数 + 内容指纹）、有序 productive SQL 链 + 各轮 outcome、中间结果名 / 重命名、no-result 轮历史条目（消歧选择 / 拒绝 / 失败 / 取消）、全量对话历史、active dataset 指针。
   - **出（非持久）**：物化结果数据（0034 重放重建）、源数据本身（用户磁盘）、对话窗口（ADR-0023 从全量派生）、viz 选择 / 图表状态（**不持久化；创作时 / 显式请求时再生，resume 时不重算以保离线**，ADR-0033）、UI 视图偏好、执行元数据（token / 耗时 / 行数）。

3. **头条安全约束：secrets never in .duck。** BYOK API key / provider 配置是**用户级、app 级**（ADR-0006/0019），**绝不**进 .duck——.duck 可移植可分享，塞 key = 分享即泄露凭证。是 ADR-0029（key 仅存 Rust 核心、连 webview 都不进）的直接推论：key 连出 Rust 都不行，何况写进用户可见文本文档。**安全不变量，非偏好。**

4. **源路径混合表示**：源在 .duck 目录子树内 → 存相对；别处 / 跨卷 → 存绝对；**两种都存**。resume 先按相对当前 .duck 位置解析、回退绝对，**两种都做指纹校验**（接 0035），全失败走 re-link。覆盖「.duck + 源一起搬」与「只搬 .duck」两种搬法；纯相对在 Windows 跨卷无法表达、纯绝对一搬全断——混合是唯一对跨平台桌面现实的诚实回答。

## Context

0034 让 .duck 成为用户拥有的持久可移植文档 → 它现在是一份**契约**：老 .duck 须在新 app 持续可开（longevity，0034），其内容须有明确边界（什么进什么出），且作为可分享文件须有安全边界。是持久化主题的收口决策——把"持久化单位 / 形式 / 行为"（0034/0035）落到"文件即契约"的最后一层。

## Why

1. **format_version 从 v1 起零成本买断未来最贵 ambiguity**——野生文件一旦无版本标记，将来 v2 改格式便无法区分新老文件，只能脆弱启发式 / 误解析。hard-to-reverse 之王，跳过不可辩护。
2. **向前迁移兑现 longevity；拒超新 = 0017 诚实拒绝的格式层镜像**，防静默误解析——与整个产品诚实 ethos 同源。
3. **secrets-never 是 0029 key-in-Rust 在新持久 artifact 上的延伸**——可分享文件是新的 key 泄露面，必须关上。
4. **内容边界把"recipe 装什么"钉死**，避免派生 / 临时态 / app 级配置污染持久契约；viz 出（重算）与 0033 一致——v1 无用户手改 viz，故无持久物。
5. **混合路径是可移植承诺的现实落地**：搬文件夹场景下"就是能用"；指纹校验守住内容时效（0035），路径对上但内容变了仍按漂移处理。

## Considered options

- **不版本化（v1 不带 format_version）**：将来 v2 改格式无法区分新老文件，脆弱启发式 / 误解析。**否决**。
- **版本化但严格拒旧（非当前版本拒开）**：毁掉 longevity（老分析打不开）。**否决**。
- **BYOK 配置 / key 进 .duck（便利 / 可移植配置）**：可分享文件泄露凭证，违 0029。**否决**。
- **viz 状态进 recipe**：与 0033（LLM 运行时决 viz）相悖；v1 无用户手改 viz 故无持久物。**否决**。
- **纯绝对路径**：搬文件夹全断、逐个 re-link，背叛可移植。**否决**。
- **纯相对路径**：Windows 跨卷（C/D 盘）无法表达，常见失效。**否决**。
- **迁移前默认备份原始 v1**：YAGNI，留待精修。**否决（v1）**。

## Consequences

- **延伸 ADR-0029 不变量 3（key 仅 Rust）**：在新持久 artifact 上补一条「key 绝不进 .duck」——非改 0029 文本，是其安全隔离向持久化层的延伸。
- 实现侧：.duck schema 含 `format_version`；向前迁移变换；打开时版本路由；源路径相对 / 绝对双存 + 解析；内容边界序列化（**密钥绝不序列化**——BYOK 走 app 级 keychain / Rust，ADR-0006/0029）。
- 若未来加「用户手动调 viz」，那份手改状态须进 recipe（届时另开 ADR 校准本内容边界）。
