# 消息书签功能审计与设计

状态：审计与设计稿，未实现。实现时需按本文"实现前置验证项"完成钉死后更新 `docs/host-contract.md`、`docs/storage-contract.md` 并新建功能文档。

## 1. 需求与术语澄清

为当前聊天的任意消息保存可跳转的书签（可含备注），在插件内浏览、管理并跳转回宿主聊天。集成方式待定：并入聊天查看的搜索区，或新建独立功能页（见第 8 节，推荐后者）。

命名必须与宿主既有概念区分：TauriTavern 的 "bookmark / Checkpoint / Branch"（`src/scripts/bookmarks.js`）是**聊天级分叉**——把 `chat[]` 截片保存为新聊天文件；本功能是**消息级标记**。功能稳定 ID 定为 `chat-bookmarks`，界面文案使用"消息书签"，避免与宿主"书签/检查点"混淆。

## 2. 验证基线

- TauriTavern `2.2.0`，本地源码提交 `24926a5d4331`，核对日期 2026-09-02。
- 该提交晚于 `docs/host-contract.md` 基线（`439216353260`，2026-08-25）。本次审计重新确认了聊天保存、消息删除、事件、聊天身份与 per-chat store 契约；其余基线行未逐项重验。
- TT-Toolkit 适配边界不变：`src/kernel/host.js`。

## 3. 宿主契约证据

### 3.1 消息身份：无 muid，只有绝对索引

- 全仓库检索 `muid` 无命中（唯一命中为无关 TTS 库 `kokoro.web.js`）。宿主消息没有独立唯一 ID，消息身份就是 `chat[]` 的 0 基绝对索引；宿主 slash 命令与分支 API 均以 `chat[mesId]` 直接寻址（`scripts/bookmarks.js:479-489`）。
- 结论：书签不能依赖宿主提供的稳定消息 ID，必须自建"索引 + 内容摘要"锚定，并自行处理索引漂移。

### 3.2 消息删除：splice 位移，事件负载不含被删索引

- `deleteMessage()` 执行 `chat.splice(id, 1)`，其后所有消息索引前移 1，并置 `chat_metadata.tainted = true`（`src/script.js:2160-2216`）。
- `MESSAGE_DELETED` 事件负载是删除后的新 `chat.length`，不是被删索引（`src/script.js:2211`、`13730`）。
- 结论：书签存储的索引会因删除整体漂移；不能信任事件负载推断索引，只能在事件后重读快照重新解析锚定（与聊天查看"事件只标失效"的既有模式一致）。

### 3.3 swipe：swipes 数组与楼层 0 投影

- 消息当前正文 `mes` 由 `swipes[swipe_id]` 投影；swipe 删除走 `deleteSwipe(index, mesId)`，候选序号位移（`src/script.js:2160-2193`）。
- 楼层 0 角色问候的 `mes` 是宏展开投影，可与 `swipes[swipe_id]` 合法不等（`docs/host-contract.md` 已记录）。
- 结论：书签锚定的内容匹配候选必须同时覆盖 `mes` 与全部 `swipes[]`；swipe 切换/删除不改变"消息存在性"，只影响当前投影。

### 3.4 分叉（branch/checkpoint）：复制 metadata 含 integrity 与扩展数据

- `createBranch(mesId, { swipeId })` 对 `chat.slice(0, mesId + 1)` 做 `structuredClone` 写入新文件 `<名> - Branch #N`，并把分支名追加进原消息 `extra.branches`；checkpoint 写 `extra.bookmark_link`（`scripts/bookmarks.js:171-243`）。
- 关键：角色与群聊两条保存路径都以 `{ ...chat_metadata, ...(withMetadata || {}) }` **合并**既有 metadata，而非替换（`src/script.js:8717`、`scripts/group-chats.js:2467`）。分叉出的新聊天文件**完整继承** `chat_metadata`，包括 `integrity` 与所有 `tt-toolkit.*` 扩展命名空间。
- 后端从不生成 integrity：`verify_integrity_match` 同值放行、异值报错（`file_chat_repository/integrity.rs:3-12`）。因此 `docs/tauritavern-character-fork-stable-id-issue-draft.md` 记录的"分支与原聊天 stableId 相同"缺陷在新提交依然成立。
- 结论：
  - 写入聊天 metadata 的数据会随分叉**复制**进新文件，此后各自独立演化；
  - 仅凭 `stableId()` 无法区分角色分支，永久写入前需要 **ref 级**（kind + characterId + fileName / chatId）身份复验，现有 `assertIdentity(stableId)` 不足以覆盖"同谱系分支切换"场景。

