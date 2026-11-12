# 开发日志架构重设计计划

> 文档状态：已落地的设计存档。锁定决策、宿主契约与事件模型的细节以本文为准；现行行为描述见 `docs/logging.md` 与 `docs/host-contract.md`。

## 目标

TT-Toolkit 日志继续作为默认关闭、主要面向开发者和 Agent 的诊断能力。重设计需要解决当前只有显式埋点才能进入日志、已捕获的界面错误大量漏记、宿主 console 状态与 Toolkit 日志内容脱节的问题。

完成后，启用日志会统一持久化两类事件：

1. TT-Toolkit 主动产生的结构化诊断事件；
2. TauriTavern 公开 `api.dev.frontendLogs` 提供的前端日志副本。

首版只接入宿主前端日志流，不读取 backend logs 或 LLM API logs，不调用内部 `devlog_*`，也不改变宿主全局 console 捕获设置。

## 已锁定决策

下列策略已锁定，不得重新选择：

- `api.dev.frontendLogs` 是日志功能的必需能力，不是整个 TT-Toolkit 的全局必需 ABI。该能力缺失或启动失败时只停用日志功能，其它工具继续运行。
- 已运行的日志会话收到非法宿主 DTO 时，立即停止宿主副本流并显示契约错误；Toolkit 自身结构化日志、持久化和导出继续工作，不自动重连。
- 用户手动启用日志，以及 TauriTavern 重启后恢复上次已启用状态时，都导入宿主当前保留的前端日志尾部。
- 隐私模式轮换和清空日志后的内部重启只恢复实时订阅，不重新导入尾部。
- 保持 `logger-settings-v1`、`logs/index-v2`、现有事件对象和 JSONL 分块格式兼容，不增加存储迁移。
- 不修改、补丁或定制 TauriTavern 源码。

## 已验证宿主契约

验证基线：TauriTavern `2.2.0`，提交 `3a8c5401c859`。

公开 `window.__TAURITAVERN__.api.dev.frontendLogs` 提供：

- `list(options?: { limit?: number }) -> Promise<FrontendLogEntry[]>`；
- `subscribe(handler) -> Promise<unsubscribe>`；
- `getConsoleCaptureEnabled() -> Promise<boolean>`；
- `setConsoleCaptureEnabled(enabled) -> Promise<void>`。

TT-Toolkit 只允许调用前三个读取/订阅方法。虽然宿主公开了 setter，本功能也不得调用或在界面暴露它。

`FrontendLogEntry` 的已验证字段为：

```text
id: number
timestampMs: number
level: debug | info | warn | error
message: string
target?: string
```

宿主负责捕获顶层窗口和同源 iframe 的未处理错误与未处理 Promise rejection；console 捕获开启时还会捕获 console 输出。宿主前端日志按级别保留运行期尾部，`message` 只是可能截断和摘要化的预览。

`list()` 不传 `limit` 时返回当前仍保留的完整尾部；当前宿主按 `debug` 400 条、`info` 300 条、`warn + error` 100 条分别保留，返回数组保持剩余记录的发生顺序。`subscribe()` 不复播历史，只推送新记录，并异步返回可安全重复调用的取消函数。实现仍必须自行处理“订阅建立后、尾部读取完成前”的竞态。

实现只能经过 `src/kernel/host.js` 使用以上公开 ABI。宿主方法缺失、返回结构非法或订阅生命周期不符合契约时，日志功能必须 fail-fast，不添加猜测式兼容，也不影响其它工具功能。

因此需要从当前 `requireAbi()` 的全局必需条件中移除 `api.dev.frontendLogs`。聊天、extension store、layout、模型传输等既有必需 ABI 继续全局 fail-fast；日志 ABI 改为 logger 初始化和启用时独立探测。

宿主证据：

