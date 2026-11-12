# 开发日志

TT-Toolkit 日志是默认关闭的开发能力。启用后创建全局日志会话，不按聊天分库，也不向聊天消息或 metadata 写入任何日志。

启用日志会统一持久化两类事件：

1. TT-Toolkit 主动产生的结构化诊断事件；
2. TauriTavern 公开 `api.dev.frontendLogs` 提供的前端日志副本（未处理错误、未处理 Promise rejection，以及宿主 console 捕获开启时的 console 输出）。

首版只接入宿主前端日志流，不读取 backend logs 或 LLM API logs，不调用内部 `devlog_*`，也不改变宿主全局 console 捕获设置。日志 ABI 是功能级必需能力：`list` / `subscribe` / `getConsoleCaptureEnabled` 缺失或启动失败时只停用日志功能，其它工具继续运行。

每条事件同时携带稳定的 `featureId` 和技术 `source`。查看器以功能作为主分类：聊天清洗、聊天查看、AI 激活等功能只记录自身事件；启动、宿主桥、外壳和日志内核统一归入“系统”，宿主前端日志归入“系统 / host-frontend”。`source` 用于进一步定位技术来源，不会改变功能归属。

## 宿主前端日志接入

- 用户手动启用日志，以及 TauriTavern 重启后恢复上次已启用状态时，会导入宿主当前保留的前端日志尾部（`list()` 不传 `limit`），再进入实时订阅。
- 宿主条目按运行期 `id` 去重，与订阅建立期间到达的实时条目合并后按 `id` 升序接收；宿主 `id` 只承担当前宿主运行期、当前 Toolkit 会话内的去重，不写入索引。
- 宿主来源事件不使用 Toolkit 本地 console 同步，避免形成“宿主日志 → Toolkit → console → 宿主日志”循环；同步到 console 的 Toolkit 结构化记录若被宿主重新捕获，宿主副本接收器只按固定四段 `[TT-Toolkit][featureId][source][event]` 前缀过滤，启动错误和近似前缀不会被误过滤。
- 运行中的宿主流收到非法 DTO 时立即停止宿主接入并标记为降级，记录 `system / logger / host.stream_contract_failed`，继续记录 Toolkit 自身事件，不自动重连；用户真正关闭并重新启用日志时才重新探测。
- 宿主 console 捕获状态只展示，不提供开关；读取失败显示“未知”和独立错误，不改变宿主设置。

## 隐私与级别

- `redacted` 是默认模式：保留计数、安全索引、阶段、独立原因码、已知源码位置、字段/约束/类型、处理结果、恢复动作和当前运行期生成的 `chat-N` 别名；不保留原始业务值或未知错误详情，宿主 `message` / `target` 不写入存储或导出。
- `full` 会额外保存事件调用方明确提供的 `sensitive` 字段，例如规则、相关正文、before/after、原始聊天身份、完整错误，以及宿主 `message` / `target` 预览；选择会跨重启保持。
- 隐私模式切换会结束旧会话并开启新会话；隐私切换和清空日志后的内部重启只恢复实时订阅，不重新导入宿主尾部。
- 记录级别和 console 同步级别分别配置；console 默认只同步 `warn` 与 `error`。最低记录级别同时作用于 Toolkit 与宿主事件；被级别忽略的宿主条目仍把运行期 `id` 记为已处理。
- 插件不修改 TauriTavern 的全局 console 捕获开关。宿主已开启捕获时，插件同步到 console 的事件会自然进入宿主日志，并由回流过滤去重。

## 分级与可定位诊断

按 `AGENTS.md` 的规则分级：正常取消为 `info`；输入校验、局部降级、可恢复失败、过期计划和等待风险确认使用 `warn`；只有真正不可恢复损失使用 `error`。是否拦截当前操作独立于日志级别。宿主前端日志副本保留宿主原始级别，不据此改变插件行为。

首阶段已落实聊天查看/导出；聊天清洗本轮已覆盖冷候选读回、局部异常计划、候选清除及提交复验/可恢复保存失败。世界书写回及其它未改链路仍需逐项审计，不以全局替换日志级别代替风险路径设计。只读链路的当前事件：

