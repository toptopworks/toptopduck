# 步数上限契约：触顶自动续窗、限续三窗、原生续跑通道

## Decision

1. **触顶不结算，自动续窗。** 单轮次步数触顶（内置 `MaxTurnsError`、外部 `MaxTurnRequests` / `error_max_turns` / codex 计数）不再直接落 `StepCap` → `Failed(Execute)`：续窗计数 < 3 时注入一条收敛提示（user-role、在飞对话专用——不进 trace、不落 `.duck`、不进次轮次窗口装配）后重开一窗。无挂起态、无新 IPC、无新前端面；trace 轮次跨窗连续编号，最终一次结算；取消 token、看门狗时钟、审批门、委派规格全程延续。

2. **硬顶 = 每轮次最多自动续 3 窗。** 第 4 次触顶照旧 `Termination::StepCap` → `Failed(Execute)`，落账文案渲染全局值（内置 96 = 24×4 派生值，非独立常数）。契约计量词汇统一为续窗次数——各族窗大小不可通约（内置自数 24；codex 可设 `model_max_turns`；ACP 族为 agent 自报内部预算；claude 不可设），步数不进契约文本。

3. **内置循环以错误携带历史重开。** rig 的 `MaxTurnsError` 自带 `chat_history` 与未派发 `prompt`，续窗请求以该历史 + 收敛提示重发——完整在飞对话零重建成本；EventFold 继续累积。

4. **外部三族各走原生会话续跑通道。** ACP proper（gemini/qwen/opencode）向同一 `session_id` 追发 `session/prompt`（agent 自持完整状态）；claude-code 输入面换 `--input-format stream-json`（与 probe control plane 同机制），`error_max_turns` result frame 后同进程续写 user frame；codex 窗边界改 `-c model_max_turns` 注入使 CLI 自停（替代 app 侧计数即杀），续跑 `codex exec resume <session_id>`（session id 自事件流捕获）。rounds 跨请求合并、轮次连续、单次结算。

5. **claude 族无窗为诚实降级。** claude 当前版本无 max-turns 设置面；CLI 内部预算不触发 `error_max_turns` 则该族无窗无顶（与既有形态一致的无界运行），兜底为无进展看门狗 + 同参重复检测，续跑通道为其自报预算预留。

6. **子代理预算不动。** `SUBAGENT_STEP_CAP` 不随主循环续窗延长，维持委派面的独立预算契约。

## Context

`DEFAULT_STEP_CAP = 24`（ADR-0081 谱系）定位为「非收敛轨迹的最后一道安全网，非目标」：内置 rig 循环与外部 engine 共用，触顶统一收敛 `Termination::StepCap` → `TurnOutcome::Failed(Execute)`，轮次失败落账、无继续入口。复杂分析合法超 24 步；失败后新开轮次的窗口由持久化 trace 重装，而成功调用的结果载荷不入档（ADR-0036），「继续」实为降级续聊——完整在飞对话只存活于轮次内存态。外部三族形态：claude/codex 无状态逐轮 spawn（进程随轮死）；gemini/qwen/opencode 的 ACP session 存活于轮次内；codex 的 24 是 app 侧 `tool_call_count` 计数后杀进程，非 CLI 预算。

## Why

1. **触顶是合法场景而非异常。** 步数上限的目标是非收敛兜底，不是工作量的合规边界；数据分析的合法长轨迹与发散轨迹在同一条计数轴上不可区分，判别力来自「有无进展」与「是否重复」，不来自步数本身。

2. **兜底三层已足，安全网职责上移至续窗上限。** 无进展看门狗（ADR-0115）杀静默、同参重复检测（steer → abort）杀循环、续 3 窗上限杀慢速发散——步数从「首要安全网」降为「发散成本的粗上界」，24×4 保留该上界即可。

3. **同轮次续跑保真度不可替代。** 新轮次续聊丢在飞工具结果载荷（ADR-0036）；各族原生续跑通道（rig 错误携带历史 / ACP 同 session / stream-json 同进程 / exec resume）零重建成本拿到完整对话，任何重放重建方案都是更差的近似。

## Considered options

- **手动确认续（挂起态 + UI 卡片）**：需造 paused-turn 生命周期（新 IPC、前端卡片、会话关闭即失忆边界），且触顶是常态场景、确认即交互成本。**否决**。
- **只调高 `DEFAULT_STEP_CAP`**：推迟触顶而非消除，仍无继续入口；窗级收敛提示的逐窗推收敛增益一并丢失。**否决**。
- **硬顶计步数（全局 96）跨族统一**：各族窗大小不可通约（agent 自报 / 不可设），步数硬顶对外部族不可实施；续窗次数四族皆可计量。**否决**。
- **外部统一 respawn + transcript 重放**：为统一引入 transcript 重放序列化面，「续跑」实为扁平引用近似，保真度与成本皆劣于各族现成原生通道。**否决**。
- **窗边界可见（trace 窗标记）**：窗是成本治理机制非对话内容，标记需在 trace 数据结构开纯显示类型；step 编号已传达轮次重度。**否决**。
- **硬顶用户可配**：无设置面诉求，配置面先于需求。**否决**。
- **claude 伪造窗（app 计数强杀再 respawn）**：为不存在的边界事件引入杀进程机制，违背原生续跑原则。**否决**。

## Consequences

- 触顶轮次继续而非失败：trace 连续、单次结算、收敛提示零持久化痕迹；用户感知仅为该轮跑得久、轮数多。
- 内置落账文案渲染全局值而非单窗值；防失控分层定格为续 3 窗（慢速发散）+ 看门狗（静默）+ 同参重复检测（循环）三层，子代理预算独立不变。
- claude 输入面换轨波及每次 claude 轮次（不只触顶路径），argv 拼写沿 live E2E 钉死惯例；codex session id 捕获与 result 后续写行为以真机实测钉死。
- 实施期真机钉死（claude 2.1.259 / codex 0.154.0）：claude 的 `user` 帧提示与 result 帧后同进程续写（第二条 `user` 帧得到第二个 result 帧验证），probe 与轮次驱动共享同一输入面（`--input-format stream-json` 折入轮次 argv）；codex 的会话句柄即 `thread.started` 的 `thread_id`（`exec resume` 直收），rollout 落 `CODEX_HOME/sessions`，故 codex argv 退役 `--ephemeral`（ephemeral 禁写 rollout 会杀死续跑通道，session 文件落盘成为该通道的记录在案代价）。
- 外部三族的 app 侧计数即杀全面退役：窗边界是各族原生自报（ACP `MaxTurnRequests` / claude `error_max_turns` / codex `model_max_turns` 自停），codex 的耗尽事件措辞（`turn.failed` 的 turn-limit 判别子串）尚未实测钉死，留待真机补钉。
- 取消、看门狗、审批门在续窗路径的既有语义不变，测试面随续窗用例扩展。
- **部分取代 ADR-0081**：执行级兜底的步数触顶语义从「触顶即 failed」重写为「触顶自动续窗 + 限续 3 窗，第 4 次触顶仍 failed」；单窗 24 作为窗粒度预算保留，看门狗与整轮取消保留。
