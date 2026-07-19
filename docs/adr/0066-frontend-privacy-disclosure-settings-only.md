# Frontend privacy disclosure: single surface in SettingsView

## Decision

全局隐私披露（`DisclosureBanner` 组件承载的三段：外发 payload / API key 隔离 / loading 语义）仅在设置覆盖视图的 Privacy 栏（`SettingsView` → `PrivacySection`）呈现。冷启动 hero（`ColdStartHero`）与会话侧边栏（`SessionSidebar`）不再挂载该组件。每数据集的 `PrivacyControls`（"当前外发 payload" 动态摘要 + 按列/按样本控制）不在本决策范围——它随数据集详情出现，承载操作上下文里的即时披露，与全局声明语义独立。

## Context

在引入设置覆盖视图（ADR-0065）之前，`DisclosureBanner` 已挂在冷启动 hero 与会话侧边栏两处（折叠 `<details>`），作为"顺手可见"的全局披露入口。ADR-0065 把 Privacy 栏确立为设置视图的固定分类，承载同一份 ADR-0011/0029 披露文案。于是同一份长文披露出现在三处：hero、sidebar、Settings Privacy 栏。冷启动时（无 session），hero 与 sidebar 同时可见，两份折叠的同一份长文并列出现，构成视觉重复；三份文本经组件复用（DRY 已满足），但 UI 入口的冗余未消除。

## Why

1. **Settings 是主动查找的预期入口**：用户来找隐私声明时，标准路径是"设置 → 隐私"（ADR-0065 已固化此心智）。hero 与 sidebar 是"顺便瞄一眼"的被动入口，折叠态下信息密度低、实际触达率有限。
2. **消除视觉重复**：冷启动 hero 与 sidebar 同屏两份折叠披露是唯一真正的视觉冗余；收口到单一入口后，hero 回归纯 CTA 语义（"开始一次分析"），sidebar 回归纯会话导航语义。
3. **保留操作上下文里的即时披露**：`PrivacyControls` 随数据集详情出现，告诉用户"这个数据集当前实际会发什么"——这是与控件绑定的动态摘要，不是全局声明的重复。本决策不动它，操作点位的披露可达性不降级。
4. **降低维护面**：披露文案的修改（如 endpoint 策略变化）只需关心一处入口的呈现形态（Settings 展开式），不必同时校准 hero/sidebar 折叠态的视觉。

## Considered options

- **保留 hero、删 sidebar（或反之）**：不对称、无正当理由选择哪一侧；冷启动时保留侧仍与另一入口语义重叠。否决。
- **三处都保留**：视觉重复未解决，与收口目标矛盾。否决。
- **都删、只留 Settings**：本决策。Settings 作为标准查找入口足以承载；`PrivacyControls` 保留操作点位的动态披露。
- **在 hero / sidebar 新增"在哪找披露"的跳转链接**：把"折叠长文"换成"跳转链接"看似折中，但 hero / sidebar 作为导航 / CTA 区引入设置跳转语义混乱，且 Settings 入口本身已是常识（top bar 齿轮图标）。否决（YAGNI）。

## Consequences

- `DisclosureBanner` 仅由 `PrivacySection`（SettingsView Privacy 栏）挂载；`App.tsx` 的 `ColdStartHero` 与 `session/SessionSidebar.tsx` 不再 import / 渲染它。
- `DisclosureBanner` 组件本体保留（仍被 `PrivacySection` 使用）；`src/__tests__/components.test.tsx` 的组件本体测试继续有效。
- i18n catalog key `coldStart.privacy`、`sidebar.privacy` 从 `zh-CN.json` / `en-US.json` 退役（不再有调用点）；`.sidebar-disclosure` CSS 规则随最后一个使用点移除。
- 关联 ADR-0065：0065 把 Privacy 栏确立为披露承载分类，本决策进一步把 Privacy 栏确立为**唯一**承载入口；两者一致。
- 关联 ADR-0011 / ADR-0029：披露**内容**（payload 三段 + key 隔离）不变，本决策只改**呈现位置**。
- `PrivacyControls`（每数据集动态摘要，`DatasetDetail` 内）不受影响——它是与控件绑定的操作点位披露，语义独立于全局声明。
