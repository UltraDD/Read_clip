// Read Clip · Background Service Worker
//
// 工作流：
//   网页/B站/PDF → 提取内容 → 图片转存 OSS（可选）→ DeepSeek 一段话总结（可选）
//                → 拼装 md（frontmatter + AI 速览 + 原文）→ GitHub Contents API push
//                → 历史记录
//
// 失败容错：
//   OSS 未配置 → 跳过图片转存和 HTML 备份，正文图片用原始外链
//   DeepSeek 未配置/失败 → md 标注"未生成 AI 总结"，主流程继续
//   GitHub 失败 → 抛出（这是主轴，必须成功）

importScripts(
  'lib/secure-crypto.js',
  'lib/secure-settings.js',
  'lib/aliyun-oss.js',
  'lib/pdf.min.js',
  'lib/pdf.worker.min.js',
  'lib/slug-util.js',
  'lib/markdown-builder.js',
  'lib/github-client.js',
  'lib/deepseek-client.js'
);

// ============ 1. Extension 入口 ============

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  const isBilibili = tab.url && /bilibili\.com\/video\/(BV[\w]+|av\d+)/i.test(tab.url);
  const scripts = isBilibili
    ? ['lib/bilibili-extractor.js', 'content.js']
    : ['lib/Readability.js', 'content.js'];
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: scripts
  }).catch((err) => console.error('Injection failed:', err));
});

