# 提示词查看：详细开发计划

> 文档状态：已按本文完成 v1 实现（源码、测试与文档同步）<br>
> 实现版本：随 `0.7.0` 交付<br>
> 功能注册：`聊天数据 / 提示词查看`<br>
> 功能 ID：`prompt-viewer`<br>
> 宿主核对基线：TauriTavern `2.2.0`，源码提交 `db4186da1e6e`<br>
> 本文范围：产品决策、前端交互、数据模型、捕获与预测流程、宿主契约、测试计划。

## 1. 背景与目标

TauriTavern 在一次 Chat Completion 生成中，会按 PromptManager 顺序把预设条目、角色卡字段、Persona、世界书条目、对话历史与注入内容组装成最终消息数组。宿主自带的 Prompt Inspector 只提供“最终原始数组 + 粗粒度 token 统计”，无法回答“这套提示词具体由哪些预设条目和世界书条目构成”。

本功能提供两个明确边界的能力：

1. **上一轮**：逐条查看最近一次正文聊天实际发送的提示词，按最终发送顺序展示，并标注每一条的来源。
2. **预测**：给定一段假设的用户输入，用宿主自身的 dry-run 组装一次，展示会组装出的提示词。

功能核心定位是“宿主组装结果的条目级解释器”，不是网络抓包器，也不是第二套组装实现：上一轮直接读取宿主真实组装结果，预测直接调用宿主自身组装路径，两者都不在前端重放 PromptManager 逻辑。

## 2. 已确定的产品决策

| 决策项 | 结论 |
| --- | --- |
| 导航归类 | 现有大类 `聊天数据` 下新增功能，不新增顶层分类 |
| 功能 ID / 名称 | `prompt-viewer` / `提示词查看` |
| 图标 | `🔬` |
| 排序 | `order: 40`，显示在聊天导出（`order: 30`）之后 |
| 首次默认状态 | 关闭，需手动启用后才捕获 |
| 接口范围 | 仅 Chat Completion 管线（`main_api === 'openai'`） |
| 上一轮捕获类型 | `normal` / `regenerate` / `swipe` / `continue`，全部捕获并标注类型 |
| 预测类型 | 仅 `normal` |
| Agent 组装 | 不检测 Agent 开关；捕获后过滤宿主三个 Agent 专用条目（`agentSystemPrompt`、`agentResults`、`agentTask`），得到普通组装口径；预测始终使用 `Generate('normal', {}, true)`。若该轮受 Agent context policy 裁剪（历史窗口/关闭世界书），给出中性提示。一轮内多次组装时记录次数并只展示最后一次 |
| 历史保留 | 只保留最近一轮，新快照覆盖旧快照 |
| 捕获时机 | 功能启用后持续后台捕获，不做“仅打开时捕获”设置项 |
| 新轮次处理 | 停留在“上一轮”标签时出现“检测到新的一轮”横幅，用户点击才刷新 |
| 页面结构 | 双标签页：`上一轮` / `预测` |
| 条目组织 | 按最终发送顺序的扁平列表，每条带来源徽章 |
| 世界书展示 | 独立激活条目面板 + 在 `worldInfoBefore/After` 条目下展开；字段为 `comment + position/depth + 世界书名` |
| 折叠 | 默认显示固定高度预览（约 5 行，超出裁切）；可单条展开/收起、全部展开、全部折叠；设置项“默认展开全部正文”控制新快照初始状态；展开状态不跨快照保留 |
| Token | 每条 token + 总计 + 上下文预算占用 |
| 模型信息 | 上一轮显示捕获时快照；预测显示当前设置 |
| 筛选 | 按来源类型筛选 |
| 搜索 | 搜正文与条目名称，命中高亮，不持久化，切换快照时清空 |
| 复制 / 下载 | 复制 + 下载 `.txt`；内容为**实际发送的 messages 数组**；格式为可读分块（`[system]` / `[user]` / `[assistant]`） |
| 预测输入 | 多行文本框，默认空白（不预填上一条用户消息） |
| 预测展示 | 与上一轮同构的条目列表 + 当前模型信息 |
| 预测失败 | 顶部错误横幅 + 保留输入 |
| 长列表 | 全部渲染 + 默认折叠 |
| 群聊 | 标注该轮所属成员名；“上一轮”取最后一个成员 |
| 不适用状态 | 顶部显式横幅 + 禁用捕获/预测 |
| 日志 | 只记元数据，跟随全局日志开关 |
| 持久化 | 快照只驻内存；唯一持久化是功能级设置 |

