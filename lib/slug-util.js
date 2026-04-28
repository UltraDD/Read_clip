/**
 * slug-util.js
 *
 * 把任意中英文标题转成可作 markdown 文件名的 slug。
 *
 * 设计目标：
 *   - 中文保留（GitHub / Obsidian / Windows / macOS 都能正常处理 UTF-8 文件名）
 *   - 去掉 Windows 不允许的 9 个保留字符 \ / : * ? " < > |
 *   - 去掉控制字符与首尾空白点
 *   - 多空格折叠成单空格再换成中划线
 *   - 长度封顶 60（够认人，不挤路径）
 *
 * 注意：跨平台一致性优先，所以中文不转拼音——拼音库太重、且会丢语义。
 */
(function () {
  const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
  const COLLAPSE_WS = /\s+/g;
  const TRIM_PUNCT = /^[\s\-_.·、，。；：!?]+|[\s\-_.·、，。；：!?]+$/g;
  const MAX_LEN = 60;

  function slugify(title) {
    if (!title) return 'untitled';
    let s = String(title).replace(ILLEGAL, '');
    s = s.replace(COLLAPSE_WS, ' ').trim();
    s = s.replace(/\s/g, '-');
    s = s.replace(TRIM_PUNCT, '');
    if (!s) return 'untitled';
    // UTF-16 字符截断；中文字符各占一格够直观
    if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
    return s;
  }

  function todayStamp() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function buildFilename(title, ext = 'md') {
    return `${todayStamp()}-${slugify(title)}.${ext}`;
  }

  self.SlugUtil = { slugify, todayStamp, buildFilename };
})();
