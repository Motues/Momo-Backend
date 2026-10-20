import type { Context } from "hono";
import { db, schema } from "../../orm/client";
import { setSetting } from "../../utils/settings";
import { checkKey, extractToken, checkContent, sanitizeUrl, sanitizeHtml, isValidIpBlacklistJson } from "../../utils/security";
import { validateSpamSettings } from "../../utils/spam";
import { normalizeEmojiCdnUrls, normalizeEmojiEnabled, validateEmojiCdnUrl, validateEmojiCdnUrls, validateEmojiEnabled } from "../../utils/emoji";
import {
  getAdminEmailList,
  normalizeAdminEmails,
  normalizeEmail,
  parseAdminEmails,
  validateAdminEmails,
  validateNotifyEmail,
} from "../../utils/adminEmails";
import {
  LINK_SWITCH_KEYS,
  normalizeLinkSwitch,
  resolveDormantDays,
  validateDormantDays,
  validateLinkSwitch,
} from "../../utils/linkSecurity";
import { parseMarkdown } from "../../utils/markdown";
import { resolveMailLogRetentionDays, validateMailLogRetentionDays } from "../../utils/mailLog";
import { applyTrustProxySetting } from "../../utils/ip";
import LogService from "../../utils/log";

// 字段长度上限（与公开提交路径一致）
const MAX_CONTENT = 2000;
const MAX_AUTHOR = 100;
const MAX_EMAIL = 254;
const MAX_URL = 500;
const MAX_POST_SLUG = 200;

// 导入时不允许用空值覆盖已有值的敏感字段
const SENSITIVE_SETTINGS = ["email_password", "admin_comment_key"];

/**
 * 解析导入数据中的 pub_date（C12 契约）：
 * 依次兼容毫秒整数、数字字符串与 ISO 字符串；无法解析时退回当前时间。
 */
function parsePubDate(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function checkAuth(c: Context): boolean {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    return false;
  }
  return true;
}

// 导入评论数据
export async function importComments(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = (await c.req.json()) as { comments: Record<string, any>[] };
  if (!body?.comments || !Array.isArray(body.comments)) {
    return c.json({ code: 400, message: "请求体须包含 comments 数组" }, 400);
  }

  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < body.comments.length; i++) {
    const item = body.comments[i];
    try {
      const postSlug = item.postSlug || item.post_slug;
      const rawText = item.contentText || item.content_text;

      if (!postSlug) {
        errors.push(`第 ${i + 1} 条缺少 postSlug`);
        continue;
      }
      if (!item.author) {
        errors.push(`第 ${i + 1} 条缺少 author`);
        continue;
      }
      if (!item.email) {
        errors.push(`第 ${i + 1} 条缺少 email`);
        continue;
      }
      if (!rawText) {
        errors.push(`第 ${i + 1} 条缺少 contentText`);
        continue;
      }

      // 导入路径同样必须走净化：这里的数据可能来自不可信文件
      const safeSlug = String(postSlug);
      const safeAuthor = checkContent(String(item.author));
      const safeEmail = String(item.email);
      const safeText = checkContent(String(rawText));

      if (
        safeSlug.length > MAX_POST_SLUG ||
        safeAuthor.length > MAX_AUTHOR ||
        safeEmail.length > MAX_EMAIL ||
        safeText.length > MAX_CONTENT ||
        (item.url && String(item.url).length > MAX_URL)
      ) {
        errors.push(`第 ${i + 1} 条字段超出长度限制`);
        continue;
      }

      const data: Record<string, any> = {
        post_slug: safeSlug,
        author: safeAuthor,
        email: safeEmail,
        content_text: safeText,
        // 不信任导入文件中的 content_html：统一由正文重新渲染并净化
        content_html: sanitizeHtml(await parseMarkdown(safeText)),
      };

      const safeUrl = sanitizeUrl(item.url);
      if (safeUrl) data.url = safeUrl;
      if (item.ip_address || item.ipAddress) data.ip_address = String(item.ip_address || item.ipAddress);
      if (item.os) data.os = String(item.os);
      if (item.browser) data.browser = String(item.browser);
      if (item.user_agent) data.user_agent = String(item.user_agent);
      if (item.parent_id || item.parentId) data.parent_id = item.parent_id || item.parentId;
      // 缺省状态与三端表默认值对齐：pending（最安全）
      data.status = item.status ? String(item.status) : "pending";
      // pub_date 兼容毫秒整数与 ISO 字符串，无法解析时退回当前时间
      if (item.pub_date !== undefined || item.pubDate !== undefined) {
        data.pub_date = parsePubDate(item.pub_date ?? item.pubDate);
      }

      await db.insert(schema.comments).values(data as any).run();
      imported++;
    } catch (e: any) {
      LogService.error(`Import failed for comment #${i + 1}`, e);
      errors.push(`第 ${i + 1} 条导入失败，请检查数据格式`);
    }
  }

  LogService.info(`Data import completed: ${imported} comments imported`);

  return c.json({
    code: 200,
    message: `导入完成，成功 ${imported} 条${errors.length ? `，失败 ${errors.length} 条` : ""}`,
    data: { imported, errors: errors.length > 0 ? errors : undefined },
  });
}

