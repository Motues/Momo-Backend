import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { setSetting } from '../../utils/settings';
import { checkContent, sanitizeUrl, isValidIpBlacklistJson, MAX_CONTENT, MAX_AUTHOR, MAX_EMAIL, MAX_URL, MAX_POST_SLUG } from '../../utils/security';
import { parseMarkdown, sanitizeHtml } from '../../utils/markdown';
import { toMillis } from '../../utils/time';

// 导入时不允许用空值覆盖已有值的敏感字段
const SENSITIVE_SETTINGS = new Set(["email_password", "admin_comment_key"]);

export const importComments = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json<{ comments: Record<string, any>[] }>();
  if (!body?.comments || !Array.isArray(body.comments)) {
    return c.json({ code: 400, message: "请求体须包含 comments 数组" }, 400);
  }

  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < body.comments.length; i++) {
    const item = body.comments[i];
    try {
      if (!item.postSlug && !item.post_slug) { errors.push(`第 ${i + 1} 条缺少 postSlug`); continue; }
      if (!item.author) { errors.push(`第 ${i + 1} 条缺少 author`); continue; }
      if (!item.email) { errors.push(`第 ${i + 1} 条缺少 email`); continue; }
      if (!item.contentText && !item.content_text) { errors.push(`第 ${i + 1} 条缺少 contentText`); continue; }

      // 导入路径同样必须净化：数据可能来自不可信文件
      const postSlug = checkContent(String(item.postSlug || item.post_slug));
      const author = checkContent(String(item.author));
      const email = String(item.email);
      const rawContent = String(item.contentText || item.content_text);
      const contentText = checkContent(rawContent);

      if (
        postSlug.length > MAX_POST_SLUG ||
        author.length > MAX_AUTHOR ||
        email.length > MAX_EMAIL ||
        contentText.length > MAX_CONTENT ||
        (item.url && String(item.url).length > MAX_URL)
      ) {
        errors.push(`第 ${i + 1} 条字段超出长度限制`);
        continue;
      }

      // 不信任导入文件中的 contentHtml：统一由正文重新渲染并净化
      const contentHtml = sanitizeHtml(parseMarkdown(contentText));
      // pub_date 兼容毫秒整数与 ISO 字符串，无法解析时退回当前时间（三端契约一致）
      const pubDate = toMillis(item.pubDate ?? item.pub_date) ?? Date.now();
      // 缺省状态与三端表默认值对齐：pending（最安全）
      const status = item.status || 'pending';
      const parentId = item.parentId || item.parent_id || null;
      const url = sanitizeUrl(item.url) || null;
      const ipAddress = item.ipAddress || item.ip_address || null;
      const os = item.os || null;
      const browser = item.browser || null;

      await c.env.MOMO_DB.prepare(
        `INSERT INTO Comment (post_slug, author, email, url, ip_address, os, browser, content_text, content_html, parent_id, status, pub_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(postSlug, author, email, url, ipAddress, os, browser, contentText, contentHtml, parentId, status, pubDate).run();

      imported++;
    } catch (e: any) {
      console.error(`Import failed for comment #${i + 1}:`, e);
      errors.push(`第 ${i + 1} 条导入失败，请检查数据格式`);
    }
  }

  return c.json({
    code: 200,
    message: `导入完成，成功 ${imported} 条${errors.length ? `，失败 ${errors.length} 条` : ''}`,
    data: { imported, errors: errors.length > 0 ? errors : undefined },
  });
};

export const importSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json<Record<string, string>>();
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, message: "请提供有效的设置数据" }, 400);
  }

  const allowList = new Set([
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
    "trust_proxy",
  ]);

  if ("ip_blacklist" in body && !isValidIpBlacklistJson(String(body.ip_blacklist ?? ""))) {
    return c.json({ code: 400, message: "ip_blacklist must be a JSON array of valid IP or CIDR strings" }, 400);
  }

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!allowList.has(key) || value === undefined || value === null) continue;
    // 导出的敏感字段是空串：留空表示「未修改」，不得覆盖已有值
    if (SENSITIVE_SETTINGS.has(key) && String(value) === "") continue;
    await setSetting(c.env, key, String(value));
    updated.push(key);
  }

  return c.json({
    code: 200,
    message: `设置导入完成，已更新 ${updated.length} 项`,
    data: { updated },
  });
};
