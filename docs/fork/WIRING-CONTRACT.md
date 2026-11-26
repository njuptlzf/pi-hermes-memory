# Wiring contract — 为什么接线、能改什么边界、补什么能力

> Fork-owned file. Upstream does not know this path, so a merge never touches it.
> 这是 `UPSTREAM-MAPPING.md`（能改什么文件 + forced/drift/additive 分类）与
> `WIRING-RATIONALE.md`（为什么接线是增量的）之间的**决策层规范**：回答"未接线
> 的功能有什么意义、fork 有没有权改边界、不接缺什么、接了补什么"。
> 状态只在 `TASKS.md`；本文档只记 fork 侧的原则与能力语义，不记进度。
>
> **范围边界**：本文件是 hermes-memory fork 自身的规范。host 侧（agent-chat）
> 要补哪些契约字段、如何调用 scoped provider 的接线指南属于 **agent-chat 仓库**，
> 不在这里描述。本文档只说 fork 需要什么注入、为什么这是接线的一部分。

## 0. 一句话原则

**源仓 `chandra447/pi-hermes-memory` 是单用户 Pi CLI 的引擎；本 fork 是把同一
引擎接进多租户 host 的适配器。fork 的职责不是"少接几个功能"，而是把源仓每个
有价值的能力重新表达在租户边界上。接线门槛只有一条——能否在多租户/租户根模型
下合法实现；"host 当前没调用、契约当前没有字段"不是门槛，是待办。**

这条原则在 2026-11-26 由用户明确纠正后确立；此前把"scoped 侧零调用""host 契约
无字段"当 blocker 的判定一律作废。

## 1. 两个侧的根本差异（一切判断的起点）

| | 源仓 upstream | 本 fork |
| --- | --- | --- |
| 宿主 | 单用户 Pi CLI（终端） | in-process 多租户 server |
| 谁来拥有 config / 进程 / 历史 / prompt | CLI 与扩展自己 | host，经 memory-provider port |
| root 的来源 | `AGENT_ROOT = process.env / os.homedir()`（`src/paths.ts:5`） | host 算好的 `storageRoot` / `sharedRoot` |
| 隔离边界 | 一个用户、一台机器 | 一个 scope 一个 store，一个 userId 一个 profile |
| 能力装配 | `src/index.ts` 一个 481 行默认导出接全部 | `src/scoped/entry.ts` 只装配 host 边界允许的部分 |

源仓的"环境"是它自己拥有的：环境变量、家目录、子进程、TUI、项目目录。这些
在单用户 CLI 里是能力，在多租户 host 里是隔离漏洞。fork 接线的本质，就是把
这些能力从"自己拿环境"改写成"host 注入"——**引擎不动，只换入口与边界**
（`UPSTREAM-MAPPING.md` §1 / §3）。

## 2. 未接线功能的意义：它们不是丢失，是待重新表达

判断一个未接线功能的意义，问三个问题，而不是问"host 现在调不调用它"：

1. **它解决了什么用户问题？** 例如 `session_search` 解决的是逐字召回（"上周
   关于 migration 我们原话怎么说的"），`MEMORY.md` 的压缩结论回答不了
   （`SESSION-SEARCH-DESIGN.md` §0）。问题真实存在，与 host 是否调用无关。
2. **它在源仓里靠什么环境实现？** 靠 `process.env`/`os.homedir()`、spawn 子
   进程、project 轴、或 TUI command 的那部分，是**必须重新表达**的——这正是
   `UPSTREAM-MAPPING.md` §3.1 的 **Forced** 类。例如上游 `session-search-tool.ts`
   在 import 时求 `DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, ...)`（该文件
   :30），scoped 不能 import，但纯函数 `searchSessions()` 可以复用。
3. **在多租户下它的等价信号是什么？** 找到等价信号，接线路径就成立：
   - 逐字会话历史 → host 提供的会话只读端口 `list()/load()`
     （`src/scoped/history-types.ts` 的结构镜像），而不是扫 host 全局 sessions 目录；
   - LLM 消费（consolidation/review/flush）→ 注入的 `complete` 回调
     （`completion-types.ts`），而不是 `pi.exec()` 或 `modelRegistry`；
   - 用户常驻指令 → `promptSection()` 里的 `StandingInstructions`（#8），
     而不是 TUI `/memory-pin`；
   - 会话变更时间 → port 的 `updatedAt`，而不是 `session_files.mtime_ms`。

**结论：未接线 = 尚未找到/实现等价表达，不等于无价值、不等于已完成。** 一个
功能被标为"延后"如果没有指出 forced 约束，就是缺陷（unforced drift 或遗漏），
不是合法状态。

## 3. fork 能不能改边界接线源仓功能：能，且这是 fork 存在的理由

