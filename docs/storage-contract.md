# TT-Toolkit 存储契约

本文定义 TT-Toolkit 持久化数据的边界、命名和演进规则。实现使用 TauriTavern 的公开 `window.__TAURITAVERN__.api.extension.store`；宿主版本与源码提交见 `docs/host-contract.md` 的验证基线。

## 存储边界

- 扩展级 namespace 固定为 `tt-toolkit`，不得按功能、角色、聊天或用户另建 namespace。
- 小型全局配置、布局和索引使用 extension store JSON；日志正文等较大的顺序数据使用 Blob。
- 当前聊天的 canonical `chat[]` 是消息事实源。不得在 extension store 建立长期聊天副本，也不得把日志、备份或大索引写入消息和聊天 metadata。
- 只有确实属于某一聊天且需要随聊天迁移的小型状态才可使用聊天 metadata extension。写入前必须验证具体聊天 ref 与 stable ID；写入成功后不能确认原活对象仍属该聊天时不镜像，保留原文件的提交结果，不修改其它聊天。
- 世界书决策配置优先写入世界书的 `extensions["tt-toolkit"]` 并后端往返验证；已有 extension-store 回退在嵌入验证成功且清理完成前仍为权威。只存配置，不存世界书或聊天备份。
- 模型服务预设允许保存用户明确填写的 API URL、模型名和访问密钥。访问密钥不得进入日志、错误详情、导出文件、聊天、世界书或聊天 metadata。

## 组件命名

TauriTavern 对 `namespace`、`table` 和 `key` 使用同一文件路径组件约束：

- 只能包含 ASCII 字母、数字、`_`、`-`、`.`，即 `[A-Za-z0-9_.-]`；
- 去除首尾空白后不能为空；
- 不能以 `.` 开头；
- 不能是 `.` 或 `..`。

这些规则由宿主后端强制执行。前端的非空字符串检查不能替代合法字符检查。

TT-Toolkit 进一步规定：

- `namespace`、`table` 和固定 `key` 必须是源码中的稳定常量。
- 用户输入、世界书名称、角色名称、聊天身份、文件名和其它外部标签不得直接作为组件。
- 外部标签需要独立记录时，使用带固定前缀的 SHA-256 十六进制摘要，例如 `world-<64 lowercase hex>`；原标签保存在受 schema 约束的 value 中，或从事实源重新取得。
- 可由插件生成的记录使用固定前缀、时间戳、UUID 和定宽序号组成，只使用合法字符。
- 不使用不可逆摘要承担需要反向显示名称的唯一数据来源。

## 当前数据布局

| Table | Key | 形态 | 所有者与用途 |
| --- | --- | --- | --- |
| `main`（省略 table） | `shell-settings-v1` | JSON | 外壳布局和入口设置 |
| `main` | `logger-settings-v1` | JSON | 日志开关、级别、隐私和容量设置 |
| `main` | `llm-presets-v1` | JSON | schema 1：OpenAI/System One 协议、URL、模型、密钥预设及当前选择 |
| `main` | `llm-preset-json-capabilities-v1` | JSON | 仅 OpenAI 预设的 JSON 能力探测结果（`{ presetId: { format, checkedAt } }`），7 天过期；无连接/密钥 |
| `main` | `world-info-ai-settings-v1` | JSON | schema 2：决策预设 ID、全局阈值、最近用户轮数、超时 |
| `main` | `prompt-conflict-settings-v1` | JSON | 冲突检测功能级设置：所选模型预设 ID（null 表示跟随当前预设） |
| `main` | `chat-cleaner-settings-v1` | JSON | 聊天清洗全局设置 |
| `main` | `world-info-editor-settings-v1` | JSON | 世界书管理功能级设置：保存时是否将独立 user 转为 `{{user}}`（默认开启） |
| `logs` | `index-v2` | JSON | 当前日志 schema 的会话和分块索引 |
| `logs` | `index-v1` | JSON | 只用于识别旧 schema；不猜测迁移 |
| `logs` | `s-<time>-<uuid>.<sequence>.jsonl` | Blob | 单会话 JSONL 日志分块（Toolkit 结构化事件与宿主前端日志副本共用） |
| `world-info-ai` | `world-<sha256>` | JSON | schema 2：世界书决策配置回退，仅开关与条目模式/条件/阈值 |
| `world-info-images` | `img-<sha256>.<png\|jpg\|webp\|gif>` | Blob | 世界书条目图片本体，内容寻址、可被多条条目/多本世界书共享 |

