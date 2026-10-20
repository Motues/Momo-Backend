import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { toIsoString } from '../../utils/time';
import {
  mergeDistribution,
  normalizeBrowserFamily,
  normalizeDeviceType,
  normalizeOSFamily
} from '../../utils/statsDistribution';

/** 一天的毫秒数（UTC 窗口计算用） */
const DAY_MS = 86400000;

/**
 * 环比百分比：`Math.round((cur - prev) / prev * 100)`。
 * 上一个窗口为 0 时返回 null（不是 0 也不是 100）—— 前端据此显示「—」而不是「+100%」。
 */
function percentDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export const statsOverview = async (c: Context<{ Bindings: Bindings }>) => {
  // range=all / range=0：最近 12 个月按月聚合；其余：最近 N 天（默认 7，上限 365）
  const rangeParam = (c.req.query('range') || '').trim().toLowerCase();
  const isAll = rangeParam === 'all' || rangeParam === '0';
  const parsedRange = parseInt(rangeParam, 10);
  const range = isAll ? 0 : (Number.isFinite(parsedRange) && parsedRange > 0 ? Math.min(parsedRange, 365) : 7);

  // 1. 总评论数
  const totalComments = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment"
  ).first<{ count: number }>();

  // 2. 总用户数
  const totalUsers = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment)"
  ).first<{ count: number }>();

  // 3. 总文章数
  const totalPosts = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(DISTINCT post_slug) as count FROM Comment"
  ).first<{ count: number }>();

  // 4. 状态分布
  const statusRows = await c.env.MOMO_DB.prepare(
    "SELECT status, COUNT(*) as count FROM Comment GROUP BY status"
  ).all<{ status: string; count: number }>();

  const statusDistribution = { approved: 0, pending: 0, deleted: 0 };
  for (const row of statusRows.results || []) {
    if (row.status === 'approved') statusDistribution.approved = row.count;
    else if (row.status === 'pending') statusDistribution.pending = row.count;
    else if (row.status === 'deleted') statusDistribution.deleted = row.count;
  }

  // 5. 最近趋势
  // pub_date 为毫秒整数，分桶统一使用 UTC（strftime(...,'unixepoch') 就是 UTC），
  // 键也用 UTC 生成，避免非 UTC 时区下整体偏移一天/一月（C3）
  const recentComments: { date: string; count: number }[] = [];
  const now = new Date();

  // 时间窗口边界（全部 UTC）：
  //  - range != 0：winStart = 今天 00:00 - (range-1) 天，prevWinStart = winStart - range 天；
  //  - range == 0/all：winStart = 11 个月前的 1 号 00:00（与下面月度分桶的 twelveMonthsAgo
  //    是同一表达式，因此 windowComments 恰好等于 recentComments 各行之和），
  //    prevWinStart = 23 个月前的 1 号。
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const winStart = isAll
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    : startOfToday - (range - 1) * DAY_MS;
  const prevWinStart = isAll
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1)
    : winStart - range * DAY_MS;

  if (isAll) {
    // 最近 12 个月：按月聚合
    const monthlyMap = new Map<string, number>();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthlyMap.set(key, 0);
    }
    // 与窗口指标共用同一个表达式，保证两个口径不会漂移
    const twelveMonthsAgo = winStart;
    const monthlyRows = await c.env.MOMO_DB.prepare(
      "SELECT strftime('%Y-%m', pub_date / 1000, 'unixepoch') as month_str, COUNT(*) as count FROM Comment WHERE pub_date >= ? GROUP BY month_str ORDER BY month_str ASC"
    ).bind(twelveMonthsAgo).all<{ month_str: string; count: number }>();
    for (const row of monthlyRows.results || []) {
      if (monthlyMap.has(row.month_str)) {
        monthlyMap.set(row.month_str, row.count);
      }
    }
    for (const [date, count] of monthlyMap.entries()) {
      recentComments.push({ date, count });
    }
  } else {
    const daysBack = range - 1;
    const dateCountMap = new Map<string, number>();
    for (let i = daysBack; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      dateCountMap.set(d.toISOString().slice(0, 10), 0);
    }
    // 同上：复用窗口起点
    const startOfWindow = winStart;
    const recentRows = await c.env.MOMO_DB.prepare(
      "SELECT strftime('%Y-%m-%d', pub_date / 1000, 'unixepoch') as date_str, COUNT(*) as count FROM Comment WHERE pub_date >= ? GROUP BY date_str ORDER BY date_str ASC"
    ).bind(startOfWindow).all<{ date_str: string; count: number }>();

    for (const row of recentRows.results || []) {
      if (dateCountMap.has(row.date_str)) {
        dateCountMap.set(row.date_str, row.count);
      }
    }
    for (const [date, count] of dateCountMap.entries()) {
      recentComments.push({ date, count });
    }
  }

  // 6. 热门评论者 Top 5
  const topRows = await c.env.MOMO_DB.prepare(
    "SELECT author, email, COUNT(*) as count, MAX(pub_date) as last_date FROM Comment GROUP BY author, email ORDER BY count DESC LIMIT 5"
  ).all<{ author: string; email: string; count: number; last_date: unknown }>();

  const topCommenters = (topRows.results || []).map(r => ({
    author: r.author,
    email: r.email,
    count: r.count,
    lastCommentDate: toIsoString(r.last_date)
  }));

  // 7. 时间窗口指标：窗口内评论数 / 上一个等长窗口的评论数（含所有状态）
  const windowCountRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment WHERE pub_date >= ?"
  ).bind(winStart).first<{ count: number }>();

  const prevWindowCountRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment WHERE pub_date >= ? AND pub_date < ?"
  ).bind(prevWinStart, winStart).first<{ count: number }>();

  // 窗口内活跃评论者数：与 totalUsers 同口径（author + email 去重）
  const windowUsersRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment WHERE pub_date >= ?)"
  ).bind(winStart).first<{ count: number }>();

  const prevWindowUsersRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment WHERE pub_date >= ? AND pub_date < ?)"
  ).bind(prevWinStart, winStart).first<{ count: number }>();

  const windowComments = windowCountRow?.count || 0;
  const prevWindowComments = prevWindowCountRow?.count || 0;
  const windowUsers = windowUsersRow?.count || 0;
  const prevWindowUsers = prevWindowUsersRow?.count || 0;

  // 8. 今天（UTC 00:00 起）与最近 7 个 UTC 日（含今天）的新增评论数
  const todayRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment WHERE pub_date >= ?"
  ).bind(startOfToday).first<{ count: number }>();

  const last7DaysRow = await c.env.MOMO_DB.prepare(
    "SELECT COUNT(*) as count FROM Comment WHERE pub_date >= ?"
  ).bind(startOfToday - 6 * DAY_MS).first<{ count: number }>();

  // 9. 热门文章 Top 5（并列按 post_slug 升序，保证三端顺序一致）
  const topPostRows = await c.env.MOMO_DB.prepare(
    "SELECT post_slug, COUNT(*) as count, MAX(pub_date) as last_date FROM Comment GROUP BY post_slug ORDER BY count DESC, post_slug ASC LIMIT 5"
  ).all<{ post_slug: string; count: number; last_date: unknown }>();

  const topPosts = (topPostRows.results || []).map(r => ({
    postSlug: r.post_slug,
    count: r.count,
    lastCommentDate: toIsoString(r.last_date)
  }));

  // 10. 客户端分布 Top 5
  // 先在 SQL 里按「原始列值」分组（含所有状态），再在 JS 里归一化成家族名并合并 ——
  // 同一个浏览器的每个版本因此折叠成一档，历史整条 UA 归入「未知」。
  // 家族名规则无法用 SQL 表达，所以合并必须在 JS 完成。
  const deviceRows = await c.env.MOMO_DB.prepare(
    "SELECT device as name, COUNT(*) as count FROM Comment GROUP BY device"
  ).all<{ name: string | null; count: number }>();

  const browserRows = await c.env.MOMO_DB.prepare(
    "SELECT browser as name, COUNT(*) as count FROM Comment GROUP BY browser"
  ).all<{ name: string | null; count: number }>();

  const osRows = await c.env.MOMO_DB.prepare(
    "SELECT os as name, COUNT(*) as count FROM Comment GROUP BY os"
  ).all<{ name: string | null; count: number }>();

  const deviceDistribution = mergeDistribution(deviceRows.results || [], normalizeDeviceType);
  const browserDistribution = mergeDistribution(browserRows.results || [], normalizeBrowserFamily);
  const osDistribution = mergeDistribution(osRows.results || [], normalizeOSFamily);

  // 11. 最新评论动态：最近 5 条（含所有状态），并列按 id 倒序
  const latestRows = await c.env.MOMO_DB.prepare(
    "SELECT id, author, email, post_slug, content_text, status, pub_date FROM Comment ORDER BY pub_date DESC, id DESC LIMIT 5"
  ).all<{
    id: number;
    author: string;
    email: string;
    post_slug: string;
    content_text: string;
    status: string;
    pub_date: unknown;
  }>();

  const latestComments = (latestRows.results || []).map(r => ({
    id: r.id,
    author: r.author,
    email: r.email,
    postSlug: r.post_slug,
    contentText: r.content_text,
    status: r.status,
    pubDate: toIsoString(r.pub_date)
  }));

  return c.json({
    code: 200,
    message: "Stats fetched successfully",
    data: {
      totalComments: totalComments?.count || 0,
      totalUsers: totalUsers?.count || 0,
      totalPosts: totalPosts?.count || 0,
      statusDistribution,
      recentComments,
      topCommenters,
      // —— 时间窗口指标（窗口 = range 参数；range=0/all 时窗口 = 最近 12 个自然月）
      windowComments,
      prevWindowComments,
      commentsDelta: percentDelta(windowComments, prevWindowComments),
      windowUsers,
      prevWindowUsers,
      usersDelta: percentDelta(windowUsers, prevWindowUsers),
      todayComments: todayRow?.count || 0,
      last7DaysComments: last7DaysRow?.count || 0,
      // —— 热门文章 Top 5
      topPosts,
      // —— 客户端分布 Top 5（归一化后的家族名）
      deviceDistribution,
      browserDistribution,
      osDistribution,
      // —— 最新评论动态（最近 5 条，含所有状态）
      latestComments
    }
  });
};
