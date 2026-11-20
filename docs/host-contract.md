# TauriTavern 宿主契约

TT-Toolkit 只面向 TauriTavern，同时使用其专属公开 ABI，以及由当前 TauriTavern 源码验证仍受支持的 SillyTavern legacy ESM 导出。使用 legacy 导出不表示兼容原版 SillyTavern。

## 验证基线

- 聊天清洗生成门卫及保存恢复复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对下述生成状态、群聊结束事件、保存队列、刷新和 metadata 写入时序；未做实机验证。
- 生成事件与收尾复核：同一 `2.4.0` / `0a7e7a55e3ac` 基线，确认按钮门控、停止/消息事件、真正的空闲等待接口及群聊 `finally`；仅源码与模拟验证。
- 聊天身份及 metadata 镜像复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对固定 handle、文件提交、当前内存对象的替换和 legacy 整体保存；仅源码和模拟验证。
- 宿主订阅清理复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对异步返回取消函数与 legacy 事件注册/移除；仅源码和模拟验证。
- 宿主 console 捕获取消读取复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，源码证据见下文“日志与存储”；未做实机验证。
- 模型密钥日志边界复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对 `src/tauri/main/api/dev.js:61-77` 和 `src/tauri/main/services/dev-logging/frontend-log-capture.js:238-282,486-499` 的宿主前端日志副本。Toolkit 只处理收到的副本，不改写宿主捕获的数据；未做实机验证。
- 通用文件导出本轮验证：TauriTavern `2.4.0`，本地源码提交 `0a7e7a55e3ac`；仅复核下述导出链路，不宣称其它能力已在此提交重验。
- 其它能力沿用基线：TauriTavern `2.3.0`，本地源码提交 `3fe9e055b512`
- 本轮复核：世界书条目图片使用的 `Message` / `MessageCollection` 导出、`Message.createAsync` / `addImage` / `MessageCollection.getChat`、`CHAT_COMPLETION_PROMPT_READY` 的可变 `chat` 数组与 `Message.addImage` 吞错行为（均核对下述同一 `0a7e7a55e3ac` 提交）；世界书决策的生成登记/扫描时序、prompt 正则、严格条件宏、资格过滤、末位异步监听与最终激活 Map；Android IME 键盘避让使用的 `--tt-ime-bottom` 公开变量与默认目标 `#sheld`（`WebViewInsetsStyleApplier.kt`、`mobile-ime-surface-controller.js`、`docs/API/Layout.md`）；通用导出/通知及其它能力沿用下述分项记录，不宣称全部重验或实机通过。
- 独立插图功能复核（同一 `2.4.0` / `0a7e7a55e3ac` 基线）：`world-info-images` 独立订阅既有生成事件，不依赖世界书管理器启用；图片描述交既有 `Message.createAsync('user', text, identifier)`，随后 `addImage`（`openai.js:5193,5270`），无新增宿主调用。条目引用与描述复用 fresh 读取和整本快照比对写回；`worldinfo-routes.js:12,38` 分别读取原始 JSON 字节和提交完整 JSON，不以条目正文承载描述。验证范围为拆分、描述往返、注入和原文保持，不宣称其它链路本轮重验。
- 挂载世界书快照复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对挂载来源、工作缓存与预热边界；仅源码和模拟验证。
- 提示词查看与插图联动复核：TauriTavern `2.4.0` / `0a7e7a55e3ac`，核对组装数组、首位监听、顺序等待和注销；未做实机验证。
- TT-Toolkit 适配边界：`src/kernel/host.js` 的 `TauriTavernHost`。能力方法按域拆在同目录：`host-abi.js`（常量、`requireAbi()`、动态导入）、`host-store.js`（extension store、Blob 列举与 `dev.frontendLogs`）、`host-chat.js`（聊天身份/保存/事件）、`host-world-info.js`、`host-generation.js`（宿主事件、生成与决策条件）、`host-prompt.js`（PromptManager 快照/冲突来源、图片消息构造与查看器补录）、`host-entry.js`（魔棒入口与文件导出）。功能模块仍只允许经过该边界访问宿主。

宿主源码提交自 `439216353260` 前移后引入了新的公开 chat handle 能力（per-chat store、locate/searchMessages、分页 history）。2026-09-02 消息书签审计重新确认了聊天保存、消息删除、聊天事件、聊天身份与 per-chat store 契约。2026-09-13 提示词查看设计审计在 `db4186da1e6e` 重新确认了 PromptManager 组装快照、Chat Completions 组装事件、世界书激活事件与宿主输入框契约；其余能力行沿用上次核对结论，使用对应能力前应按本节要求重验。

新增或改变宿主调用时，必须在本地 TauriTavern 源码中重新确认导出、参数、返回值、错误和生命周期，并更新本节基线。正式文档和当前源码冲突时立即暂停讨论；不得用猜测式兼容掩盖差异。

## 已验证能力

