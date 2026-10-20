import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { toIsoString } from '../../utils/time';

/**
 * 评论列表（GET /admin/comments/list）
 *
 * 查询参数：
 *  - page：页码，默认 1
 *  - status：状态精确匹配（approved / pending / rejected / deleted），空值不筛选
 *  - postSlug：文章标识**精确匹配**（不是前缀），两端空白裁剪，空串/纯空白不筛选
 *
 * 多个筛选条件之间是 AND；响应结构与分页口径不变（每页固定 10 条，按 pub_date 倒序）。
 * 注意：公开评论区 / 数据导出走的是各自独立的查询，不共用本文件。
 */
export const listComments = async (c: Context<{ Bindings: Bindings }>) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const status = c.req.query('status') || '';
  // 文章标识：精确匹配（`/posts/a` 不能命中 `/posts/ab`）
  const postSlug = (c.req.query('postSlug') || '').trim();
  const limit = 10;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const args: any[] = [];
  if (status) {
    conditions.push("status = ?");
    args.push(status);
  }
  if (postSlug) {
    conditions.push("post_slug = ?");
    args.push(postSlug);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalCount = await c.env.MOMO_DB.prepare(
    `SELECT COUNT(*) as count FROM Comment ${whereClause}`
  ).bind(...args).first<{ count: number }>();

  const { results } = await c.env.MOMO_DB.prepare(
    `SELECT * FROM Comment ${whereClause} ORDER BY pub_date DESC LIMIT ? OFFSET ?`
  ).bind(...args, limit, offset).all();

  const comments = (results || []).map((row: any) => ({
    id: row.id,
    // pub_date 在库里是毫秒整数，响应契约统一为 ISO 字符串（与 Node/Go 一致）
    pubDate: toIsoString(row.pub_date),
    postSlug: row.post_slug,
    author: row.author,
    email: row.email,
    url: row.url,
    ipAddress: row.ip_address,
    os: row.os,
    browser: row.browser,
    contentText: row.content_text,
    contentHtml: row.content_html,
    status: row.status
  }));

  return c.json({
    code: 200,
    message: 'Comments fetched successfully',
    data: {
      comments: comments,
      pagination: {
        page,
        limit,
        totalPage: Math.ceil((totalCount?.count || 0) / limit)
      }
    }
  });
};