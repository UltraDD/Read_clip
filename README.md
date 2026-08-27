# Read Clip

一个 Chrome Manifest V3 阅读剪藏扩展：把网页文章、B 站视频（含字幕）和 PDF 一键剪藏成 Markdown，推送到你自己的 GitHub 仓库，可选生成 AI 摘要、备份原件到阿里云 OSS。

所有数据和凭据都在你自己手里：不经过任何第三方服务器，GitHub 仓库、DeepSeek 账号、OSS Bucket 均由你自行创建和授权。

## 功能特性

- **网页剪藏**：基于 Readability 提取正文，自动处理图片。
- **B 站视频剪藏**：抓取视频标题、简介和字幕，正文按时间轴整理为 Markdown。
- **PDF 剪藏**：基于 pdf.js 解析 PDF 页面文本。
- **AI 摘要**：调用 DeepSeek API 为每篇剪藏生成一段话速览；不填 key 自动跳过，不阻断主流程。
- **媒体备份**：图片、PDF 原件或整页 HTML 快照可上传到阿里云 OSS，Markdown 中保留原始链接与备份链接。
- **本地历史**：popup 展示最近剪藏；管理后台支持从 GitHub 拉取历史记录做同步和对账。
- **凭据加密**：第三方密钥用主密码经 Web Crypto 加密后存储，不落明文。

## 工作原理

```
网页 / B 站 / PDF 页面
        │ content script 提取正文
        ▼
background service worker 编排
        │                        │
        ▼                        ▼
  OSS 备份(可选)           DeepSeek 摘要(可选)
        └───────────┬────────────┘
                    ▼
     生成带 frontmatter 的 Markdown
                    ▼
      GitHub Contents API 提交到你的仓库
```

任一可选环节失败都不会中断剪藏；只有 GitHub 写入失败才视为剪藏失败。

## 安装

本项目未发布到 Chrome Web Store，以开发者模式加载：

```text
1. 克隆本仓库
2. 打开 chrome://extensions
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目根目录
5. 点击扩展图标开始第一次剪藏前，先完成下方配置
```

## 配置

扩展需要一组第三方凭据才能工作。有两种配置方式：

- **方式 A（推荐日常使用）**：从 popup 进入管理后台，设置主密码后在界面中填写。凭据加密存储，跨设备随 Chrome 同步。
- **方式 B**：复制 `config.example.json` 为 `config.json`，填入真实值后重新加载扩展。`config.json` 已被 `.gitignore` 忽略，不会进入 Git。

两者字段一致：

| 字段 | 说明 | 必填 |
|---|---|---|
| `github_owner` / `github_repo` / `github_branch` | 你的 GitHub 用户名 / 目标仓库名 / 分支 | ✅ |
| `github_token` | GitHub PAT，见下文获取方式 | ✅ |
| `github_path_article` / `github_path_media` / `github_path_pdf` | 仓库内保存路径，默认 `reading/articles`、`reading/media` | 否 |
| `deepseek_api_key` / `deepseek_model` | DeepSeek API 密钥与模型名 | 否 |
| `oss_region` / `oss_bucket` / `oss_ak` / `oss_sk` | 阿里云 OSS 备份配置 | 否 |

### 获取 GitHub Token

1. 打开 GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens)。
2. 新建 token，Repository access 只勾选你的目标仓库。
3. Permissions 中给 Contents 设置 **Read and write**，其余保持默认。
4. 生成后立即复制（形如 `github_pat_...`）。

### 其他可选项

- **DeepSeek**：在 [platform.deepseek.com](https://platform.deepseek.com/) 创建 API Key。不填写时跳过 AI 摘要，Markdown 会标注"未生成"。
- **阿里云 OSS**：创建 Bucket 后在 RAM 中为子账号授予该 Bucket 的读写权限。不填写时不做备份，正文图片保留原始外链。

## 输出格式

每次剪藏在目标仓库生成一个 Markdown 文件，包含 frontmatter（标题、来源、URL、剪藏时间等）、AI 摘要和正文内容；如有 OSS 备份会附上备份链接。

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` + `scripting` | 在当前标签页注入脚本提取正文 |
| `<all_urls>` | 允许在任意页面剪藏（提取正文需要读取当前页面 DOM）；扩展不做任何页面内容上报 |
| `storage` + `unlimitedStorage` | 存储加密后的配置和本地剪藏历史 |

网络请求仅发往：GitHub API、DeepSeek API、阿里云 OSS、B 站公开接口（用于字幕获取）。可在源码 `lib/` 目录中逐行核对。

## 安全边界

- `config.json` 与加密存储之外的任何位置都不应出现真实凭据；提交前请检查。
- 主密码加密基于浏览器内置 Web Crypto 实现（见 `lib/secure-crypto.js`、`lib/secure-settings.js`），配置密文存于 `chrome.storage.sync`。请使用足够强的主密码。
- 上传到 OSS 的对象默认可能为公开可读链接，如对隐私敏感请将 Bucket 设为私有并自行调整签名访问逻辑。

## 开发

目录结构与技术栈详见源码；核心模块：

| 路径 | 职责 |
|---|---|
| `background.js` | 网页 / B 站 / PDF 三条剪藏流程的主编排 |
| `content.js` | 页面检测、正文提取、toast 与消息 |
| `manager.*` / `popup.*` | 设置界面与进度展示 |
| `lib/markdown-builder.js` | Markdown 与 frontmatter 生成 |
| `lib/github-client.js` / `deepseek-client.js` / `aliyun-oss.js` | 对接 GitHub / DeepSeek / OSS |
| `tests/` | Node 内置测试框架的单元测试 |

运行测试：

```bash
node --test
```

修改配置字段时，同步更新 `lib/secure-settings.js` 的 `DEFAULTS` / `normalizeSettings` 和 `config.example.json`。

## License

[MIT](LICENSE)
