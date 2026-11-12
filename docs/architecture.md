# TT-Toolkit 架构

TT-Toolkit 使用四个职责域：`kernel` 负责宿主桥、存储、通用 System One 决策与保留 OpenAI LLM 任务、功能加载契约；`shell` 负责可选悬浮球/魔棒菜单入口与顶层 iframe；`ui` 负责原生 DOM 工具台与元素 helper；`features/<id>` 封装各功能。活动源码和界面统一使用原生 JavaScript DOM。

功能通过静态轻量注册表声明稳定 ID、所属大类、显示信息和动态加载器。导航按 TauriTavern 数据域组织为“大类 → 功能”两级，只显示拥有已注册功能的大类。根目录 `index.js` 是固定的微型启动入口，直接导入 `src/main.js`；各 `src/features/<id>/index.js` 是功能入口，首次打开功能页或启用功能时才动态加载实现。关闭的功能仍可进入设置，但在进入前不会加载代码，也不能订阅宿主事件或读取聊天。当前 `model-settings` 与 `world-info-ai` 已注册，分别默认启用/关闭；仅 `prompt-conflict` 暂时隐藏，不加载运行时。

宿主事件负载由内核专用适配器验证，功能负责领域处理与降级提示。世界书决策与保留聊天屏蔽接线共用 `subscribeWorldInfoEntriesLoaded`，先验证四组数组再交付原引用、返回 Promise；决策通过 `{ last: true }` 单次 makeLast 注册，末位只保证注册时顺序，后续扩展可重排。非法事件不改数组，中止当前决策，下一轮重新校验。四组名称和白名单诊断集中在 `kernel/world-info.js`。其它事件链路未全部迁移，不宣称已审计。

单个功能内部继续按职责拆分。聊天清洗当前分为 schema 校验、字面规则、操作计划、事务写回、运行时、原生 DOM 页面和功能专属样式；聊天查看分为只读楼层模型、运行时、原生 DOM 页面和功能专属样式；聊天导出分为文档模型、规则、序列化、文件保存、运行时、原生 DOM 页面和功能专属样式；提示词查看分为 schema 校验、纯函数模型（来源归类、世界书归因、筛选搜索与可读分块序列化）、运行时、原生 DOM 页面和功能专属样式。三项聊天功能复用 `kernel/chat-messages.js` 中经验证的消息角色分类，避免 system、tool 与隐藏对话产生不同解释；聊天查看与聊天导出都经 `kernel/chat-projection.js` 取得同一份对话楼层投影。根目录 `style.css` 通过 CSS `@import` 聚合公共样式和各功能样式：宿主页面用它渲染悬浮入口，iframe 文档再次加载它渲染工具台。

可视化外壳不使用工作台 Shadow DOM。宿主创建固定定位的 `#tt-toolkit-overlay`，在其中放置全视口 iframe，再把原生 DOM 应用挂载到 iframe 文档。悬浮入口和 overlay 都直接挂到 `document.documentElement`，并强制使用 `2147483647` 层级，从而脱离聊天区域内部的层叠上下文。iframe 打开期间负责拦截工具台范围的输入，关闭后整体设为 `display: none`。桌面端将大类横向排列、当前大类的功能纵向排列，点击遮罩或按 Esc 关闭工作台（打开的模态确认框优先接管 Esc）；关闭后焦点回到打开工作台的入口（魔棒方式回到宿主魔棒按钮）；只用魔棒时隐藏悬浮球。手机外壳（≤720px，或主指针为触控且高度≤720px）默认全屏，标题栏按钮可切换为真正可拖动的悬浮窗口；两种模式、悬浮位置与自定义尺寸独立于桌面布局持久化。全屏通过 CSS 四边 inset 填满安全区内的可用空间、禁止拖动，不再由 JS 计算全屏宽高，也不调用隐藏系统栏的原生全屏接口；悬浮模式默认留出更明显的水平余量，右下角手柄支持触控/方向键缩放，取消不保存中间状态，不再支持标题栏下拉关闭。两层导航在手机上都可独立横向滚动（未到端点的一侧显示渐隐提示），标题栏的模式与关闭按钮均为 44px，在四边安全区外再留出顶部 12px 操作间距，全屏时再额外下移 16px 以避开状态栏与边缘手势误触；底部关闭栏移除。仅手机悬浮模式显示独立的缩放手柄行，不覆盖功能内容。overlay 标记为宿主公开 taxonomy 的 `backdrop`，保持 full-bleed；工作台从顶层文档读取 `--tt-inset-*` / `env()` 后，将四边输入桥接为 iframe 的 `--ttk-safe-*`，由自有 CSS 消费，避免重复安全区收缩；宿主 geometry firewall 不跨 iframe，不依赖其 private bridge。显示 overlay 后才读取 iframe/窗口的实际尺寸；视口 resize 与宿主根节点 style 变化时重新约束位置和尺寸，不覆盖记忆位置。布局保存失败时保留运行期布局并提供警告与重试，只记白名单 warn。危险确认统一由 `ui/confirm.js` 的 `confirmDanger`（`dialog.showModal`）提供遮罩、焦点陷阱与 Esc 取消，移动端取消/确认按钮整行拉满并放大触摸目标。功能内容建立独立 inline-size 容器，多列表单和数据布局根据内容区的实际宽度自动换列，不依赖 iframe 视口宽度推测可用空间。

