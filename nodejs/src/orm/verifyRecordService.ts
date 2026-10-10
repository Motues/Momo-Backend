import { db, schema } from "./client";
import { sql, type SQL } from "drizzle-orm";
import { getSetting } from "../utils/settings";
import LogService from "../utils/log";

/**
 * 评论无感验证（人机验证）的认证记录服务。
 *
 * 三端（Node / Go / Worker）的表结构、写入时机与统计口径必须完全一致，
 * 详见 doc/data_table.md（VerifyRecord 表）与 doc/api.md（/admin/verify/*）。
 *
 * 设计要点：
 *  - 写入是**尽力而为**：任何异常都只写日志，绝不影响验证结果本身；
 *  - 统计在 SQL 里聚合（不把整表读进 JS），窗口按 UTC 对齐，避免非 UTC 时区整体偏移；
 *  - 过期清理是惰性的（每小时最多一次），默认保留 30 天，见 comment_verify_retention_days。
 */

export type VerifyEvent = "challenge" | "pass" | "fail";

export interface VerifyRecordInput {
  event: VerifyEvent;
  /** 失败原因（challenge / pass 传 null） */
  reason?: string | null;
  /** 客户端上报的求解耗时（仅 pass / fail 有） */
  elapsedMs?: number | null;
  /** 本次生效的总期望哈希次数 */
  difficulty?: number | null;
  /** 挑战 cid；签名校验或载荷解析就失败时可能为空 */
  challengeId?: string | null;
  postSlug?: string | null;
  ip?: string | null;
  /** 以下三项仅 Worker 部署有值 */
  country?: string | null;
  network?: string | null;
  asn?: number | null;
}

export type Bucket = "hour" | "day" | "month";

interface StatsWindow {
  start: number;
  /** 排他上界 */
  end: number;
  bucket: Bucket;
  keys: string[];
}

interface Summary {
  challenges: number;
  verified: number;
  failed: number;
  avgDurationMs: number | null;
}

export interface VerifyOverview {
  range: {
    days: number;
    offset: number;
    from: string;
    to: string;
    bucket: Bucket;
  };
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
  trend: {
    date: string;
    challenges: number;
    verified: number;
    failed: number;
  }[];
  /** 仅 Cloudflare Worker 为 true；Node / Go 无 IP 归属地数据源 */
  geoSupported: boolean;
  topCountries: { name: string; count: number; percent: number }[];
  topNetworks: { name: string; asn: number | null; count: number; percent: number }[];
  topReasons: { reason: string; count: number; percent: number }[];
}

