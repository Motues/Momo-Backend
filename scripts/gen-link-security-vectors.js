#!/usr/bin/env node
/**
 * 生成 `doc/vectors/link-security-v1.json` —— **链接安全审查（休眠链接）**契约的跨语言固定向量。
 *
 * 契约要点（唯一事实来源是 `doc/link_security.md`）：
 *   - `link_security_enabled` / `link_sync_enabled`：`"true"` / `"false"`，**fail-closed**
 *     （只有归一化后等于 `"true"` 才视为开启，其余一律按关闭处理 —— 与表情开关的 fail-open 刻意相反）；
 *   - `link_dormant_days`：1–3650 的整数，默认 30；读取时脏值回退默认、超上限夹取；
 *   - 休眠判定：功能开启 && 该评论有个人网址 && 该邮箱**最后一条评论**距今 **严格大于** N 天。
 *     判定输入是「最后评论时间」，因此同一位评论者再次评论会立刻自动解除休眠。
 *
 * 运行：`node scripts/gen-link-security-vectors.js`（纯 Node，零依赖）。
 */

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DORMANT_DAYS = 30;
const MIN_DORMANT_DAYS = 1;
const MAX_DORMANT_DAYS = 3650;

const KEYS = {
  securityEnabled: 'link_security_enabled',
  dormantDays: 'link_dormant_days',
  syncEnabled: 'link_sync_enabled',
  dormantNotice: 'link_dormant_notice_enabled',
};

const DEFAULT_DORMANT_NOTICE_ENABLED = 'false';

const ERRORS = {
  securityEnabled: `${KEYS.securityEnabled} 只能是 true 或 false`,
  syncEnabled: `${KEYS.syncEnabled} 只能是 true 或 false`,
  dormantNoticeEnabled: `${KEYS.dormantNotice} 只能是 true 或 false`,
  dormantDays: `${KEYS.dormantDays} 必须是 ${MIN_DORMANT_DAYS}-${MAX_DORMANT_DAYS} 之间的整数`,
};

/** 开关的写入校验：归一化后只允许 "" / "true" / "false" */
function validateSwitch(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '' || value === 'true' || value === 'false' ? null : 'bad';
}

/** 开关的读取归一化：fail-closed，只有 true 才算开启 */
function resolveSwitch(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'true' ? 'true' : 'false';
}

/** 天数的写入校验：1–3650 的整数 */
function validateDays(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return false;
  const value = Number(text);
  return value >= MIN_DORMANT_DAYS && value <= MAX_DORMANT_DAYS;
}

/** 天数的读取归一化：脏值回退默认、超上限夹取 */
function resolveDays(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return DEFAULT_DORMANT_DAYS;
  const value = Number(text);
  if (value < MIN_DORMANT_DAYS) return DEFAULT_DORMANT_DAYS;
  if (value > MAX_DORMANT_DAYS) return MAX_DORMANT_DAYS;
  return value;
}

/** 休眠判定：功能开启 && 有个人网址 && 最后评论距今严格大于 N 天 && 该链接未被人工确认 */
function isDormant({ enabled, hasUrl, days, ageMs, trusted }) {
  if (resolveSwitch(enabled) !== 'true') return false;
  if (trusted === true) return false;
  if (!hasUrl) return false;
  if (ageMs === null || ageMs === undefined) return false;
  return Number(ageMs) > resolveDays(days) * DAY_MS;
}

/**
 * 人工确认的有效期判定。
 *
 * 确认记录落库的是**绝对时间** `expires_at`（写入时 = 确认时刻 + 当时的 link_dormant_days 天），
 * 读取时「**严格大于**当前时间」才算有效 —— 与休眠判定的严格大于同一风格。
 *
 * 解析刻意**只接受写入格式本身**（`YYYY-MM-DDTHH:mm:ss.sssZ`，与 `new Date(ms).toISOString()`
 * 逐字一致）：JS 的 `Date.parse` 能宽容地吃下 `2026-11-17` 这类简写，而 Go 的
 * `time.Parse(RFC3339)` 会拒绝，只按「能解析就算」两边就会给出不同答案。
 * 格式不符 / 无法解析一律 fail-closed（不豁免），管理员重新确认一次即可。
 */
