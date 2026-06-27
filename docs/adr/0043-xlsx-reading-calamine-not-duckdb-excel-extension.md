# xlsx reading: calamine (compiled in), not the DuckDB `excel` extension

## Decision

`.xlsx` 读取用纯 Rust 的 **`calamine`**（编译进二进制）：逐 sheet 读取单元格**缓存值**（公式取缓存结果、不重算，ADR-0015），每 sheet 物化为临时 CSV，再走既有的 `read_csv_auto` copy-in 冻结为只读快照。**绕过** DuckDB 的 `excel` loadable 扩展。类型推断仍由 DuckDB 对 copy-in 的 CSV 做（ADR-0032 single source of truth 不变）。

本 ADR **锐化** ADR-0014 的"excel 扩展预打包"措辞：兑现其全部精神（离线、打包进应用、运行时不联网、版本随应用固定），改用 calamine 作为机制。

## Context

ADR-0014 原定"DuckDB `excel` 扩展预打包、启动离线加载"。但落地时发现：`duckdb-rs` 1.x 的 **vendored amalgamation 无法静态链接 `excel` 扩展**——`libduckdb-sys` 打包的 `manifest.json` 只含 `core_functions` / `json` / `parquet` 三个扩展的源码，`build_bundled_cc.rs` 的 `extension_enabled()` 也硬编码只启用这三者。`excel` 是 DuckDB 的 **loadable 扩展**（`read_xlsx`、`.xlsx` 在 `extension_entries.hpp` 映射到 `"excel"`），源码不在 amalgamation 中，运行时需下载平台特定的 `.duckdb_extension` 二进制才能 `INSTALL; LOAD`。

## Why

1. **兑现 ADR-0014 的精神**——calamine 编译进二进制 = 最彻底的"预打包进应用包"：完全离线、无运行时下载、版本随 `Cargo.lock` 固定、无平台特定二进制。
2. **保留 ADR-0032**——类型推断仍是 DuckDB 对 copy-in CSV 的 `DESCRIBE`（single source of truth），只是 bytes→表的"前一步"由 `read_xlsx` 换成 calamine→CSV。
3. **KISS / YAGNI**——预下载平台特定扩展二进制 + 运行时 `INSTALL from path` 对"基础加载"切片过重且跨平台 CI 脆弱。
4. **公式缓存值天然满足**——calamine 读单元格存储的 `<v>` 缓存值，不重算，正是 ADR-0015 要求。

## Considered options

- **预下载 `excel.duckdb_extension` 二进制 + 运行时 `INSTALL '<path>'; LOAD excel;`**：字面合规 ADR-0014，但需为每个目标平台（win/linux/mac × amd64/arm64）预取与 vendored DuckDB 精确 ABI 匹配的二进制；二进制入仓库不卫生；Tauri resource 路径解析；debug/release ABI 风险。**否决（v1 过重）**。
- **fork/patch `libduckdb-sys` 静态编译 `excel` 扩展**：脱离 registry 依赖、维护负担大、升级易碎。**否决**。
- **纯 Rust calamine → 每 sheet 临时 CSV → `read_csv_auto`**：离线、确定性、复用现有 copy-in/快照/schema 契约。**采纳**。

## Consequences

- xlsx 数据路径多一次 CSV 序列化/解析往返（calamine 写临时 CSV → DuckDB 读回）。基础加载切片可接受；超大 sheet 的吞吐优化留待将来按需评估。
- Int/Float 单元格经 CSV 文本渲染后由 DuckDB 重新推断类型（与 CSV 一致）；Excel 日期渲染为 ISO datetime（DuckDB 推断 TIMESTAMP）。
- 每个 sheet 一个 Dataset（ADR-0015 锐化落地）；空 sheet 不产 Dataset。
- ADR-0014 的"excel 扩展"措辞由此锐化为"离线打包的 xlsx 读取能力（calamine）"。
- **未来**：若 `duckdb-rs` 支持静态链接 `excel` 扩展（或上游 amalgamation 纳入其源码），可重新评估统一到 `read_xlsx`——届时本 ADR 的 CSV 中转步骤可移除，类型推断与多 sheet 契约不变。
