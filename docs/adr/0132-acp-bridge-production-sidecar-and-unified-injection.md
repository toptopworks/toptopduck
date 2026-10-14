# ACP 桥接生产打包：externalBin sidecar 与统一注入路径

## Decision

1. **bridge 以 externalBin sidecar 进三平台 bundle。** bundle 配置的 `externalBin` 指向 staging 目录内按 host target-triple 命名的 bridge 产物；打包器安装时去 triple 后缀、将 sidecar 置于主可执行文件旁。
2. **staging 由同一脚本承担、按入口分档。** 脚本按 host triple 复制 bridge 产物到 `externalBin` 期望名；`beforeBuildCommand` 在 release 构建（包选择 `-p acp-bridge`）后复制真产物，本地与 CI 的 `tauri build` 同径，打包 workflow 不设专步骤。tauri-build 的 build script 在任何 cargo 编译期校验 `externalBin` 产物存在性，故 `beforeDevCommand` 与 cargo 质量门入口（CI rust job、本地 `rust:*` 脚本）以 `--debug` 档前置同一脚本——该处仅存在性有意义，产物内容只在打包期消费且彼时已被 release staging 覆写。
3. **注入路径 dev / 安装态统一。** 去掉 `#[cfg(debug_assertions)]` 门控，两侧共用「解析 `current_exe()` 旁 sibling」的单一代码路径；「显式 env 非空优先、显式空值视为未设」的既有规则不变；sibling 缺失时轮次仍走既有 missing-var 诚实失败。

## Context

ADR-0085 将桥接 bin 的生产分发显式留作打包期决策——其 Considered options 对 externalBin 的否决理由即"分发形态属打包阶段"，Consequences 未决项点名「桥接 bin 生产 sidecar bundle」。落地前三缺口叠加：注入仅 debug 门控、bundle 无 `externalBin`、打包链不构建 bridge——装包后外部 runtime turn 全部 missing-var 诚实失败（内置 runtime 不受影响）。三平台打包链（push main 触发的 build workflow 与 bundle artifact 上传）与 bridge 独立 workspace member（`crates/acp-bridge`）均已就绪，生产打包只差 staging 与注入统一两步。

## Why

1. **单一 staging 路径。** beforeBuildCommand 同服务本地与 CI；若 CI 专设步骤而本地不设，本地 `tauri build` 会因 externalBin 缺产物直接失败——同一件事两套触发，违 DRY。
2. **sibling 解析在安装态天然成立。** externalBin 安装时去 triple 后缀、落主可执行文件旁，与 dev 的 target/debug sibling 完全同构——统一后零平台分支、零新增解析逻辑。
3. **诚实失败保持。** sidecar 缺失（损坏安装、产物被删）时轮次仍走 missing-var + 补救指引的 fail-closed 路径，打包态不放松配置错误暴露。

## Considered options

- **打包 workflow 专设 staging 步骤**：与 beforeBuildCommand 双轨，本地 `tauri build` 仍因 externalBin 缺产物失败。**否决**。
- **保留 debug 门控、安装态另写注入分支**：两份同语义的 sibling 解析逻辑，违 DRY；安装态与 dev 的 sibling 同构，无分支必要。**否决**。
- **bridge 静态链入主 exe（子命令形态）**：主 exe 是 Tauri GUI 二进制，外部 CLI per-turn spawn 它的启动开销不可接受——同 ADR-0085 对 app bin 子命令的否决理由。**否决**。

## Consequences

- ADR-0085 未决项「桥接 bin 生产 sidecar bundle（打包阶段）」收官；其「release 不解析 sibling，生产注入属打包期」的表述由本 ADR 校准为统一 sibling 解析。
- `tauri build` 新增前置：bridge 的 release cargo 构建（既有 dev 前提的 release 档，无新增工具链要求）；staging 产物目录为构建中间物，不入库。
- tauri-build 在任何 cargo 编译期校验 `externalBin` 产物存在性：staging 相应前置到 `beforeDevCommand` 与 cargo 质量门入口（CI rust job、本地 `rust:*` 脚本，`--debug` 档仅满足存在性）；fresh checkout 上绕过这些入口的裸 cargo 首跑仍会因缺产物报错，报错的路径名即补救指引。
- bin 名以字面量出现于四处：cargo `[[bin]]` 名、`BRIDGE_BIN_NAME` 常量、bundle `externalBin` 条目、staging 脚本。常量与 `externalBin` 条目由 unit test 互 pin；`[[bin]]` 名与脚本字面量无直接测试，漂移在构建期响亮失败——`[[bin]]` 改名令 staging 按旧字面量找不到构建产物（ENOENT），脚本字面量改名令 staged 名与 `externalBin` 期望名不匹配（tauri-build 存在性校验）；sibling 缺失的诚实降级仅覆盖从未构建 sibling 的裸 `cargo run`。
- 「装包后外部 runtime turn 经 bridge 回连 gateway」属安装级验证，由发版流程的 bundle artifact 核验；实现侧以 staging 产物名与配置 pin 测试兜底。
