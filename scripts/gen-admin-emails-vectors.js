#!/usr/bin/env node
/**
 * 生成 `doc/vectors/admin-emails-v1.json` —— **多管理员邮箱**契约的跨语言固定向量。
 *
 * 契约要点（唯一事实来源是 `doc/admin_emails.md`）：
 *   - `admin_emails`：JSON 数组字符串，元素为邮箱；写入路径**严格**校验（最多 10 个，
 *     每个 trim + 小写 + 去重），读取路径**宽容**（坏值→[]，非法邮箱/非字符串项丢弃）；
 *   - `admin_email`：旧键，仅在 `admin_emails` 解析为空时作为回落（单元素列表）；
 *   - `notify_email`：通知收件地址，归一化后必须命中管理员列表，否则回落到列表第一个。
 *
 * 三端（Node / Go / Worker）必须逐条一致：博主特权判定、通知收件人都读同一份口径，
 * 任何一端把「大小写」或「空白」处理得不一样，就会出现「面板里是管理员、评论时不是」。
 *
 * 运行：`node scripts/gen-admin-emails-vectors.js`（纯 Node，零依赖）。
 */

const fs = require('fs');
const path = require('path');

const MAX_ADMIN_EMAILS = 10;
const MAX_EMAIL_LENGTH = 254;
/**
 * 与三端实现一致：不做 RFC 5322 全量解析，只挡明显非法形态。
 * 刻意不用 `[^\s@]` 这种宽松写法（`<a@b.com>` 会漏过去），也不接受无 TLD 的 `a@b`。
 * 校验前一律 `trim`，因此行尾换行不算非法（会被裁掉）。
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const ERRORS = {
  notArray: 'admin_emails 必须是 JSON 数组',
  notString: 'admin_emails 的每一项都必须是字符串',
  tooMany: `admin_emails 最多 ${MAX_ADMIN_EMAILS} 个邮箱`,
  badEmail: 'admin_emails 包含非法邮箱地址',
  badNotify: 'notify_email 必须是合法的邮箱地址',
  notifyNotInList: 'notify_email 必须在管理员邮箱列表中',
};

function isEmail(value) {
  const email = String(value ?? '').trim();
  if (email === '' || email.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_RE.test(email);
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 读取路径：宽容解析（坏值→[]，丢弃非法项，去重保序，最多 10 个） */
function parseAdminEmails(raw) {
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
  const result = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const email = normalizeEmail(item);
    if (!isEmail(email)) continue;
    if (result.includes(email)) continue;
    result.push(email);
    if (result.length >= MAX_ADMIN_EMAILS) break;
  }
  return result;
}

/** 写入路径：严格校验（返回错误文案 key 或 null） */
function checkWrite(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null;
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
  const emails = parsed.map((item) => normalizeEmail(item)).filter((item) => item !== '');
  if (emails.length > MAX_ADMIN_EMAILS) return 'tooMany';
  for (const email of emails) {
    if (!isEmail(email)) return 'badEmail';
  }
  return null;
}

/** 写入路径：归一化（trim + 小写 + 去重，存回 JSON 数组字符串） */
function normalizeWrite(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '[]';
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return '[]';
    const emails = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const email = normalizeEmail(item);
      if (email === '' || emails.includes(email)) continue;
      emails.push(email);
    }
    return JSON.stringify(emails);
  } catch {
    return '[]';
  }
}

/** 读取路径：管理员列表（数组为空时回落到旧的单邮箱键） */
function resolveAdminEmails(storedAdmins, legacyAdmin) {
  const admins = parseAdminEmails(storedAdmins);
  if (admins.length > 0) return admins;
  const legacy = normalizeEmail(legacyAdmin);
  return isEmail(legacy) ? [legacy] : [];
}

/** 读取路径：通知收件人（必须命中列表，否则回落到第一个；列表为空则空串） */
function resolveNotifyEmail(storedNotify, storedAdmins, legacyAdmin) {
  const admins = resolveAdminEmails(storedAdmins, legacyAdmin);
  if (admins.length === 0) return '';
  const notify = normalizeEmail(storedNotify);
  return admins.includes(notify) ? notify : admins[0];
}

const elevenEmails = Array.from({ length: MAX_ADMIN_EMAILS + 1 }, (_, index) => `admin${index + 1}@example.com`);
const tenEmails = elevenEmails.slice(0, MAX_ADMIN_EMAILS);