| 事件 | 默认级别 | 诊断内容与结果 |
| --- | --- | --- |
| `message.degraded` | warn | `MESSAGE_NOT_OBJECT`、`MESSAGE_BODY_NOT_STRING` 或 `MESSAGE_SWIPE_INVALID`；原始/对话索引、字段、预期约束、实际类型、相对源码位置、占位/保留正文结果与恢复动作 |
| `export.content_warning` | warn | 规则未命中、处理后为空或标记未配对；具体楼层、处理阶段、需确认的跳过/处理结果，不记录规则和正文 |
| `operation.failed` | warn | 操作/阶段、具体失败原因、白名单字段/类型/位置/数量、暂停结果及重读、修改参数或确认继续动作；不是不可恢复事故 |
| `export.risk_confirmed` | info | 当前预览的警告数、跳过数及不可读数；不代表对未来计划永久授权 |
| `document.save_failed` | warn | 可重试的文件保存失败；不重复记录已经在上游记过的同一异常 |

聊天导出 schema 校验日志保留例如 `settings.assistant.includeRules[0].end` 的字段路径、规则序号、预期 `string` 与实际 `number`，不展开规则值、未知 key 或任意异常 context。未知异常在脱敏模式中只记录安全类别、发生操作及调用边界位置；完整模式保留经过密钥保护的异常栈。损坏聊天的降级事件在默认模式中即可定位，不能只留下笼统 `INVALID_MESSAGE`。

聊天清洗的 `message.degraded` 使用 `warn`，默认脱敏字段包含 `operation`、`stage`、`messageIndex`、可选 `swipeIndex`、`field`、`expected`、`actualType`、`reason`、`sourceLocation`、`outcome` 与 `nextAction`。候选非字符串、投影不一致、reasoning 异常、冷候选读回失败等有独立原因；候选读回失败不记录未知底层错误详情。手动/自动计划与完成事件包含局部异常楼层和清除候选数量，不记录整份计划/未知候选 metadata，即使完整模式也不展开这些对象。目标冲突、身份变化、需要确认及可重试保存失败记录 `warn` 并停止当前操作；其它功能继续运行。预览成功可同时携带局部警告，不将警告冒充整批失败。

世界书加载事件已在内核订阅边界统一校验。AI 激活和冲突检测的契约失败由各自运行时记录一次 `host.event_contract_failed`（warn）：包含 `operation`（`routing.apply` 或 `suppression.filter`）、`stage: host.event-validation`、`HOST_EVENT_INVALID`、独立 `reason`、固定 `sourceLocation`、白名单 `field`（payload 或四组 lore 名称）、`expected`、`actualType`、`outcome: round-skipped` 与 `nextAction: retry-generation-or-check-host-version`。不持久化负载、条目正文、世界书名称或未知异常详情；不另加一条内核重复日志。非法事件只跳过本轮插件处理，不永久禁用功能；AI pending 被丢弃，下一次合法事件恢复交付。此分级仅覆盖该事件契约失败链路，不宣称其它世界书操作已完成审计。

## 模型预设值保护

日志内核维护仅存在于运行期内存的受保护值集合，保护所有非空的模型预设名称、API URL、模型名和访问密钥。日志功能启动前从 `llm-presets-v1` 提取并注册；读取失败时日志功能保持不可用，其它工具继续运行。加载、保存、获取模型和测试连接前会先注册当前草稿中的值，保存成功后再注册规范化值。集合在本次页面运行期间只增加、不移除。

字符串精确匹配统一替换为 `[REDACTED_PROTECTED_VALUE]`，替换发生在事件进入内存、console、分块或导出之前；JSON/LOG 导出只消费已经处理的事件。模型服务错误（加载、保存、获取列表、测试连接）只记录稳定 `operation` 与安全 `kind`，即使完整模式也不记录未知错误的 message、stack、响应正文或完整 Error 对象。

## 存储与导出

