# close 双变体：纯 close 保 fire-and-forget，delete 路径等 canonical key 释放（闭合 close/delete/in-flight single-writer 时序缝隙）

## Decision

「关闭一个正有 in-flight ask 的会话」与「删除一个正有 in-flight ask 的会话」此前共用 `close_session` 一个 IPC（ADR-0055 fire-and-forget：移除 SessionStore map entry 即返回）。但 **close IPC resolve ≠ canonical key release** —— single-writer key（ADR-0035 Decision 3）在 `Session::Drop` 释放，而 Drop 只在最后一个 `Arc<SessionHandle>` drop 时跑；in-flight ask 的 Arc clone 要等 post-check discard 才 drop。ADR-0060「删打开会话先关闭」隐含「关闭同步」假设，实际不成立。定案：

1. **close 拆双变体**：
   - **纯 close**（Shell 关闭会话）= fire-and-forget，保留 ADR-0055 零等待语义不变。
   - **等待变体**（delete 路径专用）= 移除 map entry 后**阻塞到 `Session::Drop` 真正执行（canonical key 被 release）**才 resolve。
   - **无 in-flight 时立即 resolve**：若无 ask 在飞，map.remove 后无其他 Arc clone，SessionHandle 立即 drop → `Session::Drop` → key release，等待变体无可见延迟（不误加无谓等待）。

2. **前端 deletePersisted 改调等待变体**；`delete_session` 的 `try_acquire` gate（ADR-0035）不变，上游保证 key 已 release，gate 自然成功。`closeOpen`（Shell 纯关闭）仍调纯 close。**delete 路径的 UI 条目卸载发生在等待变体 resolve 之后**（非立即卸）——delete 是用户显式删除意图，不走纯 close 的零等待 UI 契约；这让第 4 条的超时重试 UX 自洽（条目保留，原地重试）。

3. **阻塞机制**：`SessionHandle` 暴露「等 Drop」信号（oneshot sender / Notify / 等具体形态留实现期），等待变体 await 它；信号在 `Session::Drop` 触发。**单等待者假设**：delete 路径是等待变体唯一调用点，无需多等待者广播（oneshot 即可，非 Notify 广播）。

4. **等待上限对齐 ADR-0021 `REQUEST_TIMEOUT`（120s）**：超时 = delete 报错（不撞 gate 误报「请先关闭」），用户稍后重试。

5. **single-writer 单一职责不变**：canonical key 唯一释放点仍 `Session::Drop`；不引入「delete 强制 release」第二路径（守 ADR-0035 Decision 3）。

## Context

PR #92（前端 close-in-flight + delete await closeOpen）把前端 `deletePersisted` 改为 `await closeOpen(sid)` 保证 close IPC 先于 delete IPC 发出。但后端 `close_session` 从 SessionStore map 移除 handle 即返回（ADR-0055），key 在 `Session::Drop` 释放（ADR-0035 Decision 3），Drop 只在最后一个 `Arc<SessionHandle>` drop 时发生；in-flight ask 在 spawn_blocking 里持 Arc clone 直到 post-check 发现 closing 后 discard。故 close resolve 时若 ask 在飞，key 尚未 release → `delete_session` 的 `try_acquire` gate 撞 → 误报「该会话已打开，请先关闭再删除」→ 前端 UI 条目已同步卸载 + `.duck` 实未删 + refreshSessions 后条目复现 —— 三态不一致。

三道重叠决策的交集缝隙：

- **ADR-0055** 定 close 不等 ask（fire-cancel-don't-wait），但未讨论 close 与 single-writer key 释放的时序耦合。
- **ADR-0035 Decision 3** 定 key 在 `Session::Drop` 释放，未覆盖「handle 从 map 移除后 Arc 仍存」窗口。
- **ADR-0060** 定「删打开会话先关闭」入口流程，隐含「关闭同步」假设。

非任一单 ADR 可独立解释，需新 ADR 闭合。

## Why

1. **守 ADR-0055 零等待**：纯 close 仍 fire-and-forget，Shell 关闭 in-flight 会话 UI 瞬时卸载、零等待，不退化。
2. **守 ADR-0035 single-writer 单一职责**：key 唯一释放点仍 `Session::Drop`，不引入第二释放路径（强制 release 路径会破坏，见 Considered options）。
3. **闭合 ADR-0060 同步假设**：delete 路径显式等 key release，「先关闭」从隐含同步假设变成确定性契约。
4. **最小语义破坏面**：只新增 delete 路径的等待变体；不碰前端观测 ask 退出（避免跨前后端新契约）；不碰 single-writer gate（gate 保留）。
5. **等待上限复用 ADR-0021 固有债**：in-flight ask 的最长收尾即 HTTP ≤120s（ADR-0021 软取消），等待变体上限与之对齐，不新增上限类型。

## Considered options

- **delete 强制 release canonical key**（撞 gate 时识别同进程已知 session、强制 release + cancel + 删文件）：破 ADR-0035 Decision 3 single-writer 单一职责（key 释放点分裂为 `Session::Drop` + delete 强制路径）；且删文件时 ask 可能正 persist，引入「删文件 vs 写文件」新竞态需额外同步；与 registry fail-closed 哲学冲突。**否决**。
- **前端 cancel + 等 ask 退出再 close + delete**（前端显式 cancel in-flight ask、等 turn-progress 结束 / ask promise settle、再 close + delete）：跨前后端新契约（前端需观测 ask 退出 = Session 内部状态反向耦合）；delete 延迟到 ask 收尾，用户视角 delete「卡住」；前端观测 ask 退出是新负担。**否决**。
- **close 双变体的 API 形态**（`close_session` 加 `wait_for_release` 参数 vs 新 IPC `close_session_and_wait_release`）：留实现期；本 ADR 定「双变体存在」，不定 API 具体形态。

## Consequences

- **新增 close 等待变体 IPC**（ADR-0056 会话作用域命令族成员），delete 路径专用。
- **前端 deletePersisted 改调等待变体**；closeOpen（Shell 纯关闭）仍调纯 close（fire-and-forget）。
- **延伸 ADR-0055**：close 拆双变体；纯 close 的 fire-and-forget 语义不变。ADR-0055 已加反向指针。
- **订正 ADR-0060**：「删打开会话先关闭」的「关闭」= 走等待变体（等 canonical key release），非同步假设。ADR-0060 已加反向指针。
- **不改 ADR-0035**：single-writer key 在 `Session::Drop` 释放不变。
- **依赖 ADR-0056**（后端 IPC 多会话寻址）：等待变体是 ADR-0056 会话作用域命令族成员，以 sessionId 寻址。
- **留实现期**：等待信号具体实现（oneshot / Notify / JoinHandle）、超时上限精确值、多会话同时 delete 的串/并行收尾、`rename_persisted_session` 是否也需等待变体（同构 gate 问题，另议）。