export interface VerifyRecordQuery {
  page?: number;
  pageSize?: number;
  event?: string;
  reason?: string;
  ip?: string;
  slug?: string;
  days?: number;
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
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_OVERVIEW_DAYS = 365;

export const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
/** 惰性清理的最小间隔：避免每个请求都去删一遍 */
const PRUNE_INTERVAL_MS = HOUR_MS;

let lastPruneAt = 0;

/** 保留天数：0 = 永久保留；非法值退回默认值；上限 3650 天 */
export async function getRetentionDays(): Promise<number> {
  const raw = await getSetting("comment_verify_retention_days");
  if (raw === null || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
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
async function isChallengeLogEnabled(): Promise<boolean> {
  return (await getSetting("comment_verify_log_challenge")) !== "false";
}

/** 写入一条认证记录。永不抛出：失败只写日志，避免影响验证流程本身。 */
export async function recordVerifyEvent(input: VerifyRecordInput): Promise<void> {
  const now = Date.now();
  try {
    if (input.event === "challenge" && !(await isChallengeLogEnabled())) return;

    db.insert(schema.verifyRecords)
      .values({
        created_at: now,
        event: input.event,
        reason: input.reason ?? null,
        elapsed_ms: input.elapsedMs ?? null,
        difficulty: input.difficulty ?? null,
        challenge_id: input.challengeId ?? null,
        post_slug: input.postSlug ?? null,
        ip_address: input.ip ?? null,
        country: input.country ?? null,
        network: input.network ?? null,
        asn: input.asn ?? null,
      })
      .run();
  } catch (e) {
    LogService.warn("写入认证记录失败（不影响验证结果）:", e);
    return;
  }

  await pruneIfDue(now);
}

async function pruneIfDue(now: number, force = false): Promise<void> {
  if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  try {
    const days = await getRetentionDays();
    if (days <= 0) return;

    const cutoff = now - days * DAY_MS;
    const result = db.run(
      sql`DELETE FROM "VerifyRecord" WHERE "created_at" < ${cutoff}`
    );
    const removed = Number(result.changes ?? 0);
    if (removed > 0) {
      LogService.info(`认证记录已清理 ${removed} 条（保留 ${days} 天）`);
    }
  } catch (e) {
    LogService.warn("清理认证记录失败:", e);
  }
}

/** 立即执行一次过期清理（供启动时与测试调用） */
export async function pruneVerifyRecords(): Promise<void> {
  await pruneIfDue(Date.now(), true);
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

const pad = (n: number) => String(n).padStart(2, "0");

/** 分桶键：与 SQL 里的 strftime 表达式逐字符对应 */
export function bucketKey(bucket: Bucket, ts: number): string {
  const d = new Date(ts);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (bucket === "month") return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  if (bucket === "hour") return `${ymd}T${pad(d.getUTCHours())}`;
  return ymd;
}

/** 分桶的 SQL 表达式（毫秒整数 → UTC 字符串键） */
function bucketExpr(bucket: Bucket): SQL {
  const fmt = bucket === "month" ? "%Y-%m" : bucket === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d";
  return sql`strftime(${fmt}, "created_at" / 1000, 'unixepoch')`;
}

/**
 * 解析统计窗口。
 *
 * days = 0 表示「全部」（最近 12 个月，按月分桶）；days = 1 按小时分桶；其余按天。
 * offset 表示窗口向前平移的**整窗个数**（对齐界面上的左右箭头），0 = 当前窗口。
 */
function resolveWindow(days: number, offset: number, now: number): StatsWindow {
  const shift = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let start: number;
  let end: number;
  let bucket: Bucket;

  if (days <= 0) {
    bucket = "month";
    end = addMonths(startOfUtcMonth(now), 1 - shift);
    start = addMonths(end, -MONTH_COUNT);
  } else if (days <= 1) {
    bucket = "hour";
    end = startOfUtcHour(now) + HOUR_MS - shift * 24 * HOUR_MS;
    start = end - 24 * HOUR_MS;
  } else {
    bucket = "day";
    end = startOfUtcDay(now) + DAY_MS - shift * days * DAY_MS;
    start = end - days * DAY_MS;
  }

  const keys: string[] = [];
  if (bucket === "month") {
    for (let i = 0; i < MONTH_COUNT; i += 1) keys.push(bucketKey(bucket, addMonths(start, i)));
  } else {
    const step = bucket === "hour" ? HOUR_MS : DAY_MS;
    for (let t = start; t < end; t += step) keys.push(bucketKey(bucket, t));
  }

  return { start, end, bucket, keys };
}

function normalizeDays(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === "all") return 0;
  const parsed = parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0) return 0;
  return Math.min(parsed, MAX_OVERVIEW_DAYS);
}

function normalizeOffset(raw: unknown): number {
  const parsed = parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 120);
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

function summarize(start: number, end: number): Summary {
  const row = db.get(sql`
    SELECT
      COALESCE(SUM(CASE WHEN "event" = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
      COALESCE(SUM(CASE WHEN "event" = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
      COALESCE(SUM(CASE WHEN "event" = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
      AVG(CASE WHEN "event" = 'pass' THEN "elapsed_ms" END) AS avg_duration
    FROM "VerifyRecord"
    WHERE "created_at" >= ${start} AND "created_at" < ${end}
  `) as unknown as
    | { challenges: number; verified: number; failed: number; avg_duration: number | null }
    | undefined;

  return {
    challenges: Number(row?.challenges ?? 0),
    verified: Number(row?.verified ?? 0),
    failed: Number(row?.failed ?? 0),
    avgDurationMs: row?.avg_duration === null || row?.avg_duration === undefined
      ? null
      : Math.round(Number(row.avg_duration)),
  };
}

/** 环比：与上一个等长窗口比较的百分比整数；上一窗口为空时返回 null（而不是 0/100%） */
function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function deltaPctNullable(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function getVerifyOverview(
  rawDays: unknown,
  rawOffset: unknown
): Promise<VerifyOverview> {
  const now = Date.now();
  const days = normalizeDays(rawDays, 30);
  const offset = normalizeOffset(rawOffset);
  const win = resolveWindow(days, offset, now);

  const summary = summarize(win.start, win.end);
  const span = win.end - win.start;
  const prev = summarize(win.start - span, win.start);

  // 趋势：SQL 只返回有数据的分桶，其余在 JS 里补零
  const trendMap = new Map<string, { challenges: number; verified: number; failed: number }>();
  win.keys.forEach((key) => trendMap.set(key, { challenges: 0, verified: 0, failed: 0 }));

  const trendRows = db.all(sql`
    SELECT
      ${bucketExpr(win.bucket)} AS bucket,
      COALESCE(SUM(CASE WHEN "event" = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
      COALESCE(SUM(CASE WHEN "event" = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
      COALESCE(SUM(CASE WHEN "event" = 'fail' THEN 1 ELSE 0 END), 0) AS failed
    FROM "VerifyRecord"
    WHERE "created_at" >= ${win.start} AND "created_at" < ${win.end}
    GROUP BY bucket
    ORDER BY bucket ASC
  `) as unknown as {
    bucket: string;
    challenges: number;
    verified: number;
    failed: number;
  }[];

  trendRows.forEach((row) => {
    if (!trendMap.has(row.bucket)) return;
    trendMap.set(row.bucket, {
      challenges: Number(row.challenges ?? 0),
      verified: Number(row.verified ?? 0),
      failed: Number(row.failed ?? 0),
    });
  });

  const trend = win.keys.map((key) => ({ date: key, ...trendMap.get(key)! }));

  const total = summary.challenges + summary.verified + summary.failed;
  const share = (count: number) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

  const reasonRows = db.all(sql`
    SELECT "reason" AS reason, COUNT(*) AS count
    FROM "VerifyRecord"
    WHERE "created_at" >= ${win.start} AND "created_at" < ${win.end}
      AND "event" = 'fail' AND "reason" IS NOT NULL AND "reason" <> ''
    GROUP BY "reason"
    ORDER BY count DESC, reason ASC
    LIMIT ${TOP_LIMIT}
  `) as unknown as { reason: string; count: number }[];

  const result: VerifyOverview = {
    range: {
      days,
      offset,
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
    // Node 部署没有 IP 归属地/ASN 数据源，前端据此隐藏这两块榜单
    geoSupported: false,
    topCountries: [],
    topNetworks: [],
    topReasons: reasonRows.map((row) => ({
      reason: row.reason,
      count: Number(row.count ?? 0),
      percent: share(Number(row.count ?? 0)),
    })),
  };

  return result;
}

export async function listVerifyRecords(query: VerifyRecordQuery): Promise<{
  list: VerifyRecordItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, parseInt(String(query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(String(query.pageSize ?? DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const days = normalizeDays(query.days, 30);

  const conditions: SQL[] = [];
  if (days > 0) {
    const now = Date.now();
    const win = resolveWindow(days, 0, now);
    conditions.push(sql`"created_at" >= ${win.start} AND "created_at" < ${win.end}`);
  }

  const event = String(query.event ?? "").trim();
  if (event && event !== "all") {
    conditions.push(sql`"event" = ${event}`);
  }

  const reason = String(query.reason ?? "").trim();
  if (reason) conditions.push(sql`"reason" = ${reason}`);

  const slug = String(query.slug ?? "").trim();
  if (slug) conditions.push(sql`"post_slug" = ${slug}`);

  // IP 用前缀匹配便于按网段排查；转义 LIKE 通配符，避免管理员输入的 % / _ 被当成模式
  const ip = String(query.ip ?? "").trim();
  if (ip) {
    const escaped = ip.replace(/[\\%_]/g, (m) => `\\${m}`);
    conditions.push(sql`"ip_address" LIKE ${`${escaped}%`} ESCAPE '\\'`);
  }

  const where =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const countRow = db.get(sql`
    SELECT COUNT(*) AS total FROM "VerifyRecord" ${where}
  `) as unknown as { total: number } | undefined;
  const total = Number(countRow?.total ?? 0);

  const rows = db.all(sql`
    SELECT * FROM "VerifyRecord"
    ${where}
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `) as unknown as {
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
  }[];

  return {
    list: rows.map((row) => ({
      id: Number(row.id),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      event: row.event,
      reason: row.reason || "",
      elapsedMs: row.elapsed_ms === null || row.elapsed_ms === undefined ? null : Number(row.elapsed_ms),
      difficulty: row.difficulty === null || row.difficulty === undefined ? null : Number(row.difficulty),
      challengeId: row.challenge_id || "",
      postSlug: row.post_slug || "",
      ipAddress: row.ip_address || "",
      country: row.country || "",
      network: row.network || "",
      asn: row.asn === null || row.asn === undefined ? null : Number(row.asn),
    })),
    total,
    page,
    pageSize,
  };
}
