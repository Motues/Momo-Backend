import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { toIsoString } from '../../utils/time';
import { getAllSettings } from '../../utils/settings';
import {
  AVATAR_CUSTOM_URL_KEY,
  AVATAR_SOURCE_KEY,
  buildAvatarUrl,
  resolveAvatarConfig
} from '../../utils/avatar';

export const userComments = async (c: Context<{ Bindings: Bindings }>) => {
  const author = c.req.query('author');
  const email = c.req.query('email');
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = 10;
  const offset = (page - 1) * limit;

  if (!author || !email) {
    return c.json({ code: 400, message: "author and email are required" }, 400);
  }

  const totalCount = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment WHERE author = ? AND email = ?"
  ).bind(author, email).first<{ count: number }>();

  const { results } = await c.env.MOMO_DB.prepare(
    "SELECT * FROM Comment WHERE author = ? AND email = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?"
  ).bind(author, email, limit, offset).all();

  // 后台列表的头像不受 avatar_enabled 影响（开关只约束访客可见结果），来源配置与公开列表同一套
  const settings = await getAllSettings(c.env);
  const avatarConfig = resolveAvatarConfig(
    settings[AVATAR_SOURCE_KEY],
    settings[AVATAR_CUSTOM_URL_KEY]
  );
  // 与公开列表一致：哈希失败只让该行退回空头像，不让整个后台列表 500
  const avatarOf = (email: unknown, author: unknown) =>
    buildAvatarUrl(avatarConfig, String(email ?? ''), String(author ?? '')).catch(() => '');

  const comments = await Promise.all((results || []).map(async (row: any) => ({
    id: row.id,
    // pub_date 在库里是毫秒整数，响应契约统一为 ISO 字符串（与 Node/Go 一致）
    pubDate: toIsoString(row.pub_date),
    postSlug: row.post_slug,
    author: row.author,
    email: row.email,
    url: row.url,
    avatar: await avatarOf(row.email, row.author),
    ipAddress: row.ip_address,
    os: row.os,
    browser: row.browser,
    contentText: row.content_text,
    contentHtml: row.content_html,
    status: row.status
  })));

  return c.json({
    code: 200,
    message: "User comments fetched successfully",
    data: {
      comments,
      pagination: {
        page,
        limit,
        totalPage: Math.ceil((totalCount?.count || 0) / limit)
      }
    }
  });
};
