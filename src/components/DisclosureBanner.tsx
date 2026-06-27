// Privacy disclosure (ADR-0011/0029): honest about the default-to-send payload.
// Slice 1 is not wired to any cloud LLM, so loading sends nothing off-machine.
export function DisclosureBanner() {
  return (
    <aside className="disclosure" role="note">
      <strong>隐私披露：</strong>
      完整数据集永不离开本机。默认待发载荷 = schema（列名 + DuckDB 类型）+ 加载时冻结的
      首 3 行样本（见下方预览）。当前版本未接入云端 LLM——加载数据不会向任何服务器发送任何
      内容；接入后（提问时）才会发送上述载荷，届时可按数据集或列脱敏，由你掌控。
      <br />
      <strong>加载语义：</strong>
      每个数据集都是加载时刻的只读快照（ADR-0012）。Excel 工作簿按 sheet 分别加载为独立
      数据集；公式单元格取加载时的缓存值（不重算），此后改动原文件需重新加载才反映。
    </aside>
  );
}
