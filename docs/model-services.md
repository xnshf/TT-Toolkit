# 模型服务

“设置 / 模型服务”已注册并默认启用。`kernel/llm-presets.js` 管理共享预设；`kernel/decision-model.js` 提供通用 System One / Jev 概率决策服务，`kernel/llm-tasks.js` 保留 OpenAI-compatible Chat Completions 任务服务。两条协议互斥，不借用宿主当前聊天模型或 legacy `generateRaw`。

每组预设保存显示名称、协议 `openai` / `systemone`、用户自定义 API URL、模型名和访问密钥，可选择当前预设。`main/llm-presets-v1` 仍为 schema 1；已知旧预设缺少 `protocol` 时明确补为 `openai`，下次保存写入，未知协议或损坏数据须修正/显式重置。密钥允许为空，界面默认遮蔽；无内置固定供应商或模型要求。

模型预设成功加载后才能添加和保存。若存储读取失败，选择“重新加载”；此时不允许保存或重置，避免覆盖现有预设和访问密钥。已确认格式损坏时仍可在二次确认后重置。

“获取模型”和“测试连接”使用卡片当前 URL/密钥，仅执行 `GET /models`，不要求先保存，不持久化模型列表。System One 支持 `models[].name` 或 `data[].id` 两种模型列表；也可直接手填模型名。GET 成功只证明列表接口可用，不证明付费推理可用。

## System One 决策

URL 可填 http(s) 基础地址或完整 `/systemone`；严格拒绝 URL 内嵌凭据、查询参数与片段。决策通过 WebView `fetch` 直接 POST `{ model, state, questions }`，非空密钥作为 Bearer header，禁止重定向且不携带浏览器凭据。不使用宿主代理、不改宿主源码；服务需允许 CORS，网络/HTTP/超时/协议错误均返回脱敏类型化错误，由功能原生回退，不宣称真实服务已验证通过。

问题只使用 `{ type: "noul", instructions }`，响应须有非空 `model` 与精确问题 ID 对应的 `answers`，每项为 `type: "noul"` 和有限 `[0,1]` 概率。拒绝重复 JSON 键、遗漏/未知回答和非法 usage token 计数。一次判定的全部未命中问题合成一次 POST，无重试、文本 JSON 提取、格式降级、隐式输入裁剪或虚构通用 token 预算；支持超时与取消。

保存 System One 预设不会触发付费能力探测，也没有自动 dry-run 判定。功能请求与用户确认的手动条件测试才可能产生推理费用。URL/模型/密钥/预设变化会使决策功能下次判定清空精确问题缓存；阈值不进入概率缓存。

## OpenAI Chat Completions（保留）

URL 可填版本根路径或完整 `/chat/completions`、`/models`，后二者还原为 Base URL。此协议仍使用宿主原生后端进行模型发现与生成，生成使用零温度、任务指定输出长度及优先 `json_schema`；不能用于决策激活。

`LlmTaskService` 保留 `json_schema` → `json_object` → 普通 JSON 提取的格式降级，格式拒绝、空正文或单次格式超时可继续下一格式；用户取消立即停止，最终结果仍须任务校验。保存/修改 OpenAI 预设会后台探测缺失的 JSON 能力，写入 `llm-preset-json-capabilities-v1`（预设 ID、格式、时间，7 天过期）。此行为可能发出模型请求，**只适用于 OpenAI 预设**，不适用于 System One。

模型任务只记录任务 ID、预设 ID、耗时和错误类别，不记录 API URL、模型提示、响应、聊天正文或访问密钥；HTTP 错误响应正文也不会进入错误详情。设置界面默认使用密码输入框遮蔽；模型预设在写入或发起设置页请求前登记供 Toolkit 日志遮蔽，即使完整模式也不保留已登记的密钥原文。历史日志及宿主副本的保护边界见 [开发日志](./logging.md#模型预设值保护)。

任务接口统一接受系统提示、用户载荷、JSON schema、输出长度、超时和取消信号，并支持可选 `presetId`：提供时使用该预设，缺省使用当前预设。超时、取消、HTTP 错误、响应结构错误均抛出类型化错误，由消费者决定安全降级策略。

“世界书 / 决策激活”仅可使用已保存的 System One 预设，可跟随当前预设或指定 ID；缺失/协议不符时停止本轮接管，不偷偷改用旧聊天模型。选择与阈值/轮数/超时保存在 schema 2 的 `world-info-ai-settings-v1`，不复制连接或密钥。旧一键填充描述不再接入决策协议。详见 [决策激活](./world-info-ai.md)。