const TRUST_EXPIRES_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isTrustActive(expiresAt, nowMs) {
  if (expiresAt === null || expiresAt === undefined) return false;
  const text = String(expiresAt);
  if (!TRUST_EXPIRES_RE.test(text)) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > nowMs;
}

/** 人工确认向量的固定「现在」，避免 fixture 随时间漂移 */
const TRUST_NOW_MS = Date.parse('2026-11-01T00:00:00.000Z');

/**
 * 休眠提醒的状态机：**同一个休眠周期只提醒一次**。
 *
 * 背景：链接进入休眠时要给评论者发一封提醒邮件（他可以确认仍在用、或提交新链接）。
 * 本仓库三端都没有定时任务，这封信是在「有人读取公开评论列表」时惰性检测发出的，
 * 因此必须有一个明确的「什么时候该发」口径，否则要么重复轰炸、要么永远不补发。
 *
 *   需要发提醒 = 当前休眠 && (没有记录 || 记录已过期 || 记录里的最后评论时间 ≠ 当前最后评论时间)
 *
 * 「最后评论时间」是这个状态机的锚：他没再评论过 = 同一个休眠周期（只提醒一次）；
 * 他后来又评论过 = 新的休眠周期（再提醒一次）；记录过期 = 提醒页失效了（刷新令牌与有效期后再发）。
 */
function needNotice({ dormant, hasRecord, recordExpired, recordLastCommentAt, currentLastCommentAt }) {
  if (dormant !== true) return false;
  if (hasRecord !== true) return true;
  if (recordExpired === true) return true;
  return recordLastCommentAt !== currentLastCommentAt;
}

/**
 * 休眠提醒邮件的**发信前提**（见 doc/link_security.md 第 2.7 节）。
 *
 *   发信 = link_security_enabled && link_dormant_notice_enabled && email_verify_enabled
 *
 * 三个值一律 fail-closed（归一化后等于 "true" 才算开启）：功能没开、提醒开关没开、
 * 或站点没开邮箱验证时，一封提醒都不发（界面上的警告与后端口径完全一致）。
 */
function shouldSendNotice({ securityEnabled, noticeEnabled, emailVerifyEnabled }) {
  const on = (value) => String(value ?? '').trim().toLowerCase() === 'true';
  return on(securityEnabled) && on(noticeEnabled) && on(emailVerifyEnabled);
}