| 能力 | TauriTavern 证据 | TT-Toolkit 使用与验证 | 失败策略 |
| --- | --- | --- | --- |
| 扩展启动 ABI | `src/tauri/main/api/` 下的 `chat`、`extension.store`、`layout`、`dev.frontendLogs` 及 `invoke.safeInvoke` | `src/kernel/host-abi.js` 的 `requireAbi()` 与 `src/kernel/host.js` 的 `initialize()` | 缺少必需 ABI 或 legacy 导出时停止初始化 |
| 工作台键盘高度（Android IME） | `docs/API/Layout.md:80-81,151-176` 的 `--tt-ime-bottom` 与 surface-local 语义；`docs/AndroidDevelopment.md:41,52`、`docs/CurrentState/MobileStyleAdaptation.md:55,62,174` 说明 Android 键盘不改写 WebView viewport、变量注入 active IME target root、默认回退 `#sheld`；`WebViewInsetsStyleApplier.kt:61,84-103,106-119` 的 `IME_BOTTOM_VAR` / `requireDefaultImeTarget` / `applyImeBottom`（默认 `#sheld`）与 `AndroidInsetsBridge.kt:172-175` 的 IME inset 采样；`mobile-ime-surface-controller.js:185-208` 在无可编辑目标时 `setImeTarget(null)`，回到默认回退；宿主 `src/style.css:122` 的根声明 | `src/ui/keyboard.js` 在安装时读取默认承接节点 `#sheld` 上的该变量，与可视视口差值取较大者，发布为 iframe 根节点的 `--ttk-keyboard-inset`；只监听该节点的 `style` 变更，用于 Android 键盘弹出/收起 | 缺少节点或变量、非有限值或非正值一律按 0 处理，只用可视视口差值；不猜测其它 IME 目标、不遍历宿主 DOM、不调用内部原生桥、不改写宿主节点与变量 |
| 移动外壳几何与安全区 | `docs/API/Layout.md` 的稳定 `--tt-inset-*` 与 `backdrop` taxonomy；`src/tauri/main/compat/mobile/mobile-geometry-firewall.js` 的 body 范围规则（fullscreen-window 四边收缩、backdrop full-bleed）。本轮仍核对上述同一提交与版本，不依赖 private classifier/iframe bridge | 外壳 overlay 显式标记 `backdrop`；从顶层文档以 CSS padding probe 读取宿主 inset 与 iOS env 的较大值，桥接为 iframe 的 `--ttk-safe-*`；全屏工作台标记 `fullscreen-window`，自有 CSS 四边 inset 消费输入，清除悬浮几何，不用 JS 计算全屏宽高。宿主 firewall 不跨 iframe，标记不表示宿主自动接管其内部几何或 IME；无新增 `api.layout` 方法或原生全屏调用，尺寸记忆复用 extension store | 根节点 style/resize 变化重新测量；不让宿主 CSS 与插件重复收安全区；真实 Android/iOS WebView 及 IME 行为待实机验收 |
| Extension store | `docs/API/Extension.md`、`src/tauri/main/api/extension-store.js`、Rust `file_extension_store_repository.rs`（本轮复核 `setJson` 覆盖语义与临时文件写入/替换，手机布局复用原 key 与调用） | 固定 namespace `tt-toolkit`；当前基线再次确认 `deleteBlob()` 对缺失文件抛出 not-found，并非幂等；详见 `docs/storage-contract.md` | 非缺失错误继续抛出；日志不以忽略删除失败掩盖重复 key，重复索引停止记录并要求显式重置 |
| 聊天身份和 metadata | `docs/API/Chat.md:154-169`；`src/tauri/main/api/chat.js:25-27,56-62,228-240,385-392,435-441` | 从同一 handle 取得具体 ref 和 stable ID；metadata 写入使用已验证的 handle，文件提交和内存镜像结果分开 | 身份不可读、切换或缺 ABI 时不发出写入；宿主确认提交后无法复验则只跳过镜像，不重试写入 |
| 每聊天扩展存储 | `src/tauri/main/api/chat.js` 的 `store.getJson/setJson/updateJson/renameKey/deleteJson/listKeys`；Rust `file_chat_repository/extension_store.rs`；正式文档 `docs/API/Chat.md` | 尚未使用；消息书签设计预留（`docs/chat-bookmarks-audit-and-design.md`），详见"每聊天扩展存储"一节 | 功能级必需能力：缺失或启动失败只停用对应功能 |
| Canonical 聊天和保存 | `/scripts/st-context.js` 的 `getContext()`；`src/script.js` 的 `saveChat()` / `reloadCurrentChat()`；`src/scripts/group-chats.js` 的 `saveGroupChat()` | 只读取 `getContext().chat`；角色和群聊分别保存，批量修改后统一刷新 | 不扫描 `.mes` DOM；保存前验证身份和目标原文 |
| 只读聊天消息投影 | `src/global.d.ts:67-87` 的可选正文/swipe 与第一类 tool；`src/script.js:8218-8254` 的候选校验；`src/scripts/tool-calling.js:1074` 的 tool 写入；`docs/CurrentState/ChatPayload.md:56-62` 的冷候选 | `src/kernel/chat-projection.js` / `chat-messages.js`；查看/导出共用不可读占位、当前 mes 与白名单诊断 | 单条异常局部降级；遗漏内容须明确确认，未知目标/消息集合不可用时仅拦截当前操作，不猜测原文 |
| 聊天清洗与冷候选 | `src/global.d.ts:78-79`；`docs/CurrentState/ChatPayload.md:56-64`；`src/script.js:6739-6752` 导出 `hydrateChatMessageSwipes()`；`src/scripts/tauri/chat/cold-swipes.js:71-90` 原地填充/导航校验；storage-core `file_chat_repository/cold_swipes.rs:326-346` 禁止未读回缩短数组；`script.js:10852-10889` 删除候选前读回、对应删除 swipe_info 并重置索引 | `host.hydrateChatSwipes()` 仅为清洗目标读回冷候选；`assertIdentity(stableId, ref)` 防同 stable ID 角色分支切换；纯计划局部诊断并支持只保留当前候选，写前复验全文/候选结构/待删除信息 | 读回/可选字段异常只跳过相关字段；身份/目标变化停止当前操作；冷引用未解除不缩短数组；不改宿主源码，不调用内部 invoke；测试见 plan/runtime/transaction/schema/chat-cleaner-page/host-chat-viewer |
| 清洗写入的生成门卫 | `src/script.js:1007,4286-4293,5111-5185,5233,6967-6988`；`src/scripts/group-chats.js:1132-1171`；详见下文生成事件时序 | `GENERATION_ENDED(chat.length)` 只是候选信号，延后至 `waitForGenerationIdle()`，群聊另须等 wrapper 清理。新的非 dry-run 开始、停止和聊天切换使未提交的候选过期 | 缺失结束证据或空闲接口不自动写；派发正文、刷新和进度前仍复验生成状态；已发出的宿主保存不可撤回 |
| 聊天事件和跳转 | `src/scripts/events.js:117`；`src/lib/eventemitter.js:40-59,87-123` 的 `on` / `makeFirst` / `removeListener`；`src/scripts/slash-commands.js` 的 `/chat-jump` | 事件令只读快照过期；`onHostEvent` 先确认能注销再注册，注册抛错时尝试注销本次回调；跳转前复验 stable ID 和索引 | 事件、注销方法或命令执行器缺失时显式报错；群聊结束事件注册失败撤销已注册的成员结束监听 |
| 世界书决策扫描 | `world-info.js:4933` 四组可变数组、`:5142–5235` 禁用/生成/角色/标签/定时/常驻资格顺序、`:5501–5531` 最终 activated.entries Map；`eventemitter.js:66` makeLast、`:130` await 派发 | `subscribeWorldInfoEntriesLoaded(..., { last: true })` 验证后交付原引用并等待决策；扫描局部 clone 负向 disable、正向 constant，保留预算/分组，不发强制激活事件 | 非法事件/请求/身份/目标异常本轮原生回退。末位只保证注册时；无法区分有效生成内其它扩展加载，已接受付费时机/激活歧义 |
| 决策上下文与生成门卫 | `script.js:5128/5150` START/AFTER_COMMANDS 先于当前用户入列、`:5239` regenerate 删除旧回复、`:5337–5349` 过滤/swipe/continue 深度；`regex/engine.js:293,361,472` placement/prompt 资格/getRegexedString；`script.js:3637` substituteParams | `formatDecisionText()` 仅 prompt 正则；`expandDecisionCondition()` 严格宏；`decisionEligibility()` / `decisionCharacterKey()` 保留原生资格与生成角色，完整聊天 ref/stable ID、消息/目标前后守卫 | 缺接口、异常或非字符串不回退原文；STOP/END/CHAT_CHANGED 中止；dry-run 不付费，不请求宿主改动 |
| 世界书管理器读写 | `src/scripts/world-info.js:39-44` 的 logic 0/1/2/3 顺序为 AND_ANY/NOT_ALL/NOT_ANY/AND_ALL；`:950-959` 的 position 0–7；`:4240-4286` 的默认模板；`src/scripts/world-info-persistence.js:113-129` 的立即保存；`src/tauri/main/routes/worldinfo-routes.js:12-19,38-55` 的 get/edit；`tt-adapter-storage-userdata/src/repositories/file_world_info_repository/document.rs:13-21,29-39` 验证整本 JSON 包含 `entries`，不验证单条类型（本行读写以 `2.4.0` / `0a7e7a55e3ac` 复核） | `src/kernel/host-world-info.js` 的 `loadWorldInfoFresh()` 绕过宿主缓存读取磁盘事实源、`saveWorldInfo()` 立即写入；管理器写前比对整本快照（键序无关，见 `src/kernel/snapshot.js`），只把草稿中变更的字段合并写回完整对象，写入成功后以磁盘回读作为新快照；原字段（含书级 `extensions`）保持不变 | 读取、快照复验或写入失败则保持草稿、阻止切换，不静默覆盖；键序变化不算改动，字段值变化仍然拦下；`null` 等异常条目仅降级该行，经确认可按原始键删除，目标或整本快照变化时停止；见 `docs/world-info-editor.md` |
| 宿主前端日志 | `src/tauri/main/api/dev.js:61-77` 的 `frontendLogs.list()`、`subscribe()`；`src/tauri/main/services/dev-logging/frontend-log-capture.js:466-499` | 日志功能独立探测并在启用时读取尾部、实时订阅、校验 DTO；不读取宿主 console 捕获状态 | `list`、`subscribe` 缺失或启动失败只停用日志功能；不调用有副作用的捕获状态 getter、setter 或内部 `devlog_*` |
| 通用文件导出与通知 | `src/scripts/utils.js:362` 的 `download()`，内部 `file-export.js:4` 的 `deliverBlob()`；`download-feedback.js` 的宿主通知；Rust `presentation/commands/file_transfer_commands.rs` 的 `DeliveryResult` / `deliver_staged_file` 与 `platform/file_transfer/` 的 Delivered/Cancelled | 全部文件导出共用 `host.exportFile()`，调用保留前端 ESM `download(content, filename, mimeType, { throwOnFailure: true })`，content 只接受非空字符串；只接受布尔 delivered，不依赖平台实现、路径或 URI，不重复通知。不是正式 `api.*` ABI | 缺能力/非法结果只停当前导出；true 完成、false 取消；拒绝为 warn，不假定取消、不重试。宿主失败时先打印原始异常；维护者已明确接受该副作用，插件自身诊断仍脱敏 |
| OpenAI-compatible 原生传输（保留） | Rust `chat_completion_commands.rs` 和 invoke 命令注册表 | 仅 openai 协议通过 `safeInvoke` 调用状态、生成和取消，传入独立预设；不供决策使用 | 不借用宿主当前模型设置；取消和密钥不进入日志 |
| System One 决策直连 | 浏览器标准 fetch，无新增宿主 ABI 或代理要求 | `kernel/decision-model.js` 直连自定义 URL，精确 noul 协议；GET 模型或一次 POST 判定，不自动付费探测 | CORS/网络/HTTP/超时/响应错误正常脱敏回退；不修改宿主，不宣称已真实连通 |
| Extensions menu | `src/scripts/extensions.js:267-277,925-962,971-979` 导出 `ensureExtensionsUiReady()` / `showHideExtensionsMenu()`；`templates/wandButton.html` / `wandMenu.html` 的 `#extensionsMenuButton` / `#extensionsMenu`；`src/style.css:1202-1233` 的菜单项样式。两个函数在宿主提交 `00156ea7`（2026-09-03）才由私有函数改为导出，因此分界是**构建时间**而不是版本号：本地已打的全部 tag（最新为 `v2.2.0`，2026-07-31）都早于该提交、不含导出；`main` / `dev` 当前 2.3.0（`a1855be4` / `3fe9e055`）已包含导出，稳定版 2.3 从 `main` 构建同样包含。判断宿主构建是否支持可看同一提交新增的“管理快捷入口”（`src/locales/zh-cn.json` 的 "Manage Quick Access"）。导出存在与否由宿主实际提供的脚本决定，不是运行期状态；`tauri.conf.json` 的 `frontendDist: ../../../src` 让 APK 原样携带构建时的 `src/scripts/extensions.js` | 无公开注册 API；维护者已接受窄 DOM 集成。`host.mountToolkitWandEntry()` 惰性导入模块、等待初始化，添加插件自有 `#tt-toolkit-wand-entry`，点击打开既有 iframe，事件冒泡交宿主关闭菜单；切换/销毁时仅移除自有节点与监听器 | 缺少导出/节点或重复入口只停止魔棒设置，不停用其它功能；启动失败显式保留悬浮球并提示重试，切换失败保留原入口。缺少导出按宿主能力缺失处理（恢复动作 `upgrade_or_replace_host_build`，提示升级或更换宿主构建，不引导重载宿主）；节点缺失/重复入口按可重试失败处理；不修改宿主源码。该原因码只描述实际加载到的 `/scripts/extensions.js` 没有这两个导出；若在 2026-09-03 之后的构建上仍出现，应先按实测确认该文件内容（构建指纹：“管理快捷入口”），不得直接归因为宿主构建过旧 |
| Chat Completion 组装快照 | `src/scripts/openai.js:739` 的 live `promptManager`；`PromptManager.js:1847` 的 `setChatCompletion`；`openai.js:5560` 的 `MessageCollection.flatten()`；`Message.identifier/tokens`；`promptManager.tokenHandler.counts` | 提示词查看只读投影最近一次正文组装，见 `docs/prompt-viewer-development-plan.md` | `promptManager` 或必需方法缺失时功能级 fail-fast |
| Chat Completions 组装事件 | `openai.js:2500-2522` 从 `getChat()` 得到当次可变数组、等待 `CHAT_COMPLETION_PROMPT_READY` 后返回；`src/lib/eventemitter.js:87-112,130-153` 的 `makeFirst` / `removeListener` / 顺序 `await`；`script.js:5233/5255` 的 `GENERATION_STARTED` / `GENERATION_AFTER_COMMANDS`，`world-info.js:5501-5531` 的 `WORLDINFO_SCAN_DONE` | 按最终激活集合先原地插入 `user` 图片，查看器再按同一 `chat` 数组补录。不依赖两个功能的注册顺序 | 查看器遇非法 payload 报契约错误；缺少首位监听接口时只停插图，不猜测监听顺序；Agent 不覆盖 |
| 宿主图片消息工具 | `openai.js:99-111` 导出 `Message` / `MessageCollection`；`openai.js:5197` 的 `Message.createAsync`；`:5270` 的 `addImage`（非 Data URL 会自行 fetch 并吞错返回）；`:5373` 的 `compressImage`；`:5560` 的 `MessageCollection.getChat` | `host.buildWorldInfoImageMessage()` 只传已校验的 Data URL，并按内容数组长度变化确认至少一张图真的附上；不实现各 provider 媒体协议 | 导出或 `addImage` 缺失时只停附图；实际未附图按失败处理，不发半成品消息 |
| 扩展存储 Blob 列举 | `src/tauri/main/api/extension-store.js` 的 `listBlobKeys` | `host.storeListBlobKeys()` 目前仅供诊断与后续清理评估，运行时不遍历 | 失败不当成空列表，不据此删除任何 Blob |
| 世界书激活事件 | `world-info.js:1000` 的 `WORLD_INFO_ACTIVATED`、`world-info.js:5531` 的 `WORLDINFO_SCAN_DONE` | 提示词查看按 world/uid/comment/position 逐条归因，预测用 dry-run 的 `isFinal` 结果 | 事件缺失或 payload 非法时功能级 fail-fast |
| 宿主输入框 dry-run 预测 | `openai.js:1145` 的 `promptManager.tryGenerate`（内部 `Generate('normal', {}, true)`）；`src/index.html:8395` 的 `#send_textarea` | 提示词查看临时写入假设输入、触发 dry-run、在 finally 还原值与选区 | 入口或输入框缺失时禁用预测并显式提示 |
| Agent 专用条目过滤 | `openai.js:127-130` 的 `AGENT_SYSTEM_PROMPT_IDENTIFIER` / `AGENT_RESULTS_PROMPT_IDENTIFIER` / `AGENT_TASK_PROMPT_IDENTIFIER`；`openai.js:1945` 的 `removeAgentOnlyPrompts`（普通组装在 `openai.js:2080` 调用） | 提示词查看捕获普通口径时按这三个 identifier 过滤 | 未匹配到则不移除（fail-open），常量变更时以源码重验 |