## 模型与世界书决策配置

`llm-presets-v1` 保持 schema 1，预设新增 `protocol: "openai" | "systemone"`；已知旧 v1 缺少此字段明确补为 `openai`，下次保存写入。System One URL 仅接受无内嵌凭据、无查询参数/片段的 http(s) 基础或完整 `/systemone` 地址。旧聊天预设不会迁移为决策预设；System One 不写 JSON 能力探测记录，不自动付费探测。

`world-info-ai-settings-v1` 的值升级为 `{ schemaVersion: 2, presetId, threshold, historyRounds, timeoutMs }`，默认分别为 `null`（跟随当前预设）、`0.7`、`3`、`10000`；阈值 `[0,1]`，轮数 `1–100`，超时 `1000–120000` 毫秒。已知 v1 仅保留 `presetId` 并补齐新默认值。未知版本、非法或缺失字段显式报错，提供此功能设置重置，不以无效预设自动回退其它协议。

世界书字段仍为 `extensions["tt-toolkit"].worldInfoAiRouter`，值为 `{ schemaVersion: 2, enabled, entries: { [uid]: { mode, aiDescription, threshold } } }`。`mode` 为 `native` / `ai`，`aiDescription` 沿用存储字段名表示条件，接管时须非空；`threshold` 为 `null`（跟随全局）或 `[0,1]`。已知 v1 保留模式、开关与描述作为条件，补为 `threshold: null`；未知/损坏配置须显式重置，不改原生条目字段。

保存/重置先 fresh 读取并比较整本世界书快照（键序无关），变化则停止并保留草稿。世界书写入本身失败必须如实报错、不写回退：此时世界书未被改动，回退成功会掩盖“配置没有落进世界书”。只有写入成功但读回确认不到完整配置（宿主丢弃扩展字段、字段被改写或无法解析）才只写上述摘要 key 回退。读取优先使用现有回退；只有嵌入验证成功及回退清理成功才完成转回世界书存储。合法旧 ASCII 回退 key 可读取并于保存时清理，删除前先确认存在，失败不吞掉。重置仅移除指定世界书的配置字段和对应回退，不清空 namespace、不改正文/其它扩展、不建立备份。

导入导出格式 `tt-toolkit.world-info-decision.v1` 仅携带配置，不带模型连接或密钥；导入按 UID 预览后明确合并草稿，须另行保存。精确问题概率缓存（容量 500、TTL 60 秒）、最近最多 50 条判定记录、草稿和实际注入结果仅驻内存，绝不写入世界书、metadata 或 extension store。

## 其它已注册设置

`shell-settings-v1` 保持 `schemaVersion: 1`，保存 `entryMode`、`theme`、`launcher` 与 `workspace`。`entryMode` 取 `floating` / `wand` / `both`，首次安装默认 `floating`；`theme` 取 8 个已注册主题 id（`host` / `slate` / `midnight` / `mocha` / `dawn` / `blossom` / `latte` / `parchment`），首次安装默认 `host`（跟随宿主）。旧版 v1 缺少这两个字段时由解析器显式补齐默认值，读取后随外壳初始化保存。

`workspace.position` / `workspace.size` 继续保存桌面布局；`workspace.mobile: { mode, position, size }` 独立保存手机布局，`mode` 为 `fullscreen` / `floating`，`position` 为有限数值 `{ x, y }` 或 null，`size` 为有限正数 `{ width, height }` 或 null。缺少整个 `workspace.mobile` 时显式补齐默认全屏、空位置与空尺寸，不复制桌面坐标；上一轮已保存的 `{ mode, position }` 仅补齐 `size: null`，其它缺失/未知字段或已存在但非法的尺寸仍拒绝解析。手机切到全屏保留悬浮坐标和尺寸，缩放松手或键盘调整后保存，取消不保存中间尺寸；视口约束不覆盖记忆。重置布局同时清除两端位置及手机自定义尺寸并恢复手机全屏，不新增 key/table 或改变 schemaVersion。该调整用于单用户开发验证，不提供降级回旧代码的配置兼容；旧解析器会拒绝新增 size，如人为降级需明确重置外壳配置。

