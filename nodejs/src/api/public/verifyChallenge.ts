import type { Context } from "hono";
import { getClientIP } from "../../utils/ip";
import { createChallenge, isVerifyEnabled } from "../../utils/verify";
import { checkContent } from "../../utils/security";
import LogService from "../../utils/log";

/**
 * 签发无感验证挑战（POST /api/verify/challenge）
 *
 * 请求体: { post_slug?: string }
 * 关闭验证时返回 enabled: false，前端据此不渲染验证框。
 */
export default async (c: Context): Promise<Response> => {
  try {
    let postSlug = "";
    try {
      const data = await c.req.json();
      postSlug = checkContent(String(data?.post_slug || "")).slice(0, 200);
    } catch {
      // 无请求体也允许，仅用于探测开关状态
    }

    if (!(await isVerifyEnabled())) {
      return c.json({
        code: 200,
        message: "Verification disabled",
        data: { enabled: false },
      });
    }

    const ip = getClientIP(c);
    const challenge = await createChallenge(ip);

    return c.json({
      code: 200,
      message: "Challenge issued",
      data: {
        enabled: true,
        post_slug: postSlug,
        ...challenge,
      },
    });
  } catch (error) {
    LogService.error("验证挑战签发异常:", error);
    return c.json({ code: 500, message: "Internal server error" }, 500);
  }
};
