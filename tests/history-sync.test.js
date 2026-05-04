const assert = require('node:assert/strict');
const test = require('node:test');

const HistorySync = require('../lib/history-sync.js');

test('WHEN_settings_have_duplicate_paths_THEN_normalize_to_unique_non_empty_roots', () => {
  assert.deepEqual(
    HistorySync.normalizeHistoryPaths({
      github_path_article: 'reading/articles',
      github_path_media: 'reading/media',
      github_path_pdf: 'reading/articles'
    }),
    ['reading/articles', 'reading/media']
  );
});

test('WHEN_markdown_has_frontmatter_THEN_parse_history_entry', () => {
  const md = [
    '---',
    'title: "A quoted title"',
    'source: "bilibili"',
    'url: "https://www.bilibili.com/video/BV123"',
    'captured_at: "2026-05-04T10:00:00+08:00"',
    'oss_html: "https://example.com/backup.html"',
    '---',
    '',
    '## AI 速览',
    '',
    'One useful sentence.',
    '',
    '---',
    '',
    '## 原文',
    '',
    'Body'
  ].join('\n');

  assert.deepEqual(
    HistorySync.parseMarkdownEntry(md, 'reading/media/2026-05-04-a.md', 'https://github.com/x/y/blob/main/a.md'),
    {
      title: 'A quoted title',
      originalUrl: 'https://www.bilibili.com/video/BV123',
      ossUrl: 'https://example.com/backup.html',
      githubUrl: 'https://github.com/x/y/blob/main/a.md',
      githubPath: 'reading/media/2026-05-04-a.md',
      timestamp: new Date('2026-05-04T10:00:00+08:00').getTime(),
      type: 'bilibili',
      aiSummary: 'One useful sentence.',
      source: 'bilibili'
    }
  );
});

test('WHEN_ai_summary_is_failure_quote_THEN_omit_ai_summary', () => {
  const md = [
    '---',
    'title: "PDF note"',
    'source: "pdf"',
    'captured_at: "2026-05-04T10:00:00+08:00"',
    '---',
    '',
    '## AI 速览',
    '',
    '> AI 总结生成失败：boom',
    '',
    '---'
  ].join('\r\n');

  const entry = HistorySync.parseMarkdownEntry(md, 'reading/articles/pdf-note.md', '');
  assert.equal(entry.type, 'pdf');
  assert.equal(entry.aiSummary, null);
});

test('WHEN_github_roots_contain_date_directories_THEN_collect_markdown_files_recursively', async () => {
  const listings = {
    'reading/articles': [
      { type: 'dir', name: '2026-05', path: 'reading/articles/2026-05' },
      { type: 'file', name: 'root.md', path: 'reading/articles/root.md', html_url: 'root-url' }
    ],
    'reading/articles/2026-05': [
      { type: 'file', name: 'new.md', path: 'reading/articles/2026-05/new.md', html_url: 'new-url' },
      { type: 'file', name: 'ignore.txt', path: 'reading/articles/2026-05/ignore.txt', html_url: 'txt-url' }
    ]
  };
  const calls = [];
  const githubClient = {
    async listDirectory({ path }) {
      calls.push(path);
      return listings[path] || [];
    }
  };

  const files = await HistorySync.collectMarkdownFiles({
    githubClient,
    githubOptions: {},
    roots: ['reading/articles'],
    maxFiles: 10
  });

  assert.deepEqual(calls, ['reading/articles', 'reading/articles/2026-05']);
  assert.deepEqual(files.map((file) => file.path), [
    'reading/articles/2026-05/new.md',
    'reading/articles/root.md'
  ]);
});

test('WHEN_merging_history_THEN_dedupe_sort_and_trim', () => {
  const merged = HistorySync.mergeHistory(
    [
      { githubPath: 'old.md', timestamp: 1 },
      { githubPath: 'same.md', timestamp: 2 }
    ],
    [
      { githubPath: 'same.md', timestamp: 3 },
      { githubPath: 'new.md', timestamp: 4 }
    ],
    2
  );

  assert.deepEqual(merged.map((entry) => entry.githubPath), ['same.md', 'new.md']);
  assert.equal(merged[0].timestamp, 2);
});
