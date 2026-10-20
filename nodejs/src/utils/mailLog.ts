import { desc, eq, gte, like, or, and, count, sql } from "drizzle-orm";
import { db, schema } from "../orm/client";
import { getSetting } from "./settings";

/**
 * 外发邮件日志（管理面板「邮件管理」页的数据源）。
 *
 * 只记**真正尝试发送**的邮件：SMTP 未配置、邮件通知关闭导致的「跳过」不记
 * （那两次是在拿到配置之前就返回的），面板看的是「哪封信发出去了 / 哪封失败了」。
 *
 * 保留天数由设置项 `mail_log_retention_days` 决定（默认 30 天，0 = 永久保留）：
 * 写日志时顺手清理过期行（走 idx_ml_created），列表接口也只返回窗口内的行。
 */

/** 邮件类型（三端逐字一致；面板按它分类展示） */
export const MAIL_LOG_TYPES = [
  "verify",
  "link_sync",
  "dormant_notice",
  "comment_notify",
  "reply_notify",
  "test",
] as const;

export type MailLogType = (typeof MAIL_LOG_TYPES)[number];

export const MAIL_LOG_STATUSES = ["sent", "failed"] as const;
export type MailLogStatus = (typeof MAIL_LOG_STATUSES)[number];

/** 保留天数的设置键（面板「邮件通知设置 → 邮件记录」写入） */
export const MAIL_LOG_RETENTION_KEY = "mail_log_retention_days";
/** 默认保留天数（未配置 / 脏值时的回退值） */
export const MAIL_LOG_RETENTION_DAYS = 30;
/** 保留天数上限（与认证记录的保留天数同一口径） */
export const MAX_MAIL_LOG_RETENTION_DAYS = 3650;
/** 非法保留天数的错误文案（三端逐字一致） */
export const MAIL_LOG_RETENTION_ERROR = `mail_log_retention_days 必须是 0-${MAX_MAIL_LOG_RETENTION_DAYS} 之间的整数`;

/** 失败原因写库前截断，避免一条超长错误把行撑爆 */
const MAX_ERROR_LENGTH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 读取路径的保留天数归一化（宽容）：
 *
 * - 未配置 / 非整数（`""`、`abc`、`1.5`）→ 默认 30 天；
 * - `0` 或负数 → **永久保留**（不清理、列表不做时间下限）；
 * - 大于上限 → 夹取到 3650。
 */
export function resolveMailLogRetentionDays(raw: unknown): number {
  const text = String(raw ?? "").trim();
  if (text === "") return MAIL_LOG_RETENTION_DAYS;
  if (!/^-?\d+$/.test(text)) return MAIL_LOG_RETENTION_DAYS;
  const days = Number(text);
  if (!Number.isFinite(days)) return MAIL_LOG_RETENTION_DAYS;
  if (days <= 0) return 0;
  return Math.min(days, MAX_MAIL_LOG_RETENTION_DAYS);
}

/** 写入路径校验：0–3650 的十进制整数（`""` / 负数 / 小数 / 单位都不接受） */
export function validateMailLogRetentionDays(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return MAIL_LOG_RETENTION_ERROR;
  const days = Number(text);
  if (!Number.isFinite(days) || days > MAX_MAIL_LOG_RETENTION_DAYS) {
    return MAIL_LOG_RETENTION_ERROR;
  }
  return null;
}

/** 从设置读取当前生效的保留天数（0 = 永久保留） */
export async function getMailLogRetentionDays(): Promise<number> {
  return resolveMailLogRetentionDays(await getSetting(MAIL_LOG_RETENTION_KEY));
}

/** 保留窗口的起点；永久保留时返回 `null`（调用方据此跳过清理与时间下限） */
const retentionCutoff = (days: number, nowMs: number = Date.now()): string | null =>
  days > 0 ? new Date(nowMs - days * DAY_MS).toISOString() : null;

const errorMessage = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
};

