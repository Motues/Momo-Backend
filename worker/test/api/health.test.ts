/**
 * GET /health —— 容器 HEALTHCHECK / 编排探针使用的公开端点。
 * 三端（Node / Go / Worker）响应结构必须一致。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../helpers/http';

describe('GET /health', () => {
  it('D1 可用时返回 200 与统一结构', async () => {
    const res = await api('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: 200,
      message: 'ok',
      data: {
        status: 'ok',
        database: 'ok',
        runtime: 'worker',
        container: false,
        os: 'cloudflare',
        arch: 'unknown',
      },
    });
  });

  it('不需要 Authorization 头（不经过 adminAuth）', async () => {
    const res = await api('/health');
    expect(res.status).not.toBe(401);
  });
});