## 3. 非目标

- 不覆盖 Text Completion 管线（`textgenerationwebui` / `kobold` / `novel`）。
- 不模拟 Agent 的上下文策略、工具循环或多轮调用过程；只按事件捕获实际组装结果并过滤 Agent 专用条目，多轮时只展示最后一次。
- 不覆盖其他扩展通过 `generateRaw` / `generateQuietPrompt` 发起的请求。
- 不拦截或修改网络请求，不建立第二套 PromptManager 组装实现。
- 不修改预设、世界书、聊天消息、聊天 metadata 或宿主 UI 状态（预测临时写入 `#send_textarea` 后立即还原，见第 8 节）。
- 不持久化提示词正文、世界书名、稳定聊天 ID 或模型原始响应。
- 不提供跨重启的历史轮次回看（宿主 Prompt Inspector 的 localforage 记录不在本功能范围内）。

## 4. 用户流程

### 4.1 查看上一轮

1. 用户启用 `聊天数据 / 提示词查看`；运行时开始持续捕获。
2. 用户在宿主中正常发送、重生成、换 swipe 或续写；运行时捕获该轮快照。
3. 用户打开工作台进入“上一轮”标签：顶部显示模型名、来源与 token 预算；列表按最终发送顺序展示逐条提示词。
4. 用户可按来源类型筛选、搜索正文或名称、展开单条或全部展开。
5. 用户可复制当前提示词或下载 `.txt`。

### 4.2 预测

1. 用户切到“预测”标签，在文本框输入假设的用户消息。
2. 点击“预测”，运行时用宿主 dry-run 组装一次；期间按钮禁用并显示进行中状态。
3. 完成后展示与上一轮同构的条目列表，顶部显示当前模型与来源。
4. 失败时显示错误横幅并保留输入。

### 4.3 新轮次通知

用户停留在“上一轮”标签时，若产生新的正文轮次，列表不自动替换，顶部出现“检测到新的一轮，点击查看”横幅；用户点击后刷新为新快照。

## 5. 前端信息架构

页面使用容器查询自适应，宽容器多列、窄容器自动降为单列。

```
提示词查看
├─ 状态横幅（仅不适用/警告时出现）
├─ 模型信息栏：模型名 · 来源 · token 总计 / 预算
├─ 双标签：上一轮 | 预测
│   ├─ 工具栏：来源类型筛选 · 搜索框 · 全部展开/折叠 · 复制 · 下载 .txt
│   ├─ 条目列表（扁平最终顺序）
│   │   └─ 条目行：序号 · 来源徽章 · 名称 · role · token · 展开箭头
│   │       └─ 展开区：正文文本节点
│   ├─ 世界书激活条目面板（可折叠）：comment · position/depth · 世界书名
│   └─ 空状态 / 错误状态
└─ 底部：关闭工作台（外壳提供）
```

### 5.1 来源徽章

| 来源 | 徽章 | 判定 |
| --- | --- | --- |
| `preset` | 预设 | `promptManager.getPromptById(identifier)` 存在 |
| `character` | 角色卡 | `charDescription` / `charPersonality` / `scenario` / `dialogueExamples` |
| `persona` | Persona | `personaDescription` |
| `world-info` | 世界书 | `worldInfoBefore` / `worldInfoAfter` / 深度注入可确认的条目 |
| `chat-history` | 对话历史 | `chatHistory*` |
| `system-extension` | 系统注入 | `bias` / `groupNudge` / `continueNudge` / `impersonate` / `quietPrompt` / `summary` / `authorsNote` / `vectors*` / `smartContext` / `newMainChat` 等 |
| `unknown` | 未知 | 无法归类的 identifier |