- `docs/API/Dev.md`；
- `docs/FrontendHostContract.md`；
- `src/tauri/main/api/dev.js`；
- `src/tauri/main/services/dev-logging/frontend-log-capture.js`；
- `src/tauri/main/services/dev-logging/same-origin-iframe-log-capture.js`。

## 目标架构

### 1. 宿主适配层

在 `src/kernel/host.js` 增加窄接口：

- 读取宿主前端日志尾部；
- 订阅新增宿主前端日志；
- 校验每个 `FrontendLogEntry`；
- 规范化并返回幂等取消订阅函数。

建议固定为以下接口；允许采用等价命名，但职责和失败语义不得变化：

```js
host.assertFrontendLogsCapability()
host.listFrontendLogs()
host.subscribeFrontendLogs(onEntry, onContractError)
host.getHostConsoleCaptureEnabled()
```

`assertFrontendLogsCapability()` 必须确认 `list`、`subscribe` 和 `getConsoleCaptureEnabled` 都是函数。`listFrontendLogs()` 必须调用无参数 `list()`。`subscribeFrontendLogs()` 在调用消费方前完成 DTO 校验，并返回只执行一次底层取消的幂等函数。

已知字段的严格校验规则：

- `id` 是大于零的安全整数；
- `timestampMs` 是大于等于零的安全整数；
- `level` 只能是 `debug`、`info`、`warn` 或 `error`；
- `message` 必须是字符串，允许空字符串；
- `target` 可以缺失；存在时必须是字符串，允许空字符串；
- `list()` 返回值必须是数组；
- `subscribe()` resolve 后的值必须是函数。

宿主公共契约允许未来向 DTO 增加向后兼容字段，所以未知字段必须忽略，只克隆已验证字段；不能因为未知字段拒绝记录。不得接受字符串数字、大小写级别或任何猜测式替代结构。

使用稳定 `ToolkitError` code 区分主要失败：

- `HOST_FRONTEND_LOGS_MISSING`：必需方法缺失；
- `HOST_FRONTEND_LOG_LIST_INVALID`：尾部不是数组；
- `HOST_FRONTEND_LOG_ENTRY_INVALID`：条目字段非法；
- `HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID`：取消函数非法；
- `HOST_FRONTEND_LOG_STATUS_INVALID`：console capture 状态不是 boolean。

日志功能启用前检查 `list`、`subscribe` 和 `getConsoleCaptureEnabled`。初始化失败时不创建半有效会话；已经建立的订阅必须立即取消。

运行中的订阅若收到非法 DTO，应只停止宿主日志接入并把宿主流标记为降级，不能跳过非法记录后继续猜测。当前 Toolkit 日志会话继续记录自身事件。界面需要显示稳定、可操作的宿主日志契约错误。

适配器必须覆盖回调理论上早于 `subscribe()` Promise resolve 的时序：先记下待取消状态，拿到真正取消函数后立即执行。非法 DTO 只通知一次，不得把 DTO 原值、未知字段或宿主消息写入错误日志。

### 2. Logger 生命周期

所有会改变生命周期的操作必须串行执行，避免双击开关、设置保存和清空同时创建会话或订阅。建议保留公开方法并拆出不会再次入队的内部方法：

```js
start({ importHostTail = true } = {})
stop()
saveSettings(settings)
clearLogs()

_startInternal({ importHostTail })
_stopInternal()
```

外部启动（用户手动开启或启动时恢复已启用状态）使用 `importHostTail: true`，严格按以下顺序执行：

1. 验证日志设置和日志索引可用；
2. 检查三个宿主日志方法并读取、校验 console capture 状态；
3. 建立宿主实时订阅，回调暂时只写入初始化 buffer；
4. 无参数读取宿主当前保留的前端日志尾部；
5. 构造新会话并临时加入 `index.sessions`；
6. 严格保存初始 `index-v2`，失败必须回滚，不能使用当前吞错的安全保存路径；
7. 设置 `current`、当前序号、会话级宿主 ID 集合和 `enabled`；
8. 先记录 `system / logger / session.started`；
9. 合并尾部与 buffer，按宿主 `id` 去重并升序接收；
10. 把订阅切换到正常实时接收，继续现有定时 flush。

