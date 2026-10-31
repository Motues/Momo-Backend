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
import { sendTestEmail } from '../../utils/email';
import { isValidIpBlacklistJson } from '../../utils/security';
import { validateSpamSettings } from '../../utils/spam';
import {
  validateEmojiCdnUrl,
  validateEmojiCdnUrls,
  validateEmojiEnabled,
  normalizeEmojiEnabled,
} from '../../utils/emoji';
import {
  ADMIN_EMAILS_KEY,
  NOTIFY_EMAIL_KEY,
  getAdminConfig,
  validateAdminSettingsBody,
} from '../../utils/adminEmails';
import {
  LINK_DORMANT_DAYS_KEY,
  LINK_SWITCH_KEYS,
  normalizeSwitch,
  parseDormantDays,
  validateLinkSecuritySettings,
} from '../../utils/linkSecurity';

import {
  MAIL_LOG_RETENTION_KEY,
  resolveMailLogRetentionDays,
  validateMailLogRetentionDays,
} from '../../utils/mailLog';import {
  EMAIL_VERIFY_ENABLED_KEY,
  VERIFY_BASE_URL_KEY,
  hasApiUrlDependencyKey,
  normalizeEmailVerifyEnabled,
  normalizeVerifyBaseUrl,
  validateApiUrlDependents,
  validateEmailVerifyEnabled,
  validateVerifyBaseUrl,
} from '../../utils/verifySettings';

// 敏感字段：读取时始终置空。comment_verify_secret 由系统自动生成，不对外开放读写
const SENSITIVE_KEYS = new Set(["admin_password", "email_password", "admin_comment_key", "comment_verify_secret"]);

const ALLOWED_SETTINGS = new Set([
  "site_name", "admin_email", "admin_name",
  // 多管理员邮箱：列表（admin_emails）+ 通知收件人（notify_email），旧键 admin_email 保留
  "admin_emails", "notify_email",
  "smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
  "allow_origin", "email_enabled",
  "reply_template", "notification_template",
  "comment_auto_approve",
  // 审核自动化（垃圾规则）：与 comment_auto_approve 合并为一个开关
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
  // 外发邮件日志（面板「邮件管理」）的保留天数：0 = 永久保留
  "mail_log_retention_days",
  "comment_verify_enabled",
  "comment_verify_difficulty",
  "comment_verify_instr_enabled",
  "comment_verify_block_automated",
  // 来源域名绑定：复用 allow_origin 白名单，白名单不可用时 fail-closed
  "comment_verify_domain_enabled",
  // 认证记录（无感验证落库）：保留天数与「是否记录签发事件」
  "comment_verify_retention_days",
  "comment_verify_log_challenge",
  "trust_proxy",
  // 表情设置：启用开关 + OwO 格式的表情来源（多地址数组 + 兼容的旧单地址键，见 doc/emoji.md）
  "emoji_enabled",
  "emoji_cdn_url",
  "emoji_cdn_urls",
  // 评论区头像来源：开关 + 预设 / 自定义 URL 模板（见 doc/avatar.md）
  "avatar_enabled",
  "avatar_source",
  "avatar_custom_url",
  // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件（见 doc/link_security.md）
  "link_security_enabled",
  "link_dormant_days",
  "link_sync_enabled",
  "link_dormant_notice_enabled",
]);