### 5.2 不适用与警告横幅

| 条件 | 处理 |
| --- | --- |
| `context.mainApi !== 'openai'` | 横幅“当前不是聊天补全接口，本功能不可用”；禁用捕获与预测 |
| `promptManager` 或其必需方法不可用 | 横幅“宿主 PromptManager 尚不可用”；禁用捕获与预测 |
| `squash_system_messages === true` | 警告“宿主已开启 system 消息合并，逐条粒度受限”；不禁止查看 |
| 无任何已捕获轮次 | 空状态“尚未捕获到正文轮次，发送一条消息后再查看” |
| 预测进行中 | 禁用预测按钮，显示进行中状态 |

## 6. 数据模型

纯函数模型层不依赖宿主对象，输入为已投影的普通对象。

### 6.1 快照

```js
/** @typedef {{
 *   schemaVersion: 1,
 *   kind: 'sent' | 'prediction',
 *   capturedAtMs: number,
 *   generationType: 'normal'|'regenerate'|'swipe'|'continue',
 *   groupMemberLabel: string|null,
 *   assemblyRoundCount: number,
 *   model: { name: string, source: string } | null,
 *   tokenBudget: { maxContext: number, maxTokens: number } | null,
 *   squashSystemMessages: boolean,
 *   removedAgentItemCount: number,
 *   items: PromptItem[],
 *   worldEntries: WorldEntryItem[],
 *   messages: ChatMessage[],
 * }} PromptSnapshot */
```

### 6.2 条目

```js
/** @typedef {{
 *   order: number,
 *   identifier: string,
 *   source: 'preset'|'character'|'persona'|'world-info'|'chat-history'|'system-extension'|'unknown',
 *   label: string,
 *   role: string,
 *   name: string|null,
 *   content: string|unknown[],
 *   tokens: number|null,
 *   worldEntryRefs: number[],
 *   attribution: 'exact'|'aggregate'|'unknown',
 * }} PromptItem */
```

- `items` 由 `promptManager.messages.flatten()` 顺序投影；`identifier`、`role`、`content`、`tokens`、`name` 直接来自宿主 `Message`，不重排、不合并。
- 投影函数逐字段提取，不使用 `structuredClone`（`Message` 是类实例，克隆会丢失 `tokens` 等字段）。
- `tokens` 取 `Message.tokens`；缺失时为 `null`。

### 6.3 世界书条目

```js
/** @typedef {{
 *   world: string,
 *   uid: number|string,
 *   comment: string,
 *   position: 'before'|'after'|'an_top'|'an_bottom'|'depth'|'em_top'|'em_bottom'|'outlet'|'unknown',
 *   depth: number|null,
 *   role: string|null,
 *   trigger: 'constant'|'keyword'|'vector',
 * }} WorldEntryItem */
```

来源：

- 上一轮：`WORLD_INFO_ACTIVATED` 事件参数（`world-info.js:1000`）的条目数组。
- 预测：`WORLDINFO_SCAN_DONE` 事件（`world-info.js:5411`）在 `isFinal` 时的 `args.activated.entries`（`Map`，取 `Array.from(values)`）。

`trigger` 判定：`constant === true` → `constant`；否则 `vectorized === true` 或 `extensions.vectorized === true` → `vector`；否则 `keyword`。

### 6.4 世界书归因规则（不猜测）

1. `worldInfoBefore` / `worldInfoAfter` 条目的 `worldEntryRefs` 指向 position 为 `before` / `after` 的激活条目，顺序与宿主拼接顺序一致。
2. 若这些条目的拼接内容（按宿主使用的 `getRegexedString` 处理后的结果）与消息正文不能完全匹配，则不声称逐条对应：`attribution: 'aggregate'`，界面提示“聚合文本与快照不完全一致，逐条仅供参考”。
3. 深度 / 作者注释 / 示例 / outlet 世界书条目在最终消息数组中会并入 `chatHistory-*` 消息，没有独立 identifier。只有当某个 `chatHistory-*` 消息正文与已知注入字符串**完全相等**时才标记为 `world-info`；否则保持 `chat-history`，不做模糊匹配。
4. 无论归因是否成功，世界书激活条目面板始终列出全部激活条目，保证没有条目被隐藏。

