# Excel loading: best-effort rectify, guided fallback, .xlsx-only, cached formula values

## Decision

一个 Excel **sheet** 经工具侧**尽力规整后**映射为一个 Dataset：自动探测表头行、解合并单元格（向下填充）、公式取**缓存值**（不重算）。规整失败的 sheet **不静默出脏表**——附警告 + "指定表头行/跳过行"的**用户引导加载**。仅支持 `.xlsx`；`.xls` 在 v1 明确拒绝 + 提示"另存为 .xlsx"。读写均经**离线打包的 excel 扩展**（ADR-0014）工具侧执行，LLM SQL 不碰 `read_xlsx`（ADR-0005）。

## Context

Excel 是 #1 格式（CONTEXT/ADR-0001），但真实 sheet 多为多行表头/合并单元格/公式/杂乱结构；`read_xlsx` 直读产脏表。CONTEXT 原"一个 sheet = 一个 Dataset"假设整洁矩形表，需落地为能处理杂乱 sheet 的真实加载模型。

## Why

1. **尽力规整覆盖大多数真实 sheet**，happy path 仍自动化；不让脏表进工作集是信任底线（呼应 ADR-0004）。
2. **规整不了走引导加载**而非静默垃圾——用户得可修正的明确反馈，而非错误答案。
3. **`.xls` 拒绝**：excel 扩展不支持 `.xls`；v1 不捆绑转换器（YAGNI），明确提示即可。
4. **公式只读缓存值、不重算**：自建重算引擎代价巨大且越界；列为已知限制。

## Considered options

- **直读不规整**：脏表进工作集，信任崩。**否决**。
- **严格只接整洁表、杂乱即拒**：UX 差，用户被卡。**否决**。
- **工具侧转换 `.xls→.xlsx`**：加依赖，v1 过度。**否决（v1）**。
- **公式实时重算**：越界且代价巨大。**否决**。

## Consequences

- CONTEXT 的"一个 Excel sheet 映射为一个 Dataset"锐化：杂乱结构需先规整；无法规整需引导加载。
- 公式列读缓存值——用户改原文件公式后须**重传**才反映（与 ADR-0012 会话快照一致）。
- 引导加载（表头行/跳过行）是上传流的必要交互。
- `.xls` 用户须自行另存 `.xlsx`。
- 导出侧同理可用 excel 扩展写 `.xlsx`（部分关闭 ADR-0004 的"导出格式"开放项；导出起始目录 = app-config 的"上次用过的目录"，见 ADR-0038）。
- **被 ADR-0042 延伸**：本 ADR 引导加载（表头行/跳过行）的**用户交互产物 = 进 recipe 的规整参数**（resume 重放重建快照）；resume 后规整参数**可见只读**，修正 = 重新上传（= 换源，ADR-0025）。见 ADR-0042。
