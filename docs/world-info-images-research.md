# 世界书图片输入：宿主接入调研

## 范围与结果

本轮只调研和编写本地开发文档，不修改 TT-Toolkit 或 TauriTavern 运行时代码。用户先前明确要求方案获批后才开发；本轮“先做能做的部分、不打扰”的授权用于完成无需额外选择的调研、验证与方案整理。

核对宿主：TauriTavern `2.4.0`，Git 提交 `0a7e7a55e3ac`。所有宿主路径均相对宿主仓库；行号为本次定位提示，不作为长期 API。

结论：

1. **可复用现有图片工具和模型传输链路，无需写各家模型协议。**
2. **能取得世界书最终激活集合，但这不是最终消息中逐条图文的位置映射，也不总等于文字实际进入请求。**
3. **在当前查到的导出和事件中，未发现一个同时满足“逐条原生位置、提前计入预算、跨 provider 合法角色”的通用图片钩子。** 不能据此断言宿主永远做不到，但不能把当前证据当作已实现条件。
4. 用户已允许无法精准插入时统一位置附图；普通 Chat Completions 的最终消息事件可作为候选。但插入点必须保护 continue/prefill/工具消息，且要解决预算和提示词查看，不是简单 `push()` 就完成。
5. 本地 Blob 持久化与 URL 一次性导入具备基础能力；单独导出世界书 JSON 不携带 Blob。

## 1. 世界书从扫描到文字的实际链路

### 1.1 扫描与预算

`src/scripts/world-info.js`：

- `collectWorldInfoEntries()` 读取全局、角色、聊天、Persona 四组条目，等待已有保存完成与预取，然后发 `WORLDINFO_ENTRIES_LOADED`（约 `4685–4717`）。
- `getSortedEntries()` 合并排序后调用 `prepareWorldInfoEntries()`（约 `4730–4760`）。
- 扫描循环执行资格、概率、分组、递归及文本预算等规则，发 `WORLDINFO_SCAN_DONE`；负载带 `isFinal`、`isDryRun`、`activated.entries` Map（约 `5284–5313`）。
- 最终扫描事件处于图文字符串归组之前。预算此前按文字处理，不能把“entry 已激活”解释为图像 token 也已预留。

### 1.2 最终文本归组会丢失逐条位置身份

`world-info.js:5329–5420`：

1. 对最终集合排序，执行世界书 prompt 正则。
2. 正则结果为空则不添加到提示词，但该条目仍可能位于激活集合。
3. `before/after` 变为字符串数组后以换行合并。
4. `atDepth` 按 depth + role 合并条目内容。
5. 示例消息、AN 和 Outlet 分别走不同数组或字典。
6. 返回结构包含文本组与激活集合，不为最终每段文字输出稳定的 entry→消息索引映射。

`getWorldInfoPrompt()` 只在非 dry-run 且激活集合非空时发 `WORLD_INFO_ACTIVATED`（约 `947–962`）。空集合时不发该事件，不能依赖它重置上一轮状态。

### 1.3 文本还会经过后续转换或裁剪

`src/script.js:5607–5670`：

- 示例文本经 `baseChatReplace()`、`parseMesExamples()` 转为多条消息。
- 深度组通过 `setExtensionPrompt()` 注册，组内用 `join('\n')` 合并。
- Outlet 注册为 `extension_prompt_types.NONE`；是否进入最终请求取决于宏是否引用，不能仅因 Outlet 条目激活就认定文字已发送。
- `skipWIAN` 会跳过深度/Outlet 注入；AN 另有启用条件与组合步骤。

`src/scripts/openai.js`：

- `preparePromptsForChatCompletion()` 为 worldInfoBefore/After 构造 system prompt（约 `2230`）。
- `populationInjectionPrompts()` 把深度条目和同深度其它扩展文本再次按角色/优先级合并，转成 injected 消息（约 `1395–1459`）。
- `populateChatHistory()` 按上下文余量装入历史和注入消息；深度文字可能因上下文预算未进入请求（约 `1505` 起）。
- `populateDialogueExamples()` 对示例再处理并受预算影响。
- `addToChatCompletion()` 还检查预设项是否被禁用、是否采用相对位置（约 `2021–2041`）。因此某本世界书激活并不保证对应预设组件被发送。

**实现影响：**“与文字同触发”可用原生最终集合表达；若要求“只要文字最终没有发送，图片也必须没有发送”，仅使用最终激活 Map 不够。需要处理以上过滤，或明确接受同激活、统一位置发送的语义。此处归档为待审批语义差异，不擅自选择。

