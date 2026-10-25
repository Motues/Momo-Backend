import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getAllSettings } from '../../utils/settings';
import { buildExportedSettings } from '../../utils/settingsExport';
import { toIsoString } from '../../utils/time';
import pkg from '../../../package.json';

export const exportSettings = async (c: Context<{ Bindings: Bindings }>) => {
  const all = await getAllSettings(c.env);
  // 完整快照：全部 47 个可写设置键，库里没有的键按生效默认值补全
  // （口径见 utils/settingsExport.ts 与 doc/vectors/settings-export-v1.json）
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
