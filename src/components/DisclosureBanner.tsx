// Privacy disclosure (ADR-0011/0029, issue #29): honest about the payload that
// leaves the machine when asking, and about where the API key lives. The LLM is
// now wired -- asking sends the pruned schema + samples to the configured
// endpoint; loading still sends nothing.
export function DisclosureBanner() {
  return (
    <aside className="disclosure" role="note">
      <strong>隐私披露：</strong>
      完整数据集永不离开本机。<strong>提问时</strong>，默认待发载荷 = schema（列名 + DuckDB
      类型）+ 加载时冻结的首 3 行样本（见下方预览），发往你在「设置」中配置的 LLM endpoint
      （默认 Anthropic 直连，可改为自有的 Anthropic 协议兼容网关；若用自有网关，载荷会经过它，其
      留存/训练政策由你自负）。<strong>加载</strong>数据本身不发送任何内容。你可在每个数据集的「隐私控制」中
      <strong>按数据集关闭样本发送</strong>（该数据集的任何取值都不发出），或<strong>按列标记「仅类型」</strong>
      （该列的值与列名都不发出，仅类型发出），由你完全掌控。
      <br />
      <strong>API key 隔离：</strong>
      你的 Anthropic API key 仅存于本机系统钥匙串，由应用 Rust 核心读取并发起对 endpoint 的调用；
      前端与页面永不持有 key，也无任意网络出口。除你自己配置的 LLM endpoint 外，应用不向任何服务器发送数据。
      <br />
      <strong>加载语义：</strong>
      每个数据集都是加载时刻的只读快照（ADR-0012）。Excel 工作簿按 sheet 分别加载为独立
      数据集；隐藏的工作表会被跳过；公式单元格取加载时的缓存值（不重算），此后改动原文件需重新加载才反映。
      Excel sheet 会尽力自动规整——跳过前导标题行、解合并单元格（向下填充）——产出单行表头的规整表；
      自动规整无法确定表头时，会请你指定表头行与要跳过的行（选择被记录为该数据集的规整参数）。不支持
      .xls，请另存为 .xlsx 后加载。
    </aside>
  );
}