## 2. 精准原生位置的限制

### 2.1 消息身份不能还原为条目身份

最终消息通常保留 role/content 等字段，丢弃 `identifier`；即便从 PromptManager 获取带 identifier 的快照，也只能定位 worldInfoBefore/After 等组件或合并的深度消息，无法通用地把合并内容拆回每个条目。

不能用正文子串搜索当成可靠映射：正文可重复，宏/正则会改写文本，示例可拆分，Outlet 可复用多次。

### 2.2 多模态能力不等于允许 system 图片

宿主 Rust 已明确区分角色约束：

- `chat_completion_service/payload/claude/messages.rs:44–70`：启用 system prompt 时，对前导 system 消息调用 `reject_media_for_text_only_content("Claude Messages system prompt", ...)`。
- `payload/makersuite.rs:370–390`：提取 Gemini system instruction 时也拒绝媒体。
- Claude 同文件 `move_assistant_images_to_next_user_message()` 还会调整 assistant 图片位置；即使上游放在原位，下游也可能重排。

因此不能直接向原生 system 世界书消息塞图片，然后称“模型有多模态就一定能用”。要跨 provider 使用，优先采用 user 图片消息，保留原世界书文本角色不变；这是消息位置/角色设计，不是要插件重写模型协议。

### 2.3 不采用的捷径

- 不 monkey-patch 宿主方法或原型，不替换生成函数。
- 不永久向正文加入 Markdown/HTML 图片标签并假装模型会读图。
- 不在扫描事件中向原文塞临时标记，再于最终请求替换：这会影响文字预算、正则、递归文本和第三方扩展共存，还要保证标记绝不泄漏。
- 不依赖 DOM 消息或 PromptManager 可视行的位置推断源条目。
- 不为精准插入偷偷修改宿主源码。

如果未来需要宿主 PR，建议讨论一个正式的“条目已过文字处理、仍带来源身份、参与消息预算之前”的媒体扩展点，并明确不支持图片的角色如何归位。这里只记录缺口，不为本功能修改宿主。

## 3. 统一位置候选链路

### 3.1 宿主工具足够构造图片消息

`src/scripts/openai.js:99–111` 导出 `Message`、`MessageCollection`。

- `Message.createAsync(role, text, identifier, tokenHandler?)` 生成文本消息并调用宿主计数。
- `Message.addImage(DataURL)` 追加图片块，复用现有压缩和视觉 token 估算（约 `5270–5297`）。
- `new MessageCollection(identifier, message).getChat()` 输出宿主标准消息（约 `5454–5500`）。
- 插件不必手写 `image_url` 内容块，更不需要实现 OpenAI/Claude/Gemini 请求转换。

图片准备应先在插件受控边界完成读取与解码，再给 helper 传 Data URL：`addImage()` 对远程 URL 使用 fetch，失败会 console 打印并返回；仅 await 成功不能证明图片附加成功。

`compressImage()`（约 `5373`）按 source、体积和 MIME 条件压缩，不保证每张图都缩到统一尺寸。`getImageTokenCost()` 使用现有视觉估算法，不是所有模型的精确计费器，不应复制到插件后另行“修正”。

### 3.2 最终消息事件可原地修改

`prepareOpenAIMessages():2512–2523`：

```js
const chat = chatCompletion.getChat();
const eventData = { chat, dryRun };
await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
return [chat, activePromptManager.tokenHandler.counts, toolData];
```

可修改 `eventData.chat` 指向的原数组；仅把属性替换为新数组不改变随后返回的局部变量 `chat`。

`sendOpenAIRequest():4691` 起继续走宿主当前设置、生成参数、provider 转换和流式响应。不直接调用它补发第二次请求，也不更换模型预设。

### 3.3 不能无条件追加到末尾

- `populateChatCompletion():2163–2175`：continue + continue_prefill 会把待续 assistant 消息移到 controlPrompts。
- `2188–2198`：controlPrompts 在正文/示例处理后追加。
- `populateChatHistory():1539–1562,1822`：非 prefill 的 continue 又有单独 nudge 集合。
- 群聊 nudge、quiet/tool 控制消息也有独立语义。

统一位置候选应优先在最后一条真实 user 消息附近、尾部控制消息和 prefill 之前。最终数组本身不足以完整标识所有真实/合成消息；要结合组装快照识别，并验证快照与实际数组的对应。识别失败时本轮只发原文字，不能乱插消息或拆开 tool_calls/tool results。

