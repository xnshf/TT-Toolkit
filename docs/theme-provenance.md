# 主题色值出处

本文件记录 `src/ui/tokens.css` 中内置主题的原始调色板来源，供日后核对与更新。

主题共 8 套，设置页按“暗上亮下”排成两行：暗色为跟随宿主、青灰、午夜、摩卡；亮色为朝霞、樱雪、拿铁、羊皮纸。
取值来源：**daisyUI 5.7.47** 自带主题（MIT License，Copyright 2020 Pouya Saadeghi）。

- daisyUI 主题用 `oklch()` 定义色值；`tokens.css` 里的 hex 由 oklch 精确换算而来。
- 换算方式：oklch → oklab → linear sRGB → sRGB，无人工调整。
- 表面层级映射：`--ttk-bg` ← `base-200`，`--ttk-panel` ← `base-300`，`--ttk-card` ← `base-100`，`--ttk-inset` ← `base-300`。
- 唯一派生规则：**浅色主题的 `--ttk-danger` 取 `error-content`（深色成员）**。
  daisyUI 浅色主题里 `error` + `error-content` 是「深底 + 浅字」，而我们的危险按钮是
  「深底 + 浅字」，取深色成员后实测 7.6-14.7:1；直接沿用 `error` 只有 3.3-4.1:1。
- 强调色与状态色**只用作边框/下划线/填充**，不当正文；彩色提示用
  「浅底 + 主题正文色」徽章或「实底 + `-content` 配对色」。原因见下。

## 为什么不能用强调色/状态色当文字

这些主题是为「浅底 + 彩色前景」的编辑器语法高亮设计的，所以浅色主题的强调色偏亮。
实测把它们当正文放在卡片上：

| 主题 | 强调色/卡片 | 成功/卡片 | 警告/卡片 | 信息/卡片 |
| --- | --- | --- | --- | --- |
| 朝霞 | 1.53:1 | 4.24:1 | 2.87:1 | 3.23:1 |
| 樱雪 | 1.40:1 | 2.37:1 | 1.83:1 | 2.59:1 |
| 拿铁 | 19.78:1 | 7.18:1 | 1.66:1 | 8.49:1 |

所以彩色文字一律改成浅底徽章。`tests/theme.test.js` 会拦住回退（禁止
`color: var(--ttk-accent|success|warning|info|danger)`）。

## 朝霞（`dawn`，源自 daisyUI `retro`）

```css
--color-base-100: oklch(91.637% 0.034 90.515);
--color-base-200: oklch(88.272% 0.049 91.774);
--color-base-300: oklch(84.133% 0.065 90.856);
--color-base-content: oklch(41% 0.112 45.904);
--color-primary: oklch(80% 0.114 19.571);
--color-primary-content: oklch(39% 0.141 25.723);
--color-success: oklch(51% 0.096 186.391);
--color-warning: oklch(64% 0.222 41.116);
--color-error: oklch(70% 0.191 22.216);
--color-error-content: oklch(40% 0.123 38.172);
--color-info: oklch(58% 0.158 241.966);
```

## 樱雪（`blossom`，源自 daisyUI `cupcake`）

```css
--color-base-100: oklch(97.788% 0.004 56.375);
--color-base-200: oklch(93.982% 0.007 61.449);
--color-base-300: oklch(91.586% 0.006 53.44);
--color-base-content: oklch(23.574% 0.066 313.189);
--color-primary: oklch(85% 0.138 181.071);
--color-primary-content: oklch(43% 0.078 188.216);
--color-success: oklch(69% 0.17 162.48);
--color-warning: oklch(79% 0.184 86.047);
--color-error: oklch(64% 0.246 16.439);
--color-error-content: oklch(27% 0.105 12.094);
--color-info: oklch(68% 0.169 237.323);
```

## 拿铁（`latte`，源自 daisyUI `caramellatte`）

```css
--color-base-100: oklch(98% 0.016 73.684);
--color-base-200: oklch(95% 0.038 75.164);
--color-base-300: oklch(90% 0.076 70.697);
--color-base-content: oklch(40% 0.123 38.172);
--color-primary: oklch(0% 0 0);
--color-primary-content: oklch(100% 0 0);
--color-success: oklch(43% 0.095 166.913);
--color-warning: oklch(82% 0.189 84.429);
--color-error: oklch(70% 0.191 22.216);
--color-error-content: oklch(39% 0.141 25.723);
--color-info: oklch(42% 0.199 265.638);
```

## 青灰（`slate`，源自 daisyUI `dim`）

```css
--color-base-100: oklch(30.857% 0.023 264.149);
--color-base-200: oklch(28.036% 0.019 264.182);
--color-base-300: oklch(26.346% 0.018 262.177);
--color-base-content: oklch(82.901% 0.031 222.959);
--color-primary: oklch(86.133% 0.141 139.549);
--color-primary-content: oklch(17.226% 0.028 139.549);
--color-success: oklch(86.171% 0.142 166.534);
--color-warning: oklch(86.163% 0.142 94.818);
--color-error: oklch(82.418% 0.099 33.756);
--color-error-content: oklch(16.483% 0.019 33.756);
--color-info: oklch(86.078% 0.142 206.182);
```

## 午夜（`midnight`，源自 daisyUI `night`）

```css
--color-base-100: oklch(20.768% 0.039 265.754);
--color-base-200: oklch(19.314% 0.037 265.754);
--color-base-300: oklch(17.86% 0.034 265.754);
--color-base-content: oklch(84.153% 0.007 265.754);
--color-primary: oklch(75.351% 0.138 232.661);
--color-primary-content: oklch(15.07% 0.027 232.661);
--color-success: oklch(78.452% 0.132 181.911);
--color-warning: oklch(83.242% 0.139 82.95);
--color-error: oklch(71.785% 0.17 13.118);
--color-error-content: oklch(14.357% 0.034 13.118);
--color-info: oklch(68.455% 0.148 237.251);
```

## 摩卡（`mocha`，源自 daisyUI `coffee`）

```css
--color-base-100: oklch(24% 0.023 329.708);
--color-base-200: oklch(21% 0.021 329.708);
--color-base-300: oklch(16% 0.019 329.708);
--color-base-content: oklch(72.354% 0.092 79.129);
--color-primary: oklch(71.996% 0.123 62.756);
--color-primary-content: oklch(14.399% 0.024 62.756);
--color-success: oklch(74.722% 0.072 131.116);
--color-warning: oklch(88.15% 0.14 87.722);
--color-error: oklch(77.318% 0.128 31.871);
--color-error-content: oklch(15.463% 0.025 31.871);
--color-info: oklch(79.49% 0.063 184.558);
```

## 更新方式

1. 取 daisyUI 对应版本的 `theme/<name>.css` 中 `--color-*` 原值。
2. 按同样换算与派生规则重算 hex。
3. 更新 `src/ui/tokens.css` 对应主题块。
4. 跑 `npm run check`：`tests/theme.test.js` 校验每套主题的六组对比度
   （正文/画布、正文/面板、正文/卡片、正文/凹陷、强调按钮反白、危险按钮反白）
   均不低于 AA 4.5:1，并禁止把强调色/状态色当正文。
