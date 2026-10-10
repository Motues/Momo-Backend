import { Bindings } from '../bindings';
import { getSetting } from './settings';

/**
 * 评论无感验证（人机验证）的认证记录服务 —— Cloudflare Worker 实现。
 *
 * 与 Node（nodejs/src/orm/verifyRecordService.ts）/ Go（internal/repository/sqlite/verifyRecord.go）
 * 的表结构、写入时机与统计口径完全一致，详见 doc/data_table.md 与 doc/api.md。
 *
 * 设计要点：
 *  - 写入是**尽力而为**：任何异常都只写日志，绝不影响验证结果本身；
 *  - 统计在 SQL 里聚合，窗口按 UTC 对齐（strftime(..., 'unixepoch') 即 UTC），避免时区偏移；
 *  - 过期清理是惰性的（每个 isolate 每小时最多一次），走 waitUntil 不阻塞响应。
 */

export type VerifyEvent = 'challenge' | 'pass' | 'fail';

/** 执行上下文里 waitUntil 的抽象：测试环境可能没有 c.executionCtx */
export type WaitUntil = (task: Promise<unknown>) => void;

export interface CfGeo {
  country: string | null;
  network: string | null;
  asn: number | null;
}

export interface VerifyRecordInput {
  event: VerifyEvent;
  reason?: string | null;
  elapsedMs?: number | null;
  difficulty?: number | null;
  challengeId?: string | null;
  postSlug?: string | null;
  ip?: string | null;
  geo?: CfGeo;
}

export type Bucket = 'hour' | 'day' | 'month';

interface StatsWindow {
  start: number;
  /** 排他上界 */
  end: number;
  bucket: Bucket;
  keys: string[];
}

interface SummaryRow {
  challenges: number;
  verified: number;
  failed: number;
  avg_duration: number | null;
}

interface Summary {
  challenges: number;
  verified: number;
  failed: number;
  avgDurationMs: number | null;
}

export interface VerifyOverview {
  range: { days: number; offset: number; from: string; to: string; bucket: Bucket };
  summary: {
    challenges: number;
    challengesDelta: number | null;
    verified: number;
    verifiedDelta: number | null;
    failed: number;
    failedDelta: number | null;
    avgDurationMs: number | null;
    avgDurationDelta: number | null;
    passRate: number | null;
  };
  trend: { date: string; challenges: number; verified: number; failed: number }[];
  /** Worker 部署为 true（Cloudflare 提供 cf.country / cf.asn / cf.asOrganization） */
  geoSupported: boolean;
  topCountries: { name: string; count: number; percent: number }[];
  topNetworks: { name: string; asn: number | null; count: number; percent: number }[];
  topReasons: { reason: string; count: number; percent: number }[];
}

export interface VerifyRecordQuery {
  page: number;
  pageSize: number;
  event: string;
  reason: string;
  ip: string;
  slug: string;
  days: number;
}