具体位置暂不固化：用户已接受末尾或其它统一位置，不代表已接受破坏 continue 或工具回合。

### 3.4 预算只能做独立估算，不能声称重新参与原生淘汰

- `ChatCompletion.setTokenBudget()` 使用 context - response（约 `openai.js:5630`）。
- 原生 add/insert 在组装期间扣预算；prompt-ready 在这些操作完成后才发。
- PromptManager `setChatCompletion()` / `populateTokenCounts()`（`PromptManager.js:1818–1840`）在事件前写入 counts。

晚附图必须另行估算剩余额度，并计入描述文字、消息开销和所有本轮选中图片。不能把 inventory 图片总量当成发送成本，也不能只看单图大小。

不能为塞图片悄悄删聊天历史/世界书文字。超预算时保持原文字并说明遗漏；按何种原生顺序保留部分图片还需批准。估算仍可能与 provider 实际计数不同。

## 4. URL 与本地 Blob

### 4.1 URL 是否一定要缓存：校正后的结论

不一定。宿主 Claude 转换器明确支持远程 http(s) 图片 URL（`claude/messages.rs:293–313`），OpenAI 格式也保留 image_url 块。但并非所有 provider 都以同样方式取图。

需要区分：

- 浏览器/插件自行 fetch：受 WebView 网络及 CORS 限制。
- 服务商接收 URL 后自行取图：不受插件浏览器 CORS 约束，但受服务商可访问性、URL 有效期等限制。

前期交互中“远程引用受跨域影响”未分层说明，应以上述区分为准。

用户已选择 URL 只做一次性本地导入，故不需要实现直接 URL 内容块路径。导入失败提示改选本地文件；不增加未核实的跨域代理，不保留 URL 或本机路径用于日志。

### 4.2 Blob 接口已核对前后端

公开文档 `docs/API/Extension.md` 与当前源码一致：

- `src/tauri/main/api/extension-store.js:118–156`：setBlob 接受 Blob、字节缓冲或裸 base64；Blob 分块提交，getBlob 通过 stream 返回 Blob。不要把带 `data:image/...` 前缀的 Data URL 当裸 base64 传给 setBlob。
- `getBlob()` 对缺失条目抛错；没有 tryGetBlob。其它错误不能当缺失。
- Rust `tt-adapter-storage-core/src/repositories/file_extension_store_repository.rs:105` 校验组件；`publish():134` 发布单文件；`finish_commit():196` 用锁串行发布；`delete_entry():245` 对缺失文件报错。
- 无跨 Blob/世界书引用事务。写 Blob 成功而引用保存失败会有孤儿；不能因失败删除可能已有其它引用的对象。

可行保存顺序：验证并准备 Blob → 写入并确认资源 → fresh 复验世界书 → 最小变更引用 → 回读确认。失败保留草稿，原引用不变；资源清理单独处理。

### 4.3 引用位置：发现了书级 UID 映射的代价

宿主 `duplicateWorldInfoEntry()`（`world-info.js:4121–4136`）只深拷贝条目字段，分配新 UID；`moveWorldInfoEntry()`（约 `6150–6210`）也是深拷贝条目再换 UID。

因此：

- 书级 `UID→附件` 映射不会自动随宿主条目复制/跨书移动。
- **条目自身扩展字段是更值得评估的引用位置**：原生复制/移动会连同字段一起带走，激活条目也可直接携带引用，省去每轮读整本书找映射。
- 这是对草案早期“建议书级”方向的修正建议，不直接确立 schema。需与已有手动 user 宏转换一起调整保护范围。

共享 Blob 不能在某个引用删除时直接物理删除，因为另一条目或另一本书可能仍引用它。没有可靠完整引用集合之前不自动回收持久资源；不得通过只扫当前挂载书推断“全局无人引用”。

首版不做资产库 UI、不打包导出，并不等于可以省略容量提示与明确重置/清理的损失说明。全功能清理会使其它未挂载世界书的引用失效，必须明确告知，不能伪装成无损清理。

### 4.4 世界书导入导出

- 原生导出按钮直接 `JSON.stringify(data)`（`world-info.js:2702`）。
- 整书复制把完整 data 保存到新名字（约 `2710`）。
- 原生普通世界书 JSON 导入把完整 JSON 放进 convertedData（约 `6004`）；外部格式转换走专用转换器，不承诺保留任意插件扩展。
- TT-Toolkit 现有管理器也保留完整对象，fresh 复验后最小写回。