入口契约、旧版设置迁移、切换失败保留入口与默认脱敏诊断由 `tests/toolkit-entry.test.js` 覆盖；设置页控制接口传递由 `tests/app.test.js` 覆盖；单选卡片、前置保存、草稿/生效与恢复提示由 `tests/toolkit-settings-page.test.js` 覆盖（不改变上述宿主 ABI）。魔棒菜单真实点击收起、主题样式与移动端表现仍需宿主实机验证。

相关实现至少由 `tests/host-chat-viewer.test.js`、`tests/host-logs.test.js`、`tests/logging.test.js`、`tests/logging-host.test.js`、`tests/transaction.test.js`、`tests/runtime.test.js`、`tests/host-world-info.test.js`、`tests/world-info-decision-host.test.js`、`tests/world-info-decision-context.test.js`、`tests/decision-model.test.js`、`tests/world-info-ai-schema.test.js`、`tests/world-info-ai-runtime.test.js`、`tests/prompt-conflict-host.test.js`、`tests/prompt-conflict-runtime.test.js`、`tests/prompt-conflict-analysis.test.js`、`tests/prompt-conflict-overrides.test.js` 和 `tests/prompt-conflict-schema.test.js` 覆盖；只读局部降级与诊断另由 `tests/chat-diagnostics.test.js`、`tests/chat-viewer-model.test.js`、`tests/chat-viewer-runtime.test.js`、`tests/chat-exporter.test.js`、`tests/chat-exporter-runtime.test.js` 与对应页面测试覆盖；提示词查看契约由 `tests/prompt-viewer-model.test.js`、`tests/prompt-viewer-schema.test.js`、`tests/prompt-viewer-host.test.js`、`tests/prompt-viewer-runtime.test.js`、`tests/prompt-viewer-page.test.js` 与 `tests/prompt-viewer-registry.test.js` 覆盖。表中契约变化时，应更新对应测试，而不是只改适配器。