export interface VerifyRecordItem {
  id: number;
  createdAt: string;
  event: string;
  reason: string;
  elapsedMs: number | null;
  difficulty: number | null;
  challengeId: string;
  postSlug: string;
  ipAddress: string;
  country: string;
  network: string;
  asn: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_COUNT = 12;
const TOP_LIMIT = 5;
const MAX_OVERVIEW_DAYS = 365;

export const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
/** 惰性清理的最小间隔：避免每个请求都去删一遍 */
const PRUNE_INTERVAL_MS = HOUR_MS;

let lastPruneAt = 0;

/**
 * 从 Cloudflare 请求对象里取出地域/运营商信息。
 *
 * 本地 `wrangler dev` 与测试环境里 `request.cf` 可能不存在，因此必须整体容错；
 * 取不到时返回三个 null，记录照常写入（这几列本来就是「仅 Worker 有值」）。
 */
export function extractCfGeo(cf: unknown): CfGeo {
  if (!cf || typeof cf !== 'object') return { country: null, network: null, asn: null };
  const raw = cf as Record<string, unknown>;
  const country = typeof raw.country === 'string' && raw.country ? raw.country : null;
  const network =
    typeof raw.asOrganization === 'string' && raw.asOrganization ? raw.asOrganization : null;
  // asn 缺失 / null / 空串都必须落成 NULL：Number(null) 是 0，
  // 不显式排除会把它当成「AS0」写进榜单（真实 cf 里 asn 要么是数字、要么整个字段缺失，
  // 但 wrangler dev 与自造 Request 下确实可能拿到 null）。
  const rawAsn = raw.asn;
  const asnValue =
    typeof rawAsn === 'number'
      ? rawAsn
      : rawAsn === null || rawAsn === undefined || rawAsn === ''
        ? Number.NaN
        : Number(rawAsn);
  const asn = Number.isFinite(asnValue) ? Math.trunc(asnValue) : null;
  return { country, network, asn };
}

/** 把 c.executionCtx 包装成 waitUntil 回调；取不到执行上下文时返回 undefined */
export function resolveWaitUntil(ctx: { executionCtx?: unknown }): WaitUntil | undefined {
  try {
    const executionCtx = ctx.executionCtx as { waitUntil?: (task: Promise<unknown>) => void };
    if (!executionCtx || typeof executionCtx.waitUntil !== 'function') return undefined;
    return (task) => executionCtx.waitUntil!(task);
  } catch {
    // 测试 / 非 Worker 环境下访问 executionCtx 会抛错，退化为不等待
    return undefined;
  }
}

/** 保留天数：0 = 永久保留；非法值退回默认值；上限 3650 天 */
export async function getRetentionDays(env: Bindings): Promise<number> {
  const raw = await getSetting(env, 'comment_verify_retention_days');
  if (raw === null || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed <= 0) return 0;
  return Math.min(parsed, MAX_RETENTION_DAYS);
}

/**
 * 是否记录「签发挑战」事件，默认开启。
 *
 * 关闭后只记录通过/失败，能显著降低写入量（签发事件在评论框加载时就会产生，
 * 是行数的主要来源），代价是看不到「签发了但没人提交答案」的流失情况。
 */
async function isChallengeLogEnabled(env: Bindings): Promise<boolean> {
  return (await getSetting(env, 'comment_verify_log_challenge')) !== 'false';
}

/** 写入一条认证记录。永不抛出：失败只写日志，避免影响验证流程本身。 */
export async function recordVerifyEvent(
  env: Bindings,
  input: VerifyRecordInput,
  waitUntil?: WaitUntil
): Promise<void> {
  const now = Date.now();
  try {
    if (input.event === 'challenge' && !(await isChallengeLogEnabled(env))) return;

    await env.MOMO_DB.prepare(
      `INSERT INTO VerifyRecord
         (created_at, event, reason, elapsed_ms, difficulty, challenge_id, post_slug, ip_address, country, network, asn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        now,
        input.event,
        input.reason ?? null,
        input.elapsedMs ?? null,
        input.difficulty ?? null,
        input.challengeId ?? null,
        input.postSlug ?? null,
        input.ip ?? null,
        input.geo?.country ?? null,
        input.geo?.network ?? null,
        input.geo?.asn ?? null
      )
      .run();
  } catch (e) {
    console.error('写入认证记录失败（不影响验证结果）:', e);
    return;
  }

  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    const task = pruneVerifyRecords(env).catch(() => undefined);
    if (waitUntil) {
      try {
        waitUntil(task);
      } catch {
        // waitUntil 不可用时不做任何等待：清理任务本身已经发起
      }
    }
  }
}

/** 清理超出保留期的认证记录（保留天数为 0 时直接返回） */
export async function pruneVerifyRecords(env: Bindings): Promise<number> {
  try {
    const days = await getRetentionDays(env);
    if (days <= 0) return 0;

    const cutoff = Date.now() - days * DAY_MS;
    const result = await env.MOMO_DB.prepare('DELETE FROM VerifyRecord WHERE created_at < ?')
      .bind(cutoff)
      .run();
    const removed = Number(result.meta?.changes ?? 0);
    if (removed > 0) {
      console.log(`[verify-record] 已清理 ${removed} 条认证记录（保留 ${days} 天）`);
    }
    return removed;
  } catch (e) {
    console.error('清理认证记录失败:', e);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 时间窗口
 * ------------------------------------------------------------------ */

function startOfUtcHour(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcMonth(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 分桶键：与 SQL 里的 strftime 表达式逐字符对应 */
export function bucketKey(bucket: Bucket, ts: number): string {
  const d = new Date(ts);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (bucket === 'month') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  if (bucket === 'hour') return `${ymd}T${pad(d.getUTCHours())}`;
  return ymd;
}

/** 分桶的 SQL 表达式（毫秒整数 → UTC 字符串键） */
function bucketExpr(bucket: Bucket): string {
  const fmt = bucket === 'month' ? '%Y-%m' : bucket === 'hour' ? '%Y-%m-%dT%H' : '%Y-%m-%d';
  return `strftime('${fmt}', created_at / 1000, 'unixepoch')`;
}

/**
 * 解析统计窗口。
 *
 * days = 0 表示「全部」（最近 12 个月，按月分桶）；days = 1 按小时分桶；其余按天。
 * offset 表示窗口向前平移的**整窗个数**（对齐界面上的左右箭头），0 = 当前窗口。
 */
export function resolveWindow(days: number, offset: number, now: number): StatsWindow {
  const shift = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let start: number;
  let end: number;
  let bucket: Bucket;

  if (days <= 0) {
    bucket = 'month';
    end = addMonths(startOfUtcMonth(now), 1 - shift);
    start = addMonths(end, -MONTH_COUNT);
  } else if (days <= 1) {
    bucket = 'hour';
    end = startOfUtcHour(now) + HOUR_MS - shift * 24 * HOUR_MS;
    start = end - 24 * HOUR_MS;
  } else {
    bucket = 'day';
    end = startOfUtcDay(now) + DAY_MS - shift * days * DAY_MS;
    start = end - days * DAY_MS;
  }

  const keys: string[] = [];
  if (bucket === 'month') {
    for (let i = 0; i < MONTH_COUNT; i += 1) keys.push(bucketKey(bucket, addMonths(start, i)));
  } else {
    const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
    for (let t = start; t < end; t += step) keys.push(bucketKey(bucket, t));
  }

  return { start, end, bucket, keys };
}

const SUMMARY_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN event = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
    COALESCE(SUM(CASE WHEN event = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
    COALESCE(SUM(CASE WHEN event = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
    AVG(CASE WHEN event = 'pass' THEN elapsed_ms END) AS avg_duration
  FROM VerifyRecord
  WHERE created_at >= ? AND created_at < ?
`;

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/** 环比：与上一个等长窗口比较的百分比整数；上一窗口为空时返回 null（而不是 0/100%） */
function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function deltaPctNullable(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

async function summarize(env: Bindings, start: number, end: number): Promise<Summary> {
  const row = await env.MOMO_DB.prepare(SUMMARY_SQL)
    .bind(start, end)
    .first<SummaryRow>();

  return {
    challenges: Number(row?.challenges ?? 0),
    verified: Number(row?.verified ?? 0),
    failed: Number(row?.failed ?? 0),
    avgDurationMs:
      row?.avg_duration === null || row?.avg_duration === undefined
        ? null
        : Math.round(Number(row.avg_duration)),
  };
}

export async function getVerifyOverview(
  env: Bindings,
  days: number,
  offset: number
): Promise<VerifyOverview> {
  const now = Date.now();
  const safeDays =
    Number.isFinite(days) && days >= 0 ? Math.min(Math.trunc(days), MAX_OVERVIEW_DAYS) : 30;
  const safeOffset = Number.isFinite(offset) ? Math.min(Math.max(Math.trunc(offset), 0), 120) : 0;
  const win = resolveWindow(safeDays, safeOffset, now);

  const summary = await summarize(env, win.start, win.end);
  const span = win.end - win.start;
  const prev = await summarize(env, win.start - span, win.start);

  // 趋势：SQL 只返回有数据的分桶，其余在 JS 里补零
  const trendMap = new Map<string, { challenges: number; verified: number; failed: number }>();
  win.keys.forEach((key) => trendMap.set(key, { challenges: 0, verified: 0, failed: 0 }));

  const trendRows = await env.MOMO_DB.prepare(
    `SELECT
       ${bucketExpr(win.bucket)} AS bucket,
       COALESCE(SUM(CASE WHEN event = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
       COALESCE(SUM(CASE WHEN event = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
       COALESCE(SUM(CASE WHEN event = 'fail' THEN 1 ELSE 0 END), 0) AS failed
     FROM VerifyRecord
     WHERE created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY bucket ASC`
  )
    .bind(win.start, win.end)
    .all<{ bucket: string; challenges: number; verified: number; failed: number }>();

  for (const row of trendRows.results || []) {
    if (!trendMap.has(row.bucket)) continue;
    trendMap.set(row.bucket, {
      challenges: Number(row.challenges ?? 0),
      verified: Number(row.verified ?? 0),
      failed: Number(row.failed ?? 0),
    });
  }

  const trend = win.keys.map((key) => ({ date: key, ...trendMap.get(key)! }));

  const total = summary.challenges + summary.verified + summary.failed;
  const share = (count: number) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

  const [countryRows, networkRows, reasonRows] = await Promise.all([
    env.MOMO_DB.prepare(
      `SELECT country AS name, COUNT(*) AS count
       FROM VerifyRecord
       WHERE created_at >= ? AND created_at < ? AND country IS NOT NULL AND country <> ''
       GROUP BY country
       ORDER BY count DESC, name ASC
       LIMIT ${TOP_LIMIT}`
    )
      .bind(win.start, win.end)
      .all<{ name: string; count: number }>(),
    env.MOMO_DB.prepare(
      `SELECT network AS name, MAX(asn) AS asn, COUNT(*) AS count
       FROM VerifyRecord
       WHERE created_at >= ? AND created_at < ? AND network IS NOT NULL AND network <> ''
       GROUP BY network
       ORDER BY count DESC, name ASC
       LIMIT ${TOP_LIMIT}`
    )
      .bind(win.start, win.end)
      .all<{ name: string; asn: number | null; count: number }>(),
    env.MOMO_DB.prepare(
      `SELECT reason, COUNT(*) AS count
       FROM VerifyRecord
       WHERE created_at >= ? AND created_at < ? AND event = 'fail' AND reason IS NOT NULL AND reason <> ''
       GROUP BY reason
       ORDER BY count DESC, reason ASC
       LIMIT ${TOP_LIMIT}`
    )
      .bind(win.start, win.end)
      .all<{ reason: string; count: number }>(),
  ]);

  return {
    range: {
      days: safeDays,
      offset: safeOffset,
      from: new Date(win.start).toISOString(),
      to: new Date(win.end - 1).toISOString(),
      bucket: win.bucket,
    },
    summary: {
      challenges: summary.challenges,
      challengesDelta: deltaPct(summary.challenges, prev.challenges),
      verified: summary.verified,
      verifiedDelta: deltaPct(summary.verified, prev.verified),
      failed: summary.failed,
      failedDelta: deltaPct(summary.failed, prev.failed),
      avgDurationMs: summary.avgDurationMs,
      avgDurationDelta: deltaPctNullable(summary.avgDurationMs, prev.avgDurationMs),
      // 通过率只以「已出结果的认证」为分母：签发了但没提交答案不应拉低通过率
      passRate:
        summary.verified + summary.failed > 0
          ? Math.round((summary.verified / (summary.verified + summary.failed)) * 1000) / 10
          : null,
    },
    trend,
    geoSupported: true,
    topCountries: (countryRows.results || []).map((row) => ({
      name: row.name,
      count: Number(row.count ?? 0),
      percent: share(Number(row.count ?? 0)),
    })),
    topNetworks: (networkRows.results || []).map((row) => ({
      name: row.name,
      asn: row.asn === null || row.asn === undefined ? null : Number(row.asn),
      count: Number(row.count ?? 0),
      percent: share(Number(row.count ?? 0)),
    })),
    topReasons: (reasonRows.results || []).map((row) => ({
      reason: row.reason,
      count: Number(row.count ?? 0),
      percent: share(Number(row.count ?? 0)),
    })),
  };
}

export async function listVerifyRecords(
  env: Bindings,
  query: VerifyRecordQuery
): Promise<{ list: VerifyRecordItem[]; total: number; page: number; pageSize: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.days > 0) {
    const win = resolveWindow(query.days, 0, Date.now());
    conditions.push('created_at >= ? AND created_at < ?');
    params.push(win.start, win.end);
  }

  if (query.event && query.event !== 'all') {
    conditions.push('event = ?');
    params.push(query.event);
  }

  if (query.reason) {
    conditions.push('reason = ?');
    params.push(query.reason);
  }

  if (query.slug) {
    conditions.push('post_slug = ?');
    params.push(query.slug);
  }

  // IP 用前缀匹配便于按网段排查；转义 LIKE 通配符，避免管理员输入的 % / _ 被当成模式
  if (query.ip) {
    const escaped = query.ip.replace(/[\\%_]/g, (m) => `\\${m}`);
    conditions.push(`ip_address LIKE ? ESCAPE '\\'`);
    params.push(`${escaped}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await env.MOMO_DB.prepare(
    `SELECT COUNT(*) AS total FROM VerifyRecord ${where}`
  )
    .bind(...params)
    .first<{ total: number }>();

  const rows = await env.MOMO_DB.prepare(
    `SELECT * FROM VerifyRecord ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, query.pageSize, (query.page - 1) * query.pageSize)
    .all<{
      id: number;
      created_at: number;
      event: string;
      reason: string | null;
      elapsed_ms: number | null;
      difficulty: number | null;
      challenge_id: string | null;
      post_slug: string | null;
      ip_address: string | null;
      country: string | null;
      network: string | null;
      asn: number | null;
    }>();

  return {
    list: (rows.results || []).map((row) => ({
      id: Number(row.id),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      event: row.event,
      reason: row.reason || '',
      elapsedMs: row.elapsed_ms === null || row.elapsed_ms === undefined ? null : Number(row.elapsed_ms),
      difficulty: row.difficulty === null || row.difficulty === undefined ? null : Number(row.difficulty),
      challengeId: row.challenge_id || '',
      postSlug: row.post_slug || '',
      ipAddress: row.ip_address || '',
      country: row.country || '',
      network: row.network || '',
      asn: row.asn === null || row.asn === undefined ? null : Number(row.asn),
    })),
    total: Number(countRow?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}
