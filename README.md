# Read Clip

> Updated: 2026-05-03. 阅读剪藏 Chrome 扩展工程入口。

## 读前判断

应该读本文件：
- 需要安装、调试或维护 Read Clip 浏览器扩展。
- 需要理解网页 / B 站 / PDF 剪藏到 `My_life/reading/` 的链路。
- 需要排查 GitHub、DeepSeek、OSS、PDF 或 B 站字幕相关问题。

不归本文件管：
- 阅读笔记整理、书籍复盘和阅读建议 → `My_life/reading/INDEX.md`。
- 长文写作或公众号产出 → 对应写作 skill。
- 生活知识库长期结构 → `My_life/knowledge/INDEX.md`。

## 项目概览

Read Clip 是一个 Chrome Manifest V3 扩展，用来把网页、B 站视频字幕和 PDF 资料剪藏到个人阅读库。

核心链路：
1. content script 从当前网页、B 站页面或 PDF 页面提取正文。
2. background service worker 统一编排处理流程。
3. 可选把图片、PDF 原件或 HTML 备份上传到 OSS。
4. 调用 DeepSeek 生成一段摘要；失败时主流程继续。
5. 生成 Markdown，提交到 GitHub 的 `My_life/reading/articles` 或 `My_life/reading/media`。
6. popup / manager 展示处理进度、本地历史和设置入口。

## 技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| 扩展平台 | Chrome Manifest V3 | `manifest.json` |
| 后台编排 | Service worker | `background.js` |
| 页面提取 | content script + Readability | `content.js`、`lib/Readability.js` |
| 视频提取 | Bilibili extractor | `lib/bilibili-extractor.js` |
| PDF | pdf.js | `lib/pdf.min.js`、`lib/pdf.worker.min.js` |
| AI 摘要 | DeepSeek API | `lib/deepseek-client.js` |
| 仓库写入 | GitHub Contents API | `lib/github-client.js` |
| 媒体备份 | Aliyun OSS | `lib/aliyun-oss.js` |
| 设置加密 | Web Crypto | `lib/secure-settings.js`、`lib/secure-crypto.js` |

## 目录结构

| 路径 | 职责 |
|---|---|
| `manifest.json` | 扩展声明、权限、service worker、popup |
| `background.js` | 网页 / B 站 / PDF 三条剪藏流程的主编排 |
| `content.js` | 页面内容检测、提取、toast 和消息发送 |
| `popup.*` | 扩展弹窗、进度展示、最近历史 |
| `manager.*` | 设置、连接测试、知识库历史管理 |
| `lib/markdown-builder.js` | Markdown 与 frontmatter 生成 |
| `lib/github-client.js` | GitHub 读写 |
| `lib/deepseek-client.js` | AI 摘要 |
| `lib/aliyun-oss.js` | OSS 上传 |
| `icons/` | 扩展图标 |
| `config.json` | 本机私密配置文件，插件会直接读取；已由 `.gitignore` 忽略，不应提交 |
| `config.example.json` | 可提交的配置模板，字段必须与 `config.json` 保持一致，但不放真实密钥 |

## 安装调试

```text
打开 chrome://extensions
开启 Developer mode
Load unpacked
选择 apps/Read_clip 目录
```

调试入口：
- popup 流程：点击浏览器扩展图标。
- manager 页面：从 popup 进入，或打开扩展内的 `manager.html`。
- background 日志：Chrome 扩展详情页 → service worker inspect。

## 数据契约

默认写入位置：
- 文章：`My_life/reading/articles`
- 视频 / 媒体：`My_life/reading/media`
- PDF：当前也进入 `My_life/reading/articles`

输出形态：
- Markdown 文件，带 frontmatter。
- 可包含原始链接、GitHub 链接、OSS HTML / PDF 备份链接、AI 摘要和正文摘录。

权威边界：
- Read Clip 负责采集和入库，不负责阅读复盘。
- 入库后的长期整理、摘要加工和复盘归 `My_life/reading/`。

## 配置文件

插件运行时会尝试读取项目根目录的 `config.json`，这条读取链路在 `lib/secure-settings.js` 中。这个文件是本机私密配置，保留在本地即可。

新环境配置方式：
1. 复制 `config.example.json` 为 `config.json`。
2. 填入真实的 GitHub token、DeepSeek key、OSS AK/SK 等凭据。
3. 在 Chrome 扩展页重新加载 Read Clip。

字段维护规则：
- `config.example.json` 的字段必须和 `config.json` 保持同构，避免未来 AI 或人类维护时漏字段。
- 新增配置字段时，同时更新 `lib/secure-settings.js` 的 `DEFAULTS` / `normalizeSettings`、`config.example.json` 和本 README。

## 安全边界

- `config.json` 承载 GitHub、DeepSeek、OSS 等本地密钥，不应复制到公开文档、issue、PR 描述或聊天中。
- `.gitignore` 已忽略 `config.json`；仓库只提交 `config.example.json`。
- 任何提交前都要检查是否包含 token、API key、AK/SK 等凭据。

## 维护规则

- 新增剪藏类型时，先在 `background.js` 建独立工作流，再在 `popup.js` 和 `manager.js` 补展示入口。
- 调整 Markdown 字段时，同步检查 `My_life/reading/INDEX.md` 和下游阅读处理流程。
- DeepSeek 或 OSS 失败不应阻断主流程；GitHub 写入失败才算剪藏失败。
- 若长期文档超过 3 篇，再建立 `docs/INDEX.md`；当前不预建空 docs 目录。
