import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getAllSettings, getSetting, setSetting } from '../../utils/settings';
import {
  AVATAR_CUSTOM_URL_KEY,
  AVATAR_ENABLED_KEY,
  AVATAR_SOURCE_KEY,
  normalizeAvatarCustomUrl,
  normalizeAvatarEnabled,
  normalizeAvatarSource,
  validateAvatarSettings,
} from '../../utils/avatar';
import { checkContent, sanitizeUrl, isValidIpBlacklistJson, MAX_CONTENT, MAX_AUTHOR, MAX_EMAIL, MAX_URL, MAX_POST_SLUG } from '../../utils/security';
import { parseMarkdown, sanitizeHtml } from '../../utils/markdown';
import { validateSpamSettings } from '../../utils/spam';
import {
  validateEmojiCdnUrl,
  validateEmojiCdnUrls,
  validateEmojiEnabled,
  normalizeEmojiEnabled,
} from '../../utils/emoji';
import { getAdminConfig, validateAdminSettingsBody, ADMIN_EMAILS_KEY, NOTIFY_EMAIL_KEY } from '../../utils/adminEmails';
import {
  LINK_SWITCH_KEYS,
  LINK_DORMANT_DAYS_KEY,
  normalizeSwitch,
  parseDormantDays,
  validateLinkSecuritySettings,
} from '../../utils/linkSecurity';
import { toMillis } from '../../utils/time';
import {
  MAIL_LOG_RETENTION_KEY,
  resolveMailLogRetentionDays,
  validateMailLogRetentionDays,
} from '../../utils/mailLog';
import {
  EMAIL_VERIFY_ENABLED_KEY,
  VERIFY_BASE_URL_KEY,
  hasApiUrlDependencyKey,
  normalizeEmailVerifyEnabled,
  normalizeVerifyBaseUrl,
  validateApiUrlDependents,
  validateEmailVerifyEnabled,
  validateVerifyBaseUrl,
} from '../../utils/verifySettings';

// 导入时不允许用空值覆盖已有值的敏感字段
const SENSITIVE_SETTINGS = new Set(["email_password", "admin_comment_key"]);

export const importComments = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json<{ comments: Record<string, any>[] }>();
  if (!body?.comments || !Array.isArray(body.comments)) {
    return c.json({ code: 400, message: "请求体须包含 comments 数组" }, 400);
  }

  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < body.comments.length; i++) {
    const item = body.comments[i];
    try {
      if (!item.postSlug && !item.post_slug) { errors.push(`第 ${i + 1} 条缺少 postSlug`); continue; }
      if (!item.author) { errors.push(`第 ${i + 1} 条缺少 author`); continue; }
      if (!item.email) { errors.push(`第 ${i + 1} 条缺少 email`); continue; }
      if (!item.contentText && !item.content_text) { errors.push(`第 ${i + 1} 条缺少 contentText`); continue; }

      // 导入路径同样必须净化：数据可能来自不可信文件
      const postSlug = checkContent(String(item.postSlug || item.post_slug));
      const author = checkContent(String(item.author));
      const email = String(item.email);
      const rawContent = String(item.contentText || item.content_text);
      const contentText = checkContent(rawContent);

      if (
        postSlug.length > MAX_POST_SLUG ||
        author.length > MAX_AUTHOR ||
        email.length > MAX_EMAIL ||
        contentText.length > MAX_CONTENT ||
        (item.url && String(item.url).length > MAX_URL)
      ) {
        errors.push(`第 ${i + 1} 条字段超出长度限制`);
        continue;
      }

      // 不信任导入文件中的 contentHtml：统一由正文重新渲染并净化
      const contentHtml = sanitizeHtml(parseMarkdown(contentText));
      // pub_date 兼容毫秒整数与 ISO 字符串，无法解析时退回当前时间（三端契约一致）
      const pubDate = toMillis(item.pubDate ?? item.pub_date) ?? Date.now();
      // 缺省状态与三端表默认值对齐：pending（最安全）
      const status = item.status || 'pending';
      const parentId = item.parentId || item.parent_id || null;
      const url = sanitizeUrl(item.url) || null;
      const ipAddress = item.ipAddress || item.ip_address || null;
      const os = item.os || null;
      const browser = item.browser || null;

      await c.env.MOMO_DB.prepare(
        `INSERT INTO Comment (post_slug, author, email, url, ip_address, os, browser, content_text, content_html, parent_id, status, pub_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(postSlug, author, email, url, ipAddress, os, browser, contentText, contentHtml, parentId, status, pubDate).run();

      imported++;
    } catch (e: any) {
      console.error(`Import failed for comment #${i + 1}:`, e);
      errors.push(`第 ${i + 1} 条导入失败，请检查数据格式`);
    }
  }

  return c.json({
    code: 200,
    message: `导入完成，成功 ${imported} 条${errors.length ? `，失败 ${errors.length} 条` : ''}`,
    data: { imported, errors: errors.length > 0 ? errors : undefined },
  });
};

