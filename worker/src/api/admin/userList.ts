import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting } from '../../utils/settings';
import { toIsoString } from '../../utils/time';

export const userList = async (c: Context<{ Bindings: Bindings }>) => {
  // 分页参数 clamp：page >= 1，1 <= limit <= 100（避免 limit=0/负数导致 OFFSET 异常）
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20), 100);
  const search = (c.req.query('search') || '').trim();
  // 邮箱验证筛选：all（默认）/ true（已验证）/ false（未验证）
  let verified = (c.req.query('verified') || 'all').trim().toLowerCase();
  if (verified !== 'true' && verified !== 'false') verified = 'all';
  const offset = (page - 1) * limit;

  // 与评论提交时的判定保持一致：EmailVerification.email 精确匹配且 verified = 1
  const verifiedExists = "EXISTS (SELECT 1 FROM EmailVerification ev WHERE ev.email = Comment.email AND ev.verified = 1)";

  const conditions: string[] = [];
  const args: any[] = [];
  if (search) {
    // 按昵称/邮箱搜索（不区分大小写）
    conditions.push("(LOWER(author) LIKE ? OR LOWER(email) LIKE ?)");
    const like = `%${search.toLowerCase()}%`;
    args.push(like, like);
  }
  if (verified === 'true') {
    conditions.push(verifiedExists);
  } else if (verified === 'false') {
    conditions.push(`NOT ${verifiedExists}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalCount = await c.env.MOMO_DB.prepare(
    `SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment ${whereClause})`
  ).bind(...args).first<{ count: number }>();

  const { results } = await c.env.MOMO_DB.prepare(`
    SELECT
      author, email,
      COUNT(*) as commentCount,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) as approvedCount,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pendingCount,
      COALESCE(SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END), 0) as deletedCount,
      MIN(pub_date) as firstCommentDate,
      MAX(pub_date) as lastCommentDate,
      CASE WHEN ${verifiedExists} THEN 1 ELSE 0 END as emailVerified,
      COALESCE((SELECT MAX(ev.verified_at) FROM EmailVerification ev WHERE ev.email = Comment.email AND ev.verified = 1), '') as emailVerifiedAt
    FROM Comment
    ${whereClause}
    GROUP BY author, email
    ORDER BY commentCount DESC
    LIMIT ? OFFSET ?
  `).bind(...args, limit, offset).all();

  // 加载邮箱黑名单，标记用户是否已被拉黑
  let blacklistSet = new Set<string>();
  const blacklistStr = await getSetting(c.env, "email_blacklist");
  if (blacklistStr) {
    try {
      const list = JSON.parse(blacklistStr);
      if (Array.isArray(list)) {
        blacklistSet = new Set(list.map((e: string) => String(e).toLowerCase()));
      }
    } catch {
      // 忽略无效的黑名单数据
    }
  }

  const users = (results || []).map((u: any) => ({
    ...u,
    // pub_date 为毫秒整数：与 Node/Go 一致地输出 ISO 字符串（面板直接 formatDate 展示）
    firstCommentDate: toIsoString(u.firstCommentDate),
    lastCommentDate: toIsoString(u.lastCommentDate),
    emailVerified: u.emailVerified === 1,
    emailVerifiedAt: u.emailVerifiedAt || '',
    blacklisted: blacklistSet.has(String(u.email).toLowerCase()),
  }));

  return c.json({
    code: 200,
    message: "Users fetched successfully",
    data: {
      users,
      pagination: {
        page,
        limit,
        totalPage: Math.ceil((totalCount?.count || 0) / limit)
      }
    }
  });
};