const fixture = {
  version: 1,
  note:
    '链接安全审查契约 v1：四个设置键（开关 fail-closed、休眠天数 1-3650 默认 30）、' +
    '休眠判定（严格大于 N 天、再次评论自动解除）、人工确认豁免（有效期 = 确认时的休眠天数，' +
    '读取时严格大于当前时间）与休眠提醒邮件的发信前提（总开关 + 提醒开关 + 邮箱验证）三端必须逐条一致。' +
    '由 scripts/gen-link-security-vectors.js 生成，请勿手改。',
  keys: KEYS,
  defaults: {
    securityEnabled: 'false',
    dormantDays: DEFAULT_DORMANT_DAYS,
    syncEnabled: 'false',
    dormantNoticeEnabled: DEFAULT_DORMANT_NOTICE_ENABLED,
  },
  limits: {
    minDormantDays: MIN_DORMANT_DAYS,
    maxDormantDays: MAX_DORMANT_DAYS,
    dayMs: DAY_MS,
  },
  errors: ERRORS,
  switches: {
    valid: ['', '   ', 'true', 'false', ' true ', ' TRUE ', 'False', null],
    invalid: ['1', '0', 'yes', 'on', 'true1', 'false1', 'null', '否'],
  },
  days: {
    valid: ['1', '30', '3650', ' 30 ', 1, 3650],
    invalid: ['', '   ', '0', '-1', '3651', 'abc', '1.5', '30d', '1e3', null],
    resolve: [
      { stored: '', expect: DEFAULT_DORMANT_DAYS },
      { stored: '   ', expect: DEFAULT_DORMANT_DAYS },
      { stored: 'abc', expect: DEFAULT_DORMANT_DAYS },
      { stored: '0', expect: DEFAULT_DORMANT_DAYS },
      { stored: '-5', expect: DEFAULT_DORMANT_DAYS },
      { stored: '1.5', expect: DEFAULT_DORMANT_DAYS },
      { stored: '1', expect: 1 },
      { stored: ' 30 ', expect: 30 },
      { stored: '3650', expect: 3650 },
      { stored: '99999', expect: MAX_DORMANT_DAYS },
    ],
  },
  // 休眠判定：{ enabled, hasUrl, days, ageMs } → 是否休眠
  dormant: [
    { name: '功能关闭：一律不标记', enabled: 'false', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, expect: false },
    { name: '开关是脏值：fail-closed 不标记', enabled: 'yes', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, expect: false },
    { name: '开关大小写：TRUE 才开启', enabled: ' TRUE ', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, expect: true },
    { name: '该评论没有个人网址：不标记', enabled: 'true', hasUrl: false, days: '30', ageMs: 90 * DAY_MS, expect: false },
    { name: '最后评论时间未知：不标记（fail-open）', enabled: 'true', hasUrl: true, days: '30', ageMs: null, expect: false },
    { name: '刚好 N 天：不标记（严格大于）', enabled: 'true', hasUrl: true, days: '30', ageMs: 30 * DAY_MS, expect: false },
    { name: 'N 天 + 1 毫秒：标记', enabled: 'true', hasUrl: true, days: '30', ageMs: 30 * DAY_MS + 1, expect: true },
    { name: 'N 天 + 1 天：标记', enabled: 'true', hasUrl: true, days: '30', ageMs: 31 * DAY_MS, expect: true },
    { name: '刚评论过：不标记', enabled: 'true', hasUrl: true, days: '30', ageMs: 60 * 1000, expect: false },
    { name: '天数脏值回退 30：31 天前评论 → 标记', enabled: 'true', hasUrl: true, days: 'abc', ageMs: 31 * DAY_MS, expect: true },
    { name: '天数 0 回退 30：29 天前评论 → 不标记', enabled: 'true', hasUrl: true, days: '0', ageMs: 29 * DAY_MS, expect: false },
    { name: '天数上限 3650：3651 天前评论 → 标记', enabled: 'true', hasUrl: true, days: '3650', ageMs: 3651 * DAY_MS, expect: true },
    { name: '天数上限 3650：3650 天前评论 → 不标记', enabled: 'true', hasUrl: true, days: '3650', ageMs: 3650 * DAY_MS, expect: false },
  ],
  // 休眠分组用的邮箱归一化（同一个人的评论必须落到同一组）
  emailNormalize: [
    { input: '  A@B.com ', expect: 'a@b.com' },
    { input: 'a@b.com', expect: 'a@b.com' },
    { input: '', expect: '' },
  ],
  /**
   * 人工确认（管理员把某条休眠链接标为安全）——
   * `active` 钉死有效期判定，`dormantOverride` 钉死它对休眠判定的豁免。
   */
  trust: {
    nowMs: TRUST_NOW_MS,
    expiresFormat: 'YYYY-MM-DDTHH:mm:ss.sssZ（与 new Date(ms).toISOString() 逐字一致）',
    // { expiresAt, nowMs } → 是否仍在有效期内
    active: [
      { name: '到期时间在未来：有效（豁免休眠）', expiresAt: '2026-11-17T00:00:00.000Z', nowMs: TRUST_NOW_MS, expect: true },
      { name: '到期时间恰好等于现在：已过期（严格大于）', expiresAt: '2026-11-01T00:00:00.000Z', nowMs: TRUST_NOW_MS, expect: false },
      { name: '到期时间早 1 毫秒：已过期', expiresAt: '2026-10-31T23:59:59.999Z', nowMs: TRUST_NOW_MS, expect: false },
      { name: '空串：无效（fail-closed，不豁免）', expiresAt: '', nowMs: TRUST_NOW_MS, expect: false },
      { name: '纯空白：无效', expiresAt: '   ', nowMs: TRUST_NOW_MS, expect: false },
      { name: 'null：无效', expiresAt: null, nowMs: TRUST_NOW_MS, expect: false },
      { name: '无法解析：无效', expiresAt: 'not-a-date', nowMs: TRUST_NOW_MS, expect: false },
      { name: '缺毫秒的 ISO 串：无效（必须与写入格式逐字一致）', expiresAt: '2026-11-17T00:00:00Z', nowMs: TRUST_NOW_MS, expect: false },
      { name: '只有日期：无效', expiresAt: '2026-11-17', nowMs: TRUST_NOW_MS, expect: false },
      { name: '数字时间戳字符串：无效（只接受 ISO 串）', expiresAt: '1794960000000', nowMs: TRUST_NOW_MS, expect: false },
      { name: '带时区偏移：无效（只接受 Z）', expiresAt: '2026-11-17T08:00:00.000+08:00', nowMs: TRUST_NOW_MS, expect: false },
    ],
    // { enabled, hasUrl, days, ageMs, trusted } → 是否休眠
    dormantOverride: [
      {
        name: '人工确认有效：即使超过 N 天也不标记休眠',
        enabled: 'true', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, trusted: true, expect: false,
      },
      {
        name: '人工确认已过期：照常标记休眠',
        enabled: 'true', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, trusted: false, expect: true,
      },
      {
        name: '功能关闭：一切都不标记（人工确认与否都一样）',
        enabled: 'false', hasUrl: true, days: '30', ageMs: 90 * DAY_MS, trusted: true, expect: false,
      },
      {
        name: '人工确认有效：刚过 N 天 1 毫秒也豁免',
        enabled: 'true', hasUrl: true, days: '30', ageMs: 30 * DAY_MS + 1, trusted: true, expect: false,
      },
      {
        name: '未超 N 天：本来就休眠不了',
        enabled: 'true', hasUrl: true, days: '30', ageMs: 29 * DAY_MS, trusted: false, expect: false,
      },
    ],
  },
  /**
   * 休眠提醒的状态机（见 needNotice 的注释）：
   * `{ dormant, hasRecord, recordExpired, recordLastCommentAt, currentLastCommentAt }` → 是否该发提醒。
   */
  notice: {
    needNotify: [
      {
        name: '不休眠：不提醒（没有记录也不提醒）',
        dormant: false, hasRecord: false, recordExpired: false, recordLastCommentAt: null,
        currentLastCommentAt: 1000, expect: false,
      },
      {
        name: '休眠且从没提醒过：提醒',
        dormant: true, hasRecord: false, recordExpired: false, recordLastCommentAt: null,
        currentLastCommentAt: 1000, expect: true,
      },
      {
        name: '休眠 + 记录有效 + 最后评论时间未变：同一休眠周期，不重复提醒',
        dormant: true, hasRecord: true, recordExpired: false, recordLastCommentAt: 1000,
        currentLastCommentAt: 1000, expect: false,
      },
      {
        name: '休眠 + 记录有效 + 最后评论时间变了（他后来又评论过）：新的休眠周期，再提醒',
        dormant: true, hasRecord: true, recordExpired: false, recordLastCommentAt: 1000,
        currentLastCommentAt: 2000, expect: true,
      },
      {
        name: '休眠 + 记录已过期 + 时间未变：刷新令牌后再提醒',
        dormant: true, hasRecord: true, recordExpired: true, recordLastCommentAt: 1000,
        currentLastCommentAt: 1000, expect: true,
      },
      {
        name: '休眠 + 记录已过期 + 时间变了：再提醒',
        dormant: true, hasRecord: true, recordExpired: true, recordLastCommentAt: 1000,
        currentLastCommentAt: 2000, expect: true,
      },
      {
        name: '不休眠但记录里的时间变了：不提醒',
        dormant: false, hasRecord: true, recordExpired: false, recordLastCommentAt: 1000,
        currentLastCommentAt: 2000, expect: false,
      },
    ],
    /**
     * 发信前提（见 shouldSendNotice 的注释）：
     * `{ securityEnabled, noticeEnabled, emailVerifyEnabled }` → 是否真的会发提醒邮件。
     */
    sendGate: [
      {
        name: '三个前提都开启：发信',
        securityEnabled: 'true', noticeEnabled: 'true', emailVerifyEnabled: 'true', expect: true,
      },
      {
        name: '提醒开关关闭：不发（即使链接安全与邮箱验证都开着）',
        securityEnabled: 'true', noticeEnabled: 'false', emailVerifyEnabled: 'true', expect: false,
      },
      {
        name: '提醒开关是脏值：fail-closed 不发',
        securityEnabled: 'true', noticeEnabled: 'yes', emailVerifyEnabled: 'true', expect: false,
      },
      {
        name: '邮箱验证关闭：不发（需求里的硬前提）',
        securityEnabled: 'true', noticeEnabled: 'true', emailVerifyEnabled: 'false', expect: false,
      },
      {
        name: '邮箱验证未配置（空串）：不发',
        securityEnabled: 'true', noticeEnabled: 'true', emailVerifyEnabled: '', expect: false,
      },
      {
        name: '链接安全总开关关闭：不发',
        securityEnabled: 'false', noticeEnabled: 'true', emailVerifyEnabled: 'true', expect: false,
      },
      {
        name: '全都未配置：不发',
        securityEnabled: '', noticeEnabled: '', emailVerifyEnabled: '', expect: false,
      },
      {
        name: '大小写与空格：TRUE 视为开启（三处同一归一化）',
        securityEnabled: ' TRUE ', noticeEnabled: 'True', emailVerifyEnabled: ' true ',
        expect: true,
      },
    ],
  },
};

