# toptopduck

AI 数据处理与分析工具。用户上传多格式数据集（Excel/CSV/JSON/Parquet），通过自然语言查询与处理，解决日常数据分析问题。本地优先的桌面应用，仅 LLM 推理联网。

## Language

**数据集 (Dataset)**:
会话内一个可被查询的逻辑表，是 LLM 生成 SQL 时的最小引用单元。一个 CSV/Parquet/JSON 文件映射为一个 Dataset；一个 Excel sheet 映射为一个 Dataset。
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
一次会话内当前可被 SQL 引用的全部 Dataset 集合——包括上传的源 Dataset，以及会话过程中产生的中间结果。
_Avoid_: 数据库(database)、状态(state)