`state.enabled` 只能在订阅、可选尾部读取、会话创建和初始索引保存全部成功后变为 `true`。启动失败必须取消订阅、回滚未成功建立的会话、清空 buffer 和 ID 集合、保持关闭并向调用方抛错，不能留下半有效会话。

停用日志时先停止接收宿主事件，再完成 pending flush、结束会话并保存索引。取消订阅必须可重复调用，任何启动失败、正常停用和异常终止路径都要清理订阅。

以下内部重启使用 `importHostTail: false`，仍重新建立实时订阅，但不得调用 `list()`：

- 隐私模式变化导致的会话轮换；
- 清空日志后恢复记录。

这可以避免完整模式追溯保存旧的敏感宿主消息，也保证清空日志后不会立即被宿主旧尾部重新填充。

正常停止的固定顺序为：先禁止订阅接收并取消宿主订阅，再记录 `session.stopping`，禁止新事件，清除 timer，等待 pending flush 和 flush queue，写入 `endedAt`，保存最终索引，最后清理当前会话、buffer、ID 集合和订阅引用。即使取消订阅抛错，也必须在 `finally` 中完成 flush 和会话收尾。

运行中遇到非法宿主 DTO 时，只执行一次以下降级：取消宿主订阅，将宿主流状态改为 `degraded`，记录不含原 DTO 的 `system / logger / host.stream_contract_failed`，然后继续 Toolkit 自身日志。不得自动重连；用户真正关闭并重新启用日志时才重新探测。

宿主流、console 状态与持久化错误必须分开保存，建议采用下列内存状态；它们不进入持久化 schema：

```js
hostFrontendStatus: {
  phase: 'idle' | 'starting' | 'active' | 'degraded' | 'unavailable',
  code: '',
  message: '',
  importedCount: 0,
},
hostConsoleCaptureEnabled: null,
hostConsoleCaptureError: '',
```

- `idle`：日志关闭，最近没有未解决的宿主契约错误；
- `starting`：正在订阅或导入；
- `active`：宿主流正常；
- `degraded`：会话仍工作，但宿主流因运行期契约错误停止；
- `unavailable`：宿主 ABI 缺失或启动探测失败，日志未启动。

不得再把宿主状态读取失败写入 `persistenceError`。`configurationError`、`persistenceError`、legacy schema、宿主流状态和 console 状态错误是五种不同问题。

### 3. 统一事件模型

Toolkit 自身事件继续使用现有字段：

- `featureId` 表示产品功能；
- `source` 表示技术来源；
- `event` 使用稳定的机器可读名称；
- `data` 只放脱敏后可安全持久化的数据；
- `sensitive` 只在完整模式持久化。

宿主前端日志映射为：

```text
featureId: system
source: host-frontend
event: host.frontend_log
level: 继承宿主级别
data:
  hostEntryId
  hostTimestampMs
  hostLevel
  messagePresent
sensitive:
  message
  target（存在时）
```

宿主事件仍使用 Toolkit 的本地记录时间作为主时间戳，`hostTimestampMs` 用于还原原始发生时间。宿主 ID 只承担当前宿主运行期、当前 Toolkit 会话内的去重，不作为跨重启身份。

`messagePresent` 精确定义为 `entry.message.length > 0`。当前最低记录级别同时作用于 Toolkit 和宿主事件；宿主条目即使因级别被忽略，也应先把 ID 记为已处理，不能因设置变化再次出现。ID 集合在会话结束时清空，不写入索引。

映射后的完整结构固定为：