主题、入口方式、工作台尺寸档位与手机模式属于外观与布局枚举，**取值无法识别时不再拒绝解析**：解析器回退到安全默认（`host` / `floating` / `standard` / `fullscreen`）并通过 `onIssue` 上报字段、期望集合、实际类型与回退值，由外壳记为 `SETTINGS_VALUE_UNRECOGNIZED` 白名单 `warn` 并在设置页给出可见提示，重新选择后清除提示；上报不包含原始取值。这样单个外观字段异常不会让工具箱整体无法启动。

**结构损坏仍然显式报错**，不静默猜测：设置整体不是对象、`schemaVersion` 不是 `1`、`enabledFeatures` / `launcher` / `workspace` 不是对象、`lastRoute` 不是字符串、功能启用状态不是布尔值，或布局坐标不是有限数值，都抛 `INVALID_SCHEMA` / `UNSUPPORTED_SCHEMA`。显式 setter（`setTheme` / `setEntryMode`）仍用 `validate*` 抛错，因为那属于调用方 bug。

入口切换保存失败保留原入口与原内存设置；主题保存失败回退原主题。工作台拖动、边角缩放、尺寸/手机模式切换与布局重置保存失败时保留运行期布局，显示持续警告及重试按钮，记录 `LAYOUT_SETTINGS_SAVE_FAILED` 白名单 warn，不宣称已记忆成功。重置布局不改变入口方式与主题；损坏数据的开发重置见 `docs/toolkit-settings.md`。

`chat-cleaner-settings-v1` 保持 `schemaVersion: 1`，新增 `clearSwipes` 布尔字段，默认 `false`。解析器仅对已知旧 v1 缺少此字段显式补齐默认值；字段已存在但非法、其它缺失字段或未知字段仍拒绝并提供清洗设置重置。配置写入保持原 key，不新增 table。聊天清洗进度存放在 metadata extension namespace `tt-toolkit.chat-cleaner`，schemaVersion 2；局部未完成字段的楼层不推进为已完成，断点可在后续自动清洗重试。候选读回和变更计划仅存在于运行期，候选清除只写当前 canonical chat[]，不建立聊天备份。清洗正文、断点（含基线）及进度重置写入，仅在宿主未生成时发出；正文保存和进度写入不是原子操作，正文已保存但生成已开始时保留原进度。

`world-info-editor-settings-v1` 保存 `{ schemaVersion: 1, convertUserMacro: boolean }`，默认 `convertUserMacro: true`。缺失 key 返回默认值；字段存在但非法、缺字段、未知字段或不支持的版本一律拒绝解析，界面回退默认值并提供“重置世界书管理设置”入口，不猜测覆盖。切换开关立即写入并生效，不新增 table。

聊天 metadata 的 extension namespace `tt-toolkit.prompt-conflict` 保存 `{ schemaVersion: 1, disabledWorldEntries: [{ worldDigest, uid, contentDigest }] }`，用于仅对当前聊天屏蔽世界书常驻条目。`worldDigest` 与 `contentDigest` 为 64 位小写十六进制 SHA-256，分别来自世界书名与条目原始正文（未宏展开）；`uid` 按宿主真实类型严格保存与比较。记录按 `worldDigest + uid` 去重并确定性排序，不保存世界书名称、正文、报告或聊天 ID；损坏 schema 停止屏蔽并提供该 namespace 的显式重置（见 `docs/prompt-conflict.md`）。

宿主前端日志副本复用 `logs` table、`index-v2` 与现有 JSONL key，不新增 table、key 或迁移；容量淘汰、会话淘汰与“清空日志”行为同时作用于两类事件。

## 世界书条目图片

图片本体存放在 `world-info-images` table，key 为 `img-<64 位小写十六进制 SHA-256>.<扩展名>`，扩展名由嗅探出的真实 MIME 决定，不接受调用方提供的文件名或扩展名。同内容图片只占一份，可被多个条目和多本世界书共享。

世界书条目通过 `entry.extensions["tt-toolkit"].image` 保存引用：

```json
{ "schemaVersion": 1, "blobKey": "img-<64 位 sha256>.png", "mimeType": "image/png", "sizeBytes": 12345, "description": "人物身穿银色盔甲。" }
```

