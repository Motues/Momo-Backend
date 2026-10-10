import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getVerifyOverview } from '../../utils/verifyRecord';

/**
 * 认证记录统计概览（GET /admin/verify/overview）
 *
 * 查询参数：
 *  - days：统计窗口天数。默认 30；`all` 或 `0` 表示最近 12 个月（按月分桶）；上限 365
 *  - offset：窗口向前平移的整窗个数（对齐界面上的左右箭头），默认 0，上限 120
 *
 * 三端（Node / Go / Worker）的参数语义与响应结构完全一致，见 doc/api.md。
 */
export const verifyOverview = async (c: Context<{ Bindings: Bindings }>) => {
  const rawDays = (c.req.query('days') || '30').trim().toLowerCase();
  const parsedDays = rawDays === 'all' ? 0 : parseInt(rawDays, 10);
  // 非法值（非数字、负数）回退默认 30；0 与 all = 全部；上限 365 —— 与 Node / Go 一致
  const days = rawDays === 'all'
    ? 0
    : Number.isFinite(parsedDays) && parsedDays >= 0
      ? Math.min(parsedDays, 365)
      : 30;

  const parsedOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = Number.isFinite(parsedOffset) ? Math.min(Math.max(parsedOffset, 0), 120) : 0;

  const data = await getVerifyOverview(c.env, days, offset);

  return c.json({
    code: 200,
    message: 'Verify stats fetched successfully',
    data,
  });
};