### 3.1 授权范围

| 范围 | 可否修改 | 依据 |
| --- | --- | --- |
| `src/scoped/**`、`tests/scoped/**`、`docs/fork/**` | **任意**，零冲突 | 上游没有这些路径（`UPSTREAM-MAPPING.md` §1） |
| 新端口字段、新 config、tuning 开关 | **预期工作** | host 注入的参数属于边界，不是引擎 |
| `src/store/`、`src/tools/`、`src/handlers/` 里的引擎 | **仅 forced 且登记** | fork the boundary, not the engine；改了要进 `divergences.json` |

host 侧的契约形态与调用点由 host 仓库自己的接线文档负责；本文件只规定 fork
需要什么样的注入，不规定 host 如何实现它。

### 3.2 接线时三种变化，只有一种是缺陷

沿用 `UPSTREAM-MAPPING.md` §3.1，但在接线判定里强调：

- **Forced**（upstream 读 env/home、spawn、要 host 不传的 model、inert rpc
  command、project 轴）：**重写 + 在文件头写清约束**。合法。
- **Additive**（fork-owned type 里的新选项，不碰上游文件）：**允许 + 写为什么**。
  例：`ScopedMemoryTuning.sessionSearch`、`tuning.retentionDays`。
- **Unforced drift**（照抄字面量、漏读 config）：**缺陷，必须修**。例：scoped
  曾写死 `?? 6` 而不读 `config.nudgeInterval`（#21/#22 已修）。

**缺注入字段不是上面任何一类——它是接线的一部分，不是 blocker。** fork 声明
需要的注入后，由 host 侧在它自己的仓库补齐；fork 侧不因此判定功能"做不了"。

### 3.3 判定清单（每个 backlog 残项都按此过一遍）

1. 用户问题是什么？（§2-1）
2. 上游实现依赖哪种环境？（§2-2）
3. 该环境在多租户下的等价注入是什么？（§2-3）
4. 若能表达 → **接线**；缺注入字段 → 照常声明为接线的一部分，**不是 blocker**。
5. 仅当命中 forced 约束且**无等价注入** → 才可标"不做"或"延后"，并在
   `TASKS.md` 写出具体约束，而不是只写"host 不支持"。
6. **走到 host 契约变更那一步之前，先过通用性闸**（2026-11-26 用户明确）：
   判据不是字段的出身，而是**能否用宿主期望的行为语言重述、且对其他 provider 仍可
   conformance 判定**。重述成功（如 retention → "N 天前的会话原文不再可检索"）→
   才可提请 host 仓库评估契约扩展，且必须用 provider 无关的语言命名并配 capability
   声明；重述失败（如 review 节奏、FTS 开关——换家引擎就无可观察语义）→ 不索取 host
   契约字段：留在 fork-owned `ScopedMemoryTuning`（direct-user 通道），host 可达性交给
   提供方模块自读配置或宿主部署级配置。**字段可选 + 默认值维持现行为只解决向后兼容，
   不解决契约正当性**——只有某家懂的可选字段会被别的 provider 缺省忽略，造成"产品
   配置了却没发生"的静默不合规（C6 消灭的正是这种静默丢失）。不支持的 provider 无需
   逐字段声明"没有此概念"（C6 缺省全 false，装载与会话不受影响——协议头注与
   conformance 用例 "absent capabilities … not as a load error" 即规范证据），但宿主要把该字段从静默变成可告警，就必须为它维护 capability
   声明 + conformance 对，这是契约侧的每字段维护成本。规范文本与判定例子属 agent-chat
   仓库（其端口演进规范），本条只固定 fork 侧"什么诉求值得去敲 host 的门"。

## 4. 不接缺什么、接了补什么：逐项能力矩阵

以下按源仓启动钩子 `src/index.ts:241/251/262` 和 22 候选（`TASKS.md`）归并。
"场景"是用户可以提出的真实请求。