- 所有者为独立功能 `world-info-images`（世界书 / 插入图片）。schema 1 新增可选字符串 `description`；已知旧引用没有此字段时按无描述读取，不重建引用或 Blob。字段存在但非字符串、未知字段及未知版本仍报错，可重新上传或清除异常绑定；不猜测解释。
- 描述随图片发送给模型，不改写条目正文，不做 user 宏转换，不写日志。替换图片保留描述，移除绑定同时移除描述；无新增 table 或全局 key。
- 引用存在条目自身而非书级映射：宿主复制条目、跨书移动条目都会深拷贝条目字段并重分配 UID，书级 UID 映射会因此失联。
- 只允许 `image/png`、`image/jpeg`、`image/webp`、`image/gif`；`blobKey` 扩展名必须与 MIME 一致，`sizeBytes` 必须是正整数。读取保留 `image/gif` 仅为兼容旧绑定，新导入与 URL 导入只产出 PNG/JPEG/WebP（默认压成 WebP，入库前完成降采样与重编码，摘要基于压缩后字节）。缺失、`null`、损坏分别处理：无引用表示未绑定，损坏引用只让该条目显示“图片异常”并要求重新绑定，不猜测修复。
- 手动保存的 `user` 宏转换跳过 `extensions` 整棵子树，避免把结构化标识当作正文改写。
- 不设插件侧单张体积或单轮张数上限；发送与否由模型方限制决定。
- 删除引用不立即删除 Blob：同一内容可能被其它已复制条目或未挂载世界书引用，只检查当前书无法判定无人使用。当前不提供自动垃圾回收，也不提供物理清理入口。
- 世界书 JSON 只携带引用，不携带图片字节；把 JSON 搬到另一数据根会缺图，界面按缺失提示并继续发送文字。

## 每聊天存储（宿主 chat store）

TauriTavern 公开 chat handle 另提供按聊天寻址的 JSON 存储 `handle().store.*`（2026-09-02 核对，宿主提交 `24926a5d4331`）。TT-Toolkit 规则：

- namespace 同样只允许 ASCII 字母数字与 `_-.`，必须是源码稳定常量；按聊天隔离，不占用本表的全局 table/key 布局，使用前必须先在此登记对应 namespace 与 key。
- 角色聊天按 `chat_metadata.integrity` 寻址：分支谱系共享同一份数据，聊天文件重命名不影响；群聊按聊天文件名寻址：分叉出的新聊天不携带数据。
- 写入只触碰 sidecar 文件，不改写聊天文件本体；删除聊天文件时宿主不清理 sidecar，孤儿目录属宿主行为。
- 该存储不随聊天文件导出迁移；需要随文件迁移的数据才使用聊天 metadata extension（受本文件"存储边界"约束）。

当前 TT-Toolkit 尚未使用该存储；消息书签设计预留 `tt-toolkit.bookmarks` namespace 与 `bookmarks-v1` key（见 `docs/chat-bookmarks-audit-and-design.md`），实现落地时登记到"当前数据布局"。

新增 table 或全局 key 时，必须先更新本表，明确所有者、数据形态、清理入口和 schema 策略。

## JSON、Blob 与读取语义

- 默认使用 JSON 保存需要整体校验的小型结构化值；只有确实较大、按块读取或天然为二进制的数据使用 Blob。
- `tryGetJson()` 仅把 `{ found: false }` 解释为缺失。权限、非法组件、损坏 JSON 和其它异常必须继续抛出，不得降级为默认值。
- `null` 是已存在的 JSON 值，不等同于缺失。
- `setJson()` 是覆盖写入。写入前完成 schema 校验并传入克隆值，不能依赖宿主替调用方修正数据。
- `deleteJson()`、`deleteBlob()` 和 `deleteTable()` 对不存在目标会报错。显式清空 `tt-toolkit/logs` 只把宿主确认的该表缺失当作已空，随后仍写入空 `index-v2`；权限、传输、部分删除等失败不进入重建索引。其它可选清理必须先确认存在，或只捕获经过确认的 not-found。
- Blob key 的扩展名参与 MIME 类型推断。日志分块固定使用 `.jsonl`。
- 日志分块 sequence 在会话内单调递增，容量淘汰不得回退或复用编号；运行期计数器不进入 schema。重启关闭旧会话并创建新 ID，不恢复旧会话计数器。
- 分块写入、淘汰或索引失败后暂停日志持久化；停用不再写入该次中断后的索引状态。已成功写入但尚未登记的分块只可用当前运行期索引访问，不假定重载后可找回。中断后保留有界内存尾部供当前页面运行期间查看与导出；重载或确认清空后不保留。清空只删除 `logs` table，删除成功但空索引写入失败时保持停用并提示检查存储后重载。不新增 schema、key 或 table。
- 已索引的日志分块缺失、读失败或 JSONL / 事件范围不符合索引时，只将该分块标为不可读；继续读其它分块并保留内存尾部，不在读回时写索引、替换或删除 Blob。只有宿主明确的缺失结果记为缺失；导出按所选会话确认遗漏。不改变存储或导出 schema。
- `index-v2` 中所有 Blob key 必须全局唯一。重复 key 报 `DUPLICATE_LOG_CHUNK`，停止日志记录并要求自行备份后显式清空，不自动去重或猜测恢复已覆盖内容；不改变 schema 版本、table 或 key。

