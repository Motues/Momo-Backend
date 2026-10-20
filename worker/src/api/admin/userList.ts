import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting } from '../../utils/settings';
import { toIsoString } from '../../utils/time';
import { getLinkStatusByEmail, getActiveTrustsByEmail, isUrlDormant, resolveLinkSecurityConfig } from '../../utils/linkSecurity';

/**
 * 用户列表的「网站链接状态」筛选取值（见任务规范 §2 / §7）。
 * 无法识别的取值按 `all` 处理（与既有 `verified=maybe` 的宽容口径一致）。
 */
const LINK_STATUS_FILTERS = ['all', 'dormant', 'trusted', 'normal', 'none'] as const;
type LinkStatusFilter = (typeof LINK_STATUS_FILTERS)[number];

function normalizeLinkStatusFilter(raw: unknown): LinkStatusFilter {
  const value = String(raw ?? '').trim().toLowerCase();
  return (LINK_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as LinkStatusFilter)
    : 'all';
}

/**
 * 单条用户记录是否命中链接状态筛选。
 *
 * - `none` = 没有留下过链接；
 * - `normal` = 有链接且既不休眠也未处于人工确认中；
 * - `trusted` = 有链接且存在未过期的人工确认（与功能开关无关）；
 * - `dormant` = 有链接、未被确认、且按既有口径判为休眠（功能关闭时为空集）。
 */
function matchesLinkStatus(
  user: { url: string; urlDormant: boolean; urlTrustedUntil: string },
  filter: LinkStatusFilter
): boolean {
  switch (filter) {
    case 'dormant':
      return user.url !== '' && user.urlDormant;
    case 'trusted':
      return user.url !== '' && user.urlTrustedUntil !== '';
    case 'normal':
      return user.url !== '' && !user.urlDormant && user.urlTrustedUntil === '';
    case 'none':
      return user.url === '';
    default:
      return true;
  }
}

export const userList = async (c: Context<{ Bindings: Bindings }>) => {
  // 分页参数 clamp：page >= 1，1 <= limit <= 100（避免 limit=0/负数导致 OFFSET 异常）
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20), 100);
  const search = (c.req.query('search') || '').trim();
  // 邮箱验证筛选：all（默认）/ true（已验证）/ false（未验证）
  let verified = (c.req.query('verified') || 'all').trim().toLowerCase();
  if (verified !== 'true' && verified !== 'false') verified = 'all';
  // 链接状态筛选：all（默认）/ dormant / trusted / normal / none
  const linkStatus = normalizeLinkStatusFilter(c.req.query('linkStatus'));
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

  // 用户的聚合查询（不含分页）：链接状态筛选要求在分页之前拿到**全部**用户的链接状态，
  // 因此 linkStatus !== all 时要先取回全部行，再由下面的链接字段过滤 + 内存分页。
  const usersSql = `
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
  `;

  // 需要按链接状态筛选时才取全部用户（过滤必须发生在分页之前）；
  // 默认 all 不需要筛选，保持既有的 SQL 分页，避免给最常见路径带来全表扫描。
  const filterByLinkStatus = linkStatus !== 'all';

  let totalUsers = 0;
  let results: any[] = [];
  if (filterByLinkStatus) {
    results = (await c.env.MOMO_DB.prepare(usersSql).bind(...args).all()).results || [];
  } else {
    const totalCount = await c.env.MOMO_DB.prepare(
      `SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment ${whereClause})`
    ).bind(...args).first<{ count: number }>();
    totalUsers = totalCount?.count || 0;

    results = (await c.env.MOMO_DB.prepare(`${usersSql} LIMIT ? OFFSET ?`)
      .bind(...args, limit, offset)
      .all()).results || [];
  }

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

  // 链接安全审查：本页用户的「最后评论时间 + 最新非空网址」，一次查询（按归一化邮箱聚合）。
  // 身份是邮箱而不是 author+email —— 同邮箱的多行共享同一份链接状态，与公开评论区的
  // `urlDormant` 同口径。功能关闭时 `urlDormant` 恒为 false，但 `url` 仍然下发。
  // 人工确认（TrustedLink）同样按「本页邮箱集合」一次查询取回未过期的确认，避免 N+1；
  // 无论功能开关如何都下发 `urlTrustedUntil` / `urlTrustedSource`（功能关着时写入的确认在开启后依然生效）。
  const linkSecurity = await resolveLinkSecurityConfig(c.env);
  const emails = (results || []).map((u: any) => String(u.email ?? ''));
  const now = Date.now();
  const linkStatusByEmail = await getLinkStatusByEmail(c.env, emails);
  const activeTrusts = await getActiveTrustsByEmail(c.env, emails, now);

  const mappedUsers = (results || []).map((u: any) => {
    const email = String(u.email ?? '').trim().toLowerCase();
    const link = linkStatusByEmail.get(email);
    const url = link?.latestUrl ?? '';
    // 人工确认：按 (归一化邮箱, 最新非空网址) 取未过期的确认，没有则空串（形状稳定，不是 null）
    const trust = url === '' ? undefined : activeTrusts.get(email)?.get(url);
    const urlTrustedUntil = trust?.expiresAt ?? '';
    return {
      ...u,
      // pub_date 为毫秒整数：与 Node/Go 一致地输出 ISO 字符串（面板直接 formatDate 展示）
      firstCommentDate: toIsoString(u.firstCommentDate),
      lastCommentDate: toIsoString(u.lastCommentDate),
      emailVerified: u.emailVerified === 1,
      emailVerifiedAt: u.emailVerifiedAt || '',
      blacklisted: blacklistSet.has(String(u.email).toLowerCase()),
      // 网站链接（最新非空网址）与是否「休眠」：功能关闭、无网址、查不到最后评论时间
      // （fail-open）时 urlDormant 恒为 false；有效人工确认同样豁免休眠
      url,
      urlTrustedUntil,
      // 确认来源：'' | 'admin' | 'self'（与 urlTrustedUntil 同一条件：仅未过期确认才有值）
      urlTrustedSource: trust ? trust.source : '',
      urlDormant: isUrlDormant({
        enabled: linkSecurity.securityEnabled ? 'true' : 'false',
        hasUrl: url !== '',
        dormantDays: linkSecurity.dormantDays,
        lastCommentAt: link?.lastAt ?? null,
        trusted: urlTrustedUntil !== '',
        now,
      }),
    };
  });

  const filteredUsers = filterByLinkStatus
    ? mappedUsers.filter((user) => matchesLinkStatus(user, linkStatus))
    : mappedUsers;
  const users = filterByLinkStatus ? filteredUsers.slice(offset, offset + limit) : filteredUsers;
  // 过滤后（而不是过滤前）的总数决定 totalPage
  if (filterByLinkStatus) totalUsers = filteredUsers.length;

  return c.json({
    code: 200,
    message: "Users fetched successfully",
    data: {
      users,
      pagination: {
        page,
        limit,
        totalPage: Math.ceil(totalUsers / limit)
      }
    }
  });
};
