# Chaining: materialize every step into the working set

## Decision

每次查询的结果**自动物化**进工作集，成为带名 Dataset（默认 `result_1`、`result_2`…递增），后续 SQL 可直接 `FROM result_N` 引用。LLM 生成契约 = 完整工作集 schema（源 Dataset + 所有 `result_N`）+ 对话历史。

## Context

有状态会话要真正支持链式迭代（筛选 → 分组 → 画图），必须决定"上一步结果"在 SQL 中如何被引用。

## Why

1. `FROM result_1` 比让 LLM 每步从头重写完整多步逻辑稳健得多——后者在长链中越来越长、越来越脆。
2. 每步可检视、可重命名、可回溯，契合 notebook 心智。
3. 会话内源 Dataset 是静态的，物化中间结果无脏数据隐患。

## Considered options

- **纯重写**（每步对源 Dataset 重写完整 SQL，靠对话历史理解"那个/上一步"）：工作集恒等于源、状态极简，但多步逻辑反复重建 → 脆。**否决**。
- **仅按需物化**（用户显式"存为表"才进工作集）：用户掌控强，但默认无法顺畅链式，"那个"仍模糊。**否决**。

## Consequences

- 工作集 schema 随步数膨胀；需管理 `result_N` 的命名/生命周期（重命名、清理、上限）。
- 喂给 LLM 的 schema 须包含所有 `result_N`，需注意 token 成本——大步数时要有裁剪/摘要策略。
- 用户删除某 `result_N` 后，依赖它的后续结果须定义失效行为。
