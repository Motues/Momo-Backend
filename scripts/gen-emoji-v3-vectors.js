#!/usr/bin/env node
/**
 * 生成 `doc/vectors/emoji-v3.json` —— 表情**多来源**契约（v3）的跨语言固定向量。
 *
 * 契约 v3 在 v2 的两个键之上只增加一个键：
 *   - `emoji_cdn_urls`：JSON 数组字符串，一行一个 OwO 地址（最多 5 个），按顺序拼接合并；
 *   - 旧的 `emoji_cdn_url`（单地址）**继续兼容**：仅在 `emoji_cdn_urls` 解析为空时作为回落；
 *   - `emoji_enabled` 语义与 v2 完全相同（空/未知 fail-open 为启用）。
 *
 * v2 的 `emoji-v2.json` 保持不动（它钉死的是单地址键的语义，至今仍然有效）；
 * 这份 fixture 只钉死**新增部分**：数组键的写入校验、读取归一化（含回落与截断）、
 * 以及三端必须逐字一致的五条错误文案。
 *
 * 运行：`node scripts/gen-emoji-v3-vectors.js`（纯 Node，零依赖）。
 * 生成口径在脚本里**独立复算**，不调用任何实现内部函数，因此它同时是一次独立复核。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CDN_URL = 'https://open.motues.top/emoji/owo.json';
const MAX_CDN_URL_LENGTH = 500;
const MAX_CDN_URLS = 5;

/** 用于边界用例的长地址：`https://cdn.example.com/` + 若干个 a，总长恰好 len */
const LONG_PREFIX = 'https://cdn.example.com/';
const longUrl = (len) => LONG_PREFIX + 'a'.repeat(len - LONG_PREFIX.length);

if (longUrl(MAX_CDN_URL_LENGTH).length !== MAX_CDN_URL_LENGTH) {
  throw new Error('longUrl 长度计算错误');
}

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;
const codePointLength = (value) => [...String(value)].length;

/** 三端共用的五条错误文案（写入路径） */
const ERRORS = {
  notArray: 'emoji_cdn_urls 必须是 JSON 数组',
  notString: 'emoji_cdn_urls 的每一项都必须是字符串',
  tooMany: `emoji_cdn_urls 最多 ${MAX_CDN_URLS} 个地址`,
  badScheme: 'emoji_cdn_urls 只允许 http/https 地址',
  tooLong: `emoji_cdn_urls 不能超过 ${MAX_CDN_URL_LENGTH} 个字符`,
};

// ---- 写入路径：严格校验（返回错误文案 key 或 null） ----
function checkWrite(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null; // 空串 = 未配置

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'notArray';
  }
  if (!Array.isArray(parsed)) return 'notArray';
  for (const item of parsed) {
    if (typeof item !== 'string') return 'notString';
  }
  const urls = parsed.map((item) => item.trim()).filter((item) => item !== '');
  if (urls.length > MAX_CDN_URLS) return 'tooMany';
  for (const url of urls) {
    if (codePointLength(url) > MAX_CDN_URL_LENGTH) return 'tooLong';
    if (!CDN_URL_RE.test(url)) return 'badScheme';
  }
  return null;
}

// ---- 写入路径：归一化（trim + 去空，存回 JSON 数组字符串） ----
function normalizeWrite(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '[]';
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return '[]';
    const urls = parsed
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return JSON.stringify(urls);
  } catch {
    return '[]';
  }
}

// ---- 读取路径：宽容解析（坏值→[]，非字符串丢弃，去空，最多 5 个） ----
function parseRead(raw) {
  if (raw === null || raw === undefined) return [];
  const text = String(raw).trim();
  if (text === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, MAX_CDN_URLS);
}

// ---- 读取路径：归一化（urls 为空时回落到旧的单地址键，再回落到默认源） ----
function resolve(storedUrls, storedCdnUrl, storedEnabled) {
  let urls = parseRead(storedUrls);
  if (urls.length === 0) {
    const legacy = String(storedCdnUrl ?? '').trim();
    urls = legacy === '' ? [DEFAULT_CDN_URL] : [legacy];
  }
  const enabled = String(storedEnabled ?? '').trim().toLowerCase() === 'false' ? 'false' : 'true';
  return { urls, enabled };
}

