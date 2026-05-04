// Read Clip · Manager
//
// 三件事：
//   1. 知识库浏览（从 chrome.storage.local 的 history 读）
//   2. 设置：GitHub / DeepSeek / OSS / 主密码
//   3. 测试连接：GitHub ping + OSS 上传 ping
//
// 凭据全部经主密码加密存到 chrome.storage.sync（多设备同步）。

document.addEventListener('DOMContentLoaded', () => {
  // ---------- 元素引用 ----------
  const navLibrary = document.getElementById('nav-library');
  const navSettings = document.getElementById('nav-settings');
  const viewLibrary = document.getElementById('view-library');
  const viewSettings = document.getElementById('view-settings');

  const cardGrid = document.getElementById('card-grid');
  const itemCount = document.getElementById('item-count');
  const libraryFilter = document.getElementById('library-filter');

  const masterPass = document.getElementById('master-pass');
  const rememberMe = document.getElementById('remember-me');
  const rememberStatus = document.getElementById('remember-status');
  const secureStatus = document.getElementById('secure-status');
  const btnUnlock = document.getElementById('btn-unlock');
  const btnLock = document.getElementById('btn-lock');
  const btnLogout = document.getElementById('btn-logout');

  const ghOwner = document.getElementById('gh-owner');
  const ghRepo = document.getElementById('gh-repo');
  const ghBranch = document.getElementById('gh-branch');
  const ghToken = document.getElementById('gh-token');
  const ghPathArticle = document.getElementById('gh-path-article');
  const ghPathMedia = document.getElementById('gh-path-media');
  const ghPathPdf = document.getElementById('gh-path-pdf');

  const dsKey = document.getElementById('ds-key');
  const dsModel = document.getElementById('ds-model');

  const ossRegion = document.getElementById('oss-region');
  const ossBucket = document.getElementById('oss-bucket');
  const ossAk = document.getElementById('oss-ak');
  const ossSk = document.getElementById('oss-sk');

  const btnSave = document.getElementById('save-settings-btn');
  const btnTestGitHub = document.getElementById('test-github-btn');
  const btnTestOss = document.getElementById('test-oss-btn');
  const btnSyncHistory = document.getElementById('btn-sync-history');
  const logArea = document.getElementById('log-area');
  
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const systemLogContainer = document.getElementById('system-log-container');

  // ---------- 视图切换 ----------
  function switchTab(tab) {
    [navLibrary, navSettings].forEach(b => b.classList.remove('active'));
    [viewLibrary, viewSettings].forEach(v => v.classList.remove('active'));
    if (tab === 'library') { navLibrary.classList.add('active'); viewLibrary.classList.add('active'); loadHistory(); }
    else { navSettings.classList.add('active'); viewSettings.classList.add('active'); }
  }
  navLibrary.addEventListener('click', () => switchTab('library'));
  navSettings.addEventListener('click', () => switchTab('settings'));

  // ---------- 日志 ----------
  function log(msg, isError = false) {
    logArea.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (isError) line.style.color = '#ef4444';
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  // ---------- 主密码状态 ----------
  function setSecureStatus(text, isError = false) {
    secureStatus.textContent = text;
    secureStatus.style.color = isError ? '#ef4444' : '';
  }

  async function refreshSecureStatus() {
    try {
      const has = await SecureSettings.hasEncrypted();
      const session = await SecureSettings.getSession();
      const remember = await SecureSettings.getRememberMeStatus();

      if (remember && !remember.isExpired) {
        rememberStatus.textContent = `已记住（${remember.daysLeft} 天）`;
        rememberStatus.style.color = '#10b981';
      } else {
        rememberStatus.textContent = '';
      }

      if (session) {
        setSecureStatus(`✅ 已解锁${has ? '（云端配置可用）' : '（仅本会话）'}`);
      } else if (has) {
        setSecureStatus('🔒 云端有加密配置，请输入主密码解锁');
      } else {
        setSecureStatus('🆕 尚未保存配置，请填写后输入主密码加密保存');
      }
    } catch (e) {
      setSecureStatus(`检查状态失败：${e.message}`, true);
    }
  }

  function fillForm(s) {
    ghOwner.value = s.github_owner || '';
    ghRepo.value = s.github_repo || '';
    ghBranch.value = s.github_branch || '';
    ghToken.value = s.github_token || '';
    ghPathArticle.value = s.github_path_article || '';
    ghPathMedia.value = s.github_path_media || '';
    ghPathPdf.value = s.github_path_pdf || '';
    dsKey.value = s.deepseek_api_key || '';
    dsModel.value = s.deepseek_model || '';
    ossRegion.value = s.oss_region || '';
    ossBucket.value = s.oss_bucket || '';
    ossAk.value = s.oss_ak || '';
    ossSk.value = s.oss_sk || '';
  }

  function readForm() {
    return {
      github_owner: ghOwner.value.trim(),
      github_repo: ghRepo.value.trim(),
      github_branch: ghBranch.value.trim(),
      github_token: ghToken.value.trim(),
      github_path_article: ghPathArticle.value.trim(),
      github_path_media: ghPathMedia.value.trim(),
      github_path_pdf: ghPathPdf.value.trim(),
      deepseek_api_key: dsKey.value.trim(),
      deepseek_model: dsModel.value.trim(),
      oss_region: ossRegion.value.trim(),
      oss_bucket: ossBucket.value.trim(),
      oss_ak: ossAk.value.trim(),
      oss_sk: ossSk.value.trim()
    };
  }

  async function loadFromSessionIfAny() {
    let s = await SecureSettings.getSession();
    if (!s) s = await SecureSettings.tryRestoreFromRememberMe();
    if (s) fillForm(s);
    else fillForm(await SecureSettings.emptyDraft());
  }

  // ---------- 解锁 / 锁定 / 登出 / 保存 ----------
  btnUnlock.addEventListener('click', async () => {
    try {
      const pass = masterPass.value;
      if (!pass) return setSecureStatus('请输入主密码', true);
      const s = await SecureSettings.unlock(pass, rememberMe.checked);
      fillForm(s);
      setSecureStatus('✅ 解锁成功');
      log('已解锁并填充表单');
    } catch (e) {
      setSecureStatus(`解锁失败：${e.message}`, true);
      log(`解锁失败：${e.message}`, true);
    }
  });

  btnLock.addEventListener('click', async () => {
    await SecureSettings.lock();
    fillForm(await SecureSettings.emptyDraft());
    setSecureStatus('🔒 已锁定会话');
  });

  btnLogout.addEventListener('click', async () => {
    if (!confirm('登出会清除本机记住的密码（云端加密配置仍保留）。继续？')) return;
    await SecureSettings.logout();
    fillForm(await SecureSettings.emptyDraft());
    masterPass.value = '';
    setSecureStatus('已登出');
    refreshSecureStatus();
  });

  btnSave.addEventListener('click', async () => {
    try {
      const pass = masterPass.value;
      if (!pass) {
        setSecureStatus('请输入主密码', true);
        return;
      }
      const draft = readForm();
      const saved = await SecureSettings.save(pass, draft, rememberMe.checked);
      fillForm(saved);
      setSecureStatus('✅ 已加密保存到云端 sync');
      log('保存成功');
    } catch (e) {
      setSecureStatus(`保存失败：${e.message}`, true);
      log(`保存失败：${e.message}`, true);
    }
  });

  // ---------- 测试 GitHub ----------
  btnTestGitHub.addEventListener('click', async () => {
    const draft = readForm();
    if (!draft.github_owner || !draft.github_repo || !draft.github_token) {
      log('GitHub: owner / repo / token 必填', true);
      return;
    }
    log(`测试 GitHub ${draft.github_owner}/${draft.github_repo} ...`);
    try {
      const info = await GitHubClient.ping({
        owner: draft.github_owner,
        repo: draft.github_repo,
        token: draft.github_token
      });
      log(`✅ GitHub 可达：${info.fullName}（默认分支 ${info.defaultBranch}，${info.private ? '私仓' : '公仓'}）`);
    } catch (e) {
      log(`❌ GitHub 测试失败：${e.message}`, true);
    }
  });

  // ---------- 测试 OSS ----------
  btnTestOss.addEventListener('click', async () => {
    const draft = readForm();
    if (!draft.oss_region || !draft.oss_bucket || !draft.oss_ak || !draft.oss_sk) {
      log('OSS 配置不完整（4 项必填）', true);
      return;
    }
    log(`测试 OSS ${draft.oss_region}/${draft.oss_bucket} ...`);
    try {
      const uploader = new AliyunOSSUploader({
        region: draft.oss_region,
        bucket: draft.oss_bucket,
        accessKeyId: draft.oss_ak,
        accessKeySecret: draft.oss_sk
      });
      const blob = new Blob([`Read Clip ping ${new Date().toISOString()}`], { type: 'text/plain' });
      const url = await uploader.upload(blob, `__ping/${Date.now()}.txt`, {
        'Cache-Control': 'no-store'
      });
      log(`✅ OSS 上传成功：${url}`);
    } catch (e) {
      log(`❌ OSS 测试失败：${e.message}`, true);
    }
  });

  // ---------- 系统日志 ----------
  async function refreshSystemLogs() {
    const data = await chrome.storage.local.get('system_logs');
    const logs = data.system_logs || [];
    systemLogContainer.innerHTML = '';
    
    if (logs.length === 0) {
      systemLogContainer.innerHTML = '<div style="padding: 10px; color: #888;">暂无日志</div>';
      return;
    }

    logs.slice().reverse().forEach(log => {
      const line = document.createElement('div');
      line.className = `log-line level-${log.level}`;
      line.style.padding = '4px 10px';
      line.style.borderBottom = '1px solid #333';
      
      const time = new Date(log.timestamp).toLocaleTimeString();
      let color = '#d4d4d4';
      if (log.level === 'warn') color = '#cca700';
      if (log.level === 'error') color = '#f44747';
      
      line.style.color = color;
      
      const detailStr = log.detail ? `<br/><span style="color: #888; font-size: 11px;">${escapeHtml(log.detail)}</span>` : '';
      
      line.innerHTML = `
        <span style="color: #569cd6;">[${time}]</span> 
        <span style="font-weight: bold;">${log.level.toUpperCase()}</span>: 
        ${escapeHtml(log.message)} ${detailStr}
      `;
      systemLogContainer.appendChild(line);
    });
  }

  btnRefreshLogs.addEventListener('click', refreshSystemLogs);
  btnClearLogs.addEventListener('click', async () => {
    if (!confirm('确定要清空所有运行日志吗？')) return;
    await chrome.storage.local.set({ system_logs: [] });
    refreshSystemLogs();
  });

  // ---------- 知识库 ----------
  async function loadHistory() {
    const filter = libraryFilter.value;
    const data = await chrome.storage.local.get('history');
    const history = (data.history || []).slice().reverse();
    const filtered = filter === 'all' ? history : history.filter(h => h.type === filter);

    itemCount.textContent = `${filtered.length} 项`;
    cardGrid.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state-large';
      empty.innerHTML = '<div class="empty-icon">📭</div><h3>暂无记录</h3><p>剪藏的内容会出现在这里。</p>';
      cardGrid.appendChild(empty);
      return;
    }

    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'history-card';
      const typeIcon = item.type === 'bilibili' ? '📺' : item.type === 'pdf' ? '📄' : '📰';
      const time = new Date(item.timestamp).toLocaleString();
      const aiSummary = item.aiSummary || (item.aiError ? `_AI 失败：${item.aiError}_` : '');
      const githubLink = item.githubUrl ? `<a href="${item.githubUrl}" target="_blank">在 GitHub 查看</a>` : '';
      const originalLink = item.originalUrl ? `<a href="${item.originalUrl}" target="_blank">原文</a>` : '';
      const ossLink = item.ossUrl ? `<a href="${item.ossUrl}" target="_blank">HTML 备份</a>` : '';
      const links = [originalLink, githubLink, ossLink].filter(Boolean).join(' · ');

      card.innerHTML = `
        <div class="card-title-row">
          <span class="card-icon">${typeIcon}</span>
          <h3 class="card-title">${escapeHtml(item.title || '(无标题)')}</h3>
        </div>
        <div class="card-meta">${time}${item.githubPath ? ` · ${escapeHtml(item.githubPath)}` : ''}</div>
        ${aiSummary ? `<p class="card-summary">${escapeHtml(aiSummary)}</p>` : ''}
        <div class="card-links">${links}</div>
      `;
      cardGrid.appendChild(card);
    }
  }
  libraryFilter.addEventListener('change', loadHistory);

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ---------- 同步历史 ----------
  btnSyncHistory.addEventListener('click', async () => {
    try {
      const session = await SecureSettings.getSession();
      if (!session) {
        log('请先解锁配置后再同步', true);
        return;
      }
      btnSyncHistory.disabled = true;
      btnSyncHistory.textContent = '同步中...';
      log('开始从 GitHub 同步最近 200 条记录...');
      
      chrome.runtime.sendMessage({ action: 'sync_github_history' }, (response) => {
        btnSyncHistory.disabled = false;
        btnSyncHistory.textContent = '🔄 同步 GitHub 历史';
        if (response && response.success) {
          log(`✅ 同步完成，新增 ${response.count} 条记录`);
          loadHistory();
        } else {
          log(`❌ 同步失败：${response?.error || '未知错误'}`, true);
        }
      });
    } catch (e) {
      btnSyncHistory.disabled = false;
      btnSyncHistory.textContent = '🔄 同步 GitHub 历史';
      log(`❌ 同步异常：${e.message}`, true);
    }
  });

  // ---------- 初始化 ----------
  (async () => {
    try {
      await SecureSettings.tryRestoreFromRememberMe();
    } catch { /* ignore */ }
    await refreshSecureStatus();
    await loadFromSessionIfAny();
    await loadHistory();
    await refreshSystemLogs();
  })();

  // history 变更时刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.history) loadHistory();
  });
});