export const importSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json<Record<string, string>>();
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, message: "请提供有效的设置数据" }, 400);
  }

  const allowList = new Set([
    "site_name", "admin_email", "admin_name",
    "admin_emails", "notify_email",
    "smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
    "allow_origin", "email_enabled",
    "reply_template", "notification_template",
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
    "emoji_cdn_url",
    "emoji_cdn_urls",
    "emoji_enabled",
    "avatar_enabled",
    "avatar_source",
    "avatar_custom_url",
    "link_security_enabled",
    "link_dormant_days",
    "link_sync_enabled",
    "link_dormant_notice_enabled",
  ]);

  if ("ip_blacklist" in body && !isValidIpBlacklistJson(String(body.ip_blacklist ?? ""))) {
    return c.json({ code: 400, message: "ip_blacklist must be a JSON array of valid IP or CIDR strings" }, 400);
  }

  // 导入文件可能来自不可信来源：审核自动化规则同样要在入口校验
  const spamError = validateSpamSettings(body);
  if (spamError) {
    return c.json({ code: 400, message: spamError }, 400);
  }

  // 表情设置：导入文件同样不可信，必须与 PUT /admin/settings 同一套校验（口径见 doc/emoji.md）
  if ("emoji_enabled" in body) {
    const enabledError = validateEmojiEnabled(body.emoji_enabled);
    if (enabledError) {
      return c.json({ code: 400, message: enabledError }, 400);
    }
  }
  if ("emoji_cdn_url" in body) {
    const cdnError = validateEmojiCdnUrl(body.emoji_cdn_url);
    if (cdnError) {
      return c.json({ code: 400, message: cdnError }, 400);
    }
  }
  let emojiCdnUrlsJson: string | undefined;
  if ("emoji_cdn_urls" in body) {
    const result = validateEmojiCdnUrls(body.emoji_cdn_urls);
    if (result.error) {
      return c.json({ code: 400, message: result.error }, 400);
    }
    emojiCdnUrlsJson = JSON.stringify(result.urls);
  }

  // 头像来源：与 PUT /admin/settings 同一套校验（口径见 doc/avatar.md 第 6 节）
  if (AVATAR_ENABLED_KEY in body || AVATAR_SOURCE_KEY in body || AVATAR_CUSTOM_URL_KEY in body) {
    const avatarError = validateAvatarSettings(
      {
        enabled: AVATAR_ENABLED_KEY in body ? body[AVATAR_ENABLED_KEY] : undefined,
        source: AVATAR_SOURCE_KEY in body ? body[AVATAR_SOURCE_KEY] : undefined,
        customUrl: AVATAR_CUSTOM_URL_KEY in body ? body[AVATAR_CUSTOM_URL_KEY] : undefined,
      },
      {
        source: await getSetting(c.env, AVATAR_SOURCE_KEY),
        customUrl: await getSetting(c.env, AVATAR_CUSTOM_URL_KEY),
      }
    );
    if (avatarError) {
      return c.json({ code: 400, message: avatarError }, 400);
    }
  }

  // 链接安全审查：与 PUT /admin/settings 同一套校验（口径见 doc/link_security.md）
  const linkError = validateLinkSecuritySettings(body);
  if (linkError) {
    return c.json({ code: 400, message: linkError }, 400);
  }

  // API 地址与邮箱验证开关：与 PUT /admin/settings 同一套校验
  if (VERIFY_BASE_URL_KEY in body) {
    const baseUrlError = validateVerifyBaseUrl(body[VERIFY_BASE_URL_KEY]);
    if (baseUrlError) {
      return c.json({ code: 400, message: baseUrlError }, 400);
    }
  }
  if (EMAIL_VERIFY_ENABLED_KEY in body) {
    const verifyError = validateEmailVerifyEnabled(body[EMAIL_VERIFY_ENABLED_KEY]);
    if (verifyError) {
      return c.json({ code: 400, message: verifyError }, 400);
    }
  }
  if (hasApiUrlDependencyKey(body)) {
    const dependencyError = validateApiUrlDependents(body, await getAllSettings(c.env));
    if (dependencyError) {
      return c.json({ code: 400, message: dependencyError }, 400);
    }
  }

  // 邮件日志保留天数：与 PUT /admin/settings 同一套校验（0–3650，0 = 永久保留）
  if ("mail_log_retention_days" in body) {
    const retentionError = validateMailLogRetentionDays(body.mail_log_retention_days);
    if (retentionError) {
      return c.json({ code: 400, message: retentionError }, 400);
    }
  }

  // 多管理员邮箱：与 PUT /admin/settings 同一套校验（口径见 doc/admin_emails.md）
  const adminConfig = await getAdminConfig(c.env);
  const adminWrite = validateAdminSettingsBody(body, adminConfig.admins);
  if (adminWrite.error) {
    return c.json({ code: 400, message: adminWrite.error }, 400);
  }

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!allowList.has(key) || value === undefined || value === null) continue;
    // 导出的敏感字段是空串：留空表示「未修改」，不得覆盖已有值
    if (SENSITIVE_SETTINGS.has(key) && String(value) === "") continue;
    // 与 PUT /admin/settings 一致：存归一化后的值（开关小写、地址去空格、列表重新序列化）
    if (key === "emoji_enabled") await setSetting(c.env, key, normalizeEmojiEnabled(value));
    else if (key === "emoji_cdn_url") await setSetting(c.env, key, String(value).trim());
    else if (key === "emoji_cdn_urls") await setSetting(c.env, key, emojiCdnUrlsJson ?? '[]');
    else if (key === AVATAR_ENABLED_KEY) await setSetting(c.env, key, normalizeAvatarEnabled(value));
    else if (key === AVATAR_SOURCE_KEY) await setSetting(c.env, key, normalizeAvatarSource(String(value)));
    else if (key === AVATAR_CUSTOM_URL_KEY) await setSetting(c.env, key, normalizeAvatarCustomUrl(value));
    else if (key === ADMIN_EMAILS_KEY) await setSetting(c.env, key, adminWrite.adminEmailsJson ?? '[]');
    else if (key === NOTIFY_EMAIL_KEY) await setSetting(c.env, key, adminWrite.notifyEmail ?? '');
    else if (LINK_SWITCH_KEYS.includes(key as (typeof LINK_SWITCH_KEYS)[number])) {
      await setSetting(c.env, key, normalizeSwitch(value));
    } else if (key === LINK_DORMANT_DAYS_KEY) await setSetting(c.env, key, String(parseDormantDays(value)));
    else if (key === MAIL_LOG_RETENTION_KEY) {
      await setSetting(c.env, key, String(resolveMailLogRetentionDays(value)));
    } else if (key === VERIFY_BASE_URL_KEY) await setSetting(c.env, key, normalizeVerifyBaseUrl(value));
    else if (key === EMAIL_VERIFY_ENABLED_KEY) await setSetting(c.env, key, normalizeEmailVerifyEnabled(value));
    else if (key === "admin_email") await setSetting(c.env, key, String(value));
    else await setSetting(c.env, key, String(value));
    updated.push(key);
  }

  return c.json({
    code: 200,
    message: `设置导入完成，已更新 ${updated.length} 项`,
    data: { updated },
  });
};