/** 收件人统一成一行文本：多个收件人用 ", " 连接（一次实际发送 = 一行日志） */
export const formatMailRecipients = (to: string | string[]): string =>
  Array.isArray(to) ? to.join(", ") : String(to ?? "");

/**
 * 写一条邮件日志；失败只打服务端日志，**绝不影响发信结果**。
 * 顺手清理超过保留期的旧行（保留天数为 0 时不清）。
 */
export async function logMail(entry: {
  type: MailLogType;
  recipient: string;
  subject: string;
  status: MailLogStatus;
  error?: unknown;
}): Promise<void> {
  try {
    const nowMs = Date.now();
    const days = await getMailLogRetentionDays();
    db.insert(schema.mailLogs)
      .values({
        type: entry.type,
        recipient: String(entry.recipient ?? ""),
        subject: String(entry.subject ?? ""),
        status: entry.status,
        error: entry.status === "failed" ? errorMessage(entry.error) : null,
        created_at: new Date(nowMs).toISOString(),
      })
      .run();
    // 惰性清理：走 idx_ml_created 的范围删除，代价极低
    const cutoff = retentionCutoff(days, nowMs);
    if (cutoff) {
      db.run(sql`DELETE FROM "MailLog" WHERE "created_at" < ${cutoff}`);
    }
  } catch (error) {
    console.error("[mailLog] 写入邮件日志失败:", error);
  }
}

export interface MailLogListResult {
  list: {
    id: number;
    type: string;
    recipient: string;
    subject: string;
    status: string;
    error: string;
    createdAt: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
  retentionDays: number;
}

/**
 * 分页查询邮件日志（只读，面板用）。
 * `status` / `type` 传 `all`（或无法识别的值）表示不筛选；`search` 同时匹配收件人与主题。
 */
export async function listMailLogs(options: {
  page?: number;
  pageSize?: number;
  status?: string;
  type?: string;
  search?: string;
}): Promise<MailLogListResult> {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20));
  const statuses: readonly string[] = MAIL_LOG_STATUSES;
  // 枚举类查询参数统一 trim + 小写（与既有 verified / linkStatus 的宽容口径一致）
  const rawStatus = String(options.status ?? "").trim().toLowerCase();
  const rawType = String(options.type ?? "").trim().toLowerCase();
  const wantedStatus = statuses.includes(rawStatus) ? rawStatus : "all";
  const wantedType = (MAIL_LOG_TYPES as readonly string[]).includes(rawType) ? rawType : "all";
  const keyword = String(options.search ?? "").trim();

  const retentionDays = await getMailLogRetentionDays();
  const cutoff = retentionCutoff(retentionDays);
  const conditions = [];
  // 永久保留（0）时不加时间下限：面板能看到全部历史
  if (cutoff) conditions.push(gte(schema.mailLogs.created_at, cutoff));
  if (wantedStatus !== "all") conditions.push(eq(schema.mailLogs.status, wantedStatus));
  if (wantedType !== "all") conditions.push(eq(schema.mailLogs.type, wantedType));
  if (keyword !== "") {
    conditions.push(
      or(
        like(schema.mailLogs.recipient, `%${keyword}%`),
        like(schema.mailLogs.subject, `%${keyword}%`)
      )!
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ value: count() })
    .from(schema.mailLogs)
    .where(where)
    .all() as unknown as { value: number }[];
  const total = totalRow[0]?.value ?? 0;

  const rows = db
    .select()
    .from(schema.mailLogs)
    .where(where)
    .orderBy(desc(schema.mailLogs.created_at), desc(schema.mailLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all() as unknown as {
    id: number;
    type: string;
    recipient: string;
    subject: string;
    status: string;
    error: string | null;
    created_at: string;
  }[];

  return {
    list: rows.map((row) => ({
      id: row.id,
      type: row.type,
      recipient: row.recipient,
      subject: row.subject,
      status: row.status,
      error: row.error ?? "",
      createdAt: row.created_at,
    })),
    total,
    page,
    pageSize,
    retentionDays,
  };
}
