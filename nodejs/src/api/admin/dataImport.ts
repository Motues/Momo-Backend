import type { Context } from "hono";
import { db, schema } from "../../orm/client";
import { setSetting } from "../../utils/settings";
import { checkKey, extractToken } from "../../utils/security";
import LogService from "../../utils/log";

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
      if (!item.postSlug && !item.post_slug) {
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
      if (!item.contentText && !item.content_text) {
        errors.push(`第 ${i + 1} 条缺少 contentText`);
        continue;
      }

      const data: Record<string, any> = {
        post_slug: item.postSlug || item.post_slug,
        author: item.author,
        email: item.email,
        content_text: item.contentText || item.content_text,
        content_html: item.contentHtml || item.content_html || item.contentText || item.content_text,
      };

      if (item.url) data.url = item.url;
      if (item.ip_address || item.ipAddress) data.ip_address = item.ip_address || item.ipAddress;
      if (item.os) data.os = item.os;
      if (item.browser) data.browser = item.browser;
      if (item.user_agent) data.user_agent = item.user_agent;
      if (item.parent_id || item.parentId) data.parent_id = item.parent_id || item.parentId;
      if (item.status) data.status = item.status;
      if (item.pub_date || item.pubDate) data.pub_date = new Date(item.pub_date || item.pubDate).getTime();

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
  ]);

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (allowedSettings.has(key) && value !== undefined && value !== null) {
      await setSetting(key, String(value));
      updated.push(key);
    }
  }

  LogService.info("Settings imported", updated);

  return c.json({
    code: 200,
    message: `设置导入完成，已更新 ${updated.length} 项`,
    data: { updated },
  });
}
