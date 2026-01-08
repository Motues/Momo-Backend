import { Context } from 'hono';
import { Bindings } from '../../bindings';

export const listComments = async (c: Context<{ Bindings: Bindings }>) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = 10;
  const offset = (page - 1) * limit;

  // 1. 获取总数
  const totalCount = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment"
  ).first<{ count: number }>();

  // 2. 分页查询数据
  const { results } = await c.env.MOMO_DB.prepare(
    `SELECT * FROM Comment ORDER BY pub_date DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  // 3. 映射字段名以符合你的 API 规范
  const data = results.map((row: any) => ({
    id: row.id,
    pubDate: row.pub_date,
    author: row.author,
    email: row.email,
    url: row.url,
    ipAddress: row.ip_address,
    contentText: row.content_text,
    contentHtml: row.content_html,
    status: row.status
  }));

  return c.json({
    data,
    pagination: {
      page,
      limit,
      total: Math.ceil((totalCount?. count || 0) / limit)
    }
  });
};