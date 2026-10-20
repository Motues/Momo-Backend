import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting } from '../../utils/settings';
import { sanitizeUrl } from '../../utils/security';
import { normalizeEmail } from '../../utils/adminEmails';
import {
  DAY_MS,
  LINK_DORMANT_DAYS_KEY,
  parseDormantDays,
  revokeTrustedLink,
  upsertTrustedLink,
} from '../../utils/linkSecurity';

/**
 * 休眠链接的「人工确认」（TrustedLink，见 doc/link_security.md）。
 *
 * 管理员在后台把某条休眠链接确认成安全的，确认后该链接在 **N 天**内不再被判为休眠，
 * 到期自动恢复休眠（`N` = 确认那一刻读取归一化后的 `link_dormant_days`，默认 30）。
 *
 * 口径（三端逐字一致）：
 *  - `email` = trim + 小写；`url` = `sanitizeUrl(url)`（允许 http/https/mailto/相对路径）；
 *  - 任一归一化后为空 → 400 `email and url are required`；
 *  - 不要求 `link_security_enabled` 为开：功能关着时写入的记录在功能开启后依然生效。
 */

/** 两条参数校验错误文案（三端逐字一致） */
const REQUIRED_MESSAGE = 'email and url are required';

/**
 * POST /admin/links/trust  body: { email, url }
 *
 * 幂等 upsert：`(email, url)` 已有记录则刷新 `expires_at` / `created_at`（不新增行）。
 * 成功返回 `data: { email, url, expiresAt, days }`。
 */
export const trustLink = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const url = sanitizeUrl(body?.url);
  if (!email || !url) {
    return c.json({ code: 400, message: REQUIRED_MESSAGE }, 400);
  }

  // 天数按读取口径归一化（脏值回退 30、上限 3650），并在此刻定格
  const days = parseDormantDays(await getSetting(c.env, LINK_DORMANT_DAYS_KEY));
  const now = Date.now();
  const expiresAt = new Date(now + days * DAY_MS).toISOString();
  const createdAt = new Date(now).toISOString();

  await upsertTrustedLink(c.env, { email, url, expiresAt, createdAt, source: 'admin' });
  console.log(`[INFO] Link trusted: ${email} ${url} until ${expiresAt}`);

  return c.json({
    code: 200,
    message: 'Link trusted successfully',
    data: { email, url, expiresAt, days },
  });
};

/**
 * DELETE /admin/links/trust?email=&url=
 *
 * 撤销一条人工确认：删到记录 → `revoked: true`，本来就没有 → `revoked: false`（都是 200）。
 */
export const revokeLinkTrust = async (c: Context<{ Bindings: Bindings }>) => {
  const email = normalizeEmail(c.req.query('email'));
  const url = sanitizeUrl(c.req.query('url'));
  if (!email || !url) {
    return c.json({ code: 400, message: REQUIRED_MESSAGE }, 400);
  }

  const revoked = await revokeTrustedLink(c.env, email, url);
  if (revoked) {
    console.log(`[INFO] Link trust revoked: ${email} ${url}`);
    return c.json({
      code: 200,
      message: 'Link trust revoked',
      data: { email, url, revoked: true },
    });
  }

  return c.json({
    code: 200,
    message: 'Link is not trusted',
    data: { email, url, revoked: false },
  });
};