### 6.5 导出模型

- 复制与下载共用同一序列化函数，输入为 `snapshot.messages`（实际发送数组，来自 `CHAT_COMPLETION_PROMPT_READY` 的 `chat`）。
- 输出可读分块，不含任何插件元数据：

```text
[system]
<content>

[user]
<content>

[assistant]
<content>
```

- `content` 为非字符串（媒体数组等）时使用 `JSON.stringify`；`tool` 角色附加 `tool_call_id`；有 `name` 时以 `name=<name>` 追加在角色行。
- 文件名 `prompt-<sent|prediction>-<YYYYMMDD-HHmmss>.txt`，不含聊天名、角色名或稳定 ID。

## 7. 捕获流程

### 7.1 订阅

`activate()` 时对称订阅以下宿主事件，`deactivate()` 时全部注销：

| 事件 | 用途 |
| --- | --- |
| `GENERATION_AFTER_COMMANDS(type, options, dryRun)` | 识别正文轮次开始与生成类型；非 dry-run 时重置该轮临时缓冲 |
| `CHAT_COMPLETION_PROMPT_READY({ chat, dryRun })` | 捕获最终 messages 数组与 `promptManager.messages` 条目投影 |
| `WORLD_INFO_ACTIVATED(entries)` | 捕获该轮真实激活的世界书条目 |
| `WORLDINFO_SCAN_DONE(args)` | 仅在预测 dry-run 进行中捕获预测的世界书激活集 |
| `GENERATION_STOPPED` / `GENERATION_ENDED` | 清理进行中状态 |
| `CHAT_CHANGED` | 清空上一轮快照、预测结果与进行中状态 |

### 7.2 门控

- `dryRun === true` 的 `GENERATION_AFTER_COMMANDS` / `CHAT_COMPLETION_PROMPT_READY` 默认忽略；仅当 `predictionInFlight === true` 时用于预测。
- 非 Chat Completion 管线（`mainApi !== 'openai'`）不捕获、不预测。
- `generationType` 不属于四种正文类型时忽略。
- 捕获开始于 `GENERATION_AFTER_COMMANDS`（非 dry-run）时先清空该轮的世界书临时缓冲，避免沿用上一轮激活集。

### 7.3 快照生成

`CHAT_COMPLETION_PROMPT_READY`（非 dry-run）触发时同步执行：

1. 投影 `promptManager.messages.flatten()` 为 `items`。
2. 过滤 `items` 中 identifier 属于宿主 Agent 专用集合（`agentSystemPrompt`、`agentResults`、`agentTask`）的条目，并据此重建 `messages`（普通轮次为空操作，`removedAgentItemCount` 为 0）。
3. 附加该轮 `WORLD_INFO_ACTIVATED` 投影的 `worldEntries`。
4. 附加 `pendingGenerationType`、群聊成员名、模型名与来源、`tokenBudget`、`squashSystemMessages`、`assemblyRoundCount` 与 `removedAgentItemCount`。
5. 覆盖旧快照；若工作台停留在“上一轮”标签，置 `pendingUpdate` 通知，不自动替换。

`removedAgentItemCount` 大于 0 时界面注明“该轮含 Agent 专用条目，已按普通组装口径移除”。此过滤与宿主普通组装在 `openai.js:2080` 调用 `removeAgentOnlyPrompts` 的行为一致，因此普通轮次的 `items` 与 `messages` 均不变。重建的 `messages` 用于导出，规则与宿主 `ChatCompletion.getChat()` 相同：跳过无正文且无 `tool_calls` 且非 `tool` 角色的条目。

`assemblyRoundCount` 在 `GENERATION_AFTER_COMMANDS`（非 dry-run）时归零，每收到一次非 dry-run 的 `CHAT_COMPLETION_PROMPT_READY` 加一；大于 1 时界面注明“本轮组装 N 次（可能包含工具调用或多轮 Agent 调用），仅显示最后一次结果”。

