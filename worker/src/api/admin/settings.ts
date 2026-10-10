import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getAllSettings, getSetting, setSetting } from '../../utils/settings';
import { sendTestEmail } from '../../utils/email';
import { isValidIpBlacklistJson } from '../../utils/security';

// 敏感字段：读取时始终置空。comment_verify_secret 由系统自动生成，不对外开放读写
const SENSITIVE_KEYS = new Set(["admin_password", "email_password", "admin_comment_key", "comment_verify_secret"]);

const ALLOWED_SETTINGS = new Set([
  "site_name", "admin_email", "admin_name",
  "smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
  "allow_origin", "email_enabled",
  "reply_template", "notification_template",
  "comment_auto_approve",
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
]);

const SETTINGS_GROUPS: Record<string, string[]> = {
  basic: ["site_name", "admin_email", "comment_auto_approve", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"],
  email: ["smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "email_verify_enabled", "verify_base_url", "reply_template", "notification_template"],
  security: ["allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist", "comment_verify_enabled", "comment_verify_difficulty", "comment_verify_instr_enabled", "comment_verify_block_automated", "comment_verify_retention_days", "comment_verify_log_challenge", "trust_proxy"],
  account: ["admin_name"],
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

  const smtpChanged = "smtp_host" in body || "smtp_port" in body || "email_user" in body || "email_password" in body;

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // Bug fix: 邮箱密码为空时不覆盖已有密码
      if (key === "email_password" && String(value) === "") continue;
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
  const adminEmail = await getSetting(c.env, "admin_email");
  if (!adminEmail) {
    return c.json({ code: 400, message: 'Admin email is not configured. ' }, 400);
  }

  try {
    await sendTestEmail(c.env, adminEmail);
    return c.json({ code: 200, message: 'A test email has been sent' });
  } catch (e: any) {
    return c.json({ code: 400, message: '邮件发送失败，请检查 SMTP 配置' }, 400);
  }
};