### 3.5 per-chat store：本审计确认的新公开 ABI

前端（`src/tauri/main/api/chat.js:79-223`，正式文档 `docs/API/Chat.md`）：

- `handle().store.{ getJson, setJson, updateJson, renameKey, deleteJson, listKeys }`，参数 `{ namespace, key, value }`；`updateJson` 对对象深度合并、非对象整体替换；`updateJSON`/`updateKey` 为别名。
- 宿主文档定位：per-chat 扩展数据的正式持久化通道，适合"大 JSON"；`chat_metadata` 被明示为"容量有限、语义不清"的小状态通道。

Rust 存储（`file_chat_repository/extension_store.rs`）：

- 角色聊天目录：`<聊天目录>/.tauritavern/<integrity>/<namespace>/<key>.json`（extension_store.rs:142-163）。**按 integrity 寻址**：
  - 分支谱系（含 checkpoint、嵌套分叉）共享同一 store；
  - 聊天文件重命名不受影响（integrity 不变，`rename_chat` 只移动 JSONL，repository_impl.rs:194-244）。
- 群聊目录：`group_chats/.tauritavern/<chat_id 文件名 stem>/<namespace>/<key>.json`（extension_store.rs:135-140）。**按文件名寻址**：
  - 群聊分叉使用新 chat_id，新文件从空 store 开始；
  - 文件名变更会遗弃旧 sidecar 目录（无迁移调用）。
- 组件校验与全局 extension store 相同（ASCII 字母数字与 `_-.`，非空，不得 `.` 开头，不得 `.`/`..`）。
- `listKeys` 对缺失目录返回 `[]`（NotFound 归一为空列表，extension_store.rs:465-470）；`getJson`/`deleteJson`/`renameKey` 对缺失目标报 `DomainError::NotFound`。
- 删除聊天只移除 JSONL 文件，sidecar 不清理（repository_impl.rs:161-192）——孤儿目录是宿主行为，本插件不越权清理。

### 3.6 metadata.setExtension 写入聊天文件本体

- `set_character_chat_metadata_extension` 走 `set_chat_metadata_extension_in_path`，直接改写聊天文件的 header 行（repository_impl.rs:703-715）。与宿主 `saveChat` 保存链路共用同一文件，存在写放大与并发耦合；per-chat store 写入则只触碰独立 sidecar 文件。

### 3.7 locate / searchMessages：不适合书签重锚定

- `locate.findLastMessage` 只支持 `role`、`has_top_level_keys`、`has_extra_keys`、`scan_limit` 的结构化定位（`tt-contracts/src/chat.rs:128-145`），不支持按内容查找；`searchMessages` 是评分召回，不适合精确摘要匹配。
- 结论：书签重锚定在 TT-Toolkit 内存快照（canonical `chat[]`）上做客户端摘要扫描，与聊天查看的读取模式一致，不引入额外宿主调用。

## 4. 数据落点决策

| 候选 | 语义 | 重命名 | 分叉行为 | 容量/写入 | 判定 |
| --- | --- | --- | --- | --- | --- |
| A. 聊天 metadata extension `tt-toolkit.bookmarks` | 数据内嵌聊天文件 | 随文件走 | 分叉复制一份，此后各自演化 | 每次写改写聊天文件 header，与保存链路耦合；宿主明示容量有限 | 否 |
| B. per-chat store `tt-toolkit.bookmarks` / `bookmarks-v1` | sidecar JSON | 角色安全（integrity 寻址）；群聊按文件名 | 角色谱系共享；群聊新文件为空 | 独立小文件，无保存竞态；updateJson/listKeys/renameKey 齐备 | **采用** |
| C. 全局 extension store 按聊天身份建 key | 插件侧索引 | 角色按 stableId 安全 | stableId 无法区分分支（3.4） | — | 否，且违背 storage-contract 不建长期聊天索引的边界 |

