import type { Context } from "hono";
import { getAllSettings, setSetting } from "../../utils/settings";
import { sendTestEmail } from "../../utils/email";
import { checkKey, extractToken, isValidIpBlacklistJson } from "../../utils/security";
import { validateSpamSettings } from "../../utils/spam";
import { applyTrustProxySetting, hasTrustProxyEnvOverride } from "../../utils/ip";
import LogService from "../../utils/log";

// 敏感字段：读取时始终置空。comment_verify_secret 由系统自动生成，不对外开放读写
const SENSITIVE_KEYS = ["admin_password", "email_password", "admin_comment_key", "comment_verify_secret"];

// 可配置的字段白名单
const ALLOWED_SETTINGS = [
  "site_name", "admin_email", "admin_name",
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
  "comment_verify_enabled",
  "comment_verify_difficulty",
  "comment_verify_instr_enabled",
  "comment_verify_block_automated",
  // 认证记录（无感验证落库）：保留天数与「是否记录签发事件」
  "comment_verify_retention_days",
  "comment_verify_log_challenge",
  "trust_proxy",
];

// 按模块分组的设置键
const SETTINGS_GROUPS: Record<string, string[]> = {
  basic: ["site_name", "admin_email", "comment_auto_approve", "comment_spam_keywords", "comment_spam_max_links", "comment_spam_min_length", "comment_spam_duplicate_window", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"],
  email: ["smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "email_verify_enabled", "verify_base_url", "reply_template", "notification_template"],
  security: ["allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist", "comment_verify_enabled", "comment_verify_difficulty", "comment_verify_instr_enabled", "comment_verify_block_automated", "comment_verify_retention_days", "comment_verify_log_challenge", "trust_proxy"],
  account: ["admin_name"],
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

  const smtpChanged =
    ("smtp_host" in body) || ("smtp_port" in body) ||
    ("email_user" in body) || ("email_password" in body);

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // Bug fix: 邮箱密码为空时不覆盖已有密码
      if (key === "email_password" && String(value) === "") continue;
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
  const adminEmail = all["admin_email"] || "";
  if (!adminEmail) {
    return c.json({ code: 400, message: "Admin email is not configured. " }, 400);
  }

  try {
    await sendTestEmail(adminEmail);
    return c.json({ code: 200, message: "A test email has been sent" });
  } catch (e: any) {
    return c.json({ code: 400, message: "邮件发送失败，请检查 SMTP 配置" }, 400);
  }
}
