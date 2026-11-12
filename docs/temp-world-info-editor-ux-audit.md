# 世界书编辑交互现状与客观行为记录

本文件记录世界书编辑（World Info Editor）在 2026-10-09 交互整改后的客观结构、DOM 布局与事件行为，以及本次未处理的现状。不包含主观评价。

整改实施记录与优先级见 `docs/ux-remediation.md` 的“世界书管理：移动端输入与编辑交互（2026-10-09）”，功能行为契约见 `docs/world-info-editor.md`。

---

## 1. 移动端视口、布局与软键盘表现

### 1.1 容器与视口定位机制
- **宿主与 iframe 容器**：
  - 宿主遮罩 `#tt-toolkit-overlay` 设置为 `position: fixed; inset: 0; width: 100vw; height: 100dvh;`。
  - iframe 内部 `body` 与 `#tt-toolkit-frame-root` 样式为 `width: 100vw; height: 100dvh; overflow: hidden;`。
  - 工作台容器 `.workbench` 为 `position: fixed;`；`@media (max-width: 720px)` 下为 `width: calc(100vw - 24px); height: calc(100dvh - 24px);`。
  - `ShellController` 监听宿主 `window` 的 `resize` 事件执行 `syncViewport()`，计算 `safeBottom`（仅读取 `env(safe-area-inset-bottom)`）。
  - iframe 的 `srcdoc` 视口声明为 `<meta name="viewport" content="width=device-width,initial-scale=1">`，未声明 `interactive-widget=resizes-content`（避免与外壳固定高度冲突）。

### 1.2 键盘避让变量
- `src/ui/keyboard.js` 提供 `installKeyboardInset(root)`：读取 `window.visualViewport.height`，把 `innerHeight - visualViewport.height`（下限 0，四舍五入）写入 `--ttk-keyboard-inset`；大于 60px 时在 root 上设置 `data-ttk-keyboard` 属性。监听 `visualViewport` 的 `resize` 与 `scroll`（Android 的 `resize` 会先带旧高度触发一次），用 `setTimeout(…, 0)` 合并同一帧内的重复触发。
- `ShellController.initialize()` 对宿主 `documentElement` 注入一次，`mountWorkbench()` 对 iframe 的 `documentElement` 再注入一次；两者在 `dispose()` 时各自清理，变量回落为 `0px`。
- 没有 `visualViewport` 时（桌面、部分 WebView），变量保持 `0px`。
- `src/ui/keyboard.js` 另提供 `scrollIntoViewAboveKeyboard(element, { delay = 120 })`：延迟后读取键盘遮挡高度，计算元素底边相对 `innerHeight - inset` 的溢出量；溢出时先滚最近的 `.workbench main`（`.wie-detail-pane` 在窄容器下不再滚动，滚动发生在外层宿主 `<main>`），否则回退 `scrollBy`。

### 1.3 Zen 全屏写作模式（`wie-zen-overlay`）
- **DOM 顺序**：`.wie-zen-header` → `.wie-macro-bar`（6 个宏按键）→ `.wie-zen-textarea`。
- `.wie-zen-overlay` 为 `position: absolute; inset: 0; display: flex; flex-direction: column; padding-bottom: var(--ttk-keyboard-inset, 0px);`。
- `.wie-zen-textarea` 为 `flex: 1; resize: none; padding-block-end: calc(14px + var(--ttk-keyboard-inset, 0px));`。
- 键盘弹起时宏栏位于表头与输入区之间，处于键盘覆盖区域之外；输入区底部内边距随键盘高度增大，光标行可滚到键盘上方。

### 1.4 普通编辑模式（窄容器 `mobileTab === 'basic'`）
- **DOM 顺序**：`.wie-mobile-view-header`（“‹ 返回列表” / 标题 / 保存）→ `.wie-mobile-tabs` → `.wie-section-basic` → `.wie-section-timing` → `.wie-section-advanced` → `.wie-form-footer`（“还原修改” / “💾 立即保存”）→ `.workbench-footer`。
- 正文区分区内部顺序为 `.wie-editor-toolbar`（字数与“⛶ 全屏写作”）→ `.wie-macro-bar`（6 个宏按键）→ `.wie-textarea`（`height: 170px; resize: vertical;`）。
- `@container ttk-content (max-width: 640px)` 下 `.workbench main.wie-detail-pane` 与 `.workbench main.wie-host` 设置 `padding-bottom: var(--ttk-keyboard-inset, 0px)`。
- 正文与触发词输入框聚焦、输入时调用 `scrollIntoViewAboveKeyboard`，把控件滚到键盘上方；同一时刻只保留最新一次滚动定时器。

---

## 2. 触发词（Tag / Key）输入与管理

### 2.1 事件监听与成块逻辑
- 标签输入框（`.wie-tag-input`）监听：
  - `keydown`：跳过 `isComposing` 与 `keyCode === 229`；`Enter`、`,`、`，` 成块（`/` 开头的正则输入按 `isRegexKey` 判定后放行逗号）；成块后清空输入框，输入框元素本身不被替换。
  - `blur`：输入框内仍有未成块文本时执行同一次成块逻辑。
  - `focus`：调用 `scrollIntoViewAboveKeyboard`。
