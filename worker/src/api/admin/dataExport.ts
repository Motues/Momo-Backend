import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getAllSettings } from '../../utils/settings';
import { toIsoString } from '../../utils/time';
import pkg from '../../../package.json';

// 导出时置空的敏感字段：避免 SMTP 密码 / 博主密钥以明文落盘
const SENSITIVE_EXPORT_KEYS = new Set(["email_password", "admin_comment_key"]);

export const exportSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const all = await getAllSettings(c.env);

  const allowList = new Set([
    "site_name", "admin_email", "admin_name",
    // 多管理员邮箱：列表 + 通知收件人（旧键 admin_email 保留）
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
    // 外发邮件日志保留天数（非敏感）：0 = 永久保留
    "mail_log_retention_days",
    "comment_verify_enabled",
    "comment_verify_difficulty",
    "comment_verify_instr_enabled",
    "comment_verify_block_automated",
    "comment_verify_domain_enabled",
    "comment_verify_retention_days",
    "comment_verify_log_challenge",
    "trust_proxy",
    // 表情设置：启用开关 + OwO 格式的表情来源（数组 + 兼容用的旧单地址，非敏感，正常导出）
    "emoji_cdn_url",
    "emoji_cdn_urls",
    "emoji_enabled",
    // 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件
    "link_security_enabled",
    "link_dormant_days",
    "link_sync_enabled",
    "link_dormant_notice_enabled",
  ]);

  const filtered: Record<string, string> = {};
  const sensitiveOmitted: string[] = [];
  for (const key of allowList) {
    if (key in all) {
      if (SENSITIVE_EXPORT_KEYS.has(key)) {
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
};

export const exportComments = async (c: Context<{ Bindings: Bindings }>) => {
  const { results } = await c.env.MOMO_DB.prepare(
    "SELECT * FROM Comment ORDER BY pub_date ASC"
  ).all<any>();

  const comments = (results || []).map((row: any) => ({
    id: row.id,
    // 与 Node/Go 一致：导出 ISO 字符串（pub_date 在库里是毫秒整数）
    pubDate: toIsoString(row.pub_date),
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