主题与配色由令牌层统一驱动，不再在任何功能页写死颜色。`src/ui/tokens.css` 定义四层：与主题无关的结构令牌（圆角、阴影、动效、字体族）、宿主原始令牌通道（`--ttk-host-*`）、按主题的色板（`--ttk-bg` / `--ttk-text` / `--ttk-accent` / 状态色等）、以及由色板计算的派生令牌（边框、状态底色、分类色、卡片悬浮色）。根 `src/style.css` 以 `@import` 引入它。主题 id 契约在 `kernel/settings.js`，展示元数据（标签、说明、明暗）在 `ui/theme.js`，顺序固定为“暗色在前、亮色在后”供设置页排成暗上亮下两行。

宿主文档与工作台 iframe 是两个文档，`--SmartTheme*` 不跨文档继承。`src/ui/theme-bridge.js` 从宿主 `documentElement` 的计算样式读取真实令牌值写入 iframe 根节点，用 `MutationObserver`（`style`/`class`）合并 `settings_updated` 事件做增量同步，并按宿主模糊底色的相对亮度推断 iframe 内原生控件（下拉列表、滚动条）的明暗。`ui/theme.js` 的 `applyThemeDocument` 同时作用于两个文档：宿主文档只写插件自有的 `data-ttk-theme` 且**不改写宿主 `color-scheme`**（那会连带改变宿主自身的原生控件），iframe 内才额外写入 `color-scheme`。

8 套主题中 7 套的色值取自 daisyUI 5.7.47 内置主题并由 oklch 精确换算为 hex，1 套（羊皮纸）为手工调校；出处与换算式见 `docs/theme-provenance.md`。**不直接把 daisyUI 的 `--color-*` 写入宿主根节点**：那是无命名空间的变量，与宿主或其它扩展同名就会互相覆盖，因此只取色值并内联为 `--ttk-*`。全局样式（如 `input` / `button:disabled`）必须以 `html[data-ttk-surface]` 限定，该标记只加在 iframe 文档上，防止经 `manifest.css` 泄漏并改动宿主控件；宿主契约见 `docs/host-contract.md`。强调色与状态色只用作边框、线条与填充，不当正文，因为亮色主题的这些色是为“浅底 + 彩色前景”设计、当正文只有 1.4–4.2:1；`tests/theme.test.js` 锁定每套主题六组文字/底色对比度不低于 AA 4.5:1，并禁止彩色文字回退。

