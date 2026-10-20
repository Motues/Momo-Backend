import { db, schema } from "./client";
import { and, eq, gt, lt } from "drizzle-orm";
import { normalizeEmail } from "../utils/adminEmails";

/**
 * `LinkSyncRequest`（历史链接批量更新的待确认记录）的数据访问。
 *
 * 口径见 `doc/link_security.md` 第 3 节：
 *  - 同一邮箱**只保留一条有效待确认记录**（写新记录前先把旧的未确认记录删掉）；
 *  - 去重：同一邮箱 + 同一新网址已有未过期未确认记录时不再重复发信；
 *  - 令牌一次性（确认后 `confirmed = 1`），24 小时过期。
 */

export interface LinkSyncRequestRow {
  id: number;
  email: string;
  new_url: string;
  token: string;
  expires_at: string;
  confirmed: number;
  created_at: string;
}

/** 清掉该邮箱所有未确认的记录（新请求会作废旧邮件里的链接） */
export async function clearPendingLinkSyncRequests(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (normalized === "") return;
  await db
    .delete(schema.linkSyncRequests)
    .where(
      and(
        eq(schema.linkSyncRequests.email, normalized),
        eq(schema.linkSyncRequests.confirmed, 0)
      )
    )
    .run();
}

/** 同一邮箱 + 同一新网址是否已有未过期未确认的记录（用于去重，避免重复发信） */
export async function findPendingLinkSyncRequest(
  email: string,
  newUrl: string,
  now: string
): Promise<LinkSyncRequestRow | null> {
  const normalized = normalizeEmail(email);
  if (normalized === "" || !newUrl) return null;
  const rows = (await db
    .select()
    .from(schema.linkSyncRequests)
    .where(
      and(
        eq(schema.linkSyncRequests.email, normalized),
        eq(schema.linkSyncRequests.new_url, newUrl),
        eq(schema.linkSyncRequests.confirmed, 0),
        gt(schema.linkSyncRequests.expires_at, now)
      )
    )
    .limit(1)
    .all()) as unknown as LinkSyncRequestRow[];
  return rows[0] ?? null;
}

/** 按令牌 + 邮箱取记录（确认端点用：两者都必须匹配） */
export async function findLinkSyncRequest(
  token: string,
  email: string
): Promise<LinkSyncRequestRow | null> {
  const normalized = normalizeEmail(email);
  if (!token || normalized === "") return null;
  const rows = (await db
    .select()
    .from(schema.linkSyncRequests)
    .where(
      and(
        eq(schema.linkSyncRequests.token, token),
        eq(schema.linkSyncRequests.email, normalized)
      )
    )
    .limit(1)
    .all()) as unknown as LinkSyncRequestRow[];
  return rows[0] ?? null;
}

/** 新建一条待确认记录（调用方保证已清掉旧记录） */
export async function createLinkSyncRequest(input: {
  email: string;
  newUrl: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}): Promise<LinkSyncRequestRow> {
  const email = normalizeEmail(input.email);
  const result = await db
    .insert(schema.linkSyncRequests)
    .values({
      email,
      new_url: input.newUrl,
      token: input.token,
      expires_at: input.expiresAt,
      confirmed: 0,
      created_at: input.createdAt,
    })
    .run();
  const id = Number(result.lastInsertRowid);
  const rows = (await db
    .select()
    .from(schema.linkSyncRequests)
    .where(eq(schema.linkSyncRequests.id, id))
    .limit(1)
    .all()) as unknown as LinkSyncRequestRow[];
  if (rows.length === 0) throw new Error("Failed to create link sync request");
  return rows[0];
}

/** 标记已确认（单次使用） */
export async function markLinkSyncRequestConfirmed(id: number): Promise<void> {
  await db
    .update(schema.linkSyncRequests)
    .set({ confirmed: 1 })
    .where(eq(schema.linkSyncRequests.id, id))
    .run();
}

/** 惰性清理：删掉过期且未确认的记录（写路径顺手调用，避免表无限增长） */
export async function pruneExpiredLinkSyncRequests(now: string): Promise<void> {
  try {
    // expires_at 统一是 ISO 8601 UTC，字符串比较等价于时间比较
    await db
      .delete(schema.linkSyncRequests)
      .where(and(eq(schema.linkSyncRequests.confirmed, 0), lt(schema.linkSyncRequests.expires_at, now)))
      .run();
  } catch {
    // 清理失败不影响主流程
  }
}
