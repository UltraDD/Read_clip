// Read Clip · Popup
//
// 行为：
//   点击主胶囊 → 注入 Readability/bilibili-extractor + content.js → content 触发 publish_*
//   后台广播 progress_update → 这里更新四步进度
//   complete → 展示 GitHub 链接 / 加载历史
//
// 四步：extract → oss → ai → github

document.addEventListener('DOMContentLoaded', () => {
  const btnOpenManager = document.getElementById('btn-open-manager');
  const historyList = document.getElementById('history-list');
  const actionCapsule = document.getElementById('action-capsule');
  const progressSteps = document.getElementById('progress-steps');

  const stateIdle = document.querySelector('.state-idle');
  const stateProcessing = document.querySelector('.state-processing');
  const stateSuccess = document.querySelector('.state-success');
  const stateError = document.querySelector('.state-error');
  const progressText = document.getElementById('progress-text');
  const btnOpenGitHub = document.getElementById('btn-open-github');

  let lastSuccessResult = null;

  // ---------- 启动 ----------
  init();

  btnOpenManager.addEventListener('click', () => chrome.tabs.create({ url: 'manager.html' }));

  actionCapsule.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!actionCapsule.classList.contains('processing') && !actionCapsule.classList.contains('success')) {
      startCapture();
    }
  });

  document.getElementById('btn-stop').addEventListener('click', (e) => {
    e.stopPropagation();
    setCapsuleState('idle');
    progressSteps.style.display = 'none';
    chrome.storage.local.set({ processingState: null });
  });

  if (btnOpenGitHub) {
    btnOpenGitHub.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = lastSuccessResult?.ossUrl || lastSuccessResult?.githubUrl;
      if (url) chrome.tabs.create({ url });
    });
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'progress_update') {
      updateProgress(request.step, request.data);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) loadHistory();
  });

  async function init() {
    await loadHistory();
    await checkActiveState();
  }

  async function checkActiveState() {
    const data = await chrome.storage.local.get(['processingState']);
    const p = data.processingState;
    const now = Date.now();
    if (p && p._updatedAt && (now - p._updatedAt < 120000)) {
      setCapsuleState('processing');
      if (p.step) updateProgress(p.step, p);
    } else {
      if (p) chrome.storage.local.set({ processingState: null });
      setCapsuleState('idle');
      progressSteps.style.display = 'none';
    }
  }

  // ---------- 触发剪藏 ----------
  async function startCapture() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    setCapsuleState('processing');
    resetStepsUI();
    progressText.textContent = '启动中...';

    const isBilibili = tab.url && /bilibili\.com\/video\/(BV[\w]+|av\d+)/i.test(tab.url);
    const scripts = isBilibili
      ? ['lib/bilibili-extractor.js', 'content.js']
      : ['lib/Readability.js', 'content.js'];

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: scripts
      });
    } catch (err) {
      console.error(err);
      showError('无法访问此页面');
    }
  }

  // ---------- 状态切换 ----------
  function setCapsuleState(state) {
    actionCapsule.className = 'capsule static-capsule';
    [stateIdle, stateProcessing, stateSuccess, stateError].forEach(el => el.style.display = 'none');
    if (state === 'idle') stateIdle.style.display = 'flex';
    else if (state === 'processing') {
      actionCapsule.classList.add('processing');
      stateProcessing.style.display = 'flex';
    } else if (state === 'success') {
      actionCapsule.classList.add('success');
      stateSuccess.style.display = 'flex';
    } else if (state === 'error') {
      actionCapsule.classList.add('error');
      stateError.style.display = 'flex';
      setTimeout(() => {
        setCapsuleState('idle');
        progressSteps.style.display = 'none';
      }, 4000);
    }
  }

  function resetStepsUI() {
    progressSteps.style.display = 'flex';
    ['extract', 'oss', 'ai', 'github'].forEach(s => {
      const el = progressSteps.querySelector(`[data-step="${s}"]`);
      if (!el) return;
      el.className = 'step-item';
      el.querySelector('.step-status').innerHTML = '○';
      const detailEl = el.querySelector('.step-detail');
      if (detailEl) detailEl.textContent = '';
    });
    setStepStatus('extract', 'loading');
  }

  function setStepStatus(stepName, status, detail = '') {
    const el = progressSteps.querySelector(`[data-step="${stepName}"]`);
    if (!el) return;
    el.className = 'step-item';
    const icon = el.querySelector('.step-status');
    const detailEl = el.querySelector('.step-detail');
    if (detail && detailEl) detailEl.textContent = detail;
    if (status === 'loading') {
      el.classList.add('active');
      icon.innerHTML = '<div class="step-spinner"></div>';
    } else if (status === 'completed') {
      el.classList.add('completed');
      icon.innerHTML = '✓';
    } else if (status === 'failed') {
      el.classList.add('failed');
      icon.innerHTML = '!';
    } else {
      icon.innerHTML = '○';
    }
  }

  // ---------- 进度路由 ----------
  // 后台事件 → UI 步骤映射：
  //   extract / bilibili_extract → step "extract"
  //   image / html / oss         → step "oss"
  //   ai                         → step "ai"
  //   github                     → step "github"
  //   complete                   → success
  //   error                      → error
  function updateProgress(step, data) {
    if (step === 'error') {
      showError(data?.message || '失败');
      return;
    }
    if (step === 'complete') {
      lastSuccessResult = data || null;
      setStepStatus('extract', 'completed');
      setStepStatus('oss', 'completed');
      setStepStatus('ai', data?.aiError ? 'failed' : 'completed', data?.aiError ? `AI 失败：${data.aiError}` : '');
      setStepStatus('github', 'completed');
      setCapsuleState('success');
      loadHistory();
      return;
    }

    setCapsuleState('processing');
    let detail = '';
    if (step === 'extract' || step === 'bilibili_extract') {
      detail = data?.message || '正在解析页面...';
      setStepStatus('extract', 'loading', detail);
      progressText.textContent = '解析正文...';
    } else if (step === 'image' || step === 'html' || step === 'oss') {
      setStepStatus('extract', 'completed');
      if (step === 'image' && data?.total > 0) {
        detail = `图片 ${data.current}/${data.total}`;
      } else {
        detail = data?.message || '上传到 OSS...';
      }
      setStepStatus('oss', 'loading', detail);
      progressText.textContent = '上传 OSS...';
    } else if (step === 'ai') {
      setStepStatus('extract', 'completed');
      setStepStatus('oss', 'completed');
      detail = data?.message || '正在调用 DeepSeek...';
      setStepStatus('ai', 'loading', detail);
      progressText.textContent = 'AI 总结...';
    } else if (step === 'github') {
      setStepStatus('extract', 'completed');
      setStepStatus('oss', 'completed');
      setStepStatus('ai', 'completed');
      detail = data?.message || '提交到 GitHub...';
      setStepStatus('github', 'loading', detail);
      progressText.textContent = '推 GitHub...';
    }
  }

  function showError(msg) {
    const errText = document.querySelector('.state-error .capsule-text');
    if (errText) errText.textContent = `❌ ${msg}`;
    setCapsuleState('error');
  }

  // ---------- 历史列表 ----------
  async function loadHistory() {
    try {
      const data = await chrome.storage.local.get('history');
      const history = (data.history || []).slice().reverse().slice(0, 30);
      historyList.innerHTML = '';
      if (history.length === 0) {
        historyList.innerHTML = `
          <li class="empty-state">
            <div class="empty-icon">📭</div>
            <p>暂无记录</p>
            <button class="sync-history-btn">同步 GitHub 历史</button>
            <p class="empty-hint">换设备后可从已入库的 md 恢复最近历史</p>
          </li>`;
        historyList.querySelector('.sync-history-btn')?.addEventListener('click', syncGithubHistory);
        return;
      }
      for (const item of history) {
        historyList.appendChild(renderHistoryItem(item));
      }
    } catch (e) {
      console.error(e);
      historyList.innerHTML = `<li class="empty-state"><p>加载失败</p></li>`;
    }
  }

  function renderHistoryItem(item) {
    const li = document.createElement('li');
    li.className = 'list-item';

    const diff = Date.now() - (item.timestamp || 0);
    let timeStr = '刚刚';
    if (diff > 60000) timeStr = Math.floor(diff / 60000) + 'm';
    if (diff > 3600000) timeStr = Math.floor(diff / 3600000) + 'h';
    if (diff > 86400000) timeStr = Math.floor(diff / 86400000) + 'd';

    let domain = 'Web';
    try { domain = new URL(item.originalUrl).hostname.replace('www.', ''); } catch {}

    const typeIcon = item.type === 'bilibili' ? '📺' : item.type === 'pdf' ? '📄' : '📰';
    const aiBadge = item.aiSummary ? '<span class="badge-ai">✨ AI</span>' : '';

    li.innerHTML = `
      <div class="item-content">
        <div class="item-title">
          <span class="type-icon">${typeIcon}</span>
          <span class="text-truncate">${escapeHtml(item.title || '无标题')}</span>
        </div>
        <div class="item-meta">
          <span>${timeStr}</span>
          <div class="divider-vertical" style="height:10px;"></div>
          ${aiBadge}
          <span class="badge-source">${escapeHtml(domain)}</span>
        </div>
      </div>
      <div class="item-actions">
        <button class="action-btn open-gh" title="在 GitHub 查看">🐙</button>
        <button class="action-btn copy-oss" title="复制 OSS 链接">🔗</button>
        <button class="action-btn delete" title="从历史删除">✕</button>
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn')) return;
      const url = item.ossUrl || item.githubUrl || item.originalUrl;
      if (url) chrome.tabs.create({ url });
    });

    li.querySelector('.open-gh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.githubUrl) chrome.tabs.create({ url: item.githubUrl });
    });

    li.querySelector('.copy-oss')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = item.ossUrl || item.githubUrl || '';
      if (text) {
        navigator.clipboard.writeText(text);
        const btn = e.currentTarget;
        const oldText = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = oldText; }, 1500);
      }
    });

    li.querySelector('.delete')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('从本地历史删除？\n（GitHub 仓库里的 md 文件不会被删）')) return;
      const data = await chrome.storage.local.get('history');
      const history = (data.history || []).filter(h => h.timestamp !== item.timestamp);
      await chrome.storage.local.set({ history });
    });

    return li;
  }

  function syncGithubHistory(e) {
    const button = e.currentTarget;
    const item = button.closest('.empty-state');
    const hint = item?.querySelector('.empty-hint');
    button.disabled = true;
    button.textContent = '同步中...';
    if (hint) hint.textContent = '正在从 GitHub 扫描剪藏记录';

    chrome.runtime.sendMessage({ action: 'sync_github_history' }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      button.disabled = false;
      button.textContent = '同步 GitHub 历史';

      if (runtimeError) {
        if (hint) hint.textContent = runtimeError.message || '同步失败';
        return;
      }

      if (response && response.success) {
        if (response.count > 0) {
          if (hint) hint.textContent = `已恢复 ${response.count} 条记录`;
          loadHistory();
        } else if (hint) {
          hint.textContent = 'GitHub 暂无可恢复的新记录';
        }
      } else if (hint) {
        hint.textContent = response?.error || '同步失败，请到管理后台检查配置';
      }
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
});