const fiveUrls = [
  'https://a.example.com/owo.json',
  'https://b.example.com/owo.json?group=Emoji',
  'http://c.example.com/owo.json',
  'https://d.example.com/owo.json',
  'https://e.example.com/owo.json',
];
const sixUrls = [...fiveUrls, 'https://f.example.com/owo.json'];
if (fiveUrls.length !== MAX_CDN_URLS) throw new Error('fiveUrls 长度错误');

const fixture = {
  version: 3,
  note:
    '表情多来源契约 v3：新增 emoji_cdn_urls（JSON 数组，最多 5 个地址，按顺序拼接合并），' +
    '旧 emoji_cdn_url 仅在数组为空时作为回落。' +
    'constants / 写入校验（五条错误文案）/ 读取归一化（回落、容错、截断）三端必须逐条一致。' +
    '由 scripts/gen-emoji-v3-vectors.js 生成，请勿手改。',
  defaults: {
    cdnUrl: DEFAULT_CDN_URL,
    enabled: 'true',
  },
  limits: {
    maxCdnUrlLen: MAX_CDN_URL_LENGTH,
    maxCdnUrls: MAX_CDN_URLS,
  },
  errors: ERRORS,
  cdnUrls: {
    valid: [
      { value: '', expect: [] },
      { value: '   ', expect: [] },
      { value: null, expect: [] },
      { value: '[]', expect: [] },
      { value: '["", "   "]', expect: [] },
      { value: '["  https://a.example.com/owo.json  "]', expect: ['https://a.example.com/owo.json'] },
      {
        value: '["https://a.example.com/owo.json", "", "https://b.example.com/owo.json?group=Emoji"]',
        expect: ['https://a.example.com/owo.json', 'https://b.example.com/owo.json?group=Emoji'],
      },
      { value: JSON.stringify(fiveUrls), expect: fiveUrls },
      { value: JSON.stringify([longUrl(MAX_CDN_URL_LENGTH)]), expect: [longUrl(MAX_CDN_URL_LENGTH)] },
      { value: JSON.stringify([DEFAULT_CDN_URL, 'http://example.com/owo.json']), expect: [DEFAULT_CDN_URL, 'http://example.com/owo.json'] },
    ],
    invalid: [
      { value: 'not json', error: 'notArray' },
      { value: '{}', error: 'notArray' },
      { value: '"https://a.example.com/owo.json"', error: 'notArray' },
      { value: '123', error: 'notArray' },
      { value: '[1]', error: 'notString' },
      { value: '["https://a.example.com/owo.json", null]', error: 'notString' },
      { value: JSON.stringify(sixUrls), error: 'tooMany' },
      { value: '["ftp://a.example.com/owo.json"]', error: 'badScheme' },
      { value: '["javascript:alert(1)"]', error: 'badScheme' },
      { value: '["owo.json"]', error: 'badScheme' },
      { value: '["//example.com/owo.json"]', error: 'badScheme' },
      { value: '["https://a.example.com/x\\"y.json"]', error: 'badScheme' },
      { value: '["<img src=x>"]', error: 'badScheme' },
      { value: JSON.stringify([longUrl(MAX_CDN_URL_LENGTH + 1)]), error: 'tooLong' },
    ],
  },
  // 读取归一化：resolve(storedUrls, storedCdnUrl, storedEnabled) → { urls, enabled }
  resolve: [
    {
      name: '三项都未配置：回落默认源 + 启用',
      storedUrls: '',
      storedCdnUrl: '',
      storedEnabled: '',
      expectUrls: [DEFAULT_CDN_URL],
      expectEnabled: 'true',
    },
    {
      name: '数组已配置：原样下发（两侧空格裁掉），旧的单地址键被忽略',
      storedUrls: '["  https://a.example.com/owo.json  ", "https://b.example.com/owo.json"]',
      storedCdnUrl: 'https://legacy.example.com/owo.json',
      storedEnabled: 'true',
      expectUrls: ['https://a.example.com/owo.json', 'https://b.example.com/owo.json'],
      expectEnabled: 'true',
    },
    {
      name: '数组为空：回落到旧的单地址键',
      storedUrls: '[]',
      storedCdnUrl: '  https://legacy.example.com/owo.json  ',
      storedEnabled: 'true',
      expectUrls: ['https://legacy.example.com/owo.json'],
      expectEnabled: 'true',
    },
    {
      name: '数组是脏值（非 JSON）：同样回落到旧的单地址键',
      storedUrls: 'not json',
      storedCdnUrl: 'https://legacy.example.com/owo.json',
      storedEnabled: 'true',
      expectUrls: ['https://legacy.example.com/owo.json'],
      expectEnabled: 'true',
    },
    {
      name: '数组非数组形状（对象）：回落',
      storedUrls: '{"a":1}',
      storedCdnUrl: '',
      storedEnabled: 'false',
      expectUrls: [DEFAULT_CDN_URL],
      expectEnabled: 'false',
    },
    {
      name: '读取宽容：非字符串项丢弃、空串丢弃、顺序保持',
      storedUrls: '["", 7, "https://a.example.com/owo.json", null, "  ", "https://b.example.com/owo.json"]',
      storedCdnUrl: 'https://legacy.example.com/owo.json',
      storedEnabled: 'yes',
      expectUrls: ['https://a.example.com/owo.json', 'https://b.example.com/owo.json'],
      expectEnabled: 'true',
    },
    {
      name: '读取宽容：超过 5 个只取前 5 个',
      storedUrls: JSON.stringify(sixUrls),
      storedCdnUrl: '',
      storedEnabled: 'true',
      expectUrls: fiveUrls,
      expectEnabled: 'true',
    },
    {
      name: '关闭时地址照常下发（面板不会丢掉配置）',
      storedUrls: '["https://a.example.com/owo.json"]',
      storedCdnUrl: '',
      storedEnabled: 'FALSE',
      expectUrls: ['https://a.example.com/owo.json'],
      expectEnabled: 'false',
    },
    {
      name: '空/空白开关 fail-open 为启用',
      storedUrls: '["https://a.example.com/owo.json"]',
      storedCdnUrl: '',
      storedEnabled: '   ',
      expectUrls: ['https://a.example.com/owo.json'],
      expectEnabled: 'true',
    },
  ],
};

