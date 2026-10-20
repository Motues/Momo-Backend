import type { Context } from "hono";
import { getAllSettings } from "../../utils/settings";
import { db, schema } from "../../orm/client";
import { asc } from "drizzle-orm";
import { checkKey, extractToken } from "../../utils/security";
import pkg from "../../../package.json";

function checkAuth(c: Context): boolean {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    return false;
  }
  return true;
}

// 导出时置空的敏感字段：避免 SMTP 密码 / 博主密钥以明文落盘
const SENSITIVE_EXPORT_KEYS = ["email_password", "admin_comment_key"];

// 导出系统设置（含 admin_name；不含 admin_password/comment_verify_secret；敏感字段置空）
export async function exportSettings(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const all = await getAllSettings();

  const allowList: Record<string, boolean> = {
    site_name: true,
    admin_email: true,
    // 与 Go/Worker 一致：导出管理员用户名，保证「导出 → 导入」往返后管理员身份不丢
    admin_name: true,
    smtp_host: true,
    smtp_port: true,
    email_user: true,
    email_password: true,
    email_secure: true,
    allow_origin: true,
    email_enabled: true,
    reply_template: true,
    notification_template: true,
    comment_auto_approve: true,
    comment_spam_keywords: true,
    comment_spam_max_links: true,
    comment_spam_min_length: true,
    comment_spam_duplicate_window: true,
    ip_blacklist: true,
    email_blacklist: true,
    blogger_badge_enabled: true,
    blogger_badge_text: true,
    placeholder_name: true,
    placeholder_email: true,
    placeholder_content: true,
    placeholder_url: true,
    admin_comment_key: true,
    admin_comment_key_enabled: true,
    email_verify_enabled: true,
    verify_base_url: true,
    // 外发邮件日志保留天数（非敏感）：0 = 永久保留
    mail_log_retention_days: true,
    comment_verify_enabled: true,
    comment_verify_difficulty: true,
    comment_verify_instr_enabled: true,
    comment_verify_block_automated: true,
    comment_verify_domain_enabled: true,
    comment_verify_retention_days: true,
    comment_verify_log_challenge: true,
    trust_proxy: true,
    // 表情设置：启用开关 + 表情来源列表/单地址（非敏感，正常导出）
    emoji_enabled: true,
    emoji_cdn_url: true,
    emoji_cdn_urls: true,
    // 多管理员邮箱与通知收件人（非敏感，正常导出）
    admin_emails: true,
    notify_email: true,
    // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件
    link_security_enabled: true,
    link_dormant_days: true,
    link_sync_enabled: true,
    link_dormant_notice_enabled: true,
  };

  const filtered: Record<string, string> = {};
  const sensitiveOmitted: string[] = [];
  for (const key of Object.keys(allowList)) {
    if (key in all) {
      if (SENSITIVE_EXPORT_KEYS.includes(key)) {
        filtered[key] = "";
        if (all[key]) sensitiveOmitted.push(key);
      } else {
        filtered[key] = all[key];
      }
    }
  }
  if (!("email_enabled" in filtered)) {
    filtered.email_enabled = "true";
  }

  return c.json({
    code: 200,
    message: "Settings exported. Sensitive fields (email_password, admin_comment_key) are blanked; please fill them in manually after importing.",
    data: {
      exportedAt: new Date().toISOString(),
      type: "settings",
      version: pkg.version,
      sensitiveOmitted,
      settings: filtered,
    },
  });
}

// 导出评论数据
export async function exportComments(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const rows = db
    .select()
    .from(schema.comments)
    .orderBy(asc(schema.comments.pub_date))
    .all();

  const mapped = rows.map((c: any) => ({
    id: c.id,
    pubDate: new Date(c.pub_date).toISOString(),
    postSlug: c.post_slug,
    author: c.author,
    email: c.email,
    url: c.url || undefined,
    ipAddress: c.ip_address || "",
    os: c.os || "",
    browser: c.browser || "",
    contentText: c.content_text,
    contentHtml: c.content_html,
    parentId: c.parent_id || undefined,
    status: c.status,
  }));

  return c.json({
    code: 200,
    message: "Comments exported",
    data: {
      exportedAt: new Date().toISOString(),
      type: "comments",
      version: pkg.version,
      total: mapped.length,
      comments: mapped,
    },
  });
}
