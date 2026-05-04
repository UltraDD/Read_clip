/**
 * history-sync.js
 *
 * Pure helpers for rebuilding local clip history from Markdown files already
 * stored in GitHub. Kept independent from chrome.* so it can be tested in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.HistorySync = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const DEFAULT_HISTORY_LIMIT = 200;
  const DEFAULT_REMOTE_SCAN_LIMIT = 400;

  function normalizePath(path) {
    return String(path || '').trim().replace(/^\/+|\/+$/g, '');
  }

  function normalizeHistoryPaths(settings) {
    const paths = [
      settings.github_path_article || 'reading/articles',
      settings.github_path_media || 'reading/media',
      settings.github_path_pdf || 'reading/articles'
    ].map(normalizePath).filter(Boolean);
    return [...new Set(paths)];
  }

  function unquoteYamlValue(value) {
    let val = String(value || '').trim();
    if (!val) return '';
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }

  function getFrontmatterValue(frontmatter, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = frontmatter.match(new RegExp(`^${escaped}:\\s*(.*)$`, 'm'));
    return match ? unquoteYamlValue(match[1]) : '';
  }

  function inferType(repoPath, source, originalUrl) {
    const lowerPath = String(repoPath || '').toLowerCase();
    const lowerSource = String(source || '').toLowerCase();
    const lowerUrl = String(originalUrl || '').toLowerCase();
    if (lowerSource === 'pdf' || lowerUrl.includes('.pdf')) return 'pdf';
    if (
      lowerSource === 'bilibili' ||
      lowerPath.includes('/media/') ||
      /bilibili\.com|b23\.tv/.test(lowerUrl)
    ) {
      return 'bilibili';
    }
    return 'article';
  }

  function fallbackTitle(repoPath) {
    return String(repoPath || '')
      .split('/')
      .pop()
      .replace(/\.md$/i, '') || 'untitled';
  }

  function parseMarkdownEntry(content, repoPath, githubUrl, now = () => Date.now()) {
    const frontmatterMatch = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];
    const title = getFrontmatterValue(frontmatter, 'title');
    const originalUrl = getFrontmatterValue(frontmatter, 'url');
    const capturedAt = getFrontmatterValue(frontmatter, 'captured_at');
    const ossUrl = getFrontmatterValue(frontmatter, 'oss_html');
    const pdfOssUrl = getFrontmatterValue(frontmatter, 'pdf_url');
    const source = getFrontmatterValue(frontmatter, 'source');

    let aiSummary = '';
    const aiMatch = String(content || '').match(/## AI 速览\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---/);
    if (aiMatch) {
      aiSummary = aiMatch[1].trim();
      if (aiSummary.startsWith('>')) aiSummary = '';
    }

    const parsedTime = capturedAt ? new Date(capturedAt).getTime() : NaN;
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : now();
    const type = inferType(repoPath, source, originalUrl);

    return {
      title: title || fallbackTitle(repoPath),
      originalUrl,
      ossUrl,
      githubUrl,
      githubPath: repoPath,
      timestamp,
      type,
      aiSummary: aiSummary || null,
      source: source || null,
      ...(pdfOssUrl ? { pdfOssUrl } : {})
    };
  }

  function isMarkdownFile(item) {
    return item && item.type === 'file' && /\.md$/i.test(item.name || item.path || '');
  }

  function sortByPathDesc(a, b) {
    return String(b.path || b.name || '').localeCompare(String(a.path || a.name || ''));
  }

  async function collectMarkdownFiles({
    githubClient,
    githubOptions,
    roots,
    maxFiles = DEFAULT_REMOTE_SCAN_LIMIT,
    onError
  }) {
    const collected = [];
    const visited = new Set();
    const baseOptions = githubOptions || {};

    async function walk(path) {
      const cleanPath = normalizePath(path);
      if (!cleanPath || visited.has(cleanPath) || collected.length >= maxFiles) return;
      visited.add(cleanPath);

      let entries = [];
      try {
        entries = await githubClient.listDirectory({ ...baseOptions, path: cleanPath });
      } catch (error) {
        if (onError) await onError({ path: cleanPath, error });
        return;
      }

      if (!Array.isArray(entries)) return;

      const dirs = entries
        .filter((item) => item && item.type === 'dir' && item.path)
        .sort(sortByPathDesc);
      for (const dir of dirs) {
        if (collected.length >= maxFiles) return;
        await walk(dir.path);
      }

      const files = entries.filter(isMarkdownFile).sort(sortByPathDesc);
      for (const file of files) {
        if (collected.length >= maxFiles) return;
        collected.push(file);
      }
    }

    for (const rootPath of roots || []) {
      if (collected.length >= maxFiles) break;
      await walk(rootPath);
    }

    return collected;
  }

  function mergeHistory(currentHistory, newEntries, limit = DEFAULT_HISTORY_LIMIT) {
    const byPath = new Map();
    for (const entry of currentHistory || []) {
      if (entry && entry.githubPath) byPath.set(entry.githubPath, entry);
    }
    for (const entry of newEntries || []) {
      if (!entry || !entry.githubPath || byPath.has(entry.githubPath)) continue;
      byPath.set(entry.githubPath, entry);
    }
    return [...byPath.values()]
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-limit);
  }

  return {
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_REMOTE_SCAN_LIMIT,
    normalizeHistoryPaths,
    parseMarkdownEntry,
    collectMarkdownFiles,
    mergeHistory
  };
});
