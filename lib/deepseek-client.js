/**
 * deepseek-client.js
 *
 * 调 DeepSeek chat completions 生成"一段话讲透文章"的总结。
 *
 * 第一期已经接入；用户在 manager 配置 API key 即可启用。
 * AI 失败不阻断主流程：调用方拿 null 或 throw 都可以处理为"标注失败、继续保存"。
 */
(function () {
  const API_BASE = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-v4-flash';

  const SYSTEM_PROMPT =
    '你是一个高密度阅读总结助手。任务：用一段话（200-400 字）讲透这篇文章在说什么。' +
    '具体讲清三件事：核心论点是什么、用了什么论据、对读者意味着什么。' +
    '输出要求：中文、单段、不要分点、不要小标题、不要"这篇文章"开头的废话、不要 emoji。' +
    '直接进入内容。';

  function buildUserPrompt({ title, url, source, bodyText }) {
    const head = [
      title ? `标题：${title}` : '',
      source ? `来源：${source}` : '',
      url ? `链接：${url}` : ''
    ].filter(Boolean).join('\n');

    // 截断防超长：DeepSeek context 充裕但费 token
    const MAX_BODY = 12000;
    let body = bodyText || '';
    if (body.length > MAX_BODY) {
      body = body.slice(0, MAX_BODY) + '\n\n[正文过长已截断]';
    }
    return `${head}\n\n正文：\n${body}`;
  }

  /**
   * @param {Object} opts
   *   - apiKey: string (必填)
   *   - model: string (默认 deepseek-chat)
   *   - title, url, source, bodyText
   *   - systemPrompt: string?  (覆盖默认 system)
   *   - signal: AbortSignal?
   * @returns {Promise<{summary, model, usage}>}
   */
  async function summarize(opts) {
    const {
      apiKey, model, title, url, source, bodyText,
      systemPrompt, signal
    } = opts;

    if (!apiKey) throw new Error('DeepSeek API Key 未配置');
    if (!bodyText || !bodyText.trim()) throw new Error('正文为空，无内容可总结');

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ title, url, source, bodyText }) }
        ],
        temperature: 0.3,
        max_tokens: 800,
        stream: false
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401) hint = '（API Key 无效）';
      else if (res.status === 402) hint = '（账户余额不足）';
      else if (res.status === 429) hint = '（限流，请稍后重试）';
      throw new Error(`DeepSeek 请求失败 ${res.status}${hint}: ${txt.slice(0, 200)}`);
    }

    const json = await res.json();
    const summary = json?.choices?.[0]?.message?.content?.trim() || '';
    if (!summary) throw new Error('DeepSeek 返回空内容');

    return {
      summary,
      model: json?.model || model || DEFAULT_MODEL,
      usage: json?.usage || null
    };
  }

  self.DeepSeekClient = { summarize, DEFAULT_MODEL };
})();
