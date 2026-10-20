import { db, schema } from "./client";
import { eq, inArray, sql } from "drizzle-orm";
import { linkTrustKey } from "../utils/linkSecurity";

/**
 * 休眠链接**提醒邮件**的状态机存储（`DormantNotice` 表）。
 *
 * 见 `doc/link_security.md` 第 2.7 节：本仓库没有定时任务，提醒是在「有人读取公开评论列表」时
 * 惰性检测发出的；落一条记录保证**同一个休眠周期只提醒一次**，
 * 而该记录又被提醒页用作令牌（确认/改链接后即删除，所以旧邮件里的链接随之失效）。
 */

export interface DormantNoticeRow {
  id: number;
  email: string;
  url: string;
  last_comment_at: number;
  token: string;
  expires_at: string;
  notified_at: string;
  notify_count: number;
}

type RawRow = {
  id: number;
  email: string;
  url: string;
  last_comment_at: number;
  token: string;
  expires_at: string;
  notified_at: string;
  notify_count: number;
};

/**
 * 取这批 `(邮箱, 网址)` 已有的提醒记录（键用 linkTrustKey 的同一口径）。
 *
 * 按邮箱集合一次查询（本页涉及的邮箱），避免 N+1。
 */
export async function getDormantNoticesByEmailUrls(
  items: { email: string; url: string }[]
): Promise<Map<string, DormantNoticeRow>> {
  const result = new Map<string, DormantNoticeRow>();
  const emails = Array.from(
    new Set(items.map((item) => String(item.email ?? "").trim().toLowerCase()).filter(Boolean))
  );
  if (emails.length === 0) return result;

  const rows = db
    .select()
    .from(schema.dormantNotices)
    .where(inArray(schema.dormantNotices.email, emails))
    .all() as unknown as RawRow[];

  for (const row of rows) {
    result.set(linkTrustKey(row.email, row.url), {
      id: Number(row.id),
      email: String(row.email),
      url: String(row.url),
      last_comment_at: Number(row.last_comment_at),
      token: String(row.token),
      expires_at: String(row.expires_at),
      notified_at: String(row.notified_at),
      notify_count: Number(row.notify_count),
    });
  }
  return result;
}

/**
 * 写入 / 刷新一条提醒记录（同一 `(邮箱, 网址)` 只留一行）。
 *
 * 每次发提醒都会换新令牌并刷新有效期（新邮件里的链接有效，旧的自然失效），
 * `notify_count` 累加，便于观察「提醒了几次他才回来」。
 */
export async function upsertDormantNotice(input: {
  email: string;
  url: string;
  lastCommentAt: number;
  token: string;
  expiresAt: string;
  notifiedAt: string;
}): Promise<void> {
  db.run(
    sql`INSERT INTO "DormantNotice" ("email", "url", "last_comment_at", "token", "expires_at", "notified_at", "notify_count")
            VALUES (${input.email}, ${input.url}, ${input.lastCommentAt}, ${input.token}, ${input.expiresAt}, ${input.notifiedAt}, 1)
        ON CONFLICT("email", "url") DO UPDATE SET
            "last_comment_at" = ${input.lastCommentAt},
            "token" = ${input.token},
            "expires_at" = ${input.expiresAt},
            "notified_at" = ${input.notifiedAt},
            "notify_count" = "DormantNotice"."notify_count" + 1`
  );
}

/** 按令牌取提醒记录（提醒页用；令牌唯一） */
export async function findDormantNoticeByToken(
  token: string
): Promise<DormantNoticeRow | null> {
  const trimmed = String(token ?? "").trim();
  if (trimmed === "") return null;
  const rows = db
    .select()
    .from(schema.dormantNotices)
    .where(eq(schema.dormantNotices.token, trimmed))
    .limit(1)
    .all() as unknown as RawRow[];
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    email: String(row.email),
    url: String(row.url),
    last_comment_at: Number(row.last_comment_at),
    token: String(row.token),
    expires_at: String(row.expires_at),
    notified_at: String(row.notified_at),
    notify_count: Number(row.notify_count),
  };
}

/** 删除提醒记录（确认/改链接后调用：该令牌随即失效，且到期后会重新提醒） */
export async function deleteDormantNotice(id: number): Promise<void> {
  db.run(sql`DELETE FROM "DormantNotice" WHERE "id" = ${id}`);
}