| 能力 | 不接缺什么 | 接了补什么 | 场景 |
| --- | --- | --- | --- |
| **per-scope 存储 + 共享 profile**（已接 `7c23d00`/`0e18097`） | 一个租户能读到另一个租户的记忆；删除资格会伤到用户画像 | 一个 scope 一个 store，profile 按 userId 独立，两根不相交 | 用户在课程 A 的偏好带到课程 B，但删掉课程 A 不删偏好 |
| **`memory_search` FTS5 镜像**（已接 `cfa6254`） | 只能靠模型碰巧记得，或全文注入爆 token | 按需语义检索，镜像在租户 DB 内 | "把之前记的部署命令找出来" |
| **会话逐字召回**（#3 已接 `4e02174`/backfill） | `MEMORY.md` 只有压缩结论，逐字原话永久丢失 | 当前会话 + 本 scope 已保存会话的逐字检索 | "上周 migration 那条报错原话是什么" |
| **纠正检测**（#5 已接） | 用户纠正"其实我用 TypeScript"只在 review 时才可能被概括，当下继续犯错 | 立即把纠正写成 failure memory | 对话中纠正偏好，下一轮立刻按新偏好回答 |
| **工具调用触发的 review nudge**（#6/#21/#22 已接） | 6 轮固定计数，长工具链对话不触发 review | 按 `nudgeMode` / `toolResults` 计数，`reviewEnabled` 可关 | 一轮里 20 次工具调用后自动整理记忆 |
| **用户常驻指令**（#8 已接） | 检索路由是英文的，中文"不要做 X"不会触发检索，禁令永远不被 Recall | 每条请求都注入用户自己 pin 的规则 | "不要主动改数据库 schema"在每次请求都生效 |
| **自动巩固 / review / flush**（P0 已接 `51aa48b`/`1cb50de`） | 记忆只增不减，上下文无界增长 | 有界压缩 + 后台整理，经注入 `complete` | 长会话后记忆被压缩，不撑爆 prompt |
| **observability / completion guard**（P2 已接 `441444e`） | LLM 失败无界重试、无 metrics，租户互相拖垮 | 15s 超时 + 单次重试 + 串行化 + 指标 | 某租户的 completion 卡住不影响其他租户 |
| **retention / prune**（#4 残项，可接） | 租户镜像的 sessions/messages 无限增长；只读端口的全量 `list()` 每次回灌已删会话 | 按 `updatedAt` 时间窗淘汰，并把 id 写进 backfill cursor 防回灌 | 半年后租户 DB 不因历史会话膨胀；删过的旧会话不再"复活" |
| **`session_files` 增量元数据**（#4 残项，可接） | 上游 `needsBackfill` 靠文件 mtime，租户没有文件根 | 把 `updatedAt` 写入 `mtime_ms` 等价信号，或直接走 cursor | 已索引会话不重复写，变更会话按时间戳更新 |
| **孤儿会话清理**（#4 残项，需重定义） | 子进程 review 留下的 prompt 临时会话（上游 marker）在租户里无对应物 | 等价实现改为清理 `list()` 之外且无 cursor 的行（reconcile 已覆盖一半） | host 删除会话后，租户索引不留幽灵行 |
| **崩溃恢复 sidecar 维护**（#4 残项，受 forced 约束） | `runRecoveryMaintenance` 扫 `globalDir`/`projectsRoot`，租户无 project 轴 | 改为对注入的 tenant roots 做维护；DB 损坏恢复另走 `withCorruptionRecovery` | 进程崩在写盘中途，下次 open 能恢复而不污染别的租户 |
| **程序化技能 skill_manage**（#1 延后，可接） | 多步流程只能靠记忆文本，没有可执行过程 | 租户级 skill root（host 注入路径）+ 注册工具 | "每次部署走这套检查清单"变成可复用技能 |
| **project 轴**（#7 不做，forced） | —— | —— | host 刻意移除共享维度，重加会破坏隔离；这是合法的"不做" |

注意最后两行的对比：**#1 与 #7 的差别不是"host 当前支不支持"，而是"能否在
租户模型下表达"**——技能可以放在租户根下，项目轴则会重新引入共享维度。

## 5. 本文档不写什么

- **不写 host 侧的接线指南**：要注入哪些字段、host 内部怎么构造端口、调用点
  在哪、按什么顺序启用——这些属于 agent-chat 仓库的接线文档。fork 只声明它
  需要的注入契约（§2-3、§3）和能力语义（§4）。
- **不写其他 host 的接线**：任何接入方怎么消费 `src/scoped/` 是它自己的事。
- **不写进度**：commit、PR 号、当前状态只在 `TASKS.md`。

## 6. 规范如何"定下来"并持续生效

1. **写入本文件 + 长期记忆**：原则进 `docs/fork/WIRING-CONTRACT.md`（版本化、
   随仓走），用户明确纠正的判定规则同时进 `.workbuddy/memory/MEMORY.md`。
2. **状态仍只看 `TASKS.md`**：接线是否完成、commit/PR 号只记那里；本文档不记进度。
3. **实现前先写设计记录**：按 `UPSTREAM-MAPPING.md` §3.2 四要素（交叉引用、
   真实调用链、完整影响面含所有 caller、默认值风险），缺一不可。
4. **review 时按 §3.3 清单判**：任何"延后/不做"若没有写出 forced 约束，打回。
5. **fork 侧接线只给 fork 库提 PR**：base/head 均为 `njuptlzf/pi-hermes-memory`。
   若改动涉及 host，那是另一个仓库的工作，按该仓库流程办，不在本文档规定。
