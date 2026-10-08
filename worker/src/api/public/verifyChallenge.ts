import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { createChallenge, isVerifyEnabled } from '../../utils/verify';

// 简单的内容清理，与 postComment 保持一致
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 200);
}

/**
 * 签发无感验证挑战（POST /api/verify/challenge）
 *
 * 请求体: { post_slug?: string }
 * 关闭验证时返回 enabled: false，前端据此不渲染验证框。
 */
export const verifyChallenge = async (c: Context<{ Bindings: Bindings }>) => {
  try {
    let postSlug = '';
    try {
      const data = await c.req.json();
      postSlug = clean(data?.post_slug);
    } catch {
      // 无请求体也允许，仅用于探测开关状态
    }

    if (!(await isVerifyEnabled(c.env))) {
      return c.json({
        code: 200,
        message: 'Verification disabled',
        data: { enabled: false },
      });
    }

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
    const challenge = await createChallenge(c.env, ip);

    return c.json({
      code: 200,
      message: 'Challenge issued',
      data: {
        enabled: true,
        post_slug: postSlug,
        ...challenge,
      },
    });
  } catch (e: any) {
    console.error('verifyChallenge error:', e);
    return c.json({ code: 500, message: 'Internal server error' }, 500);
  }
};
