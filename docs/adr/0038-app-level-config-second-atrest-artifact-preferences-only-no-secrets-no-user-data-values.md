# App-level config: the second at-rest artifact (alongside .duck); preferences/defaults/window-geometry only — secrets and user-data values never

## Decision

存在**两类**持久 at-rest 产物，劈清边界：

1. **`.duck`（用户文档，ADR-0034/0036）**：用户拥有的分析单元——源引用 + productive SQL 链 + 对话历史 + 中间结果名/显示名。受 `secrets-never` 约束（ADR-0036）。
2. **app 级配置（app-config，本 ADR 新增）**：住 OS app-data 目录（如 `%APPDATA%/toptopduck/config`），存**偏好、默认参数、无数据的应用状态**。

**app-config IN（可落盘）**：
- 导出起始目录（「上次用过的目录」，ADR-0004）/ 默认导出格式
- 引擎默认参数：`memory_limit` / `threads` / 行数上限（ADR-0005）/ 语句超时
- 隐私默认：样本默认行数、按列脱敏的**默认**开关（ADR-0011）
- 接入配置：`baseURL` / endpoint（ADR-0019，**不含 key**）
- UI 偏好：窗口几何、最近文件列表（路径指针）、主题
- 可调默认：重试预算 / N=20 / M=100（ADR-0013/0023/0028）

**app-config OUT（绝不落盘进 app-config）**：
- **密钥**（BYOK API key / provider 凭证）——只进 OS keychain、解密后仅存 Rust 核心（ADR-0029/0036）
- **用户数据值**——样本行 / 结果行 / prompt / SQL / 对话内容（只能进 `.duck` 或不落盘，ADR-0029 不变量 2）
- 数据集内容 / 源数据本身（用户磁盘，ADR-0034）

**劈线原则**：app-config 只存「无数据的状态」（路径指针、数值默认、布尔开关、几何）；「上次导出目录」是路径指针、非用户数据内容，可接受。

## Context

ADR-0029 不变量 2 = 「默认零**用户数据**持久落盘」、ADR-0034 精确化为「唯一持久 at-rest = 用户拥有的 `.duck`」。但 app 级偏好（导出起始目录 ADR-0004、`memory_limit`/行数上限 ADR-0005、样本默认 ADR-0011、窗口几何、`baseURL` ADR-0019）既非用户数据、也非 `.duck`，却必须落盘。ADR-0015 自陈「导出路径策略另定」。读 0029「零 at-rest」会误以为连窗口大小都不能存——需给 app-config 一个名分与边界，防两个方向的误读。

## Why

1. **劈清两类 at-rest 防误读**：0029 钉的是「用户数据」非「所有状态」；不显式劈线，则未来工程师要么「无害地」把用户数据塞进 app-config（破 0029），要么误读 0029 拒绝持久化任何偏好（体验退化）。
2. **与 ADR-0036 对称、可查**：0036 给了 `.duck` 的内容边界（IN/OUT + secrets-never）；app-config 是其孪生——同样 IN/OUT 边界形式、secrets-never 同源（0029 key-in-Rust 的延伸），让「什么落哪儿」一张表查清。
3. **路径指针 ≠ 用户数据**：「上次导出目录」是指向用户文件系统的状态指针，不含数据集内容；允许它落盘不违背 0029 不变量 2（钉的是数据内容）。

## Considered options

- **把 app 偏好塞进 `.duck`**：违背 `.duck` = 单个分析单元的语义；偏好跨会话共享、不属于某个分析；且 `.duck` 可分享，窗口几何/`baseURL` 不该随分析文档走。**否决**。
- **严格「零 at-rest」连偏好都不存**：误读 0029；窗口几何/最近文件/默认参数全丢 = 每次启动回出厂态，体验退化。**否决**。
- **app-config 允许存用户数据值（便利）**：直接破 0029 不变量 2 + 0034「数据只在 `.duck` 或用户磁盘」边界。**否决**。
- **app-config 存 key（便利/可移植配置）**：与 0036 secrets-never 同源否决——keychain 外任何明文/可读存储都是泄露面。**否决**。

## Consequences

- **校准 ADR-0029（不变量 2）**：at-rest 劈为**两类**——用户拥有的 `.duck`（0034/0036）+ app 级配置（本 ADR）。「零用户数据持久落盘」精确化为「用户数据**值**只能进 `.duck` 或不落盘」，**不**禁止 app-config 存偏好/路径指针/默认参数；key 隔离（不变量 3）延伸至 app-config（key 绝不进 config）。0029 Consequences 已追加校准指针。
- **收口 ADR-0015「导出路径策略另定」**：导出起始目录 = app-config 项（「上次用过的目录」），属本 ADR IN。0015 Consequences 已追加指针。
- **收口 ADR-0004/0005/0011/0019 的「可调默认」归宿**：这些可调参数的默认值与上次值住 app-config；会话内临时覆盖不落盘（除非另存）。
- 实现侧：app-config 读写（OS app-data 目录）、schema 只含 IN 项、迁移随 app 版本（与 `.duck` 的 `format_version` 不同域——app-config 是 app 级、随 app 升级自行迁移，不需跨用户移植）。
- app-config 不可移植（机/用户级偏好），与 `.duck` 的可移植性正交——分享分析给同事只给 `.duck`，不带偏好。