采用 B 的语义说明（需要在功能文档中向用户明示）：

- 角色聊天：书签集合在分叉谱系内共享（与宿主 stableId 同粒度）。每个文件独立解析锚定状态，分支截断点之后的书签在该分支内自然表现为 stale，无需迁移。
- 群聊：书签属于具体聊天文件；分叉出新聊天文件不携带书签。
- 若后续维护者更倾向"分叉复制、各自演化"的语义，可切换到落点 A，锚定状态机不变；这是本设计保留的唯一可逆决策点。

## 5. 消息锚定与兼容策略

### 5.1 锚定字段

每个书签记录：`id`（`bm-<uuid>`）、`index`（0 基绝对索引，定位提示）、`mesDigest`（SHA-256，对书签时刻 `mes` 原文计算）、`mesPreview`（前 120 字符，供 stale 后人工识别）、`role`、`swipeId` 与 `swipeCount`（提示用）、`createdAt`、`updatedAt`、`label`、`note`。

### 5.2 解析状态机（对 canonical `chat[]` 快照执行）

1. **anchored**：`chat[index]` 存在，且 `mesDigest` 与该消息 `mes` 或任一 `swipes[]` 成员匹配。
   - 若匹配的是 swipe 而 `mes` 不匹配，附加 `swipeView` 提示（当前投影不是书签时视图）。
2. **re-anchored**：索引处不匹配时全聊天扫描摘要；**唯一**命中 → 更新 `index` 并持久化（删除位移自动修复）。
3. **ambiguous**：扫描命中多处 → 保持 stale，列出候选索引由用户选择；不自动猜。
4. **stale**：无命中 → 目标已删除或正文被改写；展示 `mesPreview` 与原索引，提供动作：移除书签 / 跳转到原索引楼层（若仍在范围内）/ 重新锚定到当前该楼层消息。

摘要匹配候选恒为 `[mes, ...swipes]`，覆盖楼层 0 宏投影与 swipe 切换；正文编辑在"消息存在性"意义上不使书签失效（宿主无消息 ID，编辑前后是同一索引槽位），只有槽位复用（删除后新增）才通过摘要失配暴露为 stale。

### 5.3 场景兼容矩阵

| 宿主行为 | 对书签的影响 | 处理 |
| --- | --- | --- |
| 删除中间消息 | 后续索引前移 | 状态机 2 自动重锚 |
| 删除书签目标消息 | 目标消失 | 状态机 4 stale + 用户动作 |
| 编辑正文 | 索引不变，`mes` 变化 | 候选含 swipes；编辑后 `mes` 失配但槽位未复用时不自动失效（状态机 1/4 按 `role` 与索引连续性判断），确需重新锚定由用户动作完成 |
| 切换/删除 swipe | 投影变化，swipe 序号位移 | 摘要候选覆盖 swipes；书签不绑定 swipe 视图 |
| 楼层 0 宏再展开 | `mes` 与 swipe 原文不等 | 候选含 swipes，合法状态不误判 |
| 角色 branch/checkpoint | 谱系共享书签集合 | 各文件独立解析；分支截断点后的书签在该分支 stale |
| 群聊分叉 | 新文件空书签 | 无需处理 |
| Agent 消息回滚（截断） | 等价多次删除 | 状态机 2/4 覆盖 |
| 聊天切换 | 快照与身份失效 | 事件后重读；写前 ref 级复验 |

### 5.4 事件与身份

- 订阅复用 `host.onChatMutated` 的 7 个事件，另订阅 `MESSAGE_SWIPE_DELETED`（`scripts/events.js:16`）。事件负载一律不用于索引推断，只标记快照失效。
- 永久写 store 前执行 **ref 级**复验：页面装载时记录 `api.chat.current.ref()` 快照，写入前重新读取并要求 deep 相等（角色比较 `characterId + fileName`，群聊比较 `chatId`）。`stableId` 复验保留作为附加一致性检查，但不作为唯一屏障（3.4）。

## 6. Schema 设计

