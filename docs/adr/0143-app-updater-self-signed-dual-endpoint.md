# 应用更新：Tauri v2 updater 内置更新链（自签双源、一键原子流）

## Decision

1. **更新链与签名面**：接入 Tauri v2 官方 updater 插件（`tauri-plugin-updater`），更新包以 minisign 密钥对自签。更新包签名是防篡改域，独立于代码签名（杀软信誉域）——发版产物维持现状不代码签名，两个域互不替代。更新源为双 endpoint：R2 镜像主源 + GitHub release 兜底，编译期烧进包一次定死。镜像侧对 latest 清单做 URL 重写后原样分发——minisign 签名盖内容不盖 URL，重写不改签名有效性。

2. **Windows 双载体全在线**：nsis 与 msi 双发且双双进更新清单——manifest 同时携带 `windows-x86_64-nsis`、`windows-x86_64-msi` 变体键与 `windows-x86_64` 裸键（裸键指 nsis，主推安装形态）。updater 自 2.10.0 起原生按本机已装包型先试变体键再退裸键：nsis 位（`installMode: currentUser`）静默免提权更新；msi 位（Tauri 默认 WiX per-machine）收到 msi 后经稳定 UpgradeCode（自 identifier 派生）原地升级，无并存残留，代价是 per-machine 静默安装的一次 UAC 确认。msi 载体真实启用，`REBOOT=ReallySuppress` 必须作为 installer 参数传入——`msiexec /passive /promptrestart` 遇文件占用可无提示重启系统，该参数是唯一防线。

3. **产物面与清单键**：产物维持 `targets: "all"` 顺带全家（Windows nsis + msi、macOS dmg + `.app.tar.gz`、Linux AppImage + deb + rpm），全部进清单——Windows 双变体键 + 裸键（见上），Linux `linux-x86_64`（AppImage）+ `-deb` + `-rpm` 变体键（deb 位 `dpkg`、rpm 位 `rpm -U` 提权安装，AppImage 位原地重写，均在线），macOS universal 产物双写 darwin 两键。清单由发版脚本从 `.sig` 产物拼装（缺任一平台键即失败），不引入 tauri-action。插件版本钉 `>=2.14.0`：变体键匹配 2.10.0 起；Windows 安装器启动校验与失败不退出 2.11.0 起在上游；2.14.0 起上游与社区 vendor 基线等价，无需自维护 fork。

4. **检查 UX**：启动 1 秒延迟单次自动检查，无轮询；自动检查失败静默，手动检查失败显式。发现更新时 rail 出现独立更新图标，自显自隐，tooltip 标新版本号，点击直达设置页更新块；设置页按钮走状态机（检查更新 → 更新到 vX → 更新中）并展示版本 notes。更新可用是持续状态而非瞬时事件，不进 toast 分类学（ADR-0142：toast 只收瞬时事件）。

5. **一键原子流**：Rust 侧单命令编排完整链——check（不复用启动检查的旧结果）→ download（进度事件发前端）→ 清理链 → install → relaunch。清理链经插件的 `on_before_exit` 钩子执行（Windows `install()` 内部 `exit(0)` 绕过退出钩子，钩子是唯一前置机会）：收 ACP bridge sidecar → 关 DuckDB 连接 → 显式保存窗口状态（window-state 插件 API）→ 调 Tauri core `cleanup_before_exit()`（清托盘图标/资源表/隐藏窗口，属 core 非 window-state）。有活跃 ACP turn 时先弹确认框「进行中的任务会中断」，不硬封锁。无 ready 中间态——目标版本与本地包两件事实不落状态机。

6. **密钥与存量引导**：minisign 密钥对必须先于首个带 updater 的版本生成；私钥托管 GitHub Secrets 加离线备份一处。私钥丢失即存量用户断更且不可逆——轮换只救轮换后的版本，旧版只认包内旧公钥。存量引导：v0.1.0 起即双发，nsis 位与 msi 位存量升级一版后均自动进入在线更新链（msi 位每次更新经一次 UAC 确认）。

## Context

发版链现状为纯手动：`git flow release` 提 tag、build.yml 产三平台包、GitHub release 手挂资产；应用内零更新能力，release notes 安装提示段明言「无应用内更新」，用户升级等于手动下载安装。Tauri v2 官方 updater 插件配合静态 latest 清单与签名产物即可零后端接入——无服务端、无账号体系、无购买，与本项目零后端的既有形态一致。

