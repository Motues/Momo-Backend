import type { Context } from "hono";
import { getAllSettings } from "../../utils/settings";
import { buildExportedSettings } from "../../utils/settingsExport";
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

// 导出系统设置（含 admin_name；不含 admin_password/comment_verify_secret；敏感字段置空）
//
// 导出的是**完整快照**：全部 50 个可写设置键都会出现，库里没有的键按生效默认值补全
// （口径见 utils/settingsExport.ts 与 doc/vectors/settings-export-v1.json）。
// 这样备份能看出「没改过的设置」实际是什么（例如表情是否启用、来源是什么）。
export async function exportSettings(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const all = await getAllSettings();
  const { settings, sensitiveOmitted } = buildExportedSettings(all);

  return c.json({
    code: 200,
    message: "Settings exported. Sensitive fields (email_password, admin_comment_key) are blanked; please fill them in manually after importing.",
    data: {
      exportedAt: new Date().toISOString(),
      type: "settings",
      version: pkg.version,
      sensitiveOmitted,
      settings,
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
