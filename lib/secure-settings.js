/**
 * secure-settings.js  (Read_clip 重写版)
 *
 * 用主密码加密存储所有第三方凭据。复用原 Read_Add 的密码体系（secure-crypto + 三层存储：
 *   sync(加密) / session(明文缓存) / local(rememberMe 30 天)），换掉 Notion 字段。
 *
 * 字段：
 *   - github_owner / github_repo / github_branch / github_token
 *       预填 "UltraDD" / "My_life" / "main"，token 由用户填
 *   - github_path_article / github_path_media / github_path_pdf
 *       预填 "reading/articles" / "reading/media" / "reading/articles"
 *   - deepseek_api_key / deepseek_model
 *       model 默认 "deepseek-chat"
 *   - oss_region / oss_bucket / oss_ak / oss_sk
 *       图片仍走阿里云 OSS（保留原能力）
 *   - lastSavedAt
 *
 * 校验规则：github_owner / github_repo / github_token 必填（GitHub push 是主轴，缺了走不通）。
 *   OSS 全空允许（降级为不传图，正文图片用原始外链）。
 *   DeepSeek key 空允许（降级为不生成 AI 速览，md 标注"未生成"）。
 */
(function () {
  const SYNC_KEY = 'secureSettings';
  const SESSION_KEY = 'decryptedSettings';
  const SESSION_META_KEY = 'decryptedSettingsMeta';
  const LOCAL_REMEMBER_KEY = 'rememberMeSession';
  const REMEMBER_DAYS = 30;

  const DEFAULTS = {
    github_owner: 'UltraDD',
    github_repo: 'My_life',
    github_branch: 'main',
    github_path_article: 'reading/articles',
    github_path_media: 'reading/media',
    github_path_pdf: 'reading/articles',
    deepseek_model: 'deepseek-v4-flash',
    oss_region: 'oss-cn-guangzhou',
    oss_bucket: 'read-clip'
  };

  /**
   * 从项目根目录的 config.json 读取配置（如果存在）
   */
  async function loadLocalConfigFile() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {
      // 找不到或读取失败很正常，直接返回 null
    }
    return null;
  }

  function normalizeSettings(s, localConfig = null) {
    s = s || {};
    const lc = localConfig || {};
    const out = {
      github_owner: (s.github_owner ?? lc.github_owner ?? DEFAULTS.github_owner).trim(),
      github_repo: (s.github_repo ?? lc.github_repo ?? DEFAULTS.github_repo).trim(),
      github_branch: (s.github_branch ?? lc.github_branch ?? DEFAULTS.github_branch).trim(),
      github_token: (s.github_token || lc.github_token || '').trim(),
      github_path_article: (s.github_path_article ?? lc.github_path_article ?? DEFAULTS.github_path_article).trim(),
      github_path_media: (s.github_path_media ?? lc.github_path_media ?? DEFAULTS.github_path_media).trim(),
      github_path_pdf: (s.github_path_pdf ?? lc.github_path_pdf ?? DEFAULTS.github_path_pdf).trim(),

      deepseek_api_key: (s.deepseek_api_key || lc.deepseek_api_key || '').trim(),
      deepseek_model: (s.deepseek_model ?? lc.deepseek_model ?? DEFAULTS.deepseek_model).trim(),

      oss_region: (s.oss_region ?? lc.oss_region ?? DEFAULTS.oss_region).trim(),
      oss_bucket: (s.oss_bucket ?? lc.oss_bucket ?? DEFAULTS.oss_bucket).trim(),
      oss_ak: (s.oss_ak || lc.oss_ak || '').trim(),
      oss_sk: (s.oss_sk || lc.oss_sk || '').trim(),

      lastSavedAt: s.lastSavedAt || null
    };

    // 自动纠偏：将旧的 deepseek-chat 迁移到最新的 flash 模型
    if (out.deepseek_model === 'deepseek-chat') {
      out.deepseek_model = 'deepseek-v4-flash';
    }

    return out;
  }

  function validateSettings(s) {
    if (!s.github_owner || !s.github_repo) {
      throw new Error('GitHub owner / repo 不能为空');
    }
    if (!s.github_token) {
      throw new Error('GitHub Token 不能为空（fine-grained PAT，contents:write 权限）');
    }
  }

  async function emptyDraft() {
    const localConfig = await loadLocalConfigFile();
    return normalizeSettings({}, localConfig);
  }

  async function hasEncrypted() {
    const data = await chrome.storage.sync.get(SYNC_KEY);
    return !!data[SYNC_KEY];
  }

  async function getEncrypted() {
    const data = await chrome.storage.sync.get(SYNC_KEY);
    return data[SYNC_KEY] || null;
  }

  async function lock() {
    await chrome.storage.session.remove([SESSION_KEY, SESSION_META_KEY]);
  }

  async function logout() {
    await chrome.storage.session.remove([SESSION_KEY, SESSION_META_KEY]);
    await chrome.storage.local.remove([LOCAL_REMEMBER_KEY]);
  }

  async function setSession(plainSettings) {
    await chrome.storage.session.set({
      [SESSION_KEY]: plainSettings,
      [SESSION_META_KEY]: { unlockedAt: Date.now() }
    });
  }

  async function hashPassphrase(passphrase) {
    const encoder = new TextEncoder();
    const data = encoder.encode(passphrase + '_read_clip_salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function saveRememberMe(passphrase, plainSettings) {
    const expireAt = Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000;
    const rememberData = {
      settings: plainSettings,
      passphrase,
      passHash: await hashPassphrase(passphrase),
      expireAt,
      createdAt: Date.now()
    };
    await chrome.storage.local.set({ [LOCAL_REMEMBER_KEY]: rememberData });
  }

  async function tryRestoreFromRememberMe() {
    try {
      const data = await chrome.storage.local.get(LOCAL_REMEMBER_KEY);
      const remember = data[LOCAL_REMEMBER_KEY];
      if (!remember) return null;
      if (Date.now() > remember.expireAt) {
        await chrome.storage.local.remove([LOCAL_REMEMBER_KEY]);
        return null;
      }
      if (remember.passphrase) {
        try {
          const encrypted = await getEncrypted();
          if (encrypted) {
            const plain = await self.SecureCrypto.decryptJson(remember.passphrase, encrypted);
            const localConfig = await loadLocalConfigFile();
            const normalized = normalizeSettings(plain, localConfig);
            await setSession(normalized);
            remember.settings = normalized;
            await chrome.storage.local.set({ [LOCAL_REMEMBER_KEY]: remember });
            return normalized;
          }
        } catch (e) {
          console.warn('[SecureSettings] 从云端同步失败，使用本地缓存:', e);
        }
      }
      const settings = remember.settings;
      if (settings && settings.github_token) {
        await setSession(settings);
        return settings;
      }
    } catch (e) {
      console.warn('[SecureSettings] 恢复记住我失败:', e);
    }
    return null;
  }

  async function getRememberMeStatus() {
    const data = await chrome.storage.local.get(LOCAL_REMEMBER_KEY);
    const remember = data[LOCAL_REMEMBER_KEY];
    if (!remember) return null;
    const isExpired = Date.now() > remember.expireAt;
    const daysLeft = Math.ceil((remember.expireAt - Date.now()) / (24 * 60 * 60 * 1000));
    return {
      isExpired,
      daysLeft: isExpired ? 0 : daysLeft,
      expireAt: remember.expireAt,
      createdAt: remember.createdAt
    };
  }

  async function getSession() {
    const data = await chrome.storage.session.get(SESSION_KEY);
    return data[SESSION_KEY] || null;
  }

  async function requireSession() {
    let s = await getSession();
    if (s) return s;
    s = await tryRestoreFromRememberMe();
    if (s) return s;
    throw new Error('配置未解锁：请打开管理后台输入主密码解锁');
  }

  async function unlock(passphrase, rememberMe = false) {
    if (!passphrase) throw new Error('请输入主密码');
    const encrypted = await getEncrypted();
    if (!encrypted) throw new Error('未找到云端加密配置：请先保存一次配置');
    const plain = await self.SecureCrypto.decryptJson(passphrase, encrypted);
    const localConfig = await loadLocalConfigFile();
    const normalized = normalizeSettings(plain, localConfig);
    validateSettings(normalized);
    await setSession(normalized);
    if (rememberMe) await saveRememberMe(passphrase, normalized);
    return normalized;
  }

  async function save(passphrase, settingsObj, rememberMe = false) {
    if (!passphrase) throw new Error('请输入主密码');
    settingsObj.lastSavedAt = Date.now();
    const localConfig = await loadLocalConfigFile();
    const normalized = normalizeSettings(settingsObj, localConfig);
    validateSettings(normalized);
    const encrypted = await self.SecureCrypto.encryptJson(passphrase, normalized);
    await chrome.storage.sync.set({ [SYNC_KEY]: encrypted });
    await setSession(normalized);
    if (rememberMe) await saveRememberMe(passphrase, normalized);
    return normalized;
  }

  // 监听跨设备 sync 变更
  try {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'sync' || !changes[SYNC_KEY] || !changes[SYNC_KEY].newValue) return;
      try {
        const localData = await chrome.storage.local.get(LOCAL_REMEMBER_KEY);
        const remember = localData[LOCAL_REMEMBER_KEY];
        if (!remember || !remember.passphrase) return;
        if (Date.now() > remember.expireAt) return;

        const encrypted = changes[SYNC_KEY].newValue;
        const plain = await self.SecureCrypto.decryptJson(remember.passphrase, encrypted);
        const localConfig = await loadLocalConfigFile();
        const normalized = normalizeSettings(plain, localConfig);
        await setSession(normalized);
        remember.settings = normalized;
        await chrome.storage.local.set({ [LOCAL_REMEMBER_KEY]: remember });
        console.log('[SecureSettings] 云端配置已自动同步');
      } catch (e) {
        console.warn('[SecureSettings] 自动同步云端配置失败:', e);
      }
    });
  } catch {
    // 某些上下文不支持
  }

  self.SecureSettings = {
    DEFAULTS,
    emptyDraft,
    hasEncrypted,
    getEncrypted,
    getSession,
    requireSession,
    unlock,
    save,
    lock,
    logout,
    tryRestoreFromRememberMe,
    getRememberMeStatus,
    _keys: { SYNC_KEY, SESSION_KEY, LOCAL_REMEMBER_KEY }
  };
})();