## Why

1. **endpoint 编译期烧死**：旧版本永不知道后补的镜像，镜像必须在首个带 updater 的版本一次到位；「先 GitHub 单源、后加镜像」对 updater 是断层式升级——存量只认烧死的源，镜像后补不受益。
2. **一键原子流**：ready 中间态（下载完待安装）会把目标版本与本地包两件事实拖进状态机，随后需要双频复查伺候 superseded 场景；单命令原子编排从形态上消灭中间态。
3. **全形态在线**：变体键按已装包型对位，任何安装位都在线更新——nsis 位免提权静默，msi 位原地升级无并存残留，deb/rpm 位提权安装；无一安装形态掉出更新链。产物全是 `targets: "all"` 顺带产物，进清单只是拼装键值，零增量维护。
4. **清理前置**：Windows `install()` 内部 `exit(0)` 绕过 tauri 退出钩子与 window-state 自动保存，ACP sidecar、DuckDB 连接、窗口状态的清理若不前置，更新即等价于脏退场。
5. **自签足够**：更新完整性的唯一硬需求是防篡改，minisign 签名满足；杀软信誉属代码签名域，维持现状，两域互不绑架。

## Considered options

- **强制更新政策**：需要服务端强绑定或安全事件才成立。**否决**——触发条件未到。
- **周期轮询 + jitter + 退避**：伺候灰度与 ready 态的基建。**否决**——无灰度、无 ready 态。
- **blockmap 差量更新**：electron-updater 专属机制，Tauri 无对应物；26-100MiB 全量包可接受。**否决**。
- **opt-in 自动下载安装**：默认关的开关实践上无人开。**否决**——用户主动要再加。
- **服务端灰度 manifest**：需要后端，违背零购买前提。**否决**。
- **多通道/beta、灰度放量、更新遥测**：单通道单用户群，基建先于需求。**否决**。
- **系统代理喂 updater**：镜像主源走可达性好的 CDN 域，无直连受迫。**否决**——触发条件为镜像主源下检查失败的反馈。
- **代码签名**：杀软拦截目前零反馈。**否决**——触发条件为首条杀软拦截反馈。
- **nsis 单发砍 msi**：须改产物面，收益仅少挂一个资产；丢 per-machine 安装偏好用户与存量 msi 位的原地升级路径。**否决**——双发顺带零维护。
- **per-user WiX msi 单发**：自养 wxs 模板把 msi 改为 per-user 后 msi 即可更新载体（nsis 与 msi 双形态等价）；与 nsis 载体收益相同，代价是长期维护一套自有 WiX 模板。**否决**——nsis 原生 per-user 零模板。
- **toast 呈现更新可用**：更新可用是持续状态，toast 是瞬时事件反馈（ADR-0142 分类学），自动消失语义不承载持续状态。**否决**——独立更新图标自显自隐。
- **设置图标角标点**：图标、角标、tooltip、跳转四件套叠加。**否决**——rail 独立图标直达已足。
- **按版本 dismiss**：版本忽略名单基建。**否决**——图标自显自隐已消解重复打扰。
- **ready 中间态（下载完待装）**：两件事实进状态机，双频复查伺候 superseded。**否决**——一键原子流。
- **tauri-action 自动产出清单**：引入 action 依赖换 latest.json 跨平台自动合并；与现有裸 `tauri build` 发版链不同构。**否决**——发版脚本拼装 + 完整性门更贴现状。

## Consequences

- 正向：存量用户手动装一版带 updater 的版本后，此后所有安装形态永久在线更新；新版本发版后自动到达用户；更新完整性有签名硬验证；升级路径脱离手动下载安装。
- 负向：endpoint 烧死使镜像子域成为一次定死决策，后补镜像旧版不受益；私钥丢失不可逆（存量断更）；msi 位每次在线更新经一次 UAC 确认（per-machine 静默安装固有权衡）；全量更新包 26-100MiB 无差量。
- 中性：发版流程新增 updater 清单校验与 R2 同步两步；镜像清单 URL 重写不改签名有效性；更新包签名密钥成为需要长期保管的资产。
- 触发器：首条杀软拦截反馈 → 评估个体户 OV 代码签名；镜像主源可达性反馈 → 备用对象存储或系统代理接入；强制更新需求出现 → 服务端灰度 manifest 与轮询基建一并评估。