const fixture = {
  version: 1,
  note:
    '多管理员邮箱契约 v1：admin_emails（JSON 数组，最多 10 个，trim + 小写 + 去重）为权威列表，' +
    'admin_email 仅在列表为空时回落，notify_email 必须命中列表否则回落到第一个。' +
    '写入校验（六条错误文案）与读取归一化三端必须逐条一致。' +
    '由 scripts/gen-admin-emails-vectors.js 生成，请勿手改。',
  limits: {
    maxAdminEmails: MAX_ADMIN_EMAILS,
    maxEmailLen: MAX_EMAIL_LENGTH,
  },
  errors: ERRORS,
  email: {
    valid: [
      'a@b.com',
      '  A@B.COM  ',
      'user.name+tag@sub.example.co',
      'x@y.io',
      'ADMIN@EXAMPLE.COM',
    ],
    invalid: [
      '',
      '   ',
      'abc',
      'a@b',
      'a b@c.com',
      '@b.com',
      'a@',
      'a@@b.com',
      'a@b@c.com',
      '<a@b.com>',
      'a@b.c',
      'a@b..com',
      `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`,
    ],
  },
  parse: [
    { name: '未配置', stored: '', expect: [] },
    { name: '空白', stored: '   ', expect: [] },
    { name: '空数组', stored: '[]', expect: [] },
    {
      name: 'trim + 小写 + 去重保序',
      stored: '["  A@X.com ", "b@y.com", "a@x.com"]',
      expect: ['a@x.com', 'b@y.com'],
    },
    { name: '坏 JSON 容错为空', stored: '{oops', expect: [] },
    { name: '非数组容错为空', stored: '"a@b.com"', expect: [] },
    { name: '非字符串项丢弃', stored: '["a@b.com", 1, null]', expect: ['a@b.com'] },
    { name: '非法邮箱丢弃', stored: '["a@b.com", "nope", "c@d.com"]', expect: ['a@b.com', 'c@d.com'] },
    { name: `超过 ${MAX_ADMIN_EMAILS} 个只取前 ${MAX_ADMIN_EMAILS} 个`, stored: JSON.stringify(elevenEmails), expect: tenEmails },
  ],
  resolve: [
    {
      name: '列表与通知邮箱都配好',
      storedAdmins: '["a@x.com","b@y.com"]',
      legacyAdmin: '',
      storedNotify: 'b@y.com',
      expectAdmins: ['a@x.com', 'b@y.com'],
      expectNotify: 'b@y.com',
    },
    {
      name: '通知邮箱大小写/空格归一后命中',
      storedAdmins: '["a@x.com","b@y.com"]',
      legacyAdmin: '',
      storedNotify: '  B@Y.COM  ',
      expectAdmins: ['a@x.com', 'b@y.com'],
      expectNotify: 'b@y.com',
    },
    {
      name: '通知邮箱不在列表：回落到第一个',
      storedAdmins: '["a@x.com","b@y.com"]',
      legacyAdmin: '',
      storedNotify: 'c@z.com',
      expectAdmins: ['a@x.com', 'b@y.com'],
      expectNotify: 'a@x.com',
    },
    {
      name: '通知邮箱为空：回落到第一个',
      storedAdmins: '["a@x.com","b@y.com"]',
      legacyAdmin: '',
      storedNotify: '',
      expectAdmins: ['a@x.com', 'b@y.com'],
      expectNotify: 'a@x.com',
    },
    {
      name: '列表为空：回落到旧的单邮箱键',
      storedAdmins: '[]',
      legacyAdmin: 'Old@X.com',
      storedNotify: '',
      expectAdmins: ['old@x.com'],
      expectNotify: 'old@x.com',
    },
    {
      name: '列表与旧键都为空：没有管理员、没有收件人',
      storedAdmins: '',
      legacyAdmin: '',
      storedNotify: 'a@x.com',
      expectAdmins: [],
      expectNotify: '',
    },
    {
      name: '旧键是非法邮箱：视为未配置',
      storedAdmins: 'not json',
      legacyAdmin: 'nope',
      storedNotify: '',
      expectAdmins: [],
      expectNotify: '',
    },
  ],
};

// ---- 自检 ----
if (elevenEmails.length !== MAX_ADMIN_EMAILS + 1) throw new Error('elevenEmails 长度错误');
for (const value of fixture.email.valid) {
  if (!isEmail(value)) throw new Error(`email.valid 里的值不合法：${JSON.stringify(value)}`);
}
for (const value of fixture.email.invalid) {
  if (isEmail(value)) throw new Error(`email.invalid 里的值合法：${JSON.stringify(value)}`);
}
for (const item of fixture.parse) {
  const got = parseAdminEmails(item.stored);
  if (JSON.stringify(got) !== JSON.stringify(item.expect)) {
    throw new Error(`parse 用例「${item.name}」期望 ${JSON.stringify(item.expect)}，实际 ${JSON.stringify(got)}`);
  }
}
for (const item of fixture.resolve) {
  const admins = resolveAdminEmails(item.storedAdmins, item.legacyAdmin);
  const notify = resolveNotifyEmail(item.storedNotify, item.storedAdmins, item.legacyAdmin);
  if (JSON.stringify(admins) !== JSON.stringify(item.expectAdmins) || notify !== item.expectNotify) {
    throw new Error(
      `resolve 用例「${item.name}」期望 ${JSON.stringify(item.expectAdmins)}/${item.expectNotify}，` +
        `实际 ${JSON.stringify(admins)}/${notify}`
    );
  }
}

const outputPath = path.resolve(__dirname, '..', 'doc', 'vectors', 'admin-emails-v1.json');
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`写入 ${outputPath}`);
console.log(`  limits : maxAdminEmails=${MAX_ADMIN_EMAILS} maxEmailLen=${MAX_EMAIL_LENGTH}`);
console.log(`  parse  : ${fixture.parse.length} 个用例`);
console.log(`  resolve: ${fixture.resolve.length} 个用例`);
console.log(`  errors : ${Object.keys(ERRORS).length} 条文案`);
