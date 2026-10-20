import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken, sanitizeUrl } from "../../utils/security";
import { getSetting } from "../../utils/settings";
import { normalizeEmail } from "../../utils/adminEmails";
import {
  DAY_MS,
  LINK_DORMANT_DAYS_KEY,
  resolveDormantDays,
} from "../../utils/linkSecurity";
import LogService from "../../utils/log";

/**
 * 休眠链接的**人工确认**（见 doc/link_security.md 第 2.4 节）。
 *
 * 管理员在后台看过某条休眠链接、确认它没问题后写一条记录，该 `(邮箱, 网址)` 在
 * `expires_at` 之前不再被判为休眠；有效期 = 确认那一刻的 `link_dormant_days` 天，
 * 到期自动恢复休眠（无需定时任务：读取时实时判断）。
 *
 * 与「拉黑 / 移出黑名单」同一套风格：幂等、不依赖 link_security_enabled 是否开启
 * （功能关着时写入的记录在功能开启后依然按 expires_at 生效）。
 */

function checkAuth(c: Context): boolean {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  return !!key && checkKey(key);
}

/** 归一化 (email, url)：邮箱 trim + 小写；网址过 sanitizeUrl（只可能是 http/https/mailto/相对路径） */
function normalizePair(rawEmail: unknown, rawUrl: unknown): { email: string; url: string } {
  return {
    email: normalizeEmail(String(rawEmail ?? "")),
    url: sanitizeUrl(rawUrl),
  };
}

/**
 * 人工确认某条链接安全（幂等 upsert，重复确认只刷新到期时间）
 * POST /admin/links/trust  body: { email, url }
 */
export async function addLinkTrust(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const { email, url } = normalizePair(body?.email, body?.url);
  if (!email || !url) {
    return c.json({ code: 400, message: "email and url are required" }, 400);
  }

  // 有效期 = 确认时的 link_dormant_days 天（脏值回退 30、上限 3650）
  const days = resolveDormantDays(await getSetting(LINK_DORMANT_DAYS_KEY));
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + days * DAY_MS).toISOString();

  await CommentService.trustLink(email, url, expiresAt, createdAt);
  LogService.info("Link trust granted", { email, url, expiresAt });

  return c.json({
    code: 200,
    message: "Link trusted successfully",
    data: { email, url, expiresAt, days },
  });
}

/**
 * 撤销人工确认（幂等：本来就没有记录时返回 revoked: false）
 * DELETE /admin/links/trust?email=xxx&url=yyy
 */
export async function removeLinkTrust(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const { email, url } = normalizePair(c.req.query("email"), c.req.query("url"));
  if (!email || !url) {
    return c.json({ code: 400, message: "email and url are required" }, 400);
  }

  const revoked = await CommentService.revokeTrustedLink(email, url);
  if (revoked) LogService.info("Link trust revoked", { email, url });

  return c.json({
    code: 200,
    message: revoked ? "Link trust revoked" : "Link is not trusted",
    data: { email, url, revoked },
  });
}
