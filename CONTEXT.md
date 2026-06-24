# toptopduck

本地优先的 AI 数据分析桌面工具：用户上传多格式数据集（Excel/CSV/JSON/Parquet），用自然语言做查询、清洗、聚合与描述性统计（含相关性、简单回归）。v1 能力以 SQL/DuckDB 原生为界——**预测、机器学习、语义文本分类等不在范围内**（见 ADR-0017）；越界请求会被诚实拒绝并给出 in-scope 替代。仅 LLM 推理联网。

## Language

**数据集 (Dataset)**:
会话内一个可被查询的逻辑表，是 LLM 生成 SQL 时的最小引用单元。一个 CSV/Parquet/JSON 文件映射为一个 Dataset；一个 Excel sheet 映射为一个 Dataset（杂乱结构需先规整，见 ADR-0015）。
_Avoid_: 文件(file)、表(table)、数据源(source)——这些是实现概念，非领域概念

**提问 (Question)**:
用户在一个轮次中输入的自然语言请求。一次提问由 LLM 转译为一条 SQL，产出一个中间结果（可选附可视化）。
_Avoid_: 查询(query)——易与生成的 SQL 混淆；指令(command)、prompt

**中间结果 (Intermediate Result)**:
一次查询产生、自动物化进工作集的带名 Dataset，默认按产生顺序自动命名（`result_1`、`result_2`…），可被后续 SQL 引用、可被用户重命名。它本身也是一种 Dataset。
_Avoid_: 临时表(temp table)、缓存(cache)、视图(view)——实现概念

**会话 (Session)**:
一个有状态的临时分析工作区，承载当前工作集（源 Dataset 与对话中产生的中间结果），用户可在其中链式迭代查询。关闭即重置。
_Avoid_: 项目(project)、对话(conversation)

**工作集 (Working Set)**:
一次会话内当前可被 SQL 引用的全部 Dataset 集合——包括上传的**一个或多个**源 Dataset，以及会话过程中产生的中间结果。
_Avoid_: 数据库(database)、状态(state)

**当前表 (Active Dataset)**:
一个提问在用户未显式指明时所作用的 Dataset——默认是上一步的中间结果，会话开始时即**最近上传的源 Dataset**；由 LLM 从对话上下文隐式解析，用户通常无需感知其存在。用户可显式点名覆盖（如"在原始数据上重新算"、"在订单表上"）。
_Avoid_: 选中项(selection)、焦点(focus)、当前行(current row)
