# Universal AI Chat Exporter（ChatGPT / Gemini / Grok）

一个 **本地优先（local-first）** 的浏览器 Userscript：将 **ChatGPT / Gemini / Grok** 的对话导出为 **Markdown 或 JSON**，重点优化了 **TeX/公式提取**、**多行公式规范化**、以及 **跨平台附件/图片兜底扫描**；并提供可选的 **图片 data URI 内嵌**（对 Typora 更友好）。

> 适用场景：写作归档、知识库沉淀、离线保存、把 AI 对话整理成可搜索的 Markdown/JSON。

---

## 功能特性

- **导避免“只截到当前屏幕”**：可在导出前自动尝试加载更多历史消息（滚动 + 尝试点击“加载更多/展开”）
- **更好的公式导出**
  - 从 KaTeX / MathML / DOM 属性中提取 TeX
  - 可将多行/环境公式转为块公式（`$$...$$`）
  - 可做 array → aligned 等兼容化处理
- **图片与附件**
  - 默认导出为图片链接
  - 可选：把图片内嵌为 **data URI**（离线友好）
  - 跨平台“附件/图片兜底扫描”（ChatGPT / Gemini / Grok）
  - 可选：修复并移动 Gemini 的 `**Images**` 画廊区块，避免重复或位置不合理
- **UI 隔离**
  - 设置面板使用 Shadow DOM，尽量不影响原网页样式/交互
  - 页面右下角常驻一个 `Export` 按钮

---

## 支持的网站

脚本会在下列站点的对话页面生效：

- ChatGPT：`https://chat.openai.com/*`、`https://chatgpt.com/*`
- Gemini / Bard：`https://gemini.google.com/*`、`https://bard.google.com/*`、`https://www.bard.google.com/*`
- Grok：`https://grok.x.ai/*`、`https://x.com/i/grok*`

> 说明：不同平台 UI 结构差异较大，本脚本使用“平台适配器 + DOM 规则”提取对话内容；若页面结构更新导致失效，欢迎提 issue/PR。

---

## 安装

1. 安装任意 Userscript 管理器（推荐其一即可）
   - Tampermonkey（Chrome/Edge）
   - Violentmonkey（Firefox/Chrome）
2. 新建脚本（Create new script），将 `uai_exporter_v132.user.js` 全部内容粘贴进去并保存
3. 打开任意一条对话页面（ChatGPT / Gemini / Grok），右下角应出现 **Export** 按钮

---

## 使用方法（Quick Start）

1. 打开任意一条对话页面
2. 点击右下角 **Export** 打开设置面板
3. 根据需要配置选项后：
   - 点击 **导出下载**：生成 `.md` 或 `.json` 文件并下载
   - 点击 **复制 Markdown**：直接复制 Markdown 到剪贴板

---

## 重要设置说明

> 所有设置会保存在浏览器 `localStorage` 中（同一浏览器/同一配置文件下持久生效）。

### 历史加载
- `自动尽量加载完整历史`：导出前尝试上滑加载更多内容
- `允许尝试点击“加载更多”`：辅助触发更多历史加载

### 导出内容
- `仅导出视觉可见内容`：只按 display/visibility/hidden 过滤，避免误伤 aria-hidden
- `标题风格`
  - 按角色（User/Assistant）
  - 按 Q/A
- `导出格式`：Markdown / JSON

### Reasoning / 思路
- `包含已展开的“显示思路/已思考”`
- `导出时自动展开“显示思路/已思考”`

### 数学公式
- `多行/环境公式输出为块公式 $$...$$`
- `多行公式兼容化（array→aligned）`

### 图片（可选）
- `图片内嵌到 MD（data URI）`：把图片转成 data URI 写进 Markdown（更适合离线）
- `data URI 渲染`
  - `HTML <img>`（Typora 更友好）
  - `Markdown ![]()`
- `允许 fetch 图片`：当 canvas 转换失败时，允许对图片 URL 发起请求以提高内嵌成功率（会产生网络请求）

### 附件/兜底策略
- `附件/图片兜底扫描`：跨平台补齐“上传图片/内容图”
- `修复并移动 UI 的 Images 区块`：尤其对 Gemini 的图片画廊更有用

---

## 隐私与安全

- **默认不上传任何对话内容**
- **默认不主动发起网络请求**
- 只有在你开启 **“允许 fetch 图片”**（并且启用了“图片内嵌”）时，脚本才可能对图片 URL 发起下载请求，用于转换为 data URI（仍然只在本地处理，不会把对话上传到任何服务器）。

---

## 输出格式说明

### Markdown（.md）
- 可选包含 YAML Front Matter（title / platform / source_url / exported_at / message_count）
- 按消息顺序输出，并按角色（或 Q/A）分段
- 可选生成 Table of Contents

### JSON（.json）
包含：
- `title` / `platform` / `source_url` / `exported_at` / `message_count`
- `messages[]`：每条消息含 `role`、纯文本 `text`、以及 `markdown`

---

## 已知限制

- 平台页面结构更新可能导致选择器失效（建议提 issue 并附上截图/DOM 片段）
- 图片内嵌受 CORS/跨域限制影响：即使开启 fetch，也可能因权限/鉴权策略而失败
- “自动加载完整历史”依赖页面是否支持继续加载更早内容，少数情况下只能导出当前已加载部分

---

## 开发声明

- 本脚本由本人使用ChatGPT 5.2模型生成，本人本计划自己使用，想到大家可能也有需求，故分享出来，后期可能不会维护。
- 经测试在Gemini和ChatGPT 可以正常导出md格式，json本人未做尝试。
- 欢迎各位大佬进行修改，完善开发！
