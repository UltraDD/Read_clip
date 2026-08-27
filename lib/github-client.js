/**
 * github-client.js
 *
 * GitHub Contents API 推送 md 到指定仓库。
 *
 * 用 PAT (Personal Access Token, classic 或 fine-grained 都可) 鉴权。
 * 推荐 fine-grained PAT，scope: contents=write 限定到单一目标仓库。
 *
 * 主入口：
 *   GitHubClient.commitFile({
 *     owner, repo, branch, token,
 *     path,            // 仓库内路径，如 "reading/articles/2026-04-28-foo.md"
 *     content,         // 文件内容（utf-8 字符串）
 *     message,         // commit message
 *     committer,       // { name, email } 可选
 *   }) -> { commitSha, contentSha, htmlUrl }
 *
 * 边界：
 *   - 同一路径已存在时自动带上 sha 走"更新"分支
 *   - 401/403/404 给出可读错误
 *   - utf-8 → base64 用 TextEncoder + Uint8Array → btoa 路径，避免 unescape(encodeURIComponent) 兼容坑
 */
(function () {
  const API = 'https://api.github.com';

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function authHeaders(token) {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }

  async function getExistingSha({ owner, repo, branch, path, token }) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub 查询文件失败 (${res.status}): ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.sha || null;
  }

  /**
   * 提交一份文件（新建或覆盖更新）。
   * 返回 { commitSha, contentSha, htmlUrl, downloadUrl }。
   */
  async function commitFile({ owner, repo, branch, token, path, content, message, committer }) {
    if (!owner || !repo || !branch || !token) {
      throw new Error('GitHub 配置不完整：owner/repo/branch/token 缺一不可');
    }
    if (!path) throw new Error('GitHub 提交路径为空');

    let sha = null;
    try {
      sha = await getExistingSha({ owner, repo, branch, path, token });
    } catch (e) {
      // 查询失败不一定是致命：401/403 之类要往上抛，404 已经在内部处理
      if (/401|403/.test(e.message)) throw e;
      console.warn('[GitHubClient] 查询已存在文件失败，按新建处理：', e.message);
    }

    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API}/repos/${owner}/${repo}/contents/${encodedPath}`;
    const body = {
      message: message || `clip ${path}`,
      content: utf8ToBase64(content),
      branch
    };
    if (sha) body.sha = sha;
    if (committer) body.committer = committer;

    const res = await fetch(url, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401) hint = '（Token 无效或过期）';
      else if (res.status === 403) hint = '（Token 无权限或速率限制）';
      else if (res.status === 404) hint = '（仓库或分支不存在）';
      else if (res.status === 422) hint = '（参数无效，常见为 sha 不匹配 / 分支不存在）';
      throw new Error(`GitHub 提交失败 ${res.status}${hint}: ${txt.slice(0, 200)}`);
    }

    const json = await res.json();
    return {
      commitSha: json.commit && json.commit.sha,
      contentSha: json.content && json.content.sha,
      htmlUrl: json.content && json.content.html_url,
      downloadUrl: json.content && json.content.download_url,
      path: json.content && json.content.path
    };
  }

  /**
   * 仅 ping 一下：用 GET /repos/:o/:r 验证 token + 仓库可达。
   */
  async function ping({ owner, repo, token }) {
    const url = `${API}/repos/${owner}/${repo}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub ping 失败 ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    return {
      fullName: json.full_name,
      defaultBranch: json.default_branch,
      private: json.private
    };
  }

  /**
   * 列出目录下的文件
   */
  async function listDirectory({ owner, repo, branch, path, token }) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (res.status === 404) return [];
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub 获取列表失败 (${res.status}): ${txt.slice(0, 200)}`);
    }
    return await res.json();
  }

  /**
   * 获取文件内容（已解码 utf-8）
   */
  async function getFileContent({ owner, repo, branch, path, token }) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub 获取文件失败 (${res.status}): ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.encoding === 'base64') {
      const binary = atob(json.content.replace(/\s/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return json.content;
  }

  self.GitHubClient = { commitFile, ping, listDirectory, getFileContent };
})();