日志是内核级横切服务，由功能上下文注入外壳和各功能；事件使用稳定 `featureId` 作为产品归属、使用 `source` 保留技术来源，内核事件统一归入 `system`。启用后统一持久化两类事件：Toolkit 结构化事件与 TauriTavern 公开 `api.dev.frontendLogs` 提供的前端日志副本。宿主日志 ABI 是功能级必需能力，缺失或启动失败只停用日志功能；运行期收到非法 DTO 时宿主流标记为降级并记录 `host.stream_contract_failed`，不自动重连。宿主尾部与订阅、回流过滤、隐私投影和模型预设值保护由 `kernel/logging/` 实现（`logger.js` 会话状态机、`host-stream.js` 宿主日志流、`session-store.js` 分块与保留策略、`redaction.js` 预设值保护）。查看器位于独立的 `src/features/developer-logs/` 功能目录。日志注册为 bootstrap 阶段功能，已启用时先于普通功能启动。其持久化只使用 TauriTavern extension store 的 `logs` table 和公开 `api.dev.frontendLogs` 状态接口，不接管宿主 console。

模型服务是内核横切能力。`kernel/llm-presets.js` 保存独立 URL/模型/密钥和 openai/systemone 协议；schema 1 已知旧项缺协议明确补 openai，不把旧聊天预设用于决策。`kernel/decision-model.js` 是通用 System One / Jev 兼容客户端：直接 fetch `{ model, state, questions }`、精确 noul 回答及概率校验、超时/取消、一次 POST 无重试，不隐式裁剪或假设 token 预算。不借用宿主代理；WebView CORS 可能失败，普通脱敏错误由功能原生回退，不要求宿主改动。模型列表只 GET，支持两种形态或手填，不自动付费探测。

`kernel/llm-tasks.js` 保留 OpenAI structured output 格式降级与宿主原生传输，仅 openai 协议适用；设置页保存后后台 JSON 能力探测同样不用于 systemone。功能通过协议服务提交任务，不自行拼接鉴权。详见 `docs/model-services.md`。

世界书决策分为 schema/storage、context、routing、runtime 与原生页面，替代旧 AI/一键填充路径。条件概率 ≥ 阈值接管普通关键词/向量/常驻条目；模板/dont_activate、手动禁用、角色名/标签及生成过滤保持原生边界，背景仅取当前挂载范围内符合资格的原生常驻正文。context 从 canonical mes 按用户轮次构造 state，只调用 prompt 正则；条件严格宏展开，失败不原文回退。runtime 在 AFTER_COMMANDS 登记身份，加载事件内才付费判定，前后复验完整聊天身份/角色/消息/目标，STOP/END/CHAT_CHANGED 取消。routing 预先完成验证与 clone，再负向 disable、正向 constant 清概率/定时/递归门，不发送强制激活事件，预算/分组仍原生。

已接受事件缺少加载来源关联的限制：有效生成内其它扩展加载可能提前触发付费/应用，不保证只命中正式扫描。精确概率缓存仅内存（500 项/60 秒、阈值独立、预设变化清空），最近记录最多 50 项，最终注入仅取宿主最终扫描 activated.entries Map。手动条件测试须确认发送与费用，可替换所选挂载书草稿，不保存/应用；无自动 dry-run 测试。导入按 UID 明确预览合并，不含密钥。设置/世界书配置 schema 2 显式迁移已知 v1，未知/损坏可针对性重置。存储 fresh 比较整书后嵌入并验证，已有摘要 key 回退直到验证和清理成功才退出权威，不存备份。详见 `docs/world-info-ai.md` 与 `docs/storage-contract.md`。

提示词冲突检测目前隐藏，下述仅描述保留源码，不代表注册或运行。它是“配置源审计器”：纯数据层（`features/prompt-conflict/sources.js`、`schema.js`、`overrides.js`）负责来源归一化、快照指纹、两阶段协议严格校验、分批与聊天级屏蔽计划；`model-analysis.js` 串行执行原子指令提取批次并做内存缓存，再做全局冲突比较（40,000 字符硬上限），任何校验失败都不产生部分报告。宿主窄适配集中在 `kernel/host.js`：惰性读取 `/scripts/openai.js` 的 live `promptManager`（按全局 prompt order 收集启用、非 marker、非空且参与普通生成的项目），复现 `WORLDINFO_ENTRIES_LOADED` 四组来源，订阅五个来源失效事件，读写聊天 metadata 的 `tt-toolkit.prompt-conflict` namespace。动态模板识别从世界书 AI 功能抽取为内核共享模块 `kernel/dynamic-template.js`，两功能共用同一套保守排除规则。运行时屏蔽只移除 `worldDigest + uid + contentDigest` 精确匹配的条目并 fail-open，应用前重新验证聊天身份与条目；报告过期后仍可读但动作禁用。页面使用双标签（检测范围/检测结果）、紧凑来源行、冲突卡片、底部暂存栏与原生 `<dialog>` 确认框，全部内容以文本节点渲染，窄容器用容器查询降级。

