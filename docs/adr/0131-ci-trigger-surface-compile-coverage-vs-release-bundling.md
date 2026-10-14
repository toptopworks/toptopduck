# CI 触发面：PR 编译覆盖与发版期打包

## Decision

1. **PR 触发的 CI 不制作 bundle。** 三平台完整 `tauri build` 与 bundle artifact 上传仅由 push main 触发，发版取产物链路不变；PR 面收窄为纯质量门，push develop 面不变。
2. **多 OS 编译覆盖由 rust 质量门 matrix 承担。** `rust` job 为三平台 matrix（ubuntu / windows / macos）：clippy 三平台执行，check 档 `--all-targets` 编译连同各平台依赖图与平台条件分支即编译覆盖；fmt 与 test 仍仅 ubuntu 执行。
3. **质量门三触发源同面。** PR、push develop、push main 执行同一 rust matrix，不做按改动路径的条件启停。

## Context

三平台完整打包腿引入之初，打包链从未在开发机之外构建过，三平台 build 腿同时充当打包验证与多 OS 编译覆盖，属阶段性设计。打包链已由三平台全绿 run 完成验证。同类跨平台桌面项目调研（三样本）的普适形态：PR 面均不打包，bundle 收敛到 tag / 发版触发；PR 面多 OS 编译形态分布于单平台质量门加定向平台 check、三平台编译冒烟、三平台全量质量门三种；路径条件启停仅见于有外部贡献者流量的样本；无样本以 release 档做 PR 编译冒烟。温态实测三平台 build 腿与 ubuntu 质量门腿并行，PR 总墙钟仅增约 100-300 秒；完整打包成本主要落在冷缓存 run（约 20-33 分钟）。收窄的实际收益是形态对齐、冷态减免与 artifact 搅动，而非温态时长。

## Why

1. **clippy 即编译覆盖。** check 档 `--all-targets` 编译覆盖全部目标、各平台依赖图与平台条件分支；「平台能否编过」不依赖编译档位，release 档无增量。
2. **release 档编译不因收窄丢失。** push main 的 bundle 腿仍执行完整 release 编译，发版链路不变。
3. **fmt / test 不上三平台。** fmt 结果平台无关；测试套件自引入起仅在 Linux CI 运行，三平台执行无平台差异证据支撑。
4. **路径条件启停不设。** 单人低 PR 流量不值一个前置 changes job，且条件面有漏跑风险。

## Considered options

- **release 档编译冒烟（`tauri build --no-bundle`）**：对平台编译覆盖零增益，温态几乎不省时。**否决**。
- **三平台全量质量门（fmt+clippy+test matrix）**：win 侧测试增量被本地开发循环覆盖，macOS 运行器资源面未经测试套件验证，升级证据不足。**否决**。
- **按改动路径条件启停**：复杂度与收益不成比例。**否决**。
- **PR 面放弃多 OS 编译**：依赖高频发版兜底平台断点，本仓发版稀疏，断点会积压到发版日。**否决**。

## Consequences

- PR 反馈面不再包含打包结果；打包类改动（如 externalBin 装配）的 mac / linux 问题后置到 push main 暴露，在发版 draft 流程内修一版再 push 即可。
- 三平台测试化不在本决策内，待首个平台特有缺陷或用户报告出现再议。
- windows / macos clippy 腿首跑各付一次冷缓存编译，显著长于温态；此后随 rust-cache 温态。
- 发版面 build 腿不再被 PR run 保温：两次发版间隔通常超出缓存保留期，push main 的三平台打包为冷缓存；clippy 腿的 check 档缓存不覆盖 release 档产物。