## 聊天读取、写回与跳转

当前写回链路读取 `getContext().chat`，以 `api.chat.current.handle().stableId()` 绑定聊天身份。角色聊天调用 `/script.js` 的 `saveChat()`，群聊调用 `/scripts/group-chats.js` 的 `saveGroupChat()`，最后通过 `reloadCurrentChat()` 统一刷新。

消息角色判定以 `/scripts/system-messages.js:18-32,111-124` 的已知 `extra.type` / `uses_system_ui`、第一类 `role: 'tool'`、legacy `extra.tool_invocations` 和 `is_user` 为依据。第一类 Tool 由 `/scripts/tool-calling.js:1074` 写入，`/scripts/tauritavern/tool-turn-projection.js:61` 以 `role` 为角色事实，不依赖可编辑的 legacy booleans；`src/global.d.ts:67-87` 声明该结构。`/scripts/chats.js:142-165` 的隐藏操作会直接设置 `is_system`；`/script.js:5337-5338` 在生成上下文中按该字段排除消息，因此它不能独立证明语义角色。`/scripts/system-messages.js:102-110` 的安全提示也可能只带 `is_system`、不带明确类型：无法与仅以此字段隐藏的 AI 消息可靠区分。按当前清洗、查看/搜索与导出的约定，明确的 system/tool 消息排除，其余按 `is_user` 分用户/AI，包含无类型的 `is_system` 楼层；这意味着少量无明确类型的真正系统提示可能被纳入。自动清洗的事件门卫同样按上述角色判断，不再直接跳过 `is_system`。当前 `/script.js` 的 `getFirstMessage()` 为角色首条问候写入 `is_system: false`，`/scripts/group-chats.js` 的 `getFirstCharacterMessage()` 还写入 `original_avatar`。

`/script.js` 在普通生成前通过 `chat[0].mes = substituteParams(chat[0].mes)` 更新角色首条问候的当前投影；`syncMesToSwipe()` 也明确允许 pristine greeting 暂不把该投影写回 swipe，以便问候宏再次解析。因此角色聊天绝对楼层 0 的 `mes` 与 `swipes[swipe_id]` 不相等是合法状态：前者作为当前展开投影、后者作为持久原文分别处理和复验。其它楼层两者不一致时，清洗保留该楼层正文及候选结构并发出局部警告，其它可定位字段/楼层继续；不猜测修复。

聊天查看与聊天导出以完整 `chat[]` 为唯一消息事实源，并共用同一对话消息投影和 stable ID/ref 绑定。公开 ref 字段由 `src/tauri/main/api/chat.js:8-10,435-441` 与 `docs/API/Chat.md` 确认；角色分支可能共享 stable ID，下载和跳转还比较 characterId/fileName 或 group chatId，不把风险确认作为身份验证的替代。聊天导出读取当前 `mes`，不以 `extra.display_text` 或 `swipes[swipe_id]` 替代正文；文档完全在前端内存中生成，不调用宿主 `/api/chats/export`，也不触发 `saveChat()`、`saveGroupChat()` 或聊天刷新。启用期间订阅 `CHAT_CHANGED`、`MESSAGE_SENT`、`MESSAGE_RECEIVED`、`MESSAGE_EDITED`、`MESSAGE_DELETED`、`MESSAGE_UPDATED` 与 `MESSAGE_SWIPED`。事件负载不代替重新读取；注销兼容宿主实际提供的 `removeListener()` 与可能存在的 `off()`。

只读投影中的单条消息结构/正文异常保留不可读占位并记录局部诊断；不猜测原文、不修复宿主数据，不影响其它消息。所选导出范围中的不可读消息可经明确确认跳过。候选信息只作展示：`src/script.js:8218-8254` 的 `syncMesToSwipe()` 对非法候选结构直接退出，`src/global.d.ts:78-81` 允许未加载候选为 null；本插件不读取其它候选正文，候选编号异常不阻塞当前 `mes`。聊天清洗通过保留 legacy 导出 `hydrateChatMessageSwipes(messageIndex)` 先读回处理范围内的冷候选，再重建计划；成功返回 true 表示仍为同一消息，返回 false 表示楼层/聊天在读回期间改变，读回错误须保留未加载字段。TT-Toolkit 在 await 前后额外验证完整聊天 ref 与 stable ID。永久写回仍验证所有计划目标，局部异常不猜测改写；无法定位候选时保留该楼层正文/结构，不因一个非字符串候选拒绝整批预览。未解除 `tt_swipe_cold` 时不删除槽位，避免 storage-core 保存合并拒绝。只保留当前候选时同时保留当前 swipe_info，重置 swipe_id=0；当前 mes/extra 不被替换为候选信息，问候宏投影仍独立。