聊天查看只在启用期间持有当前 `chat[]` 的内存快照及引用该正文的派生视图，不建立第二份持久化历史。范围分页和精确搜索均在该快照上运行；聊天事件只把快照标记为过期，下一次操作再重新读取。搜索高亮通过 iframe 内的文本节点与 `<mark>` 渲染，不修改宿主聊天 DOM。

提示词查看同样是只读解释器而非第二套组装实现。上一轮直接读取 live `promptManager.messages` 的逐条投影，预测调用宿主自身的 dry-run，两者都经 `kernel/host.js` 窄适配；捕获后过滤三个 Agent 专用 identifier 以得到普通组装口径。快照、预测结果与搜索筛选只驻内存，唯一持久化是功能级“默认折叠”设置；导出为实际发送的 messages 可读分块。

“设置 / 界面与入口”是静态注册的内置设置功能，借助外壳传入的窄控制接口读写入口方式、外观主题与布局重置，不直接访问宿主。默认使用悬浮球，可切换为魔棒菜单或两者；主题默认“跟随宿主”，选择后立即应用并保存。魔棒 DOM 依赖只在 `kernel/host.js`：等待宿主 `ensureExtensionsUiReady()` 后添加自有菜单项，并通过 `showHideExtensionsMenu()` 同步可见性；切换到悬浮球或销毁外壳时移除自有节点和监听器。菜单节点与导出缺失只影响魔棒入口；启动失败显式保留悬浮球，设置切换失败保留原入口并给出白名单 warn 诊断。缺少宿主导出属于宿主构建能力缺失（该导出由宿主构建决定），提示与恢复动作指向升级或更换宿主构建，不引导用户重载宿主。页面使用原生 radio 卡片和独立功能 CSS，按实际内容宽度在三列/单列间切换；前置区域吸顶保存栏区分草稿与生效状态，失败保留选择供重试，局部更新不重建控件。详见 `docs/toolkit-settings.md`。

当前版本唯一来源是根 `manifest.json` 的 `version`。`src/version.js` 提供读取与校验函数，启动时读取一次，再经 `ShellController` 和页面 props 传给标题栏；源码不嵌入版本常量，私有 npm 工程和现状文档不重复维护当前版本。安装清单不可读或损坏时给出重新安装/重载提示，不猜测版本。

活动 JavaScript 源码在 `src/`，测试在 `tests/`。用户直接加载根目录 `index.js` 和 `style.css`，二者继续引用原结构下的 `src/`；不存在另一套 `dist/`、`chunks/` 或根 `features/`。`npm run syntaxcheck` 使用 Node 检查全部活动 JS，Vitest 覆盖行为；`npm run check` 把两者串起来，是提交前的门禁。原生 JS 功能不构建；将来只有确实需要编译的功能才允许在自己的功能子目录内生成产物，且不得写入个人路径或开发环境信息。

样式相关契约测试集中在 `tests/theme.test.js`：主题注册表与内核 id 契约一致、每套主题必须有可解析色板、令牌无死声明、已注册功能页禁止字面颜色与 `color-scheme` 覆盖、禁止把强调色/状态色当正文、每套主题六组对比度不低于 AA 4.5:1、宿主令牌桥不污染宿主文档。`tests/shell-overlay.test.js` 另外断言不存在无限定作用域的 `input` / `button:disabled` 规则。

`0.x` 允许调整内部架构与 schema；进入 `1.0.0` 后，配置迁移器、旧功能 ID 和旧路由兼容成为发布门槛。