// ============ 2. Message 路由 ============

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'publish_article') {
    updateProcessingState({ step: 'extract', progress: 5 });
    broadcastProgress('extract', { progress: 5 });
    handleSaveWorkflow(request.payload)
      .then((result) => {
        updateProcessingState(null);
        broadcastProgress('complete', result);
        sendResponse({ success: true, ...result });
      })
      .catch((err) => {
        console.error('Workflow Failed:', err);
        updateProcessingState(null);
        broadcastProgress('error', { message: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === 'publish_bilibili') {
    updateProcessingState({ step: 'bilibili_extract', progress: 5 });
    broadcastProgress('bilibili_extract', { progress: 5 });
    handleBilibiliWorkflow(request.payload)
      .then((result) => {
        updateProcessingState(null);
        broadcastProgress('complete', result);
        sendResponse({ success: true, ...result });
      })
      .catch((err) => {
        console.error('Bilibili Workflow Failed:', err);
        updateProcessingState(null);
        broadcastProgress('error', { message: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === 'publish_pdf') {
    updateProcessingState({ step: 'extract', progress: 5 });
    broadcastProgress('extract', { message: 'PDF 文件' });
    handlePdfWorkflow(request.payload)
      .then((result) => {
        updateProcessingState(null);
        broadcastProgress('complete', result);
        sendResponse({ success: true, ...result });
      })
      .catch((err) => {
        console.error('PDF Workflow Failed:', err);
        updateProcessingState(null);
        broadcastProgress('error', { message: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === 'open_manager') {
    chrome.tabs.create({ url: 'manager.html' });
  }
});

// ============ 3. 工具：消息广播 / 状态 / 历史 ============

function broadcastProgress(step, data) {
  chrome.runtime.sendMessage({
    action: 'progress_update',
    step,
    data
  }).catch(() => { /* popup may be closed */ });
}

function updateProcessingState(stateObj) {
  if (stateObj) stateObj._updatedAt = Date.now();
  chrome.storage.local.set({ processingState: stateObj });
}

async function addToHistory(entry) {
  const data = await chrome.storage.local.get('history');
  const history = data.history || [];
  history.push(entry);
  if (history.length > 200) history.shift();
  await chrome.storage.local.set({ history });
}

// ============ 4. 工作流：网页文章 ============

async function handleSaveWorkflow(payload) {
  const settings = await SecureSettings.requireSession();
  const uploader = buildOssUploader(settings);

  // 4.1 图片转存
  if (uploader) {
    broadcastProgress('image', { progress: 10, message: '正在处理图片...' });
    updateProcessingState({ step: 'image', progress: 10 });
    await processImages(payload.content, uploader);
  } else {
    console.warn('[Read_clip] OSS 未配置，跳过图片转存');
  }

  // 4.2 静态 HTML 备份（OSS 配了才有；当作 frontmatter 的 oss_html 字段）
  let ossUrl = '';
  if (uploader) {
    try {
      broadcastProgress('html', { progress: 60, message: '正在上传 HTML 备份...' });
      updateProcessingState({ step: 'html', progress: 60 });
      const htmlContent = generateStaticHtml(payload);
      const htmlBlob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
      const dateStr = SlugUtil.todayStamp().replace(/-/g, '');
      const filename = `articles/${dateStr}/${legacyFilename(payload.title)}.html`;
      ossUrl = await uploader.upload(htmlBlob, filename, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'text/html; charset=utf-8'
      });
    } catch (e) {
      console.warn('[Read_clip] OSS HTML 上传失败，忽略：', e.message);
    }
  }

  // 4.3 提纯文本喂 DeepSeek
  const bodyMarkdown = nodesToMarkdown(payload.content);
  const bodyPlainText = nodesToPlainText(payload.content);

  // 4.4 AI 总结
  broadcastProgress('ai', { progress: 75, message: '正在生成 AI 总结...' });
  updateProcessingState({ step: 'ai', progress: 75 });

  const aiResult = await tryAiSummarize({
    apiKey: settings.deepseek_api_key,
    model: settings.deepseek_model,
    title: payload.title,
    url: payload.original_url,
    bodyText: bodyPlainText
  });

  // 4.5 拼装 md
  const md = MarkdownBuilder.build({
    title: payload.title,
    url: payload.original_url,
    author: payload.author_name || '',
    bodyMarkdown,
    aiSummary: aiResult.summary,
    aiModel: aiResult.model,
    aiError: aiResult.error,
    tags: [],
    ossUrl
  });

  // 4.6 推 GitHub
  broadcastProgress('github', { progress: 92, message: '正在推送到 GitHub...' });
  updateProcessingState({ step: 'github', progress: 92 });

  const filename = SlugUtil.buildFilename(payload.title, 'md');
  const repoPath = joinPath(settings.github_path_article || 'reading/articles', filename);
  const ghResult = await GitHubClient.commitFile({
    owner: settings.github_owner,
    repo: settings.github_repo,
    branch: settings.github_branch || 'main',
    token: settings.github_token,
    path: repoPath,
    content: md,
    message: `reading: clip "${payload.title || 'untitled'}"`
  });

  // 4.7 历史
  await addToHistory({
    title: payload.title,
    originalUrl: payload.original_url,
    ossUrl,
    githubUrl: ghResult.htmlUrl,
    githubPath: repoPath,
    timestamp: Date.now(),
    type: 'article',
    aiSummary: aiResult.summary || null,
    aiError: aiResult.error || null
  });

  await chrome.storage.local.set({
    lastSuccess: {
      timestamp: Date.now(),
      title: payload.title,
      githubUrl: ghResult.htmlUrl,
      ossUrl,
      type: 'article'
    }
  });

  return {
    title: payload.title,
    githubUrl: ghResult.htmlUrl,
    ossUrl,
    repoPath,
    aiSummary: aiResult.summary,
    aiError: aiResult.error,
    type: 'article'
  };
}

// ============ 5. 工作流：B站视频字幕 ============

async function handleBilibiliWorkflow(payload) {
  const { url, videoInfo, subtitleText, subtitleType, subtitleLang, hasSubtitle } = payload;
  if (!hasSubtitle || !subtitleText) throw new Error('未收到字幕数据');

  const settings = await SecureSettings.requireSession();
  const uploader = buildOssUploader(settings);

  broadcastProgress('bilibili_extract', { progress: 30, message: `已获取 ${subtitleLang} 字幕` });
  updateProcessingState({ step: 'bilibili_extract', progress: 30 });

  // 5.1 封面图（OSS 可选）
  let coverOssUrl = videoInfo.pic;
  if (uploader && videoInfo.pic) {
    broadcastProgress('image', { progress: 45, message: '正在上传封面...' });
    updateProcessingState({ step: 'image', progress: 45 });
    try {
      let coverUrl = videoInfo.pic;
      if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;
      const coverResponse = await fetch(coverUrl, {
        headers: {
          'Referer': 'https://www.bilibili.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (coverResponse.ok) {
        const coverBlob = await coverResponse.blob();
        const ext = guessImageExt(coverBlob.type);
        const hash = await sha256Hex(videoInfo.bvid + '_cover');
        coverOssUrl = await uploader.upload(coverBlob, `bilibili/${hash}.${ext}`, {
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
      }
    } catch (e) {
      console.warn('[Read_clip] B站封面上传失败：', e.message);
    }
  }

  // 5.2 静态 HTML 备份
  let ossUrl = '';
  if (uploader) {
    try {
      broadcastProgress('html', { progress: 60, message: '正在上传 HTML 备份...' });
      updateProcessingState({ step: 'html', progress: 60 });
      const htmlContent = generateBilibiliHtml(videoInfo, subtitleText, subtitleType, subtitleLang, coverOssUrl, url);
      const htmlBlob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
      const dateStr = SlugUtil.todayStamp().replace(/-/g, '');
      ossUrl = await uploader.upload(htmlBlob, `bilibili/${dateStr}/${legacyFilename(videoInfo.title)}.html`, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'text/html; charset=utf-8'
      });
    } catch (e) {
      console.warn('[Read_clip] B站 HTML 备份失败：', e.message);
    }
  }

  // 5.3 拼正文 markdown（封面 + 元数据 + 字幕全文）
  const bodyMarkdown = bilibiliBodyMarkdown(videoInfo, subtitleText, subtitleType, subtitleLang, coverOssUrl);
  const bodyPlainText = `视频标题：${videoInfo.title}\nUP 主：${videoInfo.owner?.name}\n时长：${formatVideoDuration(videoInfo.duration)}\n\n字幕原文：\n${subtitleText}`;

  // 5.4 AI 总结
  broadcastProgress('ai', { progress: 75, message: '正在生成 AI 总结...' });
  updateProcessingState({ step: 'ai', progress: 75 });

  const aiResult = await tryAiSummarize({
    apiKey: settings.deepseek_api_key,
    model: settings.deepseek_model,
    title: videoInfo.title,
    url,
    source: 'bilibili',
    bodyText: bodyPlainText
  });

  // 5.5 md 拼装
  const md = MarkdownBuilder.build({
    title: videoInfo.title,
    url,
    author: videoInfo.owner?.name || '',
    bodyMarkdown,
    aiSummary: aiResult.summary,
    aiModel: aiResult.model,
    aiError: aiResult.error,
    source: 'bilibili',
    tags: [],
    ossUrl,
    extra: {
      bvid: videoInfo.bvid || '',
      duration: formatVideoDuration(videoInfo.duration),
      subtitle_type: subtitleType,
      subtitle_lang: subtitleLang
    }
  });

  // 5.6 推 GitHub
  broadcastProgress('github', { progress: 92, message: '正在推送到 GitHub...' });
  updateProcessingState({ step: 'github', progress: 92 });

  const filename = SlugUtil.buildFilename(videoInfo.title, 'md');
  const repoPath = joinPath(settings.github_path_media || 'reading/media', filename);
  const ghResult = await GitHubClient.commitFile({
    owner: settings.github_owner,
    repo: settings.github_repo,
    branch: settings.github_branch || 'main',
    token: settings.github_token,
    path: repoPath,
    content: md,
    message: `reading: clip bilibili "${videoInfo.title}"`
  });

  await addToHistory({
    title: `[视频] ${videoInfo.title}`,
    originalUrl: url,
    ossUrl,
    githubUrl: ghResult.htmlUrl,
    githubPath: repoPath,
    timestamp: Date.now(),
    type: 'bilibili',
    subtitleType,
    aiSummary: aiResult.summary || null,
    aiError: aiResult.error || null
  });

  await chrome.storage.local.set({
    lastSuccess: {
      timestamp: Date.now(),
      title: videoInfo.title,
      githubUrl: ghResult.htmlUrl,
      ossUrl,
      type: 'bilibili'
    }
  });

  return {
    title: videoInfo.title,
    githubUrl: ghResult.htmlUrl,
    ossUrl,
    repoPath,
    aiSummary: aiResult.summary,
    aiError: aiResult.error,
    type: 'bilibili'
  };
}

function bilibiliBodyMarkdown(videoInfo, subtitleText, subtitleType, subtitleLang, coverUrl) {
  const lines = [];
  if (coverUrl) lines.push(`![封面](${coverUrl})`, '');
  const ownerName = videoInfo.owner?.name || '未知';
  const duration = formatVideoDuration(videoInfo.duration);
  const pubDate = videoInfo.pubdate ? new Date(videoInfo.pubdate * 1000).toLocaleDateString('zh-CN') : '';
  lines.push(`**UP 主**：${ownerName} ｜ **时长**：${duration}${pubDate ? ` ｜ **发布**：${pubDate}` : ''}`);
  const subtitleTypeLabel = subtitleType === 'ai_assistant' ? 'AI 小助手字幕'
    : subtitleType === 'ai_generated' ? 'AI 生成字幕' : '手动上传字幕';
  lines.push(`**字幕**：${subtitleTypeLabel}（${subtitleLang}）`, '', '---', '');
  for (const line of subtitleText.split('\n').map(s => s.trim()).filter(Boolean)) {
    lines.push(line);
  }
  return lines.join('\n');
}

// ============ 6. 工作流：PDF ============

async function handlePdfWorkflow(payload) {
  const { title, pdfBase64, pdfSize, original_url } = payload;
  const settings = await SecureSettings.requireSession();
  const uploader = buildOssUploader(settings);

  if (!uploader) throw new Error('PDF 工作流必须先配置 OSS（用于存放 PDF 原件）');

  // 6.1 base64 → Uint8Array
  const binaryString = atob(pdfBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  const pdfBlob = new Blob([bytes], { type: 'application/pdf' });

  // 6.2 提取文本
  broadcastProgress('extract', { progress: 15, message: '正在提取 PDF 文本...' });
  updateProcessingState({ step: 'extract', progress: 15 });
  let pdfText = '';
  let pageCount = 0;
  try {
    const extracted = await extractPdfText(bytes);
    pdfText = extracted.text;
    pageCount = extracted.pageCount;
  } catch (e) {
    console.warn('[Read_clip] PDF 文本提取失败：', e.message);
  }

  // 6.3 上传 PDF 原件
  broadcastProgress('oss', { progress: 40, message: `正在上传 PDF（${(pdfSize / 1024 / 1024).toFixed(1)}MB）...` });
  updateProcessingState({ step: 'oss', progress: 40 });
  const dateStr = SlugUtil.todayStamp().replace(/-/g, '');
  const safeTitle = legacyFilename(title);
  const pdfOssUrl = await uploader.upload(pdfBlob, `pdf/${dateStr}/${safeTitle}.pdf`, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': 'application/pdf'
  });

  // 6.4 上传可读 HTML
  let htmlOssUrl = '';
  if (pdfText.length > 0) {
    try {
      const htmlContent = generatePdfHtml(title, pdfText, pageCount, pdfSize, original_url, pdfOssUrl);
      const htmlBlob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
      htmlOssUrl = await uploader.upload(htmlBlob, `pdf/${dateStr}/${safeTitle}.html`, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'text/html; charset=utf-8'
      });
    } catch (e) {
      console.warn('[Read_clip] PDF HTML 备份失败：', e.message);
    }
  }

  // 6.5 AI 总结
  broadcastProgress('ai', { progress: 70, message: '正在生成 AI 总结...' });
  updateProcessingState({ step: 'ai', progress: 70 });
  const aiResult = await tryAiSummarize({
    apiKey: settings.deepseek_api_key,
    model: settings.deepseek_model,
    title,
    url: original_url,
    source: 'pdf',
    bodyText: pdfText || `（PDF 文本提取失败，仅记录链接）`
  });

  // 6.6 拼 md
  const sizeStr = pdfSize > 1024 * 1024
    ? `${(pdfSize / 1024 / 1024).toFixed(1)} MB`
    : `${(pdfSize / 1024).toFixed(0)} KB`;
  const bodyLines = [
    `**PDF 文档** · ${pageCount} 页 · ${sizeStr}`,
    '',
    `[下载 PDF 原件](${pdfOssUrl})${htmlOssUrl ? ` ｜ [在线阅读 (HTML)](${htmlOssUrl})` : ''}`,
    '',
    '---',
    '',
    pdfText.trim() || '_（PDF 文本提取失败）_'
  ];
  const md = MarkdownBuilder.build({
    title,
    url: original_url,
    bodyMarkdown: bodyLines.join('\n'),
    aiSummary: aiResult.summary,
    aiModel: aiResult.model,
    aiError: aiResult.error,
    source: 'pdf',
    tags: [],
    ossUrl: htmlOssUrl,
    extra: { pdf_url: pdfOssUrl, page_count: pageCount, pdf_size: sizeStr }
  });

  // 6.7 推 GitHub
  broadcastProgress('github', { progress: 92, message: '正在推送到 GitHub...' });
  updateProcessingState({ step: 'github', progress: 92 });
  const filename = SlugUtil.buildFilename(title, 'md');
  const repoPath = joinPath(settings.github_path_pdf || 'reading/articles', filename);
  const ghResult = await GitHubClient.commitFile({
    owner: settings.github_owner,
    repo: settings.github_repo,
    branch: settings.github_branch || 'main',
    token: settings.github_token,
    path: repoPath,
    content: md,
    message: `reading: clip pdf "${title}"`
  });

  await addToHistory({
    title: `[PDF] ${title}`,
    originalUrl: original_url,
    ossUrl: htmlOssUrl,
    pdfOssUrl,
    githubUrl: ghResult.htmlUrl,
    githubPath: repoPath,
    timestamp: Date.now(),
    type: 'pdf',
    aiSummary: aiResult.summary || null,
    aiError: aiResult.error || null
  });

  await chrome.storage.local.set({
    lastSuccess: {
      timestamp: Date.now(),
      title,
      githubUrl: ghResult.htmlUrl,
      ossUrl: htmlOssUrl,
      pdfOssUrl,
      type: 'pdf'
    }
  });

  return {
    title,
    githubUrl: ghResult.htmlUrl,
    ossUrl: htmlOssUrl,
    pdfOssUrl,
    repoPath,
    aiSummary: aiResult.summary,
    aiError: aiResult.error,
    type: 'pdf'
  };
}

// ============ 7. AI 总结：失败不阻断 ============

async function tryAiSummarize({ apiKey, model, title, url, source, bodyText }) {
  if (!apiKey) {
    return { summary: '', model: '', error: 'DeepSeek API Key 未配置' };
  }
  try {
    const out = await DeepSeekClient.summarize({
      apiKey, model, title, url, source, bodyText
    });
    return { summary: out.summary, model: out.model, error: '' };
  } catch (e) {
    console.warn('[Read_clip] DeepSeek 失败：', e.message);
    return { summary: '', model: '', error: e.message };
  }
}

// ============ 8. OSS 工具 ============

function buildOssUploader(settings) {
  const has = settings.oss_region && settings.oss_bucket && settings.oss_ak && settings.oss_sk;
  if (!has) return null;
  return new AliyunOSSUploader({
    region: settings.oss_region,
    bucket: settings.oss_bucket,
    accessKeyId: settings.oss_ak,
    accessKeySecret: settings.oss_sk
  });
}

// 旧版 sanitize：用于 OSS 文件路径（OSS 路径不能含中文以外的奇怪字符）
function legacyFilename(name) {
  return String(name || 'untitled').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function joinPath(...parts) {
  return parts
    .map(s => String(s || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

// ============ 9. 图片转存 OSS ============

async function processImages(nodes, uploader) {
  const images = [];
  findImageNodes(nodes, images);
  const totalImages = images.length;
  console.log(`Found ${totalImages} images.`);

  let processedCount = 0;
  const reportProgress = () => {
    const percent = Math.floor(10 + (processedCount / (totalImages || 1)) * 50);
    broadcastProgress('image', { current: processedCount, total: totalImages, progress: percent });
    updateProcessingState({ step: 'image', current: processedCount, total: totalImages, progress: percent });
  };
  reportProgress();

  const srcToNodes = new Map();
  const uniqueSrcs = [];
  const seen = new Set();
  for (const imgNode of images) {
    const src = imgNode.attrs?.src;
    if (!src || src.startsWith('data:')) continue;
    if (!srcToNodes.has(src)) srcToNodes.set(src, []);
    srcToNodes.get(src).push(imgNode);
    if (!seen.has(src)) { seen.add(src); uniqueSrcs.push(src); }
  }

  const cacheKey = 'imageUploadCache';
  const cacheData = await chrome.storage.local.get(cacheKey);
  const cache = cacheData[cacheKey] || {};

  const MAX_BYTES = 12 * 1024 * 1024;
  const CONCURRENCY = 5;
  const TIMEOUT_MS = 25000;

  const tasks = uniqueSrcs.map((originalSrc) => async () => {
    if (cache[originalSrc]) {
      const newUrl = cache[originalSrc];
      for (const n of (srcToNodes.get(originalSrc) || [])) {
        n.attrs.src = newUrl;
        n.attrs['data-original-src'] = originalSrc;
      }
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    let response;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      response = await fetch(originalSrc, { signal: controller.signal });
      clearTimeout(t);
    } catch (e) {
      console.warn(`Image fetch failed: ${originalSrc}`, e.message);
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    if (!response || !response.ok) {
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    const len = Number(response.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) {
      console.warn(`Image too large, skip: ${originalSrc} (${len} bytes)`);
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    let blob;
    try { blob = await response.blob(); } catch {
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }
    if (!blob || (blob.size && blob.size > MAX_BYTES)) {
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    const ext = guessImageExt(blob.type);
    const hash = await sha256Hex(originalSrc);
    let newUrl;
    try {
      newUrl = await uploader.upload(blob, `images/${hash}.${ext}`, {
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
    } catch (e) {
      console.error(`Failed to upload image ${originalSrc}:`, e.message);
      processedCount += (srcToNodes.get(originalSrc)?.length || 1);
      reportProgress();
      return;
    }

    cache[originalSrc] = newUrl;
    for (const n of (srcToNodes.get(originalSrc) || [])) {
      n.attrs.src = newUrl;
      n.attrs['data-original-src'] = originalSrc;
    }
    processedCount += (srcToNodes.get(originalSrc)?.length || 1);
    reportProgress();
  });

  await runPool(tasks, CONCURRENCY);

  const MAX_CACHE = 1500;
  const entries = Object.entries(cache);
  const trimmed = entries.length > MAX_CACHE ? entries.slice(entries.length - MAX_CACHE) : entries;
  await chrome.storage.local.set({ [cacheKey]: Object.fromEntries(trimmed) });
}

function findImageNodes(nodes, list) {
  if (!nodes) return;
  if (Array.isArray(nodes)) { nodes.forEach(n => findImageNodes(n, list)); return; }
  if (nodes.tag === 'img') list.push(nodes);
  if (nodes.children) findImageNodes(nodes.children, list);
}

function guessImageExt(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return 'jpg';
  const t = mimeType.toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/gif') return 'gif';
  if (t === 'image/svg+xml') return 'svg';
  if (t === 'image/avif') return 'avif';
  const subtype = (t.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '');
  return subtype || 'jpg';
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function runPool(taskFns, concurrency) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < taskFns.length) {
      const idx = i++;
      try { await taskFns[idx](); } catch { /* swallow */ }
    }
  });
  await Promise.all(workers);
}

// ============ 10. PDF 文本提取（pdf.js）============

async function extractPdfText(pdfBytes) {
  const lib = globalThis.pdfjsLib || globalThis['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('pdf.js 未加载');
  const loadingTask = lib.getDocument({ data: pdfBytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map(item => item.str).join(''));
  }
  return { text: pages.join('\n\n'), pageCount: pdf.numPages };
}

// ============ 11. HTML 静态备份生成 ============

function generateStaticHtml(payload) {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { font-size: 2em; margin-bottom: 0.5em; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 2em; border-bottom: 1px solid #eee; padding-bottom: 10px; }
    blockquote { border-left: 4px solid #ddd; padding-left: 15px; color: #666; margin: 1.5em 0; }
    pre { background: #f5f5f5; padding: 15px; overflow-x: auto; border-radius: 4px; }
  `;
  const contentHtml = nodesToHtml(payload.content);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(payload.title)}</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(payload.title)}</h1>
    <div class="meta">
      <span>By ${escapeHtml(payload.author_name || '')}</span> |
      <a href="${escapeHtml(payload.original_url)}" target="_blank">原链接</a>
    </div>
  </header>
  <article>${contentHtml}</article>
</body>
</html>`;
}

function nodesToHtml(nodes) {
  if (!nodes) return '';
  if (typeof nodes === 'string') return escapeHtml(nodes);
  if (Array.isArray(nodes)) return nodes.map(nodesToHtml).join('');
  const tag = nodes.tag;
  const children = nodesToHtml(nodes.children);
  let attrs = '';
  if (nodes.attrs) {
    attrs = Object.entries(nodes.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  }
  if (['img', 'br', 'hr'].includes(tag)) return `<${tag}${attrs} />`;
  return `<${tag}${attrs}>${children}</${tag}>`;
}

function generateBilibiliHtml(videoInfo, subtitleText, subtitleType, subtitleLang, coverUrl, originalUrl) {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.8; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; background: #fafafa; }
    .video-header { background: linear-gradient(135deg, #00a1d6 0%, #6b4fbb 100%); color: white; padding: 30px; border-radius: 16px; margin-bottom: 30px; }
    .video-header h1 { font-size: 1.6em; margin: 0 0 15px; font-weight: 600; }
    .video-meta { display: flex; gap: 20px; font-size: 0.9em; opacity: 0.9; flex-wrap: wrap; }
    .cover-container { margin: 20px 0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .cover-container img { width: 100%; height: auto; display: block; }
    .subtitle-info { background: #f0f7ff; border-left: 4px solid #00a1d6; padding: 12px 16px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 0.9em; color: #666; }
    .subtitle-content { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); white-space: pre-wrap; font-size: 1em; line-height: 2; }
    .subtitle-content p { margin: 0.8em 0; text-indent: 2em; }
    a { color: #00a1d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  `;
  const subtitleTypeLabel = subtitleType === 'ai_assistant' ? 'AI 小助手字幕'
    : subtitleType === 'ai_generated' ? 'AI 生成字幕' : '手动上传字幕';
  const formattedSubtitle = subtitleText.split('\n').filter(l => l.trim())
    .map(l => `<p>${escapeHtml(l)}</p>`).join('\n');
  const pubDate = videoInfo.pubdate ? new Date(videoInfo.pubdate * 1000).toLocaleDateString('zh-CN') : '';
  const duration = formatVideoDuration(videoInfo.duration);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(videoInfo.title)} - B站视频字幕</title>
  <style>${css}</style>
</head>
<body>
  <article>
    <header class="video-header">
      <h1>${escapeHtml(videoInfo.title)}</h1>
      <div class="video-meta">
        <span>👤 ${escapeHtml(videoInfo.owner?.name || '')}</span>
        <span>📅 ${pubDate}</span>
        <span>⏱️ ${duration}</span>
        <span>🔗 <a href="${escapeAttr(originalUrl)}" target="_blank" style="color: white;">原视频</a></span>
      </div>
    </header>
    ${coverUrl ? `<div class="cover-container"><img src="${escapeAttr(coverUrl)}" alt="封面" /></div>` : ''}
    <div class="subtitle-info">📝 字幕来源：${subtitleTypeLabel}（${subtitleLang}）｜ 由 Read Clip 于 ${new Date().toLocaleString()} 提取</div>
    <section class="subtitle-content">${formattedSubtitle}</section>
  </article>
</body>
</html>`;
}

function generatePdfHtml(title, pdfText, pageCount, pdfSize, originalUrl, pdfOssUrl) {
  const sizeStr = pdfSize > 1024 * 1024
    ? `${(pdfSize / 1024 / 1024).toFixed(1)} MB`
    : `${(pdfSize / 1024).toFixed(0)} KB`;
  const paragraphs = pdfText.split(/\n{2,}/).filter(p => p.trim())
    .map(p => `<p>${escapeHtml(p.trim())}</p>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.8; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; background: #fafafa; }
    .pdf-header { background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: #fff; padding: 28px; border-radius: 16px; margin-bottom: 28px; }
    .pdf-header h1 { font-size: 1.5em; margin: 0 0 12px; font-weight: 600; }
    .pdf-meta { display: flex; gap: 18px; font-size: 0.9em; opacity: 0.9; flex-wrap: wrap; }
    .pdf-meta a { color: #fff; text-decoration: underline; }
    .content { background: #fff; padding: 28px; border-radius: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    .content p { margin: 0.8em 0; line-height: 1.9; }
    a { color: #e74c3c; }
  </style>
</head>
<body>
  <article>
    <header class="pdf-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="pdf-meta">
        <span>📄 PDF · ${pageCount} 页 · ${sizeStr}</span>
        <span>🔗 <a href="${escapeAttr(pdfOssUrl)}">下载 PDF 原件</a></span>
      </div>
    </header>
    <section class="content">${paragraphs}</section>
  </article>
</body>
</html>`;
}

// ============ 12. nodes → markdown / 纯文本 ============

function nodesToMarkdown(nodes) {
  if (!nodes) return '';
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const toMd = (nList) => {
    let md = '';
    for (const node of nList) {
      if (typeof node === 'string') { md += node; continue; }
      const childrenMd = node.children ? toMd(node.children) : '';
      switch (node.tag) {
        case 'p': md += `\n\n${childrenMd}\n\n`; break;
        case 'h1': md += `\n\n# ${childrenMd}\n\n`; break;
        case 'h2': md += `\n\n## ${childrenMd}\n\n`; break;
        case 'h3': md += `\n\n### ${childrenMd}\n\n`; break;
        case 'h4': md += `\n\n#### ${childrenMd}\n\n`; break;
        case 'b': case 'strong': md += `**${childrenMd}**`; break;
        case 'i': case 'em': md += `*${childrenMd}*`; break;
        case 'a': md += `[${childrenMd}](${node.attrs?.href || ''})`; break;
        case 'img': {
          const src = node.attrs?.src || '';
          const alt = node.attrs?.alt || 'image';
          md += `\n\n![${alt}](${src})\n\n`;
          break;
        }
        case 'blockquote': md += `\n> ${childrenMd}\n`; break;
        case 'li': md += `- ${childrenMd}\n`; break;
        case 'ul': case 'ol': md += `\n${childrenMd}\n`; break;
        case 'br': md += '\n'; break;
        case 'hr': md += '\n\n---\n\n'; break;
        default: md += childrenMd;
      }
    }
    return md;
  };
  return toMd(list).replace(/\n{3,}/g, '\n\n').trim();
}

function nodesToPlainText(nodes) {
  if (!nodes) return '';
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const walk = (nList) => {
    let s = '';
    for (const node of nList) {
      if (typeof node === 'string') { s += node; continue; }
      const inner = node.children ? walk(node.children) : '';
      switch (node.tag) {
        case 'p': case 'div': case 'h1': case 'h2': case 'h3': case 'h4':
        case 'h5': case 'h6': case 'li': case 'blockquote':
          s += inner + '\n\n';
          break;
        case 'br': s += '\n'; break;
        case 'img': break;
        default: s += inner;
      }
    }
    return s;
  };
  return walk(list).replace(/\n{3,}/g, '\n\n').trim();
}

// ============ 13. 杂项工具 ============

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/"/g, '&quot;');
}

function formatVideoDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
