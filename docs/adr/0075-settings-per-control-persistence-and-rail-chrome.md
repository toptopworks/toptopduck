# 设置页:逐控件持久化模型与 rail 外壳(取代 0065 的设置 header 与进出外壳)

## Decision

设置页（ADR-0065 的应用内覆盖视图）的**持久化模型**与**外壳**重定如下；ADR-0065 的覆盖视图形态、分区列表（General / Profiles / Engine / Privacy）、焦点与 ESC 习惯**保留**。

1. **治理原则——逐控件持久化**：每个设置控件按其生效语义选择提交方式。(a) **即时生效的离散控件**（主题 / 语言 / 开关）= 改即提交，乐观应用，IPC 失败以一次补偿写回退并显示行内错。(b) **即时生效的自由文本**（接入档案的 `display_name` / `protocol` / `base_url` / `model`；`live_config` 每轮读盘即生效）= **失焦提交**（commit-on-blur：写前校验、失败回退 + 行内错、关闭前 flush 当前聚焦字段），编辑态**不设保存按钮**。(c) **需重启或显式 apply 的字段**（引擎默认值；当前仅持久化、作用到 live 引擎属后续切片）= **逐字段显式保存**（行右「保存」+ 输入在下）。(d) **耦合字段**（endpoint 的 `protocol` / `base_url` / `model` 与 preset）= 单一提交单元；逐字段保存会落出无效中间端点，故同属一个失焦提交单元。判据：**显式保存不校验正确性，故不是「无效值生效」的闸门**——它仅能阻止 on-change 边输入边提交，而本决策不采用 on-change。
2. **save-unit = 耦合边界**：相互独立的字段各成一个提交单元（引擎四项 = 四个保存行）；耦合字段合成一个单元（配置档 endpoint = 一个失焦提交单元）。
3. **结构性操作**：新建 = 左侧「+」进入新增态（内存 id、不落盘；key 经 ADR-0064 孤儿槽可先设），底部按钮 = 创建并落盘，提交前不入列表；删除 = 确认即落盘，末位档案禁删，删到当前编辑 / 新增项时表单复位；设活跃 = 即时提交（镜像顶栏 quick-switcher，并 `refreshKeyStatus`）。所有 read-modify-write 取最新 app-config，避免陈旧闭包互相覆盖。
4. **关闭 / ESC 契约**（保留 ADR-0065 的焦点与 ESC 习惯，移除全局 footer 与 Cancel）：单一 `requestClose` = 先 flush 聚焦且未失焦的字段；若新增态有未提交内容则确认「放弃新建」，否则关闭；在途 IPC（失焦提交 / 创建 / key set·clear / 连接测试）期间禁止关闭；退出时焦点还原至触发元素；确认弹窗打开时窗口级 ESC 让位给 AlertDialog。编辑态干净且无在途 IPC = flush 后关闭。
5. **全局 draft 退役**：实现期原有的「SettingsView 持有跨控件本地 draft + 单一 footer 原子保存」**废除**；不再存在跨控件的未提交 draft，未提交编辑仅存于「新增态表单」与「当前聚焦、尚未失焦的字段」两处。
6. **外壳**：删除设置自带 header——「返回工作区」迁至 rail 顶部，原 header 标题升为各面板 hero 标题；nav 项加图标、选中态改浅 tint；rail 底部 = 连接状态行（活跃档案名 + keyStatus：已连接 / 无 key / 密钥库不可用；整行点击跳 Profiles）+ **齿轮双态开关**（工作区 = 打开设置、设置 = 返回工作区，带 tooltip）；内容顶部 = hero 标题 + 一句描述 + 右上刷新（Profiles 重拉 key overlay）。**跨视图将齿轮 / 连接行统一下移到 sidebar 左下超出本决策边界**，不在本切片实现。

## Context

