import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { listVerifyRecords } from '../../utils/verifyRecord';

/**
 * 认证明细列表（GET /admin/verify/records）
 *
 * 查询参数：
 *  - page：页码，默认 1
 *  - pageSize：每页条数，默认 20，上限 100
 *  - event：`all` | `challenge` | `pass` | `fail`，默认 all
 *  - reason：失败原因精确匹配（如 `ip mismatch`）
 *  - ip：来源 IP 前缀匹配（便于按网段排查）
 *  - slug：文章标识精确匹配
 *  - days：时间窗口天数，默认 30；`all` 或 `0` 表示全部历史
 *
 * 三端（Node / Go / Worker）的参数语义与响应结构完全一致，见 doc/api.md。
 */
export const verifyRecords = async (c: Context<{ Bindings: Bindings }>) => {
  const rawDays = (c.req.query('days') || '30').trim().toLowerCase();
  const parsedDays = rawDays === 'all' ? 0 : parseInt(rawDays, 10);
  // 非法值（非数字、负数）回退默认 30；0 与 all = 全部历史；上限 365 —— 与 Node / Go 一致
  const days = rawDays === 'all'
    ? 0
    : Number.isFinite(parsedDays) && parsedDays >= 0
      ? Math.min(parsedDays, 365)
      : 30;

  const parsedPage = parseInt(c.req.query('page') || '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  const parsedPageSize = parseInt(c.req.query('pageSize') || '20', 10);
  const pageSize =
    Number.isFinite(parsedPageSize) && parsedPageSize >= 1 ? Math.min(parsedPageSize, 100) : 20;

  const result = await listVerifyRecords(c.env, {
    page,
    pageSize,
    event: c.req.query('event') || 'all',
    reason: c.req.query('reason') || '',
    ip: c.req.query('ip') || '',
    slug: c.req.query('slug') || '',
    days,
  });

  return c.json({
    code: 200,
    message: 'Verify records fetched successfully',
    data: result,
  });
};