```js
{
  featureId: 'system',
  source: 'host-frontend',
  event: 'host.frontend_log',
  level: entry.level,
  data: {
    hostEntryId: entry.id,
    hostTimestampMs: entry.timestampMs,
    hostLevel: entry.level,
    messagePresent: entry.message.length > 0,
  },
  sensitive: {
    message: entry.message,
    ...(entry.target !== undefined ? { target: entry.target } : {}),
  },
}
```

### 4. 回流和重复保护

宿主来源事件不得调用现有 console 同步，否则会形成“宿主日志 → Toolkit → console → 宿主日志”的循环。

Toolkit 自身结构化事件同步到 console 后可能被宿主重新捕获。宿主副本接收器应忽略由 Toolkit logger 产生、带固定 `[TT-Toolkit][<featureId>][<source>][<event>]` 前缀的 console 记录，保留其它普通 `[TT-Toolkit]` 错误，尤其是未进入结构化 logger 的启动异常。

过滤只依据由 Toolkit 自己定义和产生的完整固定标记，不依据宿主可选 `target` 猜测来源。

匹配必须锚定消息开头，并要求四个非空、不能跨 `]` 或换行的段。只过滤完整的 `[TT-Toolkit][featureId][source][event]` 标记；必须保留 `[TT-Toolkit] Initialization failed`、`[TT-Toolkit][logger][persistence.failed]`、普通第三方 `[TT-Toolkit]` 文本和其它近似前缀。

### 5. 功能错误覆盖

所有已经捕获并显示给用户的操作失败都必须在显示之前写入结构化日志。埋点放在 runtime、事务边界或共享任务层，UI 组件只负责展示，不在多个页面重复拼装错误字段。

首轮覆盖至少包括：

- 模型预设加载与保存失败；
- 获取模型列表失败；
- 测试模型连接失败；
- 功能加载与激活失败；
- 聊天查看、聊天清洗和 AI 世界书现有失败路径的一致性复核；
- 日志查看器自身的读取、导出、复制和设置保存失败。

事件命名和归属固定如下，避免各页面自由命名：

- 模型设置：`model-settings / model-settings / presets.load_failed`、`presets.save_failed`、`models.fetch_failed`、`connection.test_failed`；
- 功能加载：`system / feature-loader / feature.load_failed`；
- 功能启停：`system / shell / feature.activation_failed`、`feature.deactivation_failed`；
- logger 自身：`system / logger / host.stream_contract_failed`、`session.load_failed`、`settings.save_failed`、`logs.clear_failed`、`host.status_refresh_failed`；
- 查看器文件与剪贴板动作：`system / logger-ui / export.file_failed`、`export.copy_failed`、`export.serialize_failed`。

UI 不自行拼装错误字段。runtime 或 logger 应提供统一的失败报告入口，例如 `reportOperationFailure(operation, error)`；页面只传稳定 operation 与原始错误。文件选择器抛出的 `AbortError` 是用户取消，不记录为失败。

聊天查看、聊天清洗和 AI 世界书需要逐个复核所有会展示错误的 `catch`：日志调用必须发生在设置 `state.error`、notice、callout 或重新抛出之前。已有 `operation.failed`、`auto.failed`、`transaction.persistence_failed`、`routing.fallback`、`fill.failed` 等事件应复用，不得在 UI 再记一份。

每个失败事件至少包含稳定操作名以及 `ToolkitError.code` 或安全的错误类型。完整错误对象只放入 `sensitive`。模型预设名称、API URL、模型名和访问密钥均不得进入日志，其中访问密钥在完整模式也禁止记录。

模型服务错误是更严格的例外：加载、保存、获取列表和测试连接失败都只记录稳定 `operation` 与安全 `kind`，即使完整模式也不记录未知错误的 message、stack、响应正文或完整 Error 对象，因为这些值可能包含 URL、模型或密钥。

启动早期、未处理异常和 iframe 异常由宿主前端日志尾部或实时流补获，不在插件内重复安装全局 `error` / `unhandledrejection` 监听器。

## 隐私、存储与导出