实现期 SettingsView 持有本地 draft（theme / locale / engine / provider 的本地副本），由单一 footer「保存」经 `commitAppConfig`（ADR-0068 的乐观单次写）原子落盘；theme / locale 因 `useTheme` / `IntlProvider` 直读 app-config 而已具即时观感，但其持久化仍留待 footer 保存；配置档记录编辑、引擎编辑、CRUD 全部留待 draft，取消即丢弃。参考的桌面 AI 设置面板普遍呈现另一形态：离散控件无保存、自由文本行带保存或无按钮即时存、无全局 footer。需在「不引入不完整却已生效的配置」「不 reintroduce 全局 draft / Cancel」两条约束下重定存盘模型；并将设置外壳对齐参考（图标侧栏、hero 标题、连接状态行、齿轮双态开关）。

## Why

1. **无全局 footer 与即时观感自洽**：theme / locale 已即时观感，留待 footer 保存会使观感与持久化分裂；逐控件持久化令「所见即所存」统一，并免除全局 Cancel / discard 心智。
2. **即时生效文本用失焦提交，而非 on-change 或显式保存**：on-change 会把未完成输入写入生效配置（下一次提问即命中无效端点）；显式保存不校验正确性，无法阻止「保存了无效值」，只是把同一风险换成显式动作，且会 reintroduce 编辑态脏态与关闭确认；失焦提交保证落盘的是完整值，配合校验 + 失败回退 + flush-on-close，既无未完成输入生效、又无全局 draft。
3. **需重启字段保留显式保存**：引擎默认值当前不作用 live（后续切片），属「持久化、下次或重启生效」类，与参考中带保存的「需重启」设置同类，显式保存契合其语义。
4. **耦合字段合为单一提交单元**：endpoint 三字段与 preset 互相覆写，逐字段保存会落出无效中间端点（部分更新的端点生效），合成单一提交单元消除此风险。
5. **结构性操作即时化**：设活跃影响下一次提问，与顶栏 quick-switcher 同为 live 切换，即时提交保持一致；新建用内存 id + 底部创建，既避免空档案孤儿，又保留「建档案前可设 key」（ADR-0064 孤儿槽认可）；删除确认即落盘 + 末位禁删，避免写出空 profiles 致 live 无活跃端点。
6. **外壳对齐参考且不引入新功能**：图标侧栏 / hero / 连接状态行 / 齿轮双态属参考的 chrome；连接状态行绑定真实状态（keyStatus + 活跃档案名；设置态下顶栏隐藏，此处为其唯一可见位置），并非账号功能；齿轮即工作区设置开关的两态，复用既有 open / close，不新增能力。

## Considered options

- **保留全局 footer 原子保存 + 本地 draft（实现期现状）**：与即时观感分裂、reintroduce 全局 Cancel / discard 心智，且与参考形态不符。**否决**——逐控件持久化 + 无 footer。
- **所有自由文本 on-change 自动提交**：未完成输入写入生效配置，下一次提问命中无效端点。**否决**——失焦提交（落完整值）。
- **所有自由文本显式保存（含配置档 endpoint）**：保存不校验正确性，无法阻止无效值生效，仅把风险换成显式动作并 reintroduce 编辑态脏态 / 关闭确认；与参考编辑态无按钮不符。**否决**——即时生效文本走失焦提交，仅「需重启」字段（引擎）显式保存。
- **配置档 endpoint 逐字段保存**：耦合字段逐字段落盘写出无效中间端点。**否决**——合成单一失焦提交单元（save-unit = 耦合边界）。
- **关闭时自动创建未提交的新增态档案**：产生用户未打算保留的档案。**否决**——新增态关闭走「放弃新建」确认。
- **关闭时静默丢弃新增态内容**：所填内容被丢弃且无提示。**否决**——确认丢弃。
- **失焦 / 即时提交失败仅报错、不回退（乐观保留无效值于 UI）**：UI 与磁盘分歧、重启回弹，对即时生效字段不可接受。**否决**——补偿写回退 + 行内错（即时与失焦提交同此；显式保存因文本未乐观应用，仅报错、无需回退）。
- **跨视图将齿轮 / 连接行统一下移到 sidebar 左下（含工作区外壳）**：超出「设置页」范围，blast radius 大（动 SessionSidebar + topbar / HeaderActions）。**否决（本切片）**——设置侧先落，统一作为边界外后续工作。
- **设置底行做成账号行 / 假头像**：无账号体系，构成误导。**否决**——连接状态行（绑定 keyStatus + 活跃档案名）。

