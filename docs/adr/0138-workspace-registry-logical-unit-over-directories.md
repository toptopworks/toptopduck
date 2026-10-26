# 工作区注册表：目录之上的逻辑单元记录

## Decision

1. **工作区概念 = 目录 + 其上的记录实体，组织层与执行层分离。** ADR-0137 的全部执行语义存活（cwd 统一、创建时定不可变、惰性铸窝、空回收）——注册表只承载记账与显示，cwd 仍是执行事实，会话头 `workspace` 字段不动。同类 GUI 产品的工作区均为目录之上的记录实体（身份、显示名、绑定路径），纯路径是 CLI 形态；分界是交互形态而非产品出身，本仓是 GUI。

2. **注册表为独立 JSON，不进 app-config。** `{app_data_dir}/workspaces.json` 自管 version、`#[serde(default)]` additive、确定性序列化，store 镜像既有 provider 配置 store 的 write-lock 与原子写家族。领域账本与用户配置是两种数据：语义（机器记账 vs 用户偏好）、写频（每次铸造/绑定追加 vs 低频手改）、生命周期（随会话历史 vs 随用户意愿重置）三分。

3. **记录形状 `WorkspaceRecord { id: Uuid, path, title: Option<String>, created_at, last_used_at }`。** `path` 为 canonical 路径，唯一性判据与成员校验依据，永不重写，canonical 相等即同一记录。`title` 缺省派生目录尾段名，写路径（改名入口）留侧栏分组票。`created_at` 在记录创建时记（目录 stat 因拷贝/移动不可靠，不可重建的观测当场记），epoch millis。`last_used_at` 语义钉死「会话开始使用该工作区」，是 LRU 排序键。

4. **写入两挂点汇注册表单方法。** `create_session` 绑定路径与 turn 内铸造路径各记一笔；`TurnDeps` 注入 `Option<&WorkspaceRegistry>`（`None` 即断轴，与会话头 workspace 字段的注入方式同构）。时间戳窝空回收时同步删记录——记录不独活于目录。

5. **显示管线消费 `title` 而非路径。** pill、浮层列表与将来的分组头统一 `title` 缺省派生；永不显示完整路径；重名允许，靠 LRU 序区分。

6. **字段跟功能走。** 归档、`updated_at`、`session_ids` 账本不做——无消费面的字段不建，消费票 serde additive 演进；唯一例外是 `created_at`——不可重建的观测，事后补不出。

## Context

ADR-0137 Decision 5 将最近工作区列表记为 app-config 存储——随工作区概念扩展为目录之上的记录实体，该表述失准。同类 GUI 产品的通行形态：工作区是目录之上的记录实体，具有独立身份与显示名、绑定路径永不重写，部分产品另持会话归属账本或多目录聚合；执行层恒为单目录（会话 cwd 创建后固定），组织层聚合不改变它。纯路径仅是 CLI 形态。记录实体的三层（身份、显示名、绑定目录）全是 UI 概念——GUI 需要给人看的标签与分组导航，CLI 用路径即够。

## Why

1. **组织层与执行层分离**：同类产品的记录实体均与会话 cwd 解耦（cwd 恒为具体目录、实体是组织层）——实体化不必动会话头，ADR-0137 落地面零翻案。
2. **独立 JSON 而非 app-config 混存**：账本与配置混居会让配置文件变成两性质混合体，且每次铸造/绑定的追加写与低频配置写共享同一 write-lock 排队。
3. **`last_used_at` 不以 `updated_at` 兼任**：任何 mutation 都合法地写 `updated_at`，改名等操作会盖掉最后使用时间、污染 LRU 排序；同类产品的最后变更时间戳也不承担排序。
4. **`title` 随记录诞生**：显示名是记录实体三层之一，字段集即概念声明；改名消费面（侧栏分组票）近在眼前，显示管线一次成型。
5. **字段跟功能走**：纯 speculative 字段不建；`created_at` 因事后不可得而在创建时记录。

## Considered options

- **维持纯路径列表（CLI 同款形态）**：同类 GUI 产品全为记录实体，纯路径形态在 GUI 阵营是代差。**否决**。
- **注册表入 app-config 单字段**：语义、写频、生命周期三分。**否决**——独立 JSON。
- **`updated_at` 替代 `last_used_at`**：LRU 排序被非使用类 mutation 污染。**否决**。
- **身份锚缓议（path 作键起步、uuid 后补）**：侧栏分组消费面已确定，id 地基随本票；后补虽可 serde additive，一步到位更贴合概念完整性。**否决**——id 随记录诞生。
- **归档、`updated_at`、`session_ids` 提前建字段**：无消费面。**否决**——字段跟功能走。
- **显示完整路径（主行或副行）**：同类产品显示面全为标题非路径；重名靠序区分，改名是解法。**否决**。

## Consequences

- **校准 ADR-0137**：Decision 5 的最近列表存储由 app-config 改为工作区注册表（`workspaces.json`），选择器三态语义不变，执行语义零改动。
- 侧栏分组票的地基：`title` 写路径、`session_ids` 账本、分组过滤的来源判据、行内新建，全部 serde additive 演进。
- 工作区搜索与侧栏分组的账本真源分歧（记录 `session_ids` 账本 vs 扫会话头派生）留后续裁决。
- 非目标：归档、`updated_at` 审计位、改名入口（侧栏分组票）。