跳转使用 `getContext().executeSlashCommandsWithOptions('/chat-jump <绝对索引>')`。插件调用前重新验证 stable ID、聊天 ref、绝对索引和可读的预览目标，成功后关闭工作台；搜索高亮只渲染在插件 iframe，不修改宿主正文。

`GENERATION_ENDED(chat.length)` 由 `src/script.js:4286-4293` 的 `hideStopButton()` 在 stop 按钮由显示变为隐藏时发出，不是成功回执。`:5233-5273,5362-5364` 的部分早退发生在按钮显示前；`:6967-6988` 的主动停止可能先隐藏按钮，再发 `GENERATION_STOPPED`。正常流式路径先解锁、再发 `MESSAGE_RECEIVED` 并保存（`:4578-4606`）；异常流式路径也可能发 `MESSAGE_RECEIVED`（`:4608-4622`），`MESSAGE_SENT` 只是用户消息入列（`:7278-7288`）。`GROUP_WRAPPER_FINISHED` 在群聊 `finally` 发出（`group-chats.js:1160-1171`），也不报告成功。任何一个都不能单独证明该轮成功。

插件使用保留导出 `waitForGenerationIdle()`（`script.js:5111-5185`、`scripts/util/generation-idle-gate.js:18-43`）：只等待生成调用和至少本次宿主收尾，不代表有回复或内容已保存成功。监听器不向宿主返回等待空闲的 Promise，避免阻塞宿主自身的收尾。自动清洗只在已观察到非 dry-run 正文轮次、同一具体聊天的合法 `chat.length` 结束候选、当前尾楼层确有变化、且宿主空闲后派发；群聊还须等 wrapper 清理。STOP 作废候选，不把消息事件、wrapper 或空闲单独当作写入许可。缺少结束证据时提示可手动预览。无独立成功事件，不能区分所有没有 STOP 的异常流式退出；宿主实机路径尚未验证。

`saveChat()` / `saveGroupChat()` 内部使用宿主保存队列（`src/script.js:640-656,8834-8841`、`src/scripts/group-chats.js:708-710`）；生成状态检查是插件侧派发门卫，不是宿主原子锁。`runChatSave()` 会重新抛出非 integrity 错误；legacy 保存返回不提供独立的落盘回执（`src/script.js:8867-8899`、`src/scripts/group-chats.js:726-729`）。`reloadCurrentChat()` 由 mutex 调度并读取届时的宿主当前聊天（`src/script.js:2352-2375`）；插件仅在派发前验证 stable ID、具体聊天 ref 和生成状态，不能锁住宿主刷新期间的切换。清洗进度通过 `src/tauri/main/api/chat.js:56-62` 按已解析的聊天 ref 提交，不和正文共用一次原子提交。

`metadata.setExtension()` 按固定 ref 提交文件，且不自动修改当前界面的 metadata（`docs/API/Chat.md:154-169`、`src/scripts/tauri/chat/commit.js:38-45,65-76`、`file_chat_repository/chat_commit.rs:281-297` 与 `chat_metadata.rs:58-78,144-165`）。`src/scripts/st-context.js:143` 暴露活对象；重新载入或更新可替换对象（`src/script.js:9145,10571-10573`），角色和群聊的 legacy 保存可以把内存 metadata 整体写回（`script.js:8883-8891,11051-11073`、`group-chats.js:712-720`）。Toolkit 在派发前复验目标 ref、stable ID 与活对象；写入成功后，仅在原 ref、stable ID、同一活对象及可用的扩展字段都能确认时更新指定 namespace。返回 `{ persisted: true, localMirror: boolean }`；未做镜像时既不改被替换的旧对象或新聊天，也不额外刷新、回滚或重试。这里的 `persisted` 表示宿主确认这次提交，不保证后续独立的宿主保存不会覆盖，也不是文件与界面的原子锁。

## 每聊天扩展存储（chat store）

公开 chat handle 提供 per-chat JSON 存储：`handle().store.{ getJson, setJson, updateJson, renameKey, deleteJson, listKeys }`（`src/tauri/main/api/chat.js`，正式文档 `docs/API/Chat.md`）。`updateJson` 对对象深度合并、非对象整体替换；组件校验与全局 extension store 相同。

Rust 落点为聊天文件旁的 sidecar JSON（`file_chat_repository/extension_store.rs`）：

- 角色聊天：`<聊天目录>/.tauritavern/<integrity>/<namespace>/<key>.json`，按 integrity 寻址。分支谱系共享同一 store，聊天文件重命名不受影响。
- 群聊：`group_chats/.tauritavern/<chat_id stem>/<namespace>/<key>.json`，按文件名寻址。群聊分叉生成新 chat_id，新文件从空 store 开始。
- `listKeys` 对缺失目录返回空数组；`getJson`/`deleteJson`/`renameKey` 对缺失目标报 not-found（JS 侧确切形态使用前必须重新确认）。
- 删除聊天文件不清理 sidecar；该孤儿目录属宿主行为，插件不越权处理。

角色聊天的 `stableId()` 读取 `chat_metadata.integrity`，而 branch/checkpoint 通过 `{ ...chat_metadata, ...withMetadata }` 合并保存复制同一 `integrity`（`src/script.js:8717`、`scripts/group-chats.js:2467`），后端从不重新生成（`integrity.rs`）。因此 `docs/tauritavern-character-fork-stable-id-issue-draft.md` 的问题在当前基线依然成立：仅凭 stable ID 无法区分角色分支。需要区分具体聊天文件的永久写入，必须以 `api.chat.current.ref()` 的 kind、characterId、fileName / chatId 做 ref 级复验，stable ID 复验只作附加检查。

`MESSAGE_DELETED` 的负载是删除后的新 `chat.length`（`src/script.js:2211`），不是被删索引；宿主消息没有独立唯一 ID，消息以 `chat[]` 绝对索引寻址。依赖消息身份的持久数据必须自建"索引 + 内容摘要"锚定并自行处理索引漂移。

## 通用文件导出

日志文件、聊天文档、提示词 TXT 及决策配置共用 `src/kernel/host-entry.js:exportFile()`，惰性导入 `/scripts/utils.js` 的 `download(content, filename, mimeType, { throwOnFailure: true })`。当前正式 `api.*` 没有通用文件导出 ABI；使用已核对的保留前端 ESM 接口，不直接调用 `deliverBlob()`、Rust 命令或平台桥。

适配器 content 只接受非空字符串，filename／mimeType 也必须非空；宿主 `download()` 负责后续 staging 与交付，Rust 返回 DeliveryResult，不新增插件原生调用。