## Consequences

- **取代 ADR-0065 的设置 header 与进出外壳**：设置自带 header 退役（返回迁 rail 顶、标题升 hero）；退出 / 入口外壳重排为 rail 底连接状态行 + 齿轮双态开关 + rail 顶返回。ADR-0065 的覆盖视图形态、分区列表、焦点 / ESC 习惯**保留**；0065 顶部加「被 0075 部分取代」标记。
- **澄清 ADR-0068（设置侧调用，契约不变）**：`commitAppConfig` 的乐观-不回滚契约不变；本 ADR 定义设置侧各调用的 surfacing——即时 / 失焦提交失败 = 补偿写回退 + 行内错（落在 0068「调用方自装 surfacing」的口子内，与 collapse 的 log、switch 的 shell-error 同类，设置侧选 revert + error）；显式保存失败 = 仅行内错。
- **全局 draft 退役**：SettingsView 不再持有跨控件 draft；未提交编辑仅存于新增态表单与当前聚焦字段；footer / Cancel 删除。
- **关联 ADR-0038 / 0064 / 0029**：app-config 存储形状不变（0038）；key 仍独立即时 keychain 传输、绝不进 app-config（0029），故配置档表单的 API Key 行保留自有 Set / Clear、不参与失焦 / 底部提交；新建的内存 id 孤儿 key 槽沿用 0064 认可。
- **新增 UI 原语**：shadcn Select copy-in + 新增依赖 `@radix-ui/react-select`（栈内增量，ADR-0049）；卡片 / 行式布局复用既有 token（`bg-card` / `border` / `divide`，ADR-0050 / 0067）。具体组件与 className 属实现，不单独立 ADR。
- **i18n**：新增 / 修订 `settings.*` keys（面板描述、保存文案、连接状态行、修订后的删除确认、新增态放弃确认）走 ADR-0052，手工双语、defaultMessage 英文、调用点字面量、不跑 extract。
- **跨视图外壳统一（边界外，已实现）**：原 deferred consequence「工作区齿轮 + 连接行下移到 sidebar 左下、两视图同位」已实现，但形态演变——连接行本身已退役（见下条），两视图底部统一为相同样式的独立齿轮按钮（左对齐、`bg-muted` + `p-2` 容器），非共享组件。
- **不做（边界）**：不引入 per-profile enabled 开关（参考的「已启用 / 禁用」无对应模型）；不引入 per-profile 模型列表（参考的「模型列表 / 添加模型」无对应模型；model 仍单字符串 + `test_profile` 临时下拉，0038）；左列表状态点映射现有 active + has_key。
- **CONTEXT.md 不动**：逐控件持久化、save-unit、失焦提交、连接状态行、齿轮双态均为前端交互 / 外壳决策，不引入领域术语（接入档案 / 协议 / keyStatus 等已定义）；治理原则是产品交互原则，非领域概念。
- **连接状态行 + keyStatus 绑定退役**：Decision 6 的连接状态行（绑定 keyStatus + 活跃档案名）+ 齿轮双态已移除；两个视图（sidebar + settings rail）底部各自渲染独立的齿轮按钮（样式统一，非共享组件）。key 状态感知改由 ComposerProviderPicker 的 per-profile overlay 承担；`ConnectionStatus` 共享组件已删除。App 级 `keyStatus` state + `refreshKeyStatus` 回调链同步移除（见 ADR-0068 Consequences）。
