/**
 * Read Clip Content Script
 * Requires lib/Readability.js (web pages) or lib/bilibili-extractor.js (bilibili).
 */

(function() {
  if (window.hasRunReadClip) {
    console.log("Read Clip already loaded. Re-running extraction...");
  }
  window.hasRunReadClip = true;

    // --- B站视频检测 ---
    function isBilibiliVideo(url) {
        if (!url) return false;
        return /bilibili\.com\/video\/(BV[\w]+|av\d+)/i.test(url) ||
               /b23\.tv\/[\w]+/i.test(url);
    }

    // --- Non-modal Toast (Chinese) ---
    function showToast(message, options = {}) {
      const {
        type = 'info',           // info | success | error
        url = '',                // clickable URL
        showGemini = false,      // show "G" button
        geminiPrompt = '',       // prompt to send to background
        articleInfo = null,      // article info for Gemini sync
        errorLog = '',           // copyable error log for debugging
        persistent = false       // true = no auto-dismiss
      } = options;
  
      const id = 'read-clip-toast-root';
      const old = document.getElementById(id);
      if (old) old.remove();
  
      const root = document.createElement('div');
      root.id = id;
      root.style.cssText = `
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        max-width: 360px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      `;
  
      const bg =
        type === 'error' ? '#ef4444' :
        type === 'success' ? '#10b981' :
        '#2563eb';
  
      const card = document.createElement('div');
      card.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 12px;
        color: #fff;
        background: ${bg};
        box-shadow: 0 10px 25px rgba(0,0,0,.18);
        transition: transform 0.2s ease;
      `;
  
      const text = document.createElement('div');
      text.style.cssText = `
        flex: 1;
        font-size: 13px;
        line-height: 1.4;
        word-break: break-word;
      `;
      text.textContent = String(message || '');
  
      const actions = document.createElement('div');
      actions.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      `;
  
      if (url) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = '打开';
        openBtn.style.cssText = `
          border: 1px solid rgba(255,255,255,.7);
          background: rgba(255,255,255,.12);
          color: #fff;
          padding: 6px 10px;
          border-radius: 10px;
          font-size: 12px;
          cursor: pointer;
        `;
        openBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(url, '_blank');
        });
        actions.appendChild(openBtn);
      }
  
      if (showGemini) {
        const gBtn = document.createElement('button');
        gBtn.type = 'button';
        gBtn.textContent = 'G';
        gBtn.title = '在 Gemini 深度分析';
        gBtn.style.cssText = `
          width: 26px;
          height: 26px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.7);
          background: rgba(255,255,255,.12);
          color: #fff;
          font-weight: 800;
          font-size: 12px;
          cursor: pointer;
          padding: 0;
          line-height: 24px;
          text-align: center;
        `;
        gBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prompt = String(geminiPrompt || '').trim();
          if (!prompt) return;
          chrome.runtime.sendMessage({ 
            action: 'open_gemini', 
            prompt,
            articleInfo: articleInfo
          });
          root.remove();
        });
        actions.appendChild(gBtn);
      }

      if (errorLog) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = '📋 复制日志';
        copyBtn.style.cssText = `
          border: 1px solid rgba(255,255,255,.7);
          background: rgba(255,255,255,.12);
          color: #fff;
          padding: 6px 10px;
          border-radius: 10px;
          font-size: 12px;
          cursor: pointer;
          white-space: nowrap;
        `;
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard.writeText(errorLog).then(() => {
            copyBtn.textContent = '✓ 已复制';
            setTimeout(() => { copyBtn.textContent = '📋 复制日志'; }, 2000);
          });
        });
        actions.appendChild(copyBtn);
      }
  
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭';
      closeBtn.style.cssText = `
        width: 24px;
        height: 24px;
        border-radius: 8px;
        border: none;
        background: transparent;
        color: rgba(255,255,255,.9);
        font-size: 18px;
        cursor: pointer;
        line-height: 22px;
        padding: 0;
      `;
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        root.remove();
      });
  
      actions.appendChild(closeBtn);
      card.appendChild(text);
      card.appendChild(actions);
      root.appendChild(card);
  
      // Avoid pages that lack body (rare) — fall back to documentElement.
      (document.body || document.documentElement).appendChild(root);
  
      // Auto dismiss with hover pause (skip if persistent)
      let dismissTimer = null;
      const ttl = type === 'success' ? 6000 : 8000;
  
      const startTimer = (ms) => {
        dismissTimer = setTimeout(() => {
          if (root && root.parentNode) root.remove();
        }, ms);
      };
  
      if (!persistent) startTimer(ttl);
  
      root.addEventListener('mouseenter', () => {
        if (dismissTimer) clearTimeout(dismissTimer);
        card.style.transform = 'translateY(-2px)';
      });
  
      root.addEventListener('mouseleave', () => {
        startTimer(2000); // 移开后 2 秒消失
        card.style.transform = 'translateY(0)';
      });
    }

  // --- 默认 Gemini 提示词模板 ---
  const DEFAULT_GEMINI_PROMPT = `嘿，我刚看了{contentType}：
{url}

别给我写那种平庸的短评。假设你是我那位博学、犀利且**话痨**的朋友，我们正坐在深夜的书房里，你准备就{contentType}给我来一场**酣畅淋漓的深度剖析**。

请你**放开篇幅限制（至少 800 字以上）**，跳过客套，直接抓住{contentType}里最让你觉得"有意思"、"反直觉"或者"值得深挖"的 1-2 个点，把它**彻底揉碎了**讲给我听。

* **拒绝浅尝辄止**：不要只罗列观点。我要你把每一个观点背后的逻辑链条、适用边界、甚至历史背景都挖出来。
* **跨界联想**：请大量引用你脑海中的其他知识（历史、心理学、经济学、科幻小说等）来佐证或反驳，让分析具有**厚度**。
* **批判性**：不要顺着作者说。{contentType}哪里逻辑有漏洞？哪里避重就轻了？狠狠地指出来。
* **最后的一问**：抛给我一个**值得我今晚失眠去思考的硬核问题**。

期待你**详尽且有洞见**的长文回复。`;

  // --- 获取当前分类的 Gemini 提示词 ---
  async function getCategoryGeminiPrompt(categoryId) {
    try {
      const data = await chrome.storage.local.get('categoryList');
      const categories = data.categoryList || [];
      const category = categories.find(c => c.id === categoryId);
      return (category && category.geminiPrompt) ? category.geminiPrompt : '';
    } catch (e) {
      return '';
    }
  }

  // --- Gemini 深度分析提示词生成 ---
  function buildGeminiPrompt(url, isVideo = false, customPrompt = '') {
    const contentType = isVideo ? '这个视频' : '这篇文章';
    const template = customPrompt || DEFAULT_GEMINI_PROMPT;
    
    return template
      .replace(/\{url\}/g, url)
      .replace(/\{contentType\}/g, contentType);
  }

  async function getActiveCategory() {
    try {
      const data = await chrome.storage.local.get('activeCategory');
      return data.activeCategory || 'articles';
    } catch (e) {
      return 'articles';
    }
  }

  // --- 处理成功响应 ---
  async function handleSuccess(response, isVideo = false) {
    const bestUrl = response.githubUrl || response.ossUrl || response.url || window.location.href;
    const successMsg = isVideo ? '视频字幕已剪藏' : '文章已剪藏';
    const aiHint = response.aiSummary
      ? '（AI 总结已生成）'
      : (response.aiError ? `（AI 失败：${response.aiError}）` : '');
    showToast(`${successMsg} ${aiHint}`, {
      type: 'success',
      url: bestUrl
    });
  }

  // --- 构建错误日志 ---
  function buildErrorLog(errorMsg, context = '') {
    const lines = [
      '=== Read Clip Error Log ===',
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `Error: ${errorMsg}`,
    ];
    if (context) lines.push(`Context: ${context}`);
    lines.push(`UserAgent: ${navigator.userAgent}`);
    lines.push(`Extension: v0.1.0`);
    return lines.join('\n');
  }

  // --- 处理错误响应 ---
  function handleError(response, context = '') {
    const msg = (response && response.error) ? String(response.error) : "未知错误";
    const log = buildErrorLog(msg, context);
    showToast(`保存失败：${msg}`, { type: 'error', errorLog: log });
  }

  // --- 检测本地文件 ---
  function isLocalFile(url) {
    return url && url.startsWith('file://');
  }

  // --- 检测 PDF 页面 ---
  function isPdfPage() {
    const url = window.location.href.split('?')[0].split('#')[0];
    if (url.toLowerCase().endsWith('.pdf')) return true;
    const embed = document.querySelector('embed[type="application/pdf"]');
    if (embed) return true;
    return false;
  }

  // --- 本地 PDF 文件选择器（file:// 下浏览器安全限制无法直接读取，需用户选择文件）---
  function showLocalPdfPicker(currentUrl, title, category) {
    const id = 'read-clip-pdf-picker';
    const old = document.getElementById(id);
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483647;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: #fff; border-radius: 16px; padding: 32px 28px;
      max-width: 380px; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    `;

    const icon = document.createElement('div');
    icon.textContent = '\uD83D\uDCC4';
    icon.style.cssText = 'font-size: 48px; margin-bottom: 14px;';

    const heading = document.createElement('h3');
    heading.textContent = '选择 PDF 文件';
    heading.style.cssText = 'margin: 0 0 8px; font-size: 18px; color: #1d1d1f; font-weight: 600;';

    const desc = document.createElement('p');
    desc.style.cssText = 'margin: 0 0 20px; font-size: 14px; color: #86868b; line-height: 1.6;';
    desc.innerHTML = '浏览器安全限制不允许直接读取本地文件。<br>请点击下方按钮选择当前查看的 PDF 文件。';

    const label = document.createElement('label');
    label.style.cssText = `
      display: inline-block; padding: 12px 24px;
      background: #007AFF; color: #fff; border-radius: 12px;
      font-size: 15px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    `;
    label.textContent = '\uD83D\uDCC2 选择文件';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,application/pdf';
    fileInput.style.display = 'none';
    label.appendChild(fileInput);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = `
      display: block; margin: 14px auto 0; background: none; border: none;
      color: #86868b; font-size: 13px; cursor: pointer; padding: 8px;
    `;

    card.appendChild(icon);
    card.appendChild(heading);
    card.appendChild(desc);
    card.appendChild(label);
    card.appendChild(cancelBtn);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);

    const cleanup = () => { if (overlay.parentNode) overlay.remove(); };
    cancelBtn.onclick = cleanup;
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };

    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      cleanup();

      showToast(`正在读取 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）...`, { type: 'info', persistent: true });

      try {
        const MAX_SIZE = 50 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
          throw new Error(`PDF 文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 50MB`);
        }

        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('FileReader 读取失败'));
          reader.readAsDataURL(file);
        });

        const pdfTitle = title || file.name.replace(/\.pdf$/i, '');

        chrome.runtime.sendMessage({
          action: "publish_pdf",
          payload: { title: pdfTitle, pdfBase64: base64, pdfSize: file.size, original_url: currentUrl, category }
        }, (response) => {
          if (chrome.runtime.lastError) {
            const log = buildErrorLog(chrome.runtime.lastError.message, '本地 PDF → sendMessage');
            showToast("发送到后台失败，请重试。", { type: 'error', errorLog: log });
          } else if (response && response.success) {
            handleSuccess(response, false);
          } else {
            handleError(response, '本地 PDF 保存');
          }
        });
      } catch (err) {
        const log = buildErrorLog(err.message, '本地 PDF 文件读取');
        showToast(`PDF 处理失败：${err.message}`, { type: 'error', errorLog: log });
      }
    };
  }

  // --- 读取网络 PDF 文件为 base64（仅用于 http/https URL）---
  async function readPdfAsBase64() {
    const response = await fetch(window.location.href);
    if (!response.ok) throw new Error(`无法读取 PDF 文件 (HTTP ${response.status})`);
    const blob = await response.blob();

    const MAX_SIZE = 50 * 1024 * 1024;
    if (blob.size > MAX_SIZE) {
      throw new Error(`PDF 文件过大（${(blob.size / 1024 / 1024).toFixed(1)}MB），最大支持 50MB`);
    }

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return { base64, size: blob.size };
  }

  // --- 抓取完整 HTML（包含样式）---
  function captureFullHtml() {
    // 获取页面标题
    const title = document.title || '本地文件';
    
    // 克隆整个文档
    const docClone = document.documentElement.cloneNode(true);
    
    // 收集所有样式（包括外部样式表的内容）
    let allStyles = '';
    
    // 1. 内联 style 标签
    const styleTags = document.querySelectorAll('style');
    styleTags.forEach(style => {
      allStyles += style.outerHTML + '\n';
    });
    
    // 2. 外部样式表 - 尝试获取计算后的样式
    const linkTags = document.querySelectorAll('link[rel="stylesheet"]');
    linkTags.forEach(link => {
      try {
        // 对于本地文件，外部样式可能无法通过 fetch 获取
        // 我们保留 link 标签，让浏览器处理
        allStyles += `/* External: ${link.href} */\n`;
      } catch (e) {
        console.warn('Could not process stylesheet:', link.href);
      }
    });
    
    // 3. 获取所有计算样式并内联到元素上（确保样式保留）
    // 这是一个更可靠的方法来保留样式
    const elementsWithStyle = docClone.querySelectorAll('*');
    elementsWithStyle.forEach(el => {
      try {
        const selector = getSelector(el);
        const originalEl = document.querySelector(selector);
        if (originalEl) {
          const computedStyle = window.getComputedStyle(originalEl);
          // 只保留关键的布局样式
          const importantStyles = [
            'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
            'grid-template-columns', 'grid-template-rows', 'gap',
            'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
            'margin', 'padding', 'border', 'border-radius',
            'background', 'background-color', 'color',
            'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
            'position', 'top', 'left', 'right', 'bottom',
            'overflow', 'white-space', 'word-break'
          ];
          let inlineStyle = '';
          importantStyles.forEach(prop => {
            const value = computedStyle.getPropertyValue(prop);
            if (value && value !== 'initial' && value !== 'none' && value !== 'normal' && value !== 'auto') {
              inlineStyle += `${prop}: ${value}; `;
            }
          });
          if (inlineStyle && !el.getAttribute('style')) {
            el.setAttribute('style', inlineStyle);
          }
        }
      } catch (e) {
        // 忽略无法处理的元素，继续处理其他元素
        console.warn('Could not process element:', e.message);
      }
    });
    
    // 生成完整 HTML
    const fullHtml = `<!DOCTYPE html>
<html lang="${document.documentElement.lang || 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    /* 保留原始样式 */
    ${allStyles}
  </style>
</head>
<body>
  ${document.body.innerHTML}
</body>
</html>`;
    
    return {
      title,
      html: fullHtml
    };
  }
  
  // 辅助函数：转义 CSS 选择器中的特殊字符
  function escapeCSSSelector(str) {
    return str.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }
  
  // 辅助函数：获取元素的 CSS 选择器
  function getSelector(el) {
    try {
      if (el.id) return '#' + escapeCSSSelector(el.id);
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c);
        if (classes.length > 0) {
          const escapedClasses = classes.map(c => escapeCSSSelector(c)).join('.');
          return el.tagName.toLowerCase() + '.' + escapedClasses;
        }
      }
      return el.tagName.toLowerCase();
    } catch (e) {
      return el.tagName.toLowerCase();
    }
  }

  try {
    const currentUrl = window.location.href;

    // ========== PDF 文件处理流程 ==========
    if (isPdfPage()) {
      console.log("Read Clip: 检测到 PDF 文件...");
      showToast("正在处理 PDF 文件...", { type: 'info', persistent: true });

      (async () => {
        try {
          const rawTitle = document.title || '';
          const fallbackTitle = decodeURIComponent(
            window.location.pathname.split('/').pop().replace(/\.pdf$/i, '')
          );
          const title = (rawTitle && rawTitle !== 'about:blank') ? rawTitle : fallbackTitle;
          const category = await getActiveCategory();

          if (isLocalFile(currentUrl)) {
            showLocalPdfPicker(currentUrl, title, category);
          } else {
            // 网络 PDF：content script 可以直接 fetch
            const { base64, size } = await readPdfAsBase64();
            showToast(`PDF 读取成功（${(size / 1024 / 1024).toFixed(1)}MB），正在上传...`, { type: 'info', persistent: true });

            chrome.runtime.sendMessage({
              action: "publish_pdf",
              payload: { title, pdfBase64: base64, pdfSize: size, original_url: currentUrl, category }
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error("Message error:", chrome.runtime.lastError);
                const log = buildErrorLog(chrome.runtime.lastError.message, 'PDF → sendMessage');
                showToast("发送到后台失败，请重试。", { type: 'error', errorLog: log });
              } else if (response && response.success) {
                handleSuccess(response, false);
              } else {
                handleError(response, 'PDF 保存');
              }
            });
          }
        } catch (err) {
          console.error("PDF 处理失败:", err);
          const log = buildErrorLog(err.message, 'PDF 读取/处理');
          showToast(`PDF 处理失败：${err.message}`, { type: 'error', errorLog: log });
        }
      })();

      return;
    }

    // ========== 本地文件 ==========（第一期不支持，给提示）
    if (isLocalFile(currentUrl)) {
      console.log("Read Clip: 本地文件不在第一期支持范围内");
      showToast("Read Clip 暂不支持本地 HTML 文件，请在线打开后再试。", { type: 'info' });
      return;
    }

    // ========== B站视频处理流程 ==========
    if (isBilibiliVideo(currentUrl)) {
      console.log("Read Clip: 检测到B站视频，启动字幕提取...");
      showToast("正在提取B站视频字幕...", { type: 'info' });

      // 检查 BilibiliExtractor 是否已加载
      if (typeof BilibiliExtractor === 'undefined') {
        const log = buildErrorLog('BilibiliExtractor undefined', 'B站字幕提取');
        showToast("B站提取器未加载，请刷新页面后重试。", { type: 'error', errorLog: log });
        return;
      }

      // 在页面上下文中提取字幕（利用用户 Cookie）
      (async () => {
        try {
          console.log("[B站] 开始提取字幕...");
          const result = await BilibiliExtractor.extract(currentUrl);
          
          if (!result.hasSubtitle) {
            const log = buildErrorLog('No subtitle found', 'B站字幕提取');
            showToast("该视频没有字幕（请确认视频已开启AI字幕或有UP主上传的字幕）", { type: 'error', errorLog: log });
            return;
          }

          console.log(`[B站] 字幕提取成功: ${result.subtitleLang}, ${result.subtitles.length} 条`);
          showToast(`已提取 ${result.subtitleLang} 字幕，正在上传...`, { type: 'info' });

          // 将提取到的数据发送给 background.js 进行 OSS 上传和 GitHub 推送
          const category = await getActiveCategory();
          chrome.runtime.sendMessage({
            action: "publish_bilibili",
            payload: {
              url: currentUrl,
              videoInfo: result.videoInfo,
              subtitleText: result.subtitleText,
              subtitleType: result.subtitleType,
              subtitleLang: result.subtitleLang,
              hasSubtitle: result.hasSubtitle,
              category
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("Message error:", chrome.runtime.lastError);
              const log = buildErrorLog(chrome.runtime.lastError.message, 'B站视频 → sendMessage');
              showToast("发送到后台失败，请重试。", { type: 'error', errorLog: log });
            } else if (response && response.success) {
              handleSuccess(response, true);
            } else {
              handleError(response, 'B站视频保存');
            }
          });

        } catch (err) {
          console.error("[B站] 字幕提取失败:", err);
          const log = buildErrorLog(err.message + (err.stack ? '\n' + err.stack : ''), 'B站字幕提取');
          showToast(`字幕提取失败: ${err.message}`, { type: 'error', errorLog: log });
        }
      })();

      return; // 结束 B站处理流程
    }

    // ========== 普通文章处理流程 ==========
    const article = parseArticle();
    
    if (article) {
      console.log("Read Clip extraction success:", article.title);
      
      // Convert the HTML content to Telegraph Node structure
      // We iterate over the children of the root element (body) to get an array of nodes.
      const contentNodes = domToNode(article.content);

      // Send the data to background.js for processing and uploading
      (async () => {
        const category = await getActiveCategory();
        chrome.runtime.sendMessage({
          action: "publish_article",
          payload: {
              title: article.title,
              author_name: article.byline || "",
              content: contentNodes, // Array of Nodes
              original_url: window.location.href,
              category
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
               console.error("Message error:", chrome.runtime.lastError);
               const log = buildErrorLog(chrome.runtime.lastError.message, '文章 → sendMessage');
               showToast("发送到后台失败，请重试（或检查插件是否启用）。", { type: 'error', errorLog: log });
          } else if (response && response.success) {
              handleSuccess(response, false);
          } else {
              handleError(response, '文章保存');
          }
        });
      })();

    } else {
      console.warn("Read Clip: Readability returned null.");
      const log = buildErrorLog('Readability returned null', '文章解析');
      showToast("提取失败：该页面可能不支持解析。", { type: 'error', errorLog: log });
    }

  } catch (error) {
    console.error("Read Clip error:", error);
    const log = buildErrorLog(error.message + (error.stack ? '\n' + error.stack : ''), '全局异常');
    if (error.message.includes("Readability is not defined")) {
      showToast("运行失败：Readability 未加载（请刷新页面后重试）。", { type: 'error', errorLog: log });
    } else {
      showToast(`运行失败：${error.message || '未知错误'}`, { type: 'error', errorLog: log });
    }
  }

  /**
   * Extracts the main article content using Mozilla Readability.
   */
  function parseArticle() {
    if (typeof Readability === 'undefined') {
      throw new Error("Readability is not defined.");
    }

    const documentClone = document.cloneNode(true);
    const reader = new Readability(documentClone);
    const article = reader.parse();
    
    // If parse was successful, article.content is an HTML string.
    // We need to convert that string back to a DOM element to traverse it easily for domToNode.
    if (article && article.content) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(article.content, 'text/html');
        // We replace the string content with the actual DOM body for our converter
        article.content = doc.body; 
    }
    
    return article;
  }

  /**
   * Converts a DOM Element to Telegraph 'Node' format.
   * Telegraph Nodes: String | { tag: 'p', attrs: {...}, children: [...] }
   * Returns an ARRAY of nodes to allow unwrapping containers.
   */
  function domToNode(element) {
    // 1. Text Node
    if (element.nodeType === Node.TEXT_NODE) {
        const text = element.textContent;
        // Trim whitespace? Telegraph preserves whitespace but excess is bad.
        // If it's just whitespace, ignore? No, might be space between words.
        // But block level whitespace should be ignored.
        // Let's keep it simple: return text.
        return [text];
    }

    // 2. Element Node
    if (element.nodeType !== Node.ELEMENT_NODE) {
        return [];
    }

    const tagName = element.tagName.toLowerCase();
    
    // Skip disallowed tags
    if (['script', 'style', 'noscript', 'meta', 'link', 'svg', 'button', 'input', 'form', 'iframe'].includes(tagName)) {
        return [];
    }

    // Recursively process children
    let childNodes = [];
    for (let i = 0; i < element.childNodes.length; i++) {
        const children = domToNode(element.childNodes[i]);
        childNodes = childNodes.concat(children);
    }
    
    const validTags = ['a', 'aside', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption', 'figure', 'h3', 'h4', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'video'];
    
    // Map H1/H2 to H3/H4 because Telegraph doesn't support H1/H2
    let targetTag = tagName;
    if (tagName === 'h1') targetTag = 'h3';
    if (tagName === 'h2') targetTag = 'h4';
    if (tagName === 'div' || tagName === 'span' || tagName === 'section' || tagName === 'article' || tagName === 'main') {
        // Unwrap these generic containers
        return childNodes;
    }

    let attrs = {};
    if (targetTag === 'a') {
        attrs.href = element.href;
    }
    if (targetTag === 'img') {
        // Handle lazy loaded images
        const src = element.getAttribute('data-src') || element.getAttribute('data-original') || element.src;
        if (src) {
            attrs.src = src;
            return [{ tag: 'img', attrs: attrs }]; // Img has no children
        }
        return [];
    }

    if (validTags.includes(targetTag)) {
        // Remove empty nodes
        if (childNodes.length === 0 && !['img', 'br', 'hr', 'video'].includes(targetTag)) {
            return [];
        }

        return [{
            tag: targetTag,
            attrs: Object.keys(attrs).length ? attrs : undefined,
            children: childNodes
        }];
    }

    // Default fallback: Unwrap
    return childNodes;
  }

})();
