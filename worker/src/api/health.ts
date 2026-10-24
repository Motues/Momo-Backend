import { Context } from 'hono';
import { Bindings } from '../bindings';

/**
 * 健康检查（GET /health）
 *
 * 供容器 HEALTHCHECK / docker-compose / 反向代理探针使用，不需要认证：
 * 进程能响应且 D1 可用 → 200；数据库不可用 → 503。
 * 响应结构与 Node / Go 完全一致：
 *
 *   200 {"code":200,"message":"ok","data":{"status":"ok","database":"ok"}}
 *   503 {"code":503,"message":"database unavailable","data":{"status":"error","database":"error"}}
 */
export const health = async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // 最小查询：不碰业务表，只验证 D1 绑定与连接可用
    await c.env.MOMO_DB.prepare('SELECT 1').first();
  } catch {
    return c.json(
      {
        code: 503,
        message: 'database unavailable',
        data: { status: 'error', database: 'error' },
      },
      503
    );
  }

  return c.json({
    code: 200,
    message: 'ok',
    data: { status: 'ok', database: 'ok' },
  });
};
