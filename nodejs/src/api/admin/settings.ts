import type { Context } from "hono";
import { getAllSettings, setSetting } from "../../utils/settings";
import { sendTestEmail } from "../../utils/email";
import { checkKey, extractToken, isValidIpBlacklistJson } from "../../utils/security";
import { validateSpamSettings } from "../../utils/spam";
import {
  normalizeEmojiCdnUrls,
  normalizeEmojiEnabled,
  validateEmojiCdnUrl,
  validateEmojiCdnUrls,
  validateEmojiEnabled,
} from "../../utils/emoji";
import {
  getAdminEmailList,
  normalizeAdminEmails,
  normalizeEmail,
  parseAdminEmails,
  resolveNotifyEmail,
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
import { applyTrustProxySetting, hasTrustProxyEnvOverride } from "../../utils/ip";
import { validateMailLogRetentionDays, resolveMailLogRetentionDays } from "../../utils/mailLog";
import LogService from "../../utils/log";

// 敏感字段：读取时始终置空。comment_verify_secret 由系统自动生成，不对外开放读写
const SENSITIVE_KEYS = ["admin_password", "email_password", "admin_comment_key", "comment_verify_secret"];

// 可配置的字段白名单
const ALLOWED_SETTINGS = [
  "site_name", "admin_email", "admin_emails", "notify_email", "admin_name",
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
  // 表情：是否启用 + OwO 格式的表情来源（数组，见 doc/emoji.md）
  "emoji_enabled",
  "emoji_cdn_url",
  "emoji_cdn_urls",
  // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件（见 doc/link_security.md）
  "link_security_enabled",
  "link_dormant_days",
  "link_sync_enabled",
  "link_dormant_notice_enabled",
];

// 按模块分组的设置键
const SETTINGS_GROUPS: Record<string, string[]> = {
  basic: ["site_name", "admin_email", "admin_emails", "notify_email", "comment_auto_approve", "comment_spam_keywords", "comment_spam_max_links", "comment_spam_min_length", "comment_spam_duplicate_window", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"],
  email: ["smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "email_verify_enabled", "verify_base_url", "mail_log_retention_days", "reply_template", "notification_template"],
  security: ["allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist", "comment_verify_enabled", "comment_verify_difficulty", "comment_verify_instr_enabled", "comment_verify_block_automated", "comment_verify_domain_enabled", "comment_verify_retention_days", "comment_verify_log_challenge", "trust_proxy"],
  account: ["admin_name"],
  // 表情设置：启用开关 + 表情来源列表（外加兼容用的单地址键）
  emoji: ["emoji_enabled", "emoji_cdn_urls", "emoji_cdn_url"],
  // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件
  link: ["link_security_enabled", "link_dormant_days", "link_sync_enabled", "link_dormant_notice_enabled"],
};

function checkAuth(c: Context): boolean {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    return false;
  }
  return true;
}

export async function getSettings(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }
  const all = await getAllSettings();
  const type = c.req.query("type");

  // 确定要返回的键列表
  // 必须用 hasOwnProperty 判断：`type in SETTINGS_GROUPS` 会命中 Object.prototype
  // 上的成员（toString / constructor / valueOf ...），使 keys 变成函数而非数组，
  // 下面的 for...of 随即抛 TypeError 并返回 500。
  let keys: string[];
  if (type && Object.prototype.hasOwnProperty.call(SETTINGS_GROUPS, type)) {
    keys = SETTINGS_GROUPS[type];
  } else {
    keys = ALLOWED_SETTINGS;
  }

  // 只返回白名单内的，且屏蔽敏感字段
  const filtered: Record<string, string> = {};
  for (const key of keys) {
    if (key in all) {
      filtered[key] = SENSITIVE_KEYS.includes(key) ? "" : all[key];
    }
  }
  // 始终返回 email_enabled 的默认值
  if (!("email_enabled" in filtered)) {
    filtered.email_enabled = "true";
  }
  // 告知前端该开关是否被环境变量强制指定（页面设置将不生效）
  if (keys.includes("trust_proxy") && hasTrustProxyEnvOverride()) {
    filtered.trust_proxy_override = "env";
  }

  return c.json({ code: 200, message: "Settings fetched", data: filtered });
}

export async function updateSettings(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }
  const body = await c.req.json() as Record<string, string>;
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, message: "Invalid request body" }, 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_SETTINGS.includes(key)) {
      return c.json({ code: 400, message: `Setting "${key}" is not allowed` }, 400);
    }
  }

  // 黑名单格式校验：非法条目会让规则失效甚至误伤全部 IP，必须在入口拦下
  if ("ip_blacklist" in body && !isValidIpBlacklistJson(String(body.ip_blacklist ?? ""))) {
    return c.json(
      { code: 400, message: "ip_blacklist must be a JSON array of valid IP or CIDR strings" },
      400
    );
  }

  // 审核自动化规则同样必须在入口校验：一个非数字阈值或坏掉的关键词数组
  // 会让规则静默失效，甚至把全站评论都判为垃圾
  const spamError = validateSpamSettings(body);
  if (spamError) {
    return c.json({ code: 400, message: spamError }, 400);
  }

  // 表情配置同样必须在入口校验：脏值会在公开接口下发时才暴露，这里拦下把问题定位在「保存」这一步
  // （口径见 doc/emoji.md，三端一致）
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
  if ("emoji_cdn_urls" in body) {
    const cdnError = validateEmojiCdnUrls(body.emoji_cdn_urls);
    if (cdnError) {
      return c.json({ code: 400, message: cdnError }, 400);
    }
  }

  // 多管理员邮箱：列表严格校验；通知邮箱必须命中列表
  // （同一次请求里带了 admin_emails 就用新列表判定，否则用库里的当前列表）
  if ("admin_emails" in body) {
    const adminError = validateAdminEmails(body.admin_emails);
    if (adminError) {
      return c.json({ code: 400, message: adminError }, 400);
    }
  }
  if ("notify_email" in body) {
    const effectiveAdmins =
      "admin_emails" in body
        ? parseAdminEmails(normalizeAdminEmails(body.admin_emails))
        : await getAdminEmailList();
    const notifyError = validateNotifyEmail(body.notify_email, effectiveAdmins);
    if (notifyError) {
      return c.json({ code: 400, message: notifyError }, 400);
    }
  }

  // 链接安全审查：开关 fail-closed（含休眠提醒邮件开关）、天数 1–3650
  for (const key of LINK_SWITCH_KEYS) {
    if (key in body) {
      const linkError = validateLinkSwitch(body[key], key);
      if (linkError) {
        return c.json({ code: 400, message: linkError }, 400);
      }
    }
  }
  if ("link_dormant_days" in body) {
    const daysError = validateDormantDays(body.link_dormant_days);
    if (daysError) {
      return c.json({ code: 400, message: daysError }, 400);
    }
  }

  // 邮件日志保留天数：0–3650 的整数（0 = 永久保留）
  if ("mail_log_retention_days" in body) {
    const retentionError = validateMailLogRetentionDays(body.mail_log_retention_days);
    if (retentionError) {
      return c.json({ code: 400, message: retentionError }, 400);
    }
  }

  const smtpChanged =
    ("smtp_host" in body) || ("smtp_port" in body) ||
    ("email_user" in body) || ("email_password" in body);

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // Bug fix: 邮箱密码为空时不覆盖已有密码
      if (key === "email_password" && String(value) === "") continue;
      // 地址两侧的空格会让前端 fetch 拿到一个畸形 URL，这里顺手归一化
      if (key === "emoji_cdn_url") {
        await setSetting(key, String(value).trim());
        continue;
      }
      // 开关统一存归一化后的小写值（口径见 doc/emoji.md 第 3.1 节）
      if (key === "emoji_enabled") {
        await setSetting(key, normalizeEmojiEnabled(value));
        continue;
      }
      // 表情来源列表：存归一化后的 JSON 数组（trim + 去空）
      if (key === "emoji_cdn_urls") {
        await setSetting(key, normalizeEmojiCdnUrls(value));
        continue;
      }
      // 管理员邮箱列表：存归一化（trim + 小写 + 去重）后的 JSON 数组
      if (key === "admin_emails") {
        await setSetting(key, normalizeAdminEmails(value));
        continue;
      }
      // 通知邮箱：trim + 小写后落库（是否命中列表已在上面校验）
      if (key === "notify_email") {
        await setSetting(key, normalizeEmail(value));
        continue;
      }
      // 链接安全开关（含休眠提醒邮件开关）：同样是归一化后的小写值
      if (LINK_SWITCH_KEYS.includes(key)) {
        await setSetting(key, normalizeLinkSwitch(value));
        continue;
      }
      // 休眠天数：合法整数（已校验）归一化后落库
      if (key === "link_dormant_days") {
        await setSetting(key, String(resolveDormantDays(value)));
        continue;
      }
      // 邮件日志保留天数：存规范化后的十进制（"030" / " 30 " → "30"，0 = 永久保留）
      if (key === "mail_log_retention_days") {
        await setSetting(key, String(resolveMailLogRetentionDays(value)));
        continue;
      }
      await setSetting(key, String(value));
    }
  }

  // 客户端 IP 识别策略需要立即生效，不能等缓存过期
  if (body.trust_proxy !== undefined) {
    applyTrustProxySetting(String(body.trust_proxy));
  }

  LogService.info("Settings updated", Object.keys(body));

  return c.json({
    code: 200,
    message: "Settings updated. Some changes may require a restart to take full effect.",
    smtpChanged,
  });
}

export async function testEmail(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const all = await getAllSettings();
  // 测试邮件发给**解析后的通知邮箱**（未配置时回落管理员列表第一个，见 doc/admin_emails.md 第 6 节）
  const target = resolveNotifyEmail(
    all["notify_email"],
    all["admin_emails"],
    all["admin_email"]
  );
  if (!target) {
    return c.json({ code: 400, message: "Admin email is not configured. " }, 400);
  }

  try {
    await sendTestEmail(target);
    return c.json({ code: 200, message: "A test email has been sent" });
  } catch (e: any) {
    return c.json({ code: 400, message: "邮件发送失败，请检查 SMTP 配置" }, 400);
  }
}
