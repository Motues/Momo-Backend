import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getAllSettings } from '../../utils/settings';
import pkg from '../../../package.json';

export const exportSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const all = await getAllSettings(c.env);

  const allowList = new Set([
    "site_name", "admin_email",
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
  ]);

  const filtered: Record<string, string> = {};
  for (const key of allowList) {
    if (key in all) {
      filtered[key] = all[key];
    }
  }
  if (!("email_enabled" in filtered)) {
    filtered.email_enabled = "true";
  }

  return c.json({
    code: 200,
    message: "Settings exported",
    data: {
      exportedAt: new Date().toISOString(),
      type: "settings",
      version: pkg.version,
      settings: filtered,
    },
  });
};

export const exportComments = async (c: Context<{ Bindings: Bindings }>) => {
  const { results } = await c.env.MOMO_DB.prepare(
    "SELECT * FROM Comment ORDER BY pub_date ASC"
  ).all<any>();

  const comments = (results || []).map((row: any) => ({
    id: row.id,
    pubDate: row.pub_date,
    postSlug: row.post_slug,
    author: row.author,
    email: row.email,
    url: row.url || undefined,
    ipAddress: row.ip_address || "",
    os: row.os || "",
    browser: row.browser || "",
    contentText: row.content_text,
    contentHtml: row.content_html,
    parentId: row.parent_id || undefined,
    status: row.status,
  }));

  return c.json({
    code: 200,
    message: "Comments exported",
    data: {
      exportedAt: new Date().toISOString(),
      type: "comments",
      version: pkg.version,
      total: comments.length,
      comments,
    },
  });
};