性能：只在每轮生成时做一次 O(条目数) 投影，新快照覆盖旧快照，内存与计算均为常量级，因此不需要懒捕获或设置项。

## 8. 预测流程

### 8.1 前置条件

- 功能已启用，工作台打开在“预测”标签。
- `mainApi === 'openai'`。
- `promptManager` 及其 `tryGenerate`、`messages`、`tokenHandler`、`serviceSettings` 可用。
- 无预测进行中，且没有正文生成进行中。

### 8.2 步骤

1. `predictionInFlight = true`，清空预测缓冲。
2. 保存 `#send_textarea` 的 `value`、`selectionStart`、`selectionEnd`、`scrollTop`。
3. 直接写入假设输入（不派发 `input` 事件，避免触发宿主其它监听器）。
4. 依次记录：预测前的 `tokenHandler.counts` 快照。
5. `await promptManager.tryGenerate()`（宿主 token 预览使用的同一入口，固定 `Generate('normal', {}, true)`）。
6. 期间由事件处理器捕获 dry-run 的 `CHAT_COMPLETION_PROMPT_READY` 与 `WORLDINFO_SCAN_DONE`（`isFinal`）。
7. `finally`：还原 `#send_textarea` 的值与选区、还原 `tokenHandler.counts`、`predictionInFlight = false`。
8. 用捕获缓冲构建 `kind: 'prediction'` 快照；缺少必要的 prompt-ready 或投影失败时，显示错误横幅并保留输入。

### 8.3 约束

- 预测按钮在进行中禁用；正文生成进行中时禁用预测。
- 不使用 `Generate` 直接导入，避免依赖未文档化的导出签名；使用 live `promptManager.tryGenerate`。
- 预测会发出宿主 dry-run 事件（`GENERATION_STARTED` / `GENERATION_AFTER_COMMANDS` / `CHAT_COMPLETION_PROMPT_READY`，均带 `dryRun: true`），与宿主自带 token 预览行为一致；这一点在页面常驻说明中告知用户。
- dry-run 会覆盖 live `promptManager.messages` 与 `tokenHandler.counts`；上一轮快照在捕获时已独立保存，不受影响；`counts` 在 finally 中还原。

## 9. 宿主适配边界

新增能力集中在 `src/kernel/host.js`，其余模块不直接接触宿主对象。

| 能力 | 宿主证据 | 校验与失败策略 |
| --- | --- | --- |
| 读取 live `promptManager` | `src/scripts/openai.js:739` `export let promptManager` | 惰性导入；缺失或未初始化为 `PROMPT_MANAGER_UNAVAILABLE` |
| 读取上一轮逐条组装结果 | `promptManager.messages`（`PromptManager.js:1847` `setChatCompletion`）、`MessageCollection.flatten()`（`openai.js:5560`）、`Message.identifier/tokens` | 必需 `flatten`；缺失 fail-fast |
| 读取 token 计数与合并设置 | `promptManager.tokenHandler.counts`、`promptManager.serviceSettings.squash_system_messages` | 缺失时对应字段为 `null`/`false` |
| 条目名称 | `promptManager.getPromptById`、`promptManager.promptSources`（`PromptManager.js:321`） | 已有冲突检测使用；缺失时回退 identifier |
| 事件订阅 | `getContext().eventTypes` / `eventSource`（`st-context.js:144`） | 事件缺失显式报错 |
| 捕获最终 messages 数组 | `CHAT_COMPLETION_PROMPT_READY`（`openai.js:2577`） | payload 非对象或 `chat` 非数组时报契约错误 |
| 世界书激活（上一轮） | `WORLD_INFO_ACTIVATED`（`world-info.js:1000`） | 非数组时报契约错误 |
| 世界书激活（预测） | `WORLDINFO_SCAN_DONE`（`world-info.js:5411`，dry-run 也会发出） | `args.activated.entries` 需支持 `Array.from` |
| 预测入口 | `promptManager.tryGenerate`（`openai.js:1145`，内部 `Generate('normal', {}, true)`） | 非函数时 `PROMPT_VIEWER_PREDICTION_UNAVAILABLE` |
| 宿主输入框 | `src/index.html:8395` `#send_textarea` | 元素不存在时 `PROMPT_VIEWER_INPUT_UNAVAILABLE`，禁用预测 |
| 模型与预算信息 | `getContext().getChatCompletionModel`、`getContext().chatCompletionSettings`（`st-context.js:233`、`294`） | 缺失时信息栏显示“未知” |
| 群聊成员名 | `getContext()` 当前角色/群聊字段 | 失败时省略成员名 |
| Agent 专用条目过滤 | `openai.js:127-130` 的 `AGENT_SYSTEM_PROMPT_IDENTIFIER` / `AGENT_RESULTS_PROMPT_IDENTIFIER` / `AGENT_TASK_PROMPT_IDENTIFIER`；`openai.js:1945` 的 `removeAgentOnlyPrompts` 在普通组装时过滤 | 捕获后按这三个 identifier 过滤，得到普通组装口径 | 未匹配到则不移除（fail-open）；常量变更时以宿主源码重验 |

