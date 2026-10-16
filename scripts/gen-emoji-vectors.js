#!/usr/bin/env node
/**
 * 生成 `doc/vectors/emoji-v2.json` —— 表情配置契约的跨语言固定向量。
 *
 * 契约 v2 起，自定义表情包（`emoji_packs`）与公开接口 `GET /api/emoji` 已下线，
 * 只剩下两个设置键：
 *   - `emoji_enabled`：`"true"` / `"false"`（缺省视为 `"true"`）
 *   - `emoji_cdn_url`：OwO 格式（owo.json 同构）的表情地址，缺省为默认源
 *
 * 这份 fixture 钉死三端（Node / Go / Worker）必须逐条一致的四处口径：
 *   1. `defaults` —— 默认源地址与默认开关值（常量必须与 fixture 相同）；
 *   2. `limits` —— `emoji_cdn_url` 的最大码点长度；
 *   3. `cdnUrl` / `enabled` —— 写入路径的校验（合法 / 非法取值）；
 *   4. `resolve` —— 读取路径的归一化（空 URL 回落默认源、空/未知开关回落启用、
 *      两侧空格被裁掉、关闭时地址照常下发）。
 *
 * 运行：`node scripts/gen-emoji-vectors.js`（纯 Node，不依赖任何依赖）。
 * 脚本会打印全部生成值，便于人工核对；生成口径在脚本里**独立复算**，
 * 不调用任何实现内部函数，因此它同时也是一次对实现口径的独立复核。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CDN_URL = 'https://open.motues.top/emoji/owo.json';
const MAX_CDN_URL_LENGTH = 500;

/** 用于边界用例的长地址：`https://cdn.example.com/` + 若干个 a，总长恰好 len */
const LONG_PREFIX = 'https://cdn.example.com/';
const longUrl = (len) => LONG_PREFIX + 'a'.repeat(len - LONG_PREFIX.length);

if (longUrl(MAX_CDN_URL_LENGTH).length !== MAX_CDN_URL_LENGTH) {
  throw new Error('longUrl 长度计算错误');
}

const fixture = {
  version: 2,
  note:
    '表情配置契约 v2：不再有自定义表情包，只有「是否启用 + OwO 格式的表情来源」。' +
    'constants（默认源 / 默认开关 / 长度上限）、写入路径校验与读取路径归一化三端必须逐条一致。' +
    '由 scripts/gen-emoji-vectors.js 生成，请勿手改。',
  defaults: {
    cdnUrl: DEFAULT_CDN_URL,
    enabled: 'true',
  },
  limits: {
    maxCdnUrlLen: MAX_CDN_URL_LENGTH,
  },
  // emoji_enabled：归一化（trim + 小写）后只允许 "" / "true" / "false"
  enabled: {
    valid: ['', '   ', 'true', 'false', ' true ', ' TRUE ', 'False'],
    invalid: ['1', '0', 'yes', 'on', 'true1', ' false1', 'true false', 'null', '2', '否'],
  },
  // emoji_cdn_url：空/空白表示「未配置」，其余必须是 http(s) 且不超过 500 码点
  cdnUrl: {
    valid: [
      DEFAULT_CDN_URL,
      `${DEFAULT_CDN_URL}?group=Emoji`,
      'http://example.com/owo.json',
      'HTTPS://Example.COM/OWO.JSON',
      'https://cdn.example.com/emoji/owo.json#frag',
      'https://子目录.example.com/emoji/owo.json',
      '  https://cdn.example.com/owo.json  ',
      '',
      '   ',
      longUrl(MAX_CDN_URL_LENGTH),
    ],
    invalid: [
      'ftp://example.com/owo.json',
      'javascript:alert(1)',
      'data:application/json,{}',
      'owo.json',
      '//example.com/owo.json',
      'https://cdn.example.com/a"b.json',
      'https://cdn.example.com/a<b>.json',
      '<img src=x>',
      longUrl(MAX_CDN_URL_LENGTH + 1),
    ],
  },
  // 读取路径归一化：resolveEmojiConfig(storedUrl, storedEnabled) → { url, enabled }
  resolve: [
    {
      name: '两项都未配置：回落默认源 + 启用',
      storedUrl: '',
      storedEnabled: '',
      expectUrl: DEFAULT_CDN_URL,
      expectEnabled: 'true',
    },
    {
      name: '地址只有空白：同样回落默认源',
      storedUrl: '   ',
      storedEnabled: '   ',
      expectUrl: DEFAULT_CDN_URL,
      expectEnabled: 'true',
    },
    {
      name: '地址两侧空格被裁掉，开关原样下发',
      storedUrl: '  https://cdn.example.com/owo.json  ',
      storedEnabled: 'true',
      expectUrl: 'https://cdn.example.com/owo.json',
      expectEnabled: 'true',
    },
    {
      name: '关闭时地址照常下发（面板不会丢掉配置）',
      storedUrl: 'https://cdn.example.com/owo.json?group=Emoji',
      storedEnabled: 'false',
      expectUrl: 'https://cdn.example.com/owo.json?group=Emoji',
      expectEnabled: 'false',
    },
    {
      name: '历史脏值大小写不敏感：FALSE 判为关闭',
      storedUrl: 'https://cdn.example.com/owo.json',
      storedEnabled: 'FALSE',
      expectUrl: 'https://cdn.example.com/owo.json',
      expectEnabled: 'false',
    },
    {
      name: '无法识别的开关值 fail-open 为启用',
      storedUrl: 'https://cdn.example.com/owo.json',
      storedEnabled: 'yes',
      expectUrl: 'https://cdn.example.com/owo.json',
      expectEnabled: 'true',
    },
  ],
};