// 导入系统设置
export async function importSettings(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json();
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, message: "请提供有效的设置数据" }, 400);
  }

  const allowedSettings = new Set([
    "site_name",
    "admin_email",
    "admin_name",
    "smtp_host",
    "smtp_port",
    "email_user",
    "email_password",
    "email_secure",
    "allow_origin",
    "email_enabled",
    "reply_template",
    "notification_template",
    "comment_auto_approve",
    "comment_spam_keywords",
    "comment_spam_max_links",
    "comment_spam_min_length",
    "comment_spam_duplicate_window",
    "ip_blacklist",
    "email_blacklist",
    "blogger_badge_enabled",
    "blogger_badge_text",
    "placeholder_name",
    "placeholder_email",
    "placeholder_content",
    "placeholder_url",
    "admin_comment_key",
    "admin_comment_key_enabled",
    "email_verify_enabled",
    "verify_base_url",
    "mail_log_retention_days",
    "comment_verify_enabled",
    "comment_verify_difficulty",
    "comment_verify_instr_enabled",
    "comment_verify_block_automated",
    "comment_verify_domain_enabled",
    "comment_verify_retention_days",
    "comment_verify_log_challenge",
    "trust_proxy",
    "emoji_enabled",
    "emoji_cdn_url",
    "emoji_cdn_urls",
    "admin_emails",
    "notify_email",
    "link_security_enabled",
    "link_dormant_days",
    "link_sync_enabled",
    "link_dormant_notice_enabled",
  ]);

  if ("ip_blacklist" in body && !isValidIpBlacklistJson(String((body as any).ip_blacklist ?? ""))) {
    return c.json(
      { code: 400, message: "ip_blacklist must be a JSON array of valid IP or CIDR strings" },
      400
    );
  }

  // 图纸级校验：导入文件同样可能来自不可信来源
  const spamError = validateSpamSettings(body as Record<string, unknown>);
  if (spamError) {
    return c.json({ code: 400, message: spamError }, 400);
  }

  // 表情配置：导入文件同样不可信，必须逐项校验（口径见 doc/emoji.md）
  if ("emoji_enabled" in (body as Record<string, unknown>)) {
    const enabledError = validateEmojiEnabled((body as Record<string, unknown>).emoji_enabled);
    if (enabledError) {
      return c.json({ code: 400, message: enabledError }, 400);
    }
  }
  if ("emoji_cdn_url" in (body as Record<string, unknown>)) {
    const cdnError = validateEmojiCdnUrl((body as Record<string, unknown>).emoji_cdn_url);
    if (cdnError) {
      return c.json({ code: 400, message: cdnError }, 400);
    }
  }
  if ("emoji_cdn_urls" in (body as Record<string, unknown>)) {
    const cdnError = validateEmojiCdnUrls((body as Record<string, unknown>).emoji_cdn_urls);
    if (cdnError) {
      return c.json({ code: 400, message: cdnError }, 400);
    }
  }

  // 多管理员邮箱：导入文件同样不可信（口径见 doc/admin_emails.md）
  if ("admin_emails" in (body as Record<string, unknown>)) {
    const adminError = validateAdminEmails((body as Record<string, unknown>).admin_emails);
    if (adminError) {
      return c.json({ code: 400, message: adminError }, 400);
    }
  }

  // 链接安全审查：开关 fail-closed（含休眠提醒邮件开关）、天数 1–3650（口径见 doc/link_security.md）
  for (const switchKey of LINK_SWITCH_KEYS) {
    if (switchKey in (body as Record<string, unknown>)) {
      const linkError = validateLinkSwitch((body as Record<string, unknown>)[switchKey], switchKey);
      if (linkError) {
        return c.json({ code: 400, message: linkError }, 400);
      }
    }
  }
  if ("link_dormant_days" in (body as Record<string, unknown>)) {
    const daysError = validateDormantDays((body as Record<string, unknown>).link_dormant_days);
    if (daysError) {
      return c.json({ code: 400, message: daysError }, 400);
    }
  }

  // 邮件日志保留天数：与 PUT /admin/settings 同一套校验（0–3650，0 = 永久保留）
  if ("mail_log_retention_days" in (body as Record<string, unknown>)) {
    const retentionError = validateMailLogRetentionDays(
      (body as Record<string, unknown>).mail_log_retention_days
    );
    if (retentionError) {
      return c.json({ code: 400, message: retentionError }, 400);
    }
  }

  // 导入后的「管理员列表」用于校验通知邮箱：导入文件里带了 admin_emails 就用它，
  // 否则用库里当前的列表（与 PUT /admin/settings 同一口径）
  if ("notify_email" in (body as Record<string, unknown>)) {
    const bodyRecord = body as Record<string, unknown>;
    const effectiveAdmins =
      "admin_emails" in bodyRecord
        ? parseAdminEmails(normalizeAdminEmails(bodyRecord.admin_emails))
        : await getAdminEmailList();
    const notifyError = validateNotifyEmail(bodyRecord.notify_email, effectiveAdmins);
    if (notifyError) {
      return c.json({ code: 400, message: notifyError }, 400);
    }
  }

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!allowedSettings.has(key) || value === undefined || value === null) continue;
    // 导出的敏感字段是空串：留空表示「未修改」，不得覆盖已有值
    if (SENSITIVE_SETTINGS.includes(key) && String(value) === "") continue;
    // 与 PUT /admin/settings 一致：地址去空格、开关归一化为小写
    if (key === "emoji_cdn_url") {
      await setSetting(key, String(value).trim());
      updated.push(key);
      continue;
    }
    if (key === "emoji_enabled") {
      await setSetting(key, normalizeEmojiEnabled(value));
      updated.push(key);
      continue;
    }
    // 与 PUT /admin/settings 一致：数组键归一化后落库
    if (key === "emoji_cdn_urls") {
      await setSetting(key, normalizeEmojiCdnUrls(value));
      updated.push(key);
      continue;
    }
    if (key === "admin_emails") {
      await setSetting(key, normalizeAdminEmails(value));
      updated.push(key);
      continue;
    }
    if (key === "notify_email") {
      await setSetting(key, normalizeEmail(value));
      updated.push(key);
      continue;
    }
    if (LINK_SWITCH_KEYS.includes(key)) {
      await setSetting(key, normalizeLinkSwitch(value));
      updated.push(key);
      continue;
    }
    if (key === "link_dormant_days") {
      await setSetting(key, String(resolveDormantDays(value)));
      updated.push(key);
      continue;
    }
    // 邮件日志保留天数：存规范化后的十进制（0 = 永久保留）
    if (key === "mail_log_retention_days") {
      await setSetting(key, String(resolveMailLogRetentionDays(value)));
      updated.push(key);
      continue;
    }
    await setSetting(key, String(value));
    updated.push(key);
  }

  // 客户端 IP 识别策略需要立即生效
  if ("trust_proxy" in (body as Record<string, unknown>)) {
    applyTrustProxySetting(String((body as Record<string, unknown>).trust_proxy));
  }

  LogService.info("Settings imported", updated);

  return c.json({
    code: 200,
    message: `设置导入完成，已更新 ${updated.length} 项`,
    data: { updated },
  });
}
