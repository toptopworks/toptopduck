# toptopduck

本地优先的 AI 数据分析桌面工具：用户上传多格式数据集（Excel/CSV/JSON/Parquet），用自然语言做查询、清洗、聚合与描述性统计（含相关性、简单回归）。v1 能力以 SQL/DuckDB 原生为界——**预测、机器学习、语义文本分类等不在范围内**（见 ADR-0017）；越界请求会被诚实拒绝并给出 in-scope 替代。仅 LLM 推理联网。

## Language

**数据集 (Dataset)**:
会话内一个可被查询的逻辑表，是 LLM 生成 SQL 时的最小引用单元。一个 CSV/Parquet/JSON 文件映射为一个 Dataset；一个 Excel sheet 映射为一个 Dataset（杂乱结构需先规整，见 ADR-0015）。
_Avoid_: 文件(file)、表(table)、数据源(source)——这些是实现概念，非领域概念

**提问 (Question)**:
用户在一个轮次中输入的自然语言请求，是轮次的**输入**。它可能被转译为一条 SQL、产出中间结果，也可能触发越界拒绝 / 消歧澄清 / 执行失败 / 取消而**不**产出中间结果——产出与否取决于该轮的 outcome，而非提问本身。
在远期对话窗口与历史视图中，轮次以**提问原话（有界截断）**为指代句柄——非 LLM 生成的摘要（ADR-0039）；它同时是用户可见的步标签与 LLM 远期重定向的映射依据（ADR-0010）。
_Avoid_: 查询(query)——易与生成的 SQL 混淆；指令(command)、prompt

**轮次 (Turn)**:
一次完整的交互单元 = 一次提问 + 一个 outcome（产出中间结果只是其中一种）。轮次恒在对话 thread 中**可见**——无论 outcome 是否产出中间结果，条目本身始终存在；产不产中间结果只决定 outcome 类型，与计步序、是否进对话窗口是相互独立的维度。
_Avoid_: 请求(request)、消息(message)、回合

**中间结果 (Intermediate Result)**:
一次查询产生、自动物化进工作集的 Dataset。其**引用名**（`result_1`、`result_2`…按产生顺序单调递增、永不复用，ADR-0022）是 SQL、recipe 链、active 指针引用它的**稳定身份**；用户可改的是**显示名**（纯展示别名，仅显示层查重），改名不波及任何已存 SQL、不断 resume 重放链（ADR-0037）。它本身也是一种 Dataset。
_Avoid_: 临时表(temp table)、缓存(cache)、视图(view)——实现概念

**会话 (Session)**:
一个**持久化、可命名、可 resume** 的分析单元，拥有一条 recipe（见下）存在本地磁盘；重启后按 recipe 重建其工作集。打开时其工作集在内存中物化，多个打开的 Session 在内存中相互隔离（见 ADR-0027）。会话是持久化单位；临时的只是工作集，不再是“关闭即重置”。
_Avoid_: 项目(project)、对话(conversation)、工作区(workspace)

**配方 (Recipe)**:
一个 Session **当前工作集**的持久化描述（非历史账本），分两部分——**可重建部分**：当前源集（路径 + 规整参数 + 内容指纹）+ 当前仍有效的 productive SQL 链（ADR-0009；被换源级联失效的轮不在此列，ADR-0025）；**展示部分**：全量对话历史（所有轮恒可见，ADR-0028，纯追加永不裁剪）。外加 `format_version`、session 名、active dataset 指针。resume 即载入当前源集 + 重放可重放链。本身不含物化数据（遵循 ADR-0004 derive-only）。
_Avoid_: 日志(log)、账本(ledger)、脚本(script)、快照(snapshot)

**工作集 (Working Set)**:
一次会话内当前可被 SQL 引用的全部 Dataset 集合——包括上传的**一个或多个**源 Dataset，以及会话过程中产生的中间结果。
_Avoid_: 数据库(database)、状态(state)

**当前表 (Active Dataset)**:
一个提问在用户未显式指明时所作用的 Dataset——默认是上一步的中间结果，会话开始时即**最近上传的源 Dataset**；由 LLM 从对话上下文隐式解析，用户通常无需感知其存在。用户可显式点名覆盖（如"在原始数据上重新算"、"在订单表上"）。
_Avoid_: 选中项(selection)、焦点(focus)、当前行(current row)