/** 归一化：trim + 小写（三端写入路径共用同一口径） */
const normalizeEnabled = (value) => String(value ?? '').trim().toLowerCase();

// ---- 生成前的自检：独立复算一遍规则，避免 fixture 自己写错 ----
for (const value of fixture.enabled.valid) {
  const normalized = normalizeEnabled(value);
  if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
    throw new Error(`enabled.valid 里出现了非法值：${JSON.stringify(value)}`);
  }
}
for (const value of fixture.enabled.invalid) {
  const normalized = normalizeEnabled(value);
  if (normalized === '' || normalized === 'true' || normalized === 'false') {
    throw new Error(`enabled.invalid 里的值是合法的：${JSON.stringify(value)}`);
  }
}

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;
const codePointLength = (value) => [...String(value)].length;
const checkCdnUrl = (raw) => {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  if (codePointLength(value) > MAX_CDN_URL_LENGTH) return 'too-long';
  return CDN_URL_RE.test(value) ? '' : 'bad-scheme';
};
for (const value of fixture.cdnUrl.valid) {
  if (checkCdnUrl(value) !== '') throw new Error(`cdnUrl.valid 里的值不合法：${JSON.stringify(value)}`);
}
for (const value of fixture.cdnUrl.invalid) {
  if (checkCdnUrl(value) === '') throw new Error(`cdnUrl.invalid 里的值是合法的：${JSON.stringify(value)}`);
}

const resolve = (storedUrl, storedEnabled) => ({
  url: String(storedUrl ?? '').trim() || DEFAULT_CDN_URL,
  enabled: normalizeEnabled(storedEnabled) === 'false' ? 'false' : 'true',
});
for (const testCase of fixture.resolve) {
  const got = resolve(testCase.storedUrl, testCase.storedEnabled);
  if (got.url !== testCase.expectUrl || got.enabled !== testCase.expectEnabled) {
    throw new Error(
      `resolve 用例「${testCase.name}」期望 ${testCase.expectUrl}/${testCase.expectEnabled}，实际 ${got.url}/${got.enabled}`
    );
  }
}

const outputPath = path.resolve(__dirname, '..', 'doc', 'vectors', 'emoji-v2.json');
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`写入 ${outputPath}`);
console.log(`  defaults   : cdnUrl=${fixture.defaults.cdnUrl} enabled=${fixture.defaults.enabled}`);
console.log(`  limits     : maxCdnUrlLen=${fixture.limits.maxCdnUrlLen}`);
console.log(`  enabled    : valid=${fixture.enabled.valid.length} invalid=${fixture.enabled.invalid.length}`);
console.log(`  cdnUrl     : valid=${fixture.cdnUrl.valid.length} invalid=${fixture.cdnUrl.invalid.length}`);
console.log(`  resolve    : ${fixture.resolve.length} 个用例`);
console.log(`  边界长地址 : ${longUrl(MAX_CDN_URL_LENGTH).length} 码点（合法）`);
console.log(`               ${longUrl(MAX_CDN_URL_LENGTH + 1).length} 码点（非法）`);
