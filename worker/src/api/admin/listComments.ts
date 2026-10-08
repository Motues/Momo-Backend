import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { toIsoString } from '../../utils/time';

export const listComments = async (c: Context<{ Bindings: Bindings }>) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const status = c.req.query('status') || '';
  const limit = 10;
  const offset = (page - 1) * limit;

  let countSql, listSql, bindings: any[];

  if (status) {
    countSql = "SELECT COUNT(*) as count FROM Comment WHERE status = ?";
    listSql = "SELECT * FROM Comment WHERE status = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?";
    bindings = [status, limit, offset];
  } else {
    countSql = "SELECT COUNT(*) as count FROM Comment";
    listSql = "SELECT * FROM Comment ORDER BY pub_date DESC LIMIT ? OFFSET ?";
    bindings = [limit, offset];
  }

  const totalCount = await c.env.MOMO_DB.prepare(countSql).bind(
    ...(status ? [status] : [])
  ).first<{ count: number }>();

  const { results } = await c.env.MOMO_DB.prepare(listSql).bind(...bindings).all();

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