说明：`promptManager.tryGenerate`、`WORLD_INFO_ACTIVATED`、`WORLDINFO_SCAN_DONE`、`#send_textarea` 属于保留 legacy 导出或未文档化宿主行为，必须在实现时写入 `docs/host-contract.md` 并补充负路径测试。

## 10. 事件与生命周期

- 功能运行时（`activate`）在启用期间常驻，工作台是否打开不影响捕获。
- `deactivate()`：注销全部事件订阅，清空快照、预测结果与进行中状态。
- 工作台关闭：仅卸载页面 DOM，运行时保持订阅。
- `CHAT_CHANGED`：清空全部内存快照与预测结果；不尝试读取新聊天历史轮次。
- 生成被中止（`GENERATION_STOPPED`）：放弃该轮临时缓冲，不覆盖上一轮快照。
- 预测中止：`finally` 必须还原输入框与 token counts。

## 11. 推荐模块划分

```
src/features/prompt-viewer/
├─ index.js          # 创建 feature：runtime + mount
├─ schema.js         # 快照/条目/世界书条目的校验与投影
├─ model.js          # 纯函数：投影、来源归类、归因、token 汇总、筛选、搜索、序列化
├─ runtime.js        # 事件订阅、快照状态、预测流程、通知
├─ PromptViewerPage.js  # 原生 DOM 页面
└─ style.css         # 功能样式
```

宿主访问仍集中在 `src/kernel/host.js`；`model.js` 与 `schema.js` 不导入宿主模块。

## 12. 设置与存储

- 唯一持久化：`main` table 的 `prompt-viewer-settings-v1`，内容 `{ schemaVersion: 1, defaultCollapsed: boolean }`。
- 未知或损坏 schema 显式报错，并在页面提供重置该 key 的开发操作（与项目既有约定一致）。
- 搜索词、筛选、展开状态、预测输入、快照全部只驻内存。
- 不写聊天 metadata、不写世界书、不写 Blob。

## 13. 错误与边界状态

稳定错误种类：

| 种类 | 触发 |
| --- | --- |
| `PROMPT_MANAGER_UNAVAILABLE` | live `promptManager` 或其必需方法缺失 |
| `PROMPT_VIEWER_UNSUPPORTED_API` | `mainApi !== 'openai'` |
| `PROMPT_VIEWER_BUSY` | 预测或正文生成进行中 |
| `PROMPT_VIEWER_INPUT_UNAVAILABLE` | `#send_textarea` 缺失 |
| `PROMPT_VIEWER_PREDICTION_FAILED` | 宿主 dry-run 抛错或未产生 prompt-ready |
| `PROMPT_VIEWER_NO_SNAPSHOT` | 尚无上一轮快照 |
| `PROMPT_VIEWER_EXPORT_FAILED` | 复制或下载失败 |