因此普通世界书 JSON 可携带图片**引用元数据**；不携带 extension store 的 Blob。同一数据根中复制/改名可继续解析资源，搬到另一台仅导入 JSON 会缺图，需要明确可定位提示并继续文字。

## 5. 提示词查看：比监听顺序更深的差异

TT-Toolkit 当前 `src/features/prompt-viewer/runtime.js`：

- `capturePromptReady({ dryRun })` 不使用传入 chat 内容。
- `createSnapshot()` 读取 `host.readPromptViewerSnapshot()`。
- 后者投影 live `promptManager.messages`，不是最终 prompt-ready chat 数组。

因此即使把图片监听器排在查看器之前，单改最终数组也不会让查看器自动看见新增图片。原生 getChat 会新建外层消息对象，不能指望把新消息插入 chat 同时改变 PromptManager collection。

正式开发需要同步明确“原组件归因”与“最终消息数组”两个数据源；不能为让查看器显示而同时乱改宿主预算状态。

`src/features/prompt-viewer/model.js` 的 `stringifyContent()` 对非字符串 JSON.stringify，TXT 导出也调用它。新增图片后若直接沿用，可能把完整 Data URL 导出到文本或变成巨大搜索内容。需在查看/文本导出中使用明确图片占位或计数，不静默丢掉文字，也不把图片二进制当日志。

本轮不顺便修复已有查看器的其它行为；这些是图片接入的必要交叉工作，开发时纳入范围。

## 6. 生命周期与降级

- `src/lib/eventemitter.js:130–154` 逐个 await 监听器，但捕获异常继续派发；监听里 throw 不能可靠阻止请求。
- 用户已选择图片失败仍继续文字，所以不需要为普通图片错误实现强行中止宿主请求。
- 需在局部临时数组准备所有待附消息，验证后一次发布；不能先改原数组一半，失败后留下不完整图片块。
- 图片读回、解码、构造期间，聊天切换或生成取消要使计划失效；读取完成后不得跨聊天发布。
- 世界书扫描与最终消息事件没有能直接绑定两者的公开生成 ID。同聊天窗口内其他扩展扫描仍可能产生歧义；stable ID + 完整 ref 只能证明聊天，不证明扫描来源。
- 默认模式、再生成、swipe、continue、群聊角色回合必须独立验证。Agent 明确不在首版；quiet/tool 等额外请求路径不能因同样发事件就误附上一轮图片。
- dry-run 可读取本地图片做无付费估算；不再下载导入源 URL，也不改变附件持久化。预测应明确是估算，不宣称已实际发送。

## 7. 已完成验证

执行已有宿主测试，无新增测试文件：

```sh
node --test tests/extension-store.test.mjs tests/world-info-document-transport.test.mjs tests/world-info-token-batch-contract.test.mjs
```

结果：**8 项通过，0 失败**。

覆盖价值：

- Blob/字节写入的调用时快照与输入规范化。
- 缺失、null、非法 UTF-8 的读取区分。
- 世界书路由 JSON 传输保留。
- 原生世界书 token 批处理对激活顺序及预算决策的既有保护。

这些测试不验证图片功能、真实 provider 或 WebView CORS，不据此声称端到端成功。未运行 Rust 测试和真实模型请求，未产生模型费用；本轮无运行时代码变更，不为文档改动运行插件全量 check。

## 8. 完成项与存档项

### 已完成

- 核实原生激活→文本归组→消息组装→请求传输链路。
- 核实图片 Message/MessageCollection 可复用，避免自写媒体协议。
- 核实 Blob 文档、前端和 Rust 发布/缺失/删除边界。
- 识别精准位置、system 角色、最终文字裁剪、工具/prefill、查看器和宏转换交叉影响。
- 更新方案草案，保留用户决定与开发审批门槛。

### 待后续批准或实机验证

- 原生位置无法完整覆盖时统一位置的具体算法与分路径范围。
- 同激活与最终文字实际进入请求的语义差异；正则为空、Outlet 未引用等处理。
- 引用 schema 位置（建议条目级）及资源清理范围。
- 单图安全限制、单轮预算与超量图片取舍顺序；库存只提示。
- 同轮外部扫描歧义的剩余边界。
- 图片附件编辑、持久化、运行时、查看器及日志实现。
- 普通生成/重生成/swipe/continue/群聊实际出站图片验收，以及移动端 URL 导入与解码。

上述未决问题已存档，不在用户离开期间追问、不把候选策略擅自写入运行时。