## Schema 与迁移

- 每个持久化根对象必须具有严格解析器：验证对象类型、允许字段、字段类型、范围和 schema 版本。
- key 或 schema 名称中的版本号是持久化契约的一部分。升级时同时修改源码、测试、本文和对应功能文档。
- 已知旧 schema 只能通过显式、可测试的迁移器升级。未知、损坏或语义无法可靠恢复的数据必须停止相关能力，并提供针对该数据域的重置操作。
- 不用默认值静默覆盖损坏数据，不根据旧字段名称猜测新的业务归属。
- `0.x` 可以进行破坏性调整，但必须同步提供清理或迁移路径；从 `1.0.0` 起，非大版本必须保持既有 key、schema 和用户可观察行为兼容。

## 隐私、容量与清理

- extension store 是持久化数据，不因界面关闭或功能停用自动消失。只保存恢复功能所必需的最少数据。
- 日志只位于 `logs` table，并遵循 `docs/logging.md` 的脱敏和容量策略；清空日志只删除该 table。模型密钥保护在新日志写入前生效，导出时再次处理副本，不回写历史分块、不增加密钥存储。
- 功能重置默认只删除自己的固定 key 或 table，不得清空整个 `tt-toolkit` namespace。
- 任何导出器必须显式选择允许导出的字段；模型访问密钥永不导出。日志文件、聊天文档和提示词 TXT 的统一宿主导出适配器只临时持有文本/Blob，不新增插件 table/key/schema 或聊天副本；临时原生 staging 的创建与清理由宿主导出函数负责。新增导出诊断沿用 logs 存储，只记录固定操作、阶段、原因、mode/outcome、数量及恢复动作，不持久化正文、文件名、路径、URI 或未知异常详情。
- 日志与诊断不记录本机路径、用户名、原始聊天身份或可由业务标签反推出个人身份的信息。脱敏诊断允许固定相对源码位置、白名单字段路径、类型/约束、原因码和安全楼层索引，不允许未知异常详情或业务字段原值；消息降级诊断复用既有日志 schema/table/key，不另存聊天副本。

## 修改检查表

涉及持久化的修改完成前，逐项确认：

1. 组件全部为常量或经过统一稳定派生，没有直接使用外部标签。
2. 缺失、`null`、损坏、非法组件和宿主异常具有不同处理路径。
3. schema 解析、迁移或显式重置行为有测试。
4. 删除范围只覆盖当前功能拥有的数据。
5. 敏感字段不进入日志、导出或其它数据域。
6. 当前数据布局、功能文档和测试已同步。

## 宿主证据

相对本地 TauriTavern 仓库核对：

- `docs/API/Extension.md`：公开 API、命名规则和多表语义；
- `src/tauri/main/api/extension-store.js`：前端参数规范化与 invoke 映射；
- `src-tauri/crates/tt-adapter-storage-core/src/repositories/file_extension_store_repository.rs`：后端组件校验、文件布局、缺失和删除语义；
- `src/tauri/main/api/chat.js` 与 `src-tauri/crates/tt-adapter-storage-core/src/repositories/file_chat_repository/extension_store.rs`：每聊天存储的前端 API 与 sidecar 落点（见"每聊天存储"一节）。

宿主版本变化或上述文件改变时，重新执行宿主契约审计，不依赖本文的旧结论继续实现。