界面只显示稳定原因文案，不显示宿主原始错误堆栈或提示词正文。

## 14. 隐私与日志

- 快照、预测结果、搜索词、筛选条件只驻内存。
- 不写日志正文、世界书名、uid、稳定聊天 ID、模型原始响应或访问密钥。
- 允许记录的结构化事件（跟随全局日志开关，脱敏安全）：
  - `prompt_viewer.snapshot_captured`：`generationType`、`assemblyRoundCount`、`itemCount`、`worldEntryCount`、`tokenTotal`、`squashSystemMessages`。
  - `prompt_viewer.prediction_started` / `prediction_completed` / `prediction_failed`：耗时、`itemCount`、`worldEntryCount`、稳定错误种类。
  - `prompt_viewer.exported`：`format`（`txt`）、`itemCount`、`source`（`copy` / `download`）。
- 分享类型徽章与模型名/来源属于用户可见信息，不进入日志。
- 复制与下载是用户显式操作；页面在工具栏旁常驻一行提示“导出内容包含提示词正文，请自行注意分享范围”。

## 15. 测试计划

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/prompt-viewer-model.test.js` | 条目投影与来源归类、世界书归因（exact/aggregate/unknown）、token 汇总、筛选与搜索高亮、可读分块序列化 |
| `tests/prompt-viewer-schema.test.js` | 快照/条目校验、损坏 schema 报错、设置往返 |
| `tests/prompt-viewer-host.test.js` | promptManager 快照读取、事件订阅/注销对称、各负路径（缺失方法、非法 payload） |
| `tests/prompt-viewer-runtime.test.js` | 捕获门控（dryRun、非 openai、生成类型）、上一轮覆盖与 `pendingUpdate`、预测 textarea 暂存还原（含异常路径）、counts 还原、`CHAT_CHANGED` 清理 |
| `tests/prompt-viewer-page.test.js` | 双标签、折叠与全展开、筛选搜索、横幅状态、空状态、复制/下载调用、预测交互 |
| `tests/prompt-viewer-registry.test.js` | 功能注册信息与默认关闭 |

完成后运行 `npm run check`。

## 16. 文档与契约更新

- `docs/host-contract.md`：新增“提示词查看”小节与证据行，更新核对基线为 `2.2.0` / `db4186da1e6e`。
- `docs/prompt-viewer.md`：用户使用文档。
- `docs/architecture.md`：补充 `features/prompt-viewer` 的职责描述。
- `README.md`：功能列表新增“提示词查看”。
- `DEVELOPMENT.md`：当前实现状态与宿主验收项。
- `style.css` 与 `src/features/registry.js`：注册新功能与样式。

## 17. 风险与后续候选

| 风险 | 处理 |
| --- | --- |
| `squash_system_messages` 开启导致条目合并 | 检测并显示警告；导出仍为实际发送内容 |
| 预测临时写入宿主输入框 | 保存并还原值、选区与滚动位置；元素缺失时禁用预测 |
| 预测发出 dry-run 事件影响其它扩展 | 与宿主自带 token 预览一致；页面常驻说明 |
| dry-run 覆盖 live `promptManager.messages` / `tokenHandler.counts` | 上一轮快照提前独立保存；counts 在 finally 还原 |
| 世界书深度注入无法逐条精确归因 | 不猜测：完全匹配才标注，否则由独立激活条目面板兜底 |
| 一轮生成内多次组装（工具调用 / Agent 多轮） | 记录 `assemblyRoundCount`，只展示最后一次组装结果，界面注明 |
| Agent 专用 identifier 未导出 | 按已知常量过滤并登记入宿主契约；未匹配到就不移除（fail-open） |
| 群聊多成员轮次 | “上一轮”取最后一个成员并标注成员名 |

后续候选（不在本期）：

- 保留最近 N 轮并可回看。
- 与上一轮 diff 高亮。
- 复制/下载 JSON 或带插件标注的结构化文本。
- Text Completion 管线。
- 读取宿主 Prompt Inspector 的持久化记录以回看历史轮次。
