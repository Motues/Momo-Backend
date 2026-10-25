import { Context } from 'hono';
import { Bindings } from '../bindings';

/**
 * Worker 的运行时信息（公开，不含敏感内容）。
 * 字段与 Node / Go 的 /health 保持一致，管理面板据此自动选择升级步骤：
 *   runtime   node | go | worker
 *   container Worker 永远不是用户自己的容器
 *   os/arch   Cloudflare 运行时没有可下载的平台包
 */
const RUNTIME_INFO = {
  runtime: 'worker',
  container: false,
  os: 'cloudflare',
  arch: 'unknown',
} as const;

/**
 * 健康检查（GET /health）
 *
 * 供容器 HEALTHCHECK / docker-compose / 反向代理探针使用，不需要认证：
 * 进程能响应且 D1 可用 → 200；数据库不可用 → 503。
 * 响应结构与 Node / Go 完全一致：
 *
 *   200 {"code":200,"message":"ok","data":{"status":"ok","database":"ok",...}}
 *   503 {"code":503,"message":"database unavailable","data":{"status":"error","database":"error",...}}
 *
 * 数据库不可用时也会带上运行时字段，面板仍能识别部署方式。
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
        data: { status: 'error', database: 'error', ...RUNTIME_INFO },
      },
      503
    );
  }

  return c.json({
    code: 200,
    message: 'ok',
    data: { status: 'ok', database: 'ok', ...RUNTIME_INFO },
  });
};