const SETTINGS_GROUPS: Record<string, string[]> = {
  basic: ["site_name", "admin_email", "admin_emails", "notify_email", "verify_base_url", "email_verify_enabled", "comment_auto_approve", "comment_spam_keywords", "comment_spam_max_links", "comment_spam_min_length", "comment_spam_duplicate_window", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"],
  email: ["smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "email_verify_enabled", "verify_base_url", "mail_log_retention_days", "reply_template", "notification_template"],
  security: ["allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist", "comment_verify_enabled", "comment_verify_difficulty", "comment_verify_instr_enabled", "comment_verify_block_automated", "comment_verify_domain_enabled", "comment_verify_retention_days", "comment_verify_log_challenge", "trust_proxy"],
  account: ["admin_name"],
  // 表情设置：启用开关 + OwO 格式的表情来源地址（数组 + 兼容用的旧单地址）
  emoji: ["emoji_cdn_url", "emoji_cdn_urls", "emoji_enabled"],
  // 头像设置：开关 + 来源 + 自定义 URL 模板
  avatar: ["avatar_enabled", "avatar_source", "avatar_custom_url"],
  // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件
  link: ["link_security_enabled", "link_dormant_days", "link_sync_enabled", "link_dormant_notice_enabled"],
};

export const getSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const all = await getAllSettings(c.env);
  const type = c.req.query('type');

  let keys: string[];
  if (type && type in SETTINGS_GROUPS) {
    keys = SETTINGS_GROUPS[type];
  } else {
    keys = Array.from(ALLOWED_SETTINGS);
  }

  const filtered: Record<string, string> = {};
  for (const key of keys) {
    if (key in all) {
      filtered[key] = SENSITIVE_KEYS.has(key) ? "" : all[key];
    }
  }
  if (!("email_enabled" in filtered)) {
    filtered.email_enabled = "true";
  }
  // Worker 运行在 Cloudflare 边缘，客户端 IP 一律取自 Cloudflare 覆写的
  // cf-connecting-ip，页面上的 trust_proxy 开关在此环境下不生效
  if (keys.includes("trust_proxy")) {
    filtered.trust_proxy_override = "worker";
  }

  return c.json({ code: 200, message: "Settings fetched", data: filtered });
};

export const updateSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json() as Record<string, string>;
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, message: "Invalid request body" }, 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_SETTINGS.has(key)) {
      return c.json({ code: 400, message: `Setting "${key}" is not allowed` }, 400);
    }
  }

  // 黑名单格式校验：非法条目会让规则失效甚至误伤全部 IP，必须在入口拦下
  if ("ip_blacklist" in body && !isValidIpBlacklistJson(String(body.ip_blacklist ?? ""))) {
    return c.json({ code: 400, message: "ip_blacklist must be a JSON array of valid IP or CIDR strings" }, 400);
  }

  // 审核自动化规则同样必须在入口校验：一个非数字阈值或坏掉的关键词数组
  // 会让规则静默失效，甚至把全站评论都判为垃圾
  const spamError = validateSpamSettings(body);
  if (spamError) {
    return c.json({ code: 400, message: spamError }, 400);
  }

  // 表情设置（口径见 doc/emoji.md）：开关只接受 true/false，地址必须是 http/https
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

  // 头像来源（口径见 doc/avatar.md 第 6 节）：开关取值 + 来源 + 模板 + 跨键约束
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

  // 链接安全审查（口径见 doc/link_security.md）：开关只接受 true/false，天数必须是 1–3650 的整数
  const linkError = validateLinkSecuritySettings(body);
  if (linkError) {
    return c.json({ code: 400, message: linkError }, 400);
  }

  // API 地址与邮箱验证开关：空串允许；非空 URL 必须是 http(s) 绝对地址。
  // 依赖功能（邮箱验证 / 历史链接同步 / 休眠提醒）开启时，API 地址不得为空。
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

  // 多管理员邮箱（口径见 doc/admin_emails.md）：notify_email 必须在列表里
  const adminConfig = await getAdminConfig(c.env);
  const adminWrite = validateAdminSettingsBody(body, adminConfig.admins);
  if (adminWrite.error) {
    return c.json({ code: 400, message: adminWrite.error }, 400);
  }

  // 邮件日志保留天数（面板「邮件通知设置 → 邮件记录」）：0–3650 的整数，0 = 永久保留
  if ("mail_log_retention_days" in body) {
    const retentionError = validateMailLogRetentionDays(body.mail_log_retention_days);
    if (retentionError) {
      return c.json({ code: 400, message: retentionError }, 400);
    }
  }

  const smtpChanged = "smtp_host" in body || "smtp_port" in body || "email_user" in body || "email_password" in body;

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // Bug fix: 邮箱密码为空时不覆盖已有密码
      if (key === "email_password" && String(value) === "") continue;
      // 开关与地址都存归一化后的值：脏值（" TRUE " / 两侧带空格的 URL）会在前端炸
      if (key === "emoji_enabled") {
        await setSetting(c.env, key, normalizeEmojiEnabled(value));
        continue;
      }
      if (key === "emoji_cdn_url") {
        await setSetting(c.env, key, String(value).trim());
        continue;
      }
      if (key === "emoji_cdn_urls") {
        await setSetting(c.env, key, emojiCdnUrlsJson ?? '[]');
        continue;
      }
      // 头像来源：存归一化后的开关、来源值（空串 → default）与 trim 后的模板
      if (key === AVATAR_ENABLED_KEY) {
        await setSetting(c.env, key, normalizeAvatarEnabled(value));
        continue;
      }
      if (key === AVATAR_SOURCE_KEY) {
        await setSetting(c.env, key, normalizeAvatarSource(String(value)));
        continue;
      }
      if (key === AVATAR_CUSTOM_URL_KEY) {
        await setSetting(c.env, key, normalizeAvatarCustomUrl(value));
        continue;
      }
      if (key === ADMIN_EMAILS_KEY) {
        await setSetting(c.env, key, adminWrite.adminEmailsJson ?? '[]');
        continue;
      }
      if (key === NOTIFY_EMAIL_KEY) {
        await setSetting(c.env, key, adminWrite.notifyEmail ?? '');
        continue;
      }
      if (LINK_SWITCH_KEYS.includes(key as (typeof LINK_SWITCH_KEYS)[number])) {
        // 开关 fail-closed：写入时存归一化后的 "true" / "false" / ""
        await setSetting(c.env, key, normalizeSwitch(value));
        continue;
      }
      if (key === LINK_DORMANT_DAYS_KEY) {
        // 存**规范化后的十进制**（" 30 " / "0030" → "30"），与 Node/Go 一致
        await setSetting(c.env, key, String(parseDormantDays(value)));
        continue;
      }
      // 邮件日志保留天数：同样存规范化后的十进制（0 = 永久保留）
      if (key === MAIL_LOG_RETENTION_KEY) {
        await setSetting(c.env, key, String(resolveMailLogRetentionDays(value)));
        continue;
      }
      // API 地址：去空格与末尾斜杠后落库（格式已在上面校验）
      if (key === VERIFY_BASE_URL_KEY) {
        await setSetting(c.env, key, normalizeVerifyBaseUrl(value));
        continue;
      }
      // 邮箱验证开关：只存归一化后的 "true" / "false" / ""
      if (key === EMAIL_VERIFY_ENABLED_KEY) {
        await setSetting(c.env, key, normalizeEmailVerifyEnabled(value));
        continue;
      }
      // 旧键 admin_email：原样存储（不 trim、不做大小写归一），与 Node/Go 及 1.7.0 的写入语义一致；
      // 读取时统一走 normalizeEmail（trim + 小写）判定，所以两侧空格不影响任何行为
      if (key === "admin_email") {
        await setSetting(c.env, key, String(value));
        continue;
      }
      await setSetting(c.env, key, String(value));
    }
  }

  console.log("Settings updated:", Object.keys(body));

  return c.json({
    code: 200,
    message: "Settings updated. Some changes may require a restart to take full effect.",
    smtpChanged,
  });
};

export const testEmail = async (c: Context<{ Bindings: Bindings }>) => {
  // 收件人 = 解析后的 notify_email（未配置时回落到管理员列表第一个，见 doc/admin_emails.md 第 6 节）
  const notifyEmail = (await getAdminConfig(c.env)).notify;
  if (!notifyEmail) {
    return c.json({ code: 400, message: 'Admin email is not configured. ' }, 400);
  }

  try {
    await sendTestEmail(c.env, notifyEmail);
    return c.json({ code: 200, message: 'A test email has been sent' });
  } catch (e: any) {
    return c.json({ code: 400, message: '邮件发送失败，请检查 SMTP 配置' }, 400);
  }
};