当前宿主返回 `{ delivered: boolean }`：true 表示宿主完成文件交付，false 表示取消。必须传 `throwOnFailure: true`，否则宿主也会把失败转为 false，无法区分取消。适配器输出固定 `mode: 'host-download'` 和 saved/cancelled，不推测具体平台、保存目录或 URI；非法结果停止当前操作，提醒先检查目标位置。任意 AbortError 不视为主动取消，所有异常不重试，插件日志只记录白名单原因/类型。

通知由 `download()` 自行管理，插件不重复通知、不移动宿主容器，页面保留结果提示。维护者已明确接受宿主自行通知、失败时打印原始异常的副作用；这部分 console 可能含路径等未知信息，不受插件脱敏保证。插件不劫持全局 console/toastr，也不持久化原始异常。

聚焦测试：`tests/host-file-export.test.js` 及页面/运行时测试覆盖调用参数、成功、取消、非法结果、缺接口、异常脱敏和不自动重试。桌面、Android、iOS 真实保存/分享及宿主通知层叠仍需实机验收。不宣称 ESM 接口拥有正式 ABI 的长期稳定性。

## 日志与存储

日志使用公开 extension store 的 JSON/Blob 多表能力，并通过 `api.dev.frontendLogs` 的 `list` 与 `subscribe` 接入宿主前端日志。两者是功能级必需能力而非全局必需 ABI：缺失或启动失败时只停用日志功能，其它工具继续运行；运行中的宿主流收到非法 DTO 时立即停止宿主接入并标记为降级，不自动重连，也不跳过非法记录继续猜测。

`docs/API/Dev.md:30,45-46` 把 `getConsoleCaptureEnabled()` 描述为读取，且不允许调用方直接读写相关 localStorage；但 `src/tauri/main/api/dev.js:41-45,73-78` 在持久设置与运行时不一致时调用宿主内部 setter。`frontend-log-capture.js:106-117,383-438,466-484` 表明它会更新宿主启动标记、替换或恢复主窗口 console，并扫描或恢复同源 iframe（见 `same-origin-iframe-log-capture.js:205-218`）；getter 不写入后端 dev 设置。已核对的公开 API 中没有无副作用的状态读取入口。Toolkit 在启动、启用/恢复记录、打开日志页时均不调用 getter，也不访问内部设置接口或 localStorage；日志页只提示到宿主设置查看，日志流和存储契约不变。恢复状态显示前须对新的宿主接口重新审计。

宿主 `FrontendLogEntry` 只允许携带已验证字段 `id`、`timestampMs`、`level`、`message` 和可选 `target`；未知新增字段一律忽略，只克隆已验证字段。`list()` 不传 `limit` 返回宿主当前保留的完整尾部；`subscribe()` 不复播历史，公开方法返回 `Promise<unsubscribe>`（`docs/API/Dev.md:27-30,45-50`）；`src/tauri/main/api/dev.js:61-72` 同步调用服务层注册，`frontend-log-capture.js:117-124,486-496` 将监听加入 `Set`，取消时按相同回调移除。Toolkit 合并订阅期间收到的条目与尾部，缓冲中若遇非法条目，立即禁止进一步交付，取消函数随后到达时只执行一次；运行期非法条目使用同一注销路径。如果宿主拒绝或不给可调用的取消函数，Toolkit 停止交付并报告契约失败，不能保证注销宿主已经挂上的监听。TT-Toolkit 不调用 `setConsoleCaptureEnabled`，也不得自动开启全局 console 捕获；Toolkit 结构化事件同步到 console 后可能被宿主重新捕获，宿主副本接收器只按固定四段 `[TT-Toolkit][featureId][source][event]` 前缀过滤回流记录。