// ---- 自检：独立复算一遍，避免 fixture 自己写错 ----
for (const item of fixture.cdnUrls.valid) {
  const error = checkWrite(item.value);
  if (error !== null) {
    throw new Error(`cdnUrls.valid 里的值被判定为非法：${JSON.stringify(item.value)} → ${error}`);
  }
  const got = parseRead(item.value);
  if (JSON.stringify(got) !== JSON.stringify(item.expect)) {
    throw new Error(
      `cdnUrls.valid 里的值解析结果不符：${JSON.stringify(item.value)} → ${JSON.stringify(got)}，期望 ${JSON.stringify(item.expect)}`
    );
  }
  const stored = normalizeWrite(item.value);
  if (JSON.stringify(parseRead(stored)) !== JSON.stringify(item.expect)) {
    throw new Error(`归一化后无法往返：${JSON.stringify(item.value)} → ${stored}`);
  }
}
for (const item of fixture.cdnUrls.invalid) {
  const error = checkWrite(item.value);
  if (error !== item.error) {
    throw new Error(
      `cdnUrls.invalid 里的值与期望错误不符：${JSON.stringify(item.value)} → ${error}，期望 ${item.error}`
    );
  }
}
for (const testCase of fixture.resolve) {
  const got = resolve(testCase.storedUrls, testCase.storedCdnUrl, testCase.storedEnabled);
  if (JSON.stringify(got.urls) !== JSON.stringify(testCase.expectUrls) || got.enabled !== testCase.expectEnabled) {
    throw new Error(
      `resolve 用例「${testCase.name}」期望 ${JSON.stringify(testCase.expectUrls)}/${testCase.expectEnabled}，` +
        `实际 ${JSON.stringify(got.urls)}/${got.enabled}`
    );
  }
}

const outputPath = path.resolve(__dirname, '..', 'doc', 'vectors', 'emoji-v3.json');
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`写入 ${outputPath}`);
console.log(`  limits     : maxCdnUrlLen=${MAX_CDN_URL_LENGTH} maxCdnUrls=${MAX_CDN_URLS}`);
console.log(`  cdnUrls    : valid=${fixture.cdnUrls.valid.length} invalid=${fixture.cdnUrls.invalid.length}`);
console.log(`  resolve    : ${fixture.resolve.length} 个用例`);
console.log(`  errors     : ${Object.keys(ERRORS).length} 条文案`);
