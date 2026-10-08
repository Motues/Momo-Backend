import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { createTicket, isVerifyEnabled, verifySolution, TICKET_TTL_SECONDS } from '../../utils/verify';

/**
 * 校验无感验证答案并签发票据（POST /api/verify/solution）
 *
 * 请求体: { post_slug, prefix, sig, nonce, elapsed_ms, hp? }
 */
export const verifySolutionHandler = async (c: Context<{ Bindings: Bindings }>) => {
  try {
    if (!(await isVerifyEnabled(c.env))) {
      return c.json({
        code: 200,
        message: 'Verification disabled',
        data: { enabled: false },
      });
    }

    const data = await c.req.json();
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
    const postSlug = String(data?.post_slug ?? '').trim().slice(0, 200);

    // 蜜罐字段被填写 => 认定为脚本，静默拒绝
    const honeypot = data?.hp;
    if (honeypot !== undefined && honeypot !== null && String(honeypot).trim() !== '') {
      console.warn('人机验证蜜罐命中，已拒绝:', ip);
      return c.json({ code: 403, message: 'Verification failed', reason: 'honeypot' }, 403);
    }

    const nonceRaw = data?.nonce;
    const nonce = typeof nonceRaw === 'number' ? nonceRaw : parseInt(String(nonceRaw ?? ''), 10);

    const check = await verifySolution(c.env, {
      prefix: String(data?.prefix ?? ''),
      sig: String(data?.sig ?? ''),
      nonce,
      elapsedMs: Number(data?.elapsed_ms),
      ip,
    });

    if (!check.ok) {
      return c.json({ code: 403, message: 'Verification failed', reason: check.reason }, 403);
    }

    const ticket = await createTicket(c.env, ip, postSlug);
    return c.json({
      code: 200,
      message: 'Verification passed',
      data: { enabled: true, ticket, expires_in: TICKET_TTL_SECONDS },
    });
  } catch (e: any) {
    console.error('verifySolution error:', e);
    return c.json({ code: 500, message: 'Internal server error' }, 500);
  }
};