- namespace 固定 `tt-toolkit.bookmarks`，key 固定 `bookmarks-v1`，JSON 整体校验、`setJson` 覆盖写入。
- 根对象：`{ schemaVersion: 1, bookmarks: Bookmark[] }`；Bookmark 字段见 5.1，全部严格解析（类型、范围、摘要格式 64 位小写十六进制、`label` ≤ 60 字符、`note` ≤ 500 字符）。
- 护栏：每聊天上限 200 条；超出拒绝添加并提示。文档序列化目标 < 256KB。
- 损坏 schema：停止该聊天的书签读写并提供显式重置（删除 `bookmarks-v1`），不静默猜测（`docs/storage-contract.md` Schema 规则）。
- 隐私：书签数据本来就该保存用户可读的预览与备注；预览截断 120 字符，不保存完整正文；日志只记书签 id、聊天别名、锚定状态变化，不记正文与备注。

## 7. 失败策略

- `handle().store.*` 任一方法缺失或调用失败 → 功能级停用（日志 ABI 同款模式），其它功能不受影响；初始化时探测并记录。
- `getJson` 的"缺失 vs 错误"语义必须在实现前钉死（见第 10 节）；实现只把显式 not-found 解释为缺失，其余错误继续抛出。
- 读到 `undefined`/`null` 与"键不存在"区分处理；`null` 是合法 JSON 值，视为损坏 schema（根对象必须是解析通过的对象）。

## 8. UI 集成方案

- 新建独立功能 `chat-bookmarks`，注册于"聊天数据"大类（`chat-data`，order 40）。`src/features/registry.js` 现有结构直接支持。
- 不并入聊天查看（`chat-viewer`）的理由：该功能的文档与架构定位是**只读**（不持久化、不写聊天）；书签是持久写功能，含事件订阅与独立 schema/重置。混入会破坏其只读契约与失效语义。
- 与聊天查看的复用与衔接：
  - 共享 `kernel/chat-projection.js` 楼层投影与 `kernel/chat-messages.js` 角色分类；
  - 页内提供楼层选择（复用对话楼层投影）添加书签，跳转复用 `host.jumpToMessage`（含 stableId 复验与 `/chat-jump`）；
  - 后续增强：在聊天查看的楼层卡片/搜索结果行提供"添加书签"动作，跨功能通过注册表路由，不直接耦合。
- 列表项展示：锚定状态（正常/已重锚/待确认/失效）、楼层号与角色、预览、备注；失效项用 `mesPreview` 帮助辨认。
- 停用功能时不订阅事件、不读快照、不触碰 store。

## 9. 测试计划（实现时）

- schema：正常解析、未知字段拒绝、损坏/`null` 停用 + 重置、上限护栏。
- 锚定状态机：anchored/swipeView/唯一重锚/ambiguous/stale；楼层 0 宏投影；swipe 候选匹配；删除位移自动重锚；槽位复用判 stale。
- 身份：ref 级复验失败（分支切换、群聊切换）拒绝写入；stableId 相同但 ref 不同（角色分支）必须被 ref 复验拦截。
- ABI：store 方法缺失 → 功能级停用；`listKeys` 缺失目录为空集。
- 事件：7+1 事件仅标失效；注销对称；功能停用后无订阅残留。
- 跳转：复验、索引越界、`/chat-jump` 错误路径。

## 10. 实现前置验证项（阻断项）

1. `handle.store.getJson` 对不存在 key 在 JS 侧的确切形态（Rust `DomainError::NotFound` 经 `map_command_error`/safeInvoke 后的 rejects 值）：以运行时探针或继续追 `CommandError` 序列化确认；确认前不得实现读取路径。
2. 宿主当前提交晚于 `docs/host-contract.md` 基线，实现时同步更新基线与本功能证据行。
3. 维护者确认第 4 节落点语义（角色谱系共享 vs 分叉复制）后冻结。

## 11. 既有文档更新清单（实现时）

- `docs/host-contract.md`：基线提交；新增 per-chat store 证据行与 ref 级身份复验约定；`MESSAGE_SWIPE_DELETED` 事件。
- `docs/storage-contract.md`：新增"每聊天存储"小节（宿主 chat store 语义、孤儿目录属宿主行为）；`tt-toolkit.bookmarks`/`bookmarks-v1` 布局行。
- `docs/architecture.md`：功能域描述追加 chat-bookmarks。
- 新建 `docs/chat-bookmarks.md` 功能文档。
