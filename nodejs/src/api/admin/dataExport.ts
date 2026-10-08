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
    comment_verify_enabled: true,
    comment_verify_difficulty: true,
    trust_proxy: true,
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