- 词条块单独渲染在 `.wie-tag-list` 中（`display: flex; flex-wrap: wrap;`）；增删只替换该列表的子节点，输入框保持同一 DOM 节点。
- `runtime.revision` 与标签编辑器内部的 `revision` 记账用于区分“本次输入引发的变更”和“外部路径（还原、切换条目）引发的变更”；仅后者重新播种标签 DOM。

### 2.2 标签元素与删除控制
- 词条块 `.wie-tag` 内含文本（`span`）、可选 `.wie-tag-regex-badge` 与删除按钮 `.wie-tag-remove`（`button`，`aria-label` 为“删除触发词 …”）。
- `.wie-tag-remove` 基础尺寸 15×15px；`@container ttk-content (max-width: 640px)` 下为 26×26px、字号 16px。
- 标签本身不在点击时就地编辑；窄容器下标签最小高度 30px，输入框最小高度 30px。
- 未处理：标签的重命名、拖拽排序、批量操作。

---

## 3. 正文编辑与宏操作机制

### 3.1 宏按钮配置与插入逻辑
- 普通模式与全屏写作模式共用 `EDITOR_MACROS = ['{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"']` 与 `renderMacroBar`。
- `PAIRED_MACROS` 目前为 `[[` → `[[…]]`、`*动作*` → `*…*`、`"对话"` → `"…"`：
  - 有选区时，成对宏包裹选区，光标移动到左标记之后、选区保持选中；无选区时插入标记对，光标落在两标记之间。
  - 非成对宏（`{{char}}`、`{{user}}`、`]]`）直接替换选区或按光标插入。
- 插入后调用 `runtime.updateDraftField('content', value)` 并恢复焦点与选区。

### 3.2 文本框尺寸
- 普通模式 `.wie-textarea` 固定 `height: 170px`，`resize: vertical`（触屏上不可靠）。
- 全屏写作 `.wie-zen-textarea` 为 `flex: 1; resize: none;`。
- 未处理：按内容自动增高、在窄容器内调整高度。

---

## 4. 视图导航、滚动与保存状态管理

### 4.1 窄容器子视图流转（`mobileSubView`）
- 由 `mobileSubView: 'list' | 'edit'` 控制列表与详情的可见性。
- 点击卡片：`runtime.selectEntry(entry.uid)` 后切换为 `edit`。
- 点击“‹ 返回列表”：若草稿 `dirty` 或 `saveStatus === 'error'`，先执行一次手动保存；保存失败则停留详情、显示错误条与错误提示，不切换视图。保存成功或无待存内容时切回 `list`。
- 每次 `render()` 前记录 `.wie-card-list` 的 `scrollTop`，渲染后通过 `requestAnimationFrame` 恢复。

### 4.2 保存机制与操作入口
- **状态流转**：字段修改将 `saveStatus` 置为 `unsaved` 并启动 1000ms 防抖；超时后以 `isAuto: true` 保存，成功后为 `saved_auto`。手动保存（`isAuto: false`）在开启选项时先转换独立成词的 `user`，成功后为 `saved_manual`。
- **操作入口**：桌面端详情头部“💾 保存条目”与表单末尾“💾 立即保存”；窄容器顶部栏 `.wie-mobile-save`（状态文本，未保存/失败时高亮可点）与表单末尾“💾 立即保存”。都调用同一 `saveManually()`。
- **状态镜像**：`.wie-mobile-save` 的文案、`title` 与可点状态由 `syncMobileSaveChip()` 从详情头部的 `.wie-status-indicator` 同步；每次重绘后再同步一次。
- **状态标记**：详情头部的 `.wie-status-indicator` 在 `unsaved` / `error` 时附加 `wie-status-action` 类、`title` 为“点击立即保存”并可点触发保存；其它状态提示手动保存与自动保存的差异。该标记在窄容器下被隐藏（`.wie-detail-header { display: none; }`），由顶部栏的 `.wie-mobile-save` 代替。
- **错误恢复**：页面顶部 `.wie-error-bar`（`role="alert"`，空时加 `hidden` 类不占位）在保存失败时显示错误、提供“重试保存”和“重读世界书”。

---

## 5. 卡片列表与高级规则配置结构

### 5.1 条目卡片开关
- 每个卡片 `.wie-card` 含微型复选框开关 `.wie-mini-switch`（28×16px）；开关与包裹元素都调用 `stopPropagation()`，卡片自身的点击用于切换选中条目。
- 未处理：窄屏快速滚动时的误触防护、批量启停。

### 5.2 搜索与过滤
- `.wie-search-box` 内为图标、输入框与 `.wie-search-clear`（仅在输入框有内容时显示，点击清空并聚焦回输入框）。
- 过滤 chips 为“全部 / 常驻 / 已启用 / 已禁用 / @深度”，窄容器内横向滚动。

### 5.3 高级规则（Section 4）与窄容器选项卡
- 窄容器顶层 Tab 为 `basic`、`timing`、`advanced`。
- `.wie-section-advanced` 内部保留 `.wie-accordion-btn`（“⚙️ 高级触发与递归机制”）与 `.wie-accordion-content`；展示条件为 `view.accordionOpen || view.mobileTab === 'advanced'`。
- 未处理：Sticky / Cooldown / Delay / 扫描深度等参数的就地说明与取值范围提示。
