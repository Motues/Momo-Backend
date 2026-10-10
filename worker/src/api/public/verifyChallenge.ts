import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { createChallenge, isVerifyEnabled, VERIFY_PROTOCOL_VERSION } from '../../utils/verify';
import { sanitizePostSlug } from '../../utils/security';

/**
 * 签发无感验证挑战（POST /api/verify/challenge）
 *
 * 请求体: { post_slug?: string }
 * 关闭验证时返回 enabled: false，前端据此不渲染验证框。
 *
 * 协议 v2：data.pow 为 HashWX 挑战参数（c/d/n/count），开启第二层时另有 data.instr。
 * v1 前端读不到 POW 参数，会在提交答案时收到 PROTOCOL_OUTDATED，
 * 因此响应里同时给出 version，便于前端做前后端配套判断。
 *
 * post_slug 会被**签进挑战载荷**（challenge 绑定到这篇文章），因此净化口径
 * 必须与 /api/verify/solution 完全一致 —— 两处都调用 sanitizePostSlug。
 */
export const verifyChallenge = async (c: Context<{ Bindings: Bindings }>) => {
  try {
    let postSlug = '';
    try {
      const data = await c.req.json();
      postSlug = sanitizePostSlug(data?.post_slug);
    } catch {
      // 无请求体也允许，仅用于探测开关状态
    }

    if (!(await isVerifyEnabled(c.env))) {
      return c.json({
        code: 200,
        message: 'Verification disabled',
        data: { enabled: false, version: VERIFY_PROTOCOL_VERSION },
      });
    }

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
    const challenge = await createChallenge(c.env, ip, postSlug);

    return c.json({
      code: 200,
      message: 'Challenge issued',
      data: {
        enabled: true,
        version: VERIFY_PROTOCOL_VERSION,
        post_slug: postSlug,
        ...challenge,
      },
    });
  } catch (e: any) {
    console.error('verifyChallenge error:', e);
    return c.json({ code: 500, message: 'Internal server error' }, 500);
  }
};