宿主自身会在交付前截断部分 `message`。Toolkit 只脱敏其接收并记录的副本，无法补回已截断的密钥、改写宿主原始记录或撤回已交付文件；详见 [开发日志](./logging.md#模型预设值保护)。

extension store 的 `namespace`、`table` 和 `key` 只允许 ASCII 字母数字与 `_-.`，且不能为空、不能以 `.` 开头、不能为 `.` 或 `..`。完整数据布局、派生 key、schema、删除和隐私规则见 `docs/storage-contract.md`。

日志持久化暂停复核（TauriTavern `2.4.0` / `0a7e7a55e3ac`，未做实机验证）：`docs/API/Extension.md:79,85,103`、`src/tauri/main/api/extension-store.js:102-137,185-190` 和 Rust `file_extension_store_repository.rs:135-153,186-206,286-306` 表明 Blob 与 JSON 各自提交，不是跨条目的原子事务；清空删除同一表的 JSON 与 Blob 目录，出错不保证回滚。Toolkit 只用已返回成功的 Blob 和运行期索引补读，不扫描孤儿 Blob、不重试失败索引，也不把内存尾部当作已持久化。

历史日志 Blob 读重复核（TauriTavern `2.4.0` / `0a7e7a55e3ac`，未做实机验证）：`docs/API/Extension.md:101` 声明 `getBlob()` 返回 `Promise<Blob>`；`file_extension_store_repository.rs:158-174` 仅将文件打开的 NotFound 转为 `None`，权限等错误继续抛出；`extension_store_commands.rs:24-59` 向前端传递该空结果，`extension-store.js:29-30,60-63,140-149` 对明确空结果抛 `Extension store entry not found: <namespace>:<table>/<key>`。`host.storeGetBlob()` 只匹配实际调用对应的完整消息并映射为 `STORE_BLOB_NOT_FOUND`，其它错误原样向调用方传递；日志读取据此区分缺失和其它失败，不在诊断展示原消息。不改变宿主调用，不枚举或修复存储。

显式清空日志复核（TauriTavern `2.4.0` / `0a7e7a55e3ac`，未做实机验证）：`docs/API/Extension.md:85` 与 `src/tauri/main/api/extension-store.js:185-190` 指向 `extension_store_commands.rs:203-215`。`file_extension_store_repository.rs:286-306` 只在 JSON 与 Blob 目录均未找到时返回带目标表名的 `NotFound`；权限等错误继续抛出，即使另一侧目录已删。`tt-application/src/errors.rs` 和 `tauritavern/src/presentation/errors.rs` 保留 `NotFound` 变体，`src/tauri/main/services/invokes/invoke-service.js:182-191` 在 `Error.cause` 保留宿主原始结构。`host.storeDeleteTable()` 只将该结构中与调用目标精确匹配的缺表结果映射为 `STORE_TABLE_NOT_FOUND`，日志清空据此继续写空索引；不根据一般 `Not found` 文案推定为空、不预先列举表。

## 世界书加载事件边界

`WORLDINFO_ENTRIES_LOADED` 的负载契约由 `host.validateWorldInfoEntriesPayload()` 统一负责：根对象不能为 null 或数组，`globalLore`、`characterLore`、`chatLore`、`personaLore` 必须全部为数组。四组名称列表只在 `kernel/world-info.js` 的 `WORLD_INFO_LORE_LISTS` 声明，功能复用它而不自行定义宿主契约。未知附加字段不参与处理，不校验或丢弃条目正文等非必需信息。

`subscribeWorldInfoEntriesLoaded(listener, onContractError, options)` 要求两个回调都可调用。全部数组验证通过后才交付原 payload 并返回消费者 Promise，宿主扫描等待异步处理。决策使用 `{ last: true }`，只通过 `makeLast` 注册一次，不先调用 `on`；`src/lib/eventemitter.js:66` 注册/移到末尾，`:130` 逐个 await。末位仅在注册时成立，后注册或重排的其它扩展仍可能随后修改数组。消费者错误由自身降级处理；emitter 捕获异常继续派发不替代用户提示。

非法负载只调用 `onContractError`，不进入变更、不改数组、不补字段或永久关闭订阅。决策标记本事务失败并取消，不重放旧结果；下一合法事件恢复边界交付，但失败事务须下一轮重新登记。隐藏冲突检测的保留接线仅跳过本轮屏蔽，不改 metadata。诊断为白名单 `host.event_contract_failed`（warn），不展开 payload/未知错误。

`filterWorldInfoPayload` 与 `applyActivationDecision` 只接收此边界已验证的四组数据，不再各自解释宿主 schema；独立调用者须满足这一输入前提。此接线仅覆盖世界书加载事件，不宣称所有既有裸事件订阅已迁移。聚焦测试为 `tests/host-world-info.test.js` 及两功能的 runtime 测试；宿主实机扫描时序仍待验收。

### 挂载世界书的手动快照

`getMountedWorldInfoEntries()` 只读 `worldInfoCache`，按全局、聊天、Persona、角色顺序合并重复绑定。宿主来源见 `src/scripts/world-info.js:4551-4569,4582-4704`（角色额外书使用 `src/scripts/utils.js:1317-1322` 的头像文件名）。`world-info-persistence.js:8-9,34-65,113-119` 的缓存可能含尚未保存的工作文档；宿主切换聊天与正式收集会预热（`world-info.js:1076-1081,4704-4726`），打开世界书时也经由 `loadWorldInfo`（`:2184,6081`）。这不保证同聊天新挂载的书在手动测试时已进入缓存。

本插件在该快照路径不主动预热、不替换成磁盘内容或触发宿主扫描。有效的空 `entries` 是空书；缓存未加载或没有可读取的条目列表，整次手动快照以 `WORLD_INFO_SNAPSHOT_INCOMPLETE` 拒绝，提示在宿主打开相应的书后重试。书名仅用于界面提示，日志只记录计数、阶段和处理结果。决策条件测试不发请求；隐藏冲突检测不沿用已经确认不完整的来源，也不提交无法复验的屏蔽计划。不改变正式生成的事件路径。

## 世界书决策激活

功能 ID 保留 `world-info-ai`，已注册且默认关闭；模型服务已注册，冲突检测仍隐藏。挂载来源按 `selected_world_info`、`world_info` 和当前角色/聊天/Persona 绑定收集。关键词、向量、常驻普通条目均可接管，模板/dont_activate 不接管，手动禁用及角色名/标签/生成类型过滤按 `world-info.js:5142–5235` 保留原生资格。背景仅为挂载范围内原生且符合资格的常驻正文，预算、分组及注入顺序继续由宿主处理。

`script.js:5128/5150` 的 START/AFTER_COMMANDS 发生在用户正文入列前，因此 AFTER_COMMANDS 只登记事务，付费工作延迟到 `world-info.js:4933` 加载事件。此时 regenerate 已在 `script.js:5239` 删除旧回复；上下文按 `:5337–5349` 的隐藏过滤、swipe 去旧回复与 continue 深度口径选择 canonical mes。只对正文使用 `regex/engine.js:293,361,472` 的 prompt placement/资格/函数，不重复写入期正则；只有条件用 `script.js:3637` 的 substituteParams，接口失败严格停止，不发未经处理的原文。

`GENERATION_STARTED` 清理旧事务；normal/regenerate/swipe/continue 且非 dry-run、非 skipWIAN、可进入模型请求才登记，群聊 wrapper 不付费。STOP/END/CHAT_CHANGED 取消；结果应用前后复验 stable ID、完整聊天 ref、角色 ID/头像、消息快照和候选条目。负向只替换局部 clone 的 disable，正向 constant 并关闭概率、sticky/cooldown/delay、递归门，不发 WORLDINFO_FORCE_ACTIVATE。最终结果只读取非 dry-run 且 isFinal 的 WORLDINFO_SCAN_DONE.activated.entries Map（`world-info.js:5501–5531`）；通过阈值不保证最终注入。

**契约限制已获接受**：WORLDINFO_ENTRIES_LOADED 没有可证明来源的生成关联 ID。有效生成内其它扩展的加载可能提前触发付费/应用临时决策，末位监听与身份守卫不能辨别该来源，不宣称只处理正式最终扫描。其它扩展后来也可重排监听或改数组；真实共存时序仍待验收。

配置写前通过 `/api/worldinfo/get` fresh 读取比较整本快照，嵌入 `extensions["tt-toolkit"].worldInfoAiRouter` 后 fresh 往返验证；无法确认只回退配置到摘要 key。已有回退在验证成功且清理完成前为权威，重置仅清除此配置与对应回退。功能 key 保留 `world-info-ai-settings-v1`，设置与世界书配置均 schema 2，已知 v1 明确迁移，损坏/未知数据显式重置；详见 `docs/storage-contract.md`。

通用 System One 协议由独立 decision-model 服务直连，不依赖宿主模型/token 预算、Rust 代理或宿主修改；WebView CORS 可能失败并正常脱敏原生回退。一次未命中问题批次一次 POST，不重试、不裁剪；无自动 dry-run/付费探测。手动测试可使用所选挂载书草稿，明确确认发送内容与费用，不保存/应用。测试文件已存在，完整测试与实机结果不在此预先宣称。

## 提示词冲突检测（未注册）

下述为保留源码契约，当前不启动运行时或应用屏蔽。冲突检测通过 `src/scripts/openai.js` 的 live `export let promptManager` 读取 Chat Completions 的 PromptManager 实例（`openai.js:689`）。该实例使用 `strategy: 'global'`、`dummyId: 100001` 的单一全局 prompt order（`openai.js:1118-1121`、`PromptManager.js:453`），因此角色聊天与群聊共享同一预设顺序。参与普通生成的项目按 `getPromptOrderForCharacter(activeCharacter)` 的条目顺序，同时满足 order 条目 `enabled === true`、`shouldTrigger(prompt, 'normal')`（无 `injection_trigger` 或包含 `normal`）、非 `marker` 且 `preparePrompt()` 展开宏后的内容非空；`main` 被禁用时宿主以空内容占位，因此不会进入检测。`getPromptById`、`getPromptOrderForCharacter`、`shouldTrigger`、`preparePrompt` 与方法公开属性 `activeCharacter` 均为必需接口，任一缺失时功能级 fail-fast，不影响其它功能。openai 模块在首次使用时惰性导入，不加入启动必需导出。

世界书来源按宿主 `WORLDINFO_ENTRIES_LOADED`（`world-info.js:4933`）同一组装逻辑读取 `globalLore`、`characterLore`、`chatLore`、`personaLore` 四组数组。事件 payload 是新建的可变对象，条目为浅拷贝并带有 `world`（世界书名）与 `uid` 字段；宿主 `EventEmitter.emit` 会 `await` 每个监听器（`src/lib/eventemitter.js:130-153`），因此异步过滤在宿主继续扫描前完成。页面快照通过 `worldInfoCache`（cloneOnGet 深拷贝）按 `selected_world_info`、聊天 metadata、persona 与角色世界书绑定复现四组来源；快照与运行时过滤都只处理 `disable !== true && constant === true` 的条目。常驻条目在通过禁用/过滤/定时等资格门后参与激活（`world-info.js:5142–5235`），并仍受预算/分组处理，不表示无条件最终注入。

来源失效订阅只监听 `SETTINGS_UPDATED`、`OAI_PRESET_CHANGED_AFTER`、`WORLDINFO_UPDATED`、`WORLDINFO_SETTINGS_UPDATED` 与 `CHAT_CHANGED`（`events.js` 19/30/38/41/42）；`WORLDINFO_UPDATED` 的 payload 首参是世界书名，非当前挂载的书不触发刷新。这些事件只负责失效与快照刷新，不自动发起模型请求。聊天 metadata 读写使用 `api.chat.current.handle().metadata.get/setExtension`，namespace 固定为 `tt-toolkit.prompt-conflict`。

## 提示词查看

提示词查看（`聊天数据 / 提示词查看`）分两部分，宿主契约都集中在该边界（`src/kernel/host.js` 与 `host-prompt.js`）：

- **上一轮**：在 `CHAT_COMPLETION_PROMPT_READY`（`openai.js:2512-2516`，`dryRun === false`）对 live `promptManager.messages` 做逐字段投影（`identifier`、`role`、`content`、`tokens`、`name`），并用同轮 `WORLD_INFO_ACTIVATED` 的条目数组做世界书归因。`promptManager.messages` 由 `setChatCompletion`（`PromptManager.js:1818-1823`）写入；`squash_system_messages` 为真时宿主会原地合并 system 消息，逐条粒度受限，功能只警告不阻止。
- **预测**：上一轮的捕获状态在停止、结束、切聊天或同一轮确认空闲后清理；STOP/早退不产生新快照，也不让过期读取覆盖当前结果。预测修改宿主输入前检查 `isGenerating()` 和空闲 Promise，不把缺失 `GENERATION_ENDED` 视为一直忙，也不在 STOP 后收尾期间写入宿主输入。实际预测调用 live `promptManager.tryGenerate`（`openai.js:1145`，内部固定 `Generate('normal', {}, true)`），它读取 `#send_textarea`（`src/index.html:8395`）。功能先保存并写入输入框，在 `finally` 还原值与选区；dry-run 的 `CHAT_COMPLETION_PROMPT_READY` 提供最终 messages，`WORLDINFO_SCAN_DONE`（`world-info.js:5531`）在 `isFinal` 时提供世界书激活集。dry-run 会覆盖 live `promptManager.messages` 与 `tokenHandler.counts`，因此上一轮快照必须在捕获时独立保存，`counts` 在 `finally` 还原。

插图通过 `makeFirst` 注册一次，宿主等待异步读取和构造完成后才调用查看器。图片归因只关联本次 `chat` 数组及其中实际插入的消息对象，不修改负载形状、不跨轮保留；位置以 `openai.js:5478-5498,5773-5796` 的 `getChat()` 发送序列为准（空占位不计作位置锚点）。此约束只保证 Toolkit 两项功能的相对顺序，不保证捕获其它扩展随后改写的结果，也不是网络请求体拦截。两种启用顺序、真实轮次、dry-run 和停用后的行为由 `tests/prompt-viewer-host.test.js` 验证。

`promptManager.tryGenerate`、`WORLD_INFO_ACTIVATED`、`WORLDINFO_SCAN_DONE` 与 `#send_textarea` 属于保留 legacy 导出或未文档化宿主行为；正式文档与源码冲突时按“审计暂停条件”处理。Agent 不做检测：一轮生成内可能多次组装（工具调用或多轮 Agent 调用），功能记录组装次数并只展示最后一次；捕获后按三个 Agent 专用 identifier（`agentSystemPrompt`、`agentResults`、`agentTask`）过滤，得到与普通组装相同的口径，未匹配到则不移除。

完整设计见 `docs/prompt-viewer-development-plan.md`。

## 模型服务传输

OpenAI-compatible 预设保留 `invoke.safeInvoke` 的 `get_chat_completions_status`、`generate_chat_completion` 与取消命令，独立 URL/Key 经已验证 custom reverse-proxy 参数交给 Rust，不借用宿主当前模型或 generateRaw。此原生路径不用于决策。

System One 兼容预设只用浏览器 fetch，POST /systemone 或 GET /models（models[].name / data[].id）；支持手填模型，不自动付费探测。URL 拒绝内嵌凭据/查询/片段，密钥仅鉴权 header，错误/响应正文不进入日志。CORS 失败是普通可恢复服务错误，不要求定制宿主；真实连通与跨域尚未实机验证。

## 界面与主题的宿主边界

工作台跑在独立 iframe 里，宿主文档与 iframe 是两个文档。样式层共有 `manifest.css` 注入宿主文档与 iframe 自行加载两条路径，因此下面几条是硬约束（实现见 `docs/architecture.md`）：

- **`style.css` 会被注入宿主文档**（`manifest.json` 的 `css` 字段），所以全局选择器必须以 `html[data-ttk-surface]` 限定。该标记只加在 iframe 文档的 `documentElement` 上。已修的缺陷：`input {}` 与 `button:disabled {}` 原本无限定作用域，会经此路径改动宿主自身的输入框与禁用按钮。`tests/shell-overlay.test.js` 断言这两类规则不再无限定出现。
- **不向宿主根节点写 daisyUI 的 `--color-*`**：那是无命名空间的变量（宿主自身未使用，但其它扩展可能使用），写上去就会互相覆盖。主题色值只取 hex 并内联为 `--ttk-*`。
- **不改写宿主的 `color-scheme`**：宿主在 `body` 上声明 `color-scheme: only light`，从根节点改写会连带改变宿主自身原生控件的外观。`color-scheme` 只写进 iframe。
- **在宿主 `documentElement` 上只写插件自有属性**：`data-ttk-theme`（供悬浮球 Shadow DOM 取令牌）与 `--ttk-host-*`（不适用，宿主文档内直接解析真实变量），不碰宿主的属性与变量。
- **`--SmartTheme*` 不跨文档继承**：由 `ui/theme-bridge.js` 从宿主计算样式读出后注入 iframe，宿主主题变化经 `MutationObserver` 与 `settings_updated` 合并同步。

以上均不对宿主源码做任何修改或补丁；若后续依赖不再成立，按“审计暂停条件”处理。

## 审计暂停条件

遇到以下情况立即停止实现并与维护者讨论：

- 本地缺少对应 TauriTavern 源码或无法确认当前宿主版本；
- 正式文档、前端 ABI、legacy 导出和 Rust 后端之间存在影响行为的冲突；
- 必须修改、补丁或定制宿主才能实现；
- 需要新增长期兼容策略、猜测未知 schema 或改变数据所有权；
- 宿主错误会使身份验证、永久写回、密钥保护或日志脱敏失效。