默认隐私模式仍为 `redacted`：

- 宿主 `message` 和 `target` 不写入 Blob、不进入内存导出结果；
- 只保存级别、时间、宿主运行期 ID 和消息存在标记；
- 不保存正文、规则、原始聊天身份、本机路径、用户名、未知错误详情或访问密钥。

`full` 模式允许把宿主提供的 `message` 预览和 `target` 放入 `sensitive`，随当前会话持久化和导出。界面必须继续明确提示完整模式可能包含敏感内容。

### 模型预设值的强制保护

宿主 message 和一般 Error 可能间接包含模型预设数据，所以仅靠调用方“不主动记录”不能满足密钥边界。logger 必须维护仅存在于当前运行期内存中的受保护值集合，并提供等价于下列接口：

```js
logger.protectValues(values)
```

实施规则：

- 保护所有非空的模型预设名称、API URL、模型名和访问密钥；
- 日志功能启动前，从 `llm-presets-v1` 原始对象提取这些字段并注册；读取失败时日志功能保持不可用，其它工具继续运行；
- 模型预设加载、保存、获取模型和测试连接前，先注册当前草稿中的值；保存成功后再注册规范化值；
- 本次页面运行期间集合只增加、不移除，避免删除预设后旧值重新出现在稍晚到达的宿主消息中；
- 忽略空字符串；字符串中的精确匹配统一替换成 `[REDACTED_PROTECTED_VALUE]`；
- 对 `data`、`sensitive`、Error 字段和宿主 message/target 递归处理；
- 替换必须发生在事件进入 `pending`、`currentEntries`、console 或 Blob 之前；不能先保存明文再在导出阶段补救；
- JSON/LOG 导出只消费已经处理的事件，不再次读取模型预设或猜测敏感值。

脱敏模式同样不能先把完整宿主 message/target 放进 `currentEntries`。隐私投影必须在事件第一次进入 logger 时完成，保证内存、分块、console 和导出边界一致。

宿主副本复用现有 `tt-toolkit` namespace 下的 `logs` table、`index-v2` 和 JSONL 分块，不新增长期数据域，不写聊天 metadata。现有容量限制、会话淘汰、当前会话分块淘汰和“清空日志”行为同时作用于两类事件。

本轮保持 `logger-settings-v1`、`index-v2` 和现有事件 JSON 兼容，不需要迁移。若实现过程中必须改变持久化根 schema，应先另行更新计划并设计显式迁移或重置路径。

## 查看器调整

日志页继续使用统一会话和统一事件列表，不增加独立且不可导出的临时面板。

- 宿主记录标记为“系统 / host-frontend”；
- 现有来源筛选可以单独查看宿主流；
- 脱敏会话展开宿主事件时显示“消息因隐私模式未保存”；
- 完整会话展开时显示 `message` 和可选 `target`；
- JSON/LOG 导出继续严格使用当前筛选结果；
- 宿主 console 捕获状态只展示，不提供开关。

宿主状态显示规则：

- `unavailable`：日志没有启动，显示稳定宿主 ABI 错误；
- `degraded`：当前会话仍记录 Toolkit 事件，但宿主副本已停止；
- `persistenceError`：明确说明当前日志无法可靠写入 extension store；
- legacy 或损坏 schema：继续要求清空日志，不得与宿主流错误合并；
- console 状态读取失败：显示“未知”和独立错误，不改变宿主设置；
- 只有在以上错误都不存在且筛选结果确实为空时，才显示“没有匹配的日志”。

脱敏会话展开 `system / host-frontend` 条目时必须显示“消息因隐私模式未保存”，而不是仅展示一个缺少 `sensitive` 的 JSON。完整会话展示经过受保护值替换后的 `message` 和可选 `target`。

宿主流不可用、订阅停止、持久化失败和日志 schema 损坏必须使用不同状态提示，不能都归为普通“没有日志”。