// ---- 自检 ----
for (const value of fixture.switches.valid) {
  if (validateSwitch(value) !== null) throw new Error(`switches.valid 里的值非法：${JSON.stringify(value)}`);
}
for (const value of fixture.switches.invalid) {
  if (validateSwitch(value) === null) throw new Error(`switches.invalid 里的值合法：${JSON.stringify(value)}`);
}
for (const value of fixture.days.valid) {
  if (!validateDays(value)) throw new Error(`days.valid 里的值非法：${JSON.stringify(value)}`);
}
for (const value of fixture.days.invalid) {
  if (validateDays(value)) throw new Error(`days.invalid 里的值合法：${JSON.stringify(value)}`);
}
for (const item of fixture.days.resolve) {
  const got = resolveDays(item.stored);
  if (got !== item.expect) throw new Error(`days.resolve 「${item.stored}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.dormant) {
  const got = isDormant(item);
  if (got !== item.expect) throw new Error(`dormant 用例「${item.name}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.emailNormalize) {
  const got = String(item.input ?? '').trim().toLowerCase();
  if (got !== item.expect) throw new Error(`emailNormalize 「${item.input}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.trust.active) {
  const got = isTrustActive(item.expiresAt, item.nowMs);
  if (got !== item.expect) throw new Error(`trust.active 「${item.name}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.trust.dormantOverride) {
  const got = isDormant(item);
  if (got !== item.expect) throw new Error(`trust.dormantOverride 「${item.name}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.notice.needNotify) {
  const got = needNotice(item);
  if (got !== item.expect) throw new Error(`notice.needNotify 「${item.name}」期望 ${item.expect}，实际 ${got}`);
}
for (const item of fixture.notice.sendGate) {
  const got = shouldSendNotice(item);
  if (got !== item.expect) throw new Error(`notice.sendGate 「${item.name}」期望 ${item.expect}，实际 ${got}`);
}

const outputPath = path.resolve(__dirname, '..', 'doc', 'vectors', 'link-security-v1.json');
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`写入 ${outputPath}`);
console.log(`  keys     : ${Object.values(KEYS).join(' / ')}`);
console.log(`  limits   : days=${MIN_DORMANT_DAYS}-${MAX_DORMANT_DAYS}（默认 ${DEFAULT_DORMANT_DAYS}）`);
console.log(`  switches : valid=${fixture.switches.valid.length} invalid=${fixture.switches.invalid.length}`);
console.log(`  days     : valid=${fixture.days.valid.length} invalid=${fixture.days.invalid.length} resolve=${fixture.days.resolve.length}`);
console.log(`  dormant  : ${fixture.dormant.length} 个用例`);
console.log(`  trust    : active=${fixture.trust.active.length} dormantOverride=${fixture.trust.dormantOverride.length}`);
console.log(`  notice   : needNotify=${fixture.notice.needNotify.length} sendGate=${fixture.notice.sendGate.length}`);