日志索引和 JSONL Blob 分块位于 `tt-toolkit` namespace 的 `logs` table。默认总容量为 20 MiB，可配置 1–200 MiB。超限时先删除最旧的已结束会话；单个当前会话仍超限时删除其最旧分块并标记已淘汰字节数。分块编号在当前会话内持续递增，不按剩余分块数生成；淘汰后不回退或复用编号，即使所有分块都被淘汰也不例外。重启不续写旧会话，新会话使用独立 ID 和从 1 开始的编号。新版按功能日志使用 schema v2；检测到 schema v1 时会停止记录并要求显式清空，不会根据旧 `scope` 猜测功能归属。宿主前端日志副本复用同一 `logs` table、`index-v2` 和 JSONL 分块，不新增数据域，容量淘汰、会话淘汰和清空行为同时作用于两类事件。

读取索引时，任何会话内或跨会话的重复 Blob key 都以 `DUPLICATE_LOG_CHUNK` 拒绝。可能已经被覆盖的原文不能靠重编号恢复；只停止日志记录，其它功能继续运行，不自动去重、删除或覆盖旧索引。用户可自行备份现有日志存储，再在“设置 / 日志”手动清空并重新启用。

分块写入、容量清理和索引写入失败分别以 `LOG_BLOB_WRITE_FAILED`、`LOG_RETENTION_FAILED` 和 `LOG_INDEX_WRITE_FAILED` 发出 `warn` 诊断，记录阶段、源码位置、安全分块序号/事件数、处理结果及恢复动作，不把未知错误详情写入 console。持久化暂停后继续内存记录，界面提示先导出可读日志、检查存储、手动清空后重新启用。重复索引校验同样使用 `warn`，只记录字段和安全索引，不记录原始会话 ID 或本机路径。此分级复核仅覆盖本次索引验证、分块持久化、设置保存中的容量清理及停止时索引保存；其它日志操作仍待逐项审计。

查看器位于“设置 / 日志”，默认显示当前运行会话的全部功能和全部级别，支持按功能、会话、级别、来源和文本组合筛选。每行显示功能标签，展开后可查看完整结构化事件；宿主条目在脱敏会话中显示“消息因隐私模式未保存”，完整会话展示经过受保护值替换后的 `message` 与可选 `target`。

导出区位于日志列表之前，使用一个 JSON/LOG 格式选择器和“导出文件”“复制到剪贴板”两个操作；两种操作都严格使用当前筛选结果，空结果也会生成合法的空 JSON 或空 LOG。文件导出与聊天文档、提示词 TXT 共用 `host.exportFile()`，调用宿主保留前端接口 `utils.download(..., { throwOnFailure: true })`，不自行调用浏览器保存选择器或拼接下载链接。按宿主 delivered 布尔结果反馈完成/取消，不推测平台和保存位置。宿主负责系统交付和通知，插件不重复通知；插件诊断保持脱敏，但维护者已接受宿主在接口失败时向 console 打印原始异常（可能含路径等未知详情）的副作用。复制和导出结果也会在操作区显示即时状态：成功反馈 4.5 秒后消失，已发起/取消反馈 3 秒后消失，错误持续显示。损坏的设置需要重置设置；损坏或旧版日志索引需要清空日志，不会被自动覆盖。宿主流不可用、运行期降级、持久化失败、损坏 schema 与“没有匹配日志”使用不同状态提示。

日志文件导出在序列化前记录 `export.file_started`，宿主返回后记录 `export.file_completed`（info，含 format、数量、mode 与 outcome）；取消也记录 outcome=cancelled，不再留下诊断盲区。序列化、写出和剪贴板失败使用 warn，带 operation、stage、独立 reason、固定 sourceLocation、outcome 与 nextAction，不展开未知异常详情、路径或正文。未知 AbortError 记录中止并提示无法确认是否主动取消，不自动重试；只有已核对的宿主取消结果作为正常取消。此复核只涵盖这三个 UI 操作和新导出适配器，不宣称其它未审计日志操作已完成。
