/**
 * markdown-builder.js
 *
 * 把"原文 nodes + AI 总结 + 元数据"拼成体系内规范的 md：
 *
 *   ---
 *   title: "..."
 *   source: 微信公众号 | 知乎 | 网页 | bilibili | pdf
 *   author: ...
 *   url: ...
 *   captured_at: 2026-04-28T16:04:00+08:00
 *   tags: [...]
 *   ai_model: deepseek-chat
 *   word_count: 3200
 *   ---
 *
 *   ## AI 速览
 *
 *   {ai_summary}
 *
 *   ---
 *
 *   ## 原文
 *
 *   {body_md}
 *
 * 复用现有的 nodesToMarkdown（在 background.js 中），不重写解析逻辑。
 */
(function () {
  // YAML 安全字符串：总是返回双引号包裹的字符串，并转义内部的双引号和反斜杠
  function yamlString(s) {
    if (s === null || s === undefined) return '""';
    const str = String(s);
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }

  function yamlList(arr) {
    if (!arr || arr.length === 0) return '[]';
    return '[' + arr.map(yamlString).join(', ') + ']';
  }

  function isoLocalNow() {
    // ISO 8601 with local timezone offset, e.g. 2026-04-28T16:04:00+08:00
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
    const om = pad(Math.abs(offsetMin) % 60);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
  }

  function detectSource(url) {
    if (!url) return '网页';
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (/mp\.weixin\.qq\.com/.test(host)) return '微信公众号';
      if (/zhihu\.com/.test(host)) return '知乎';
      if (/bilibili\.com|b23\.tv/.test(host)) return 'bilibili';
      if (/jianshu\.com/.test(host)) return '简书';
      if (/juejin\.cn/.test(host)) return '掘金';
      if (/sspai\.com/.test(host)) return '少数派';
      if (/medium\.com/.test(host)) return 'Medium';
      if (/substack\.com/.test(host)) return 'Substack';
      if (/github\.com/.test(host)) return 'GitHub';
      if (/twitter\.com|x\.com/.test(host)) return 'Twitter/X';
      return host;
    } catch {
      return '网页';
    }
  }

  /**
   * 拼装文章型 md
   * @param {Object} opts
   *   - title: string
   *   - url: string (原文 URL)
   *   - author: string?
   *   - bodyMarkdown: string  (原文正文 md)
   *   - aiSummary: string?    (DeepSeek 一段话总结，没有则放 N/A 标注)
   *   - aiModel: string?      (e.g. 'deepseek-chat')
   *   - aiError: string?      (AI 失败时的错误信息)
   *   - tags: string[]?
   *   - source: string?       (覆盖自动识别)
   *   - sourceType: 'article'|'bilibili'|'pdf'  (用于日志标记，可选)
   *   - ossUrl: string?       (静态 HTML 备份链接)
   *   - extra: Object?        (额外要写到 frontmatter 的字段)
   */
  function buildArticleMarkdown(opts) {
    const {
      title, url, author, bodyMarkdown,
      aiSummary, aiModel, aiError,
      tags, source, ossUrl, extra
    } = opts;

    const fm = {
      title: title || '(无标题)',
      source: source || detectSource(url),
      author: author || '',
      url: url || '',
      captured_at: isoLocalNow(),
      tags: tags && tags.length ? tags : []
    };
    if (aiModel) fm.ai_model = aiModel;
    if (ossUrl) fm.oss_html = ossUrl;
    if (extra && typeof extra === 'object') Object.assign(fm, extra);

    const lines = ['---'];
    for (const [k, v] of Object.entries(fm)) {
      if (Array.isArray(v)) {
        lines.push(`${k}: ${yamlList(v)}`);
      } else if (v === '' || v === null || v === undefined) {
        lines.push(`${k}: ""`);
      } else {
        lines.push(`${k}: ${yamlString(v)}`);
      }
    }
    lines.push('---', '');

    lines.push('## AI 速览', '');
    if (aiSummary && aiSummary.trim()) {
      lines.push(aiSummary.trim());
    } else if (aiError) {
      lines.push(`> AI 总结生成失败：${aiError}`);
    } else {
      lines.push('> （未生成 AI 总结）');
    }
    lines.push('', '---', '');

    lines.push('## 原文', '');
    lines.push((bodyMarkdown || '').trim() || '_（无正文）_');
    lines.push('');

    return lines.join('\n');
  }

  self.MarkdownBuilder = {
    build: buildArticleMarkdown,
    detectSource,
    isoLocalNow
  };
})();
