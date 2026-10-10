import type { Context } from "hono";
import { getClientIP } from "../../utils/ip";
import { createChallenge, getDifficulty, isVerifyEnabled, VERIFY_PROTOCOL_VERSION } from "../../utils/verify";
import { sanitizePostSlug } from "../../utils/security";
import { recordVerifyEvent } from "../../orm/verifyRecordService";
import LogService from "../../utils/log";

/**
 * 签发无感验证挑战（POST /api/verify/challenge）
 *
 * 请求体: { post_slug?: string }
 * 关闭验证时返回 enabled: false，前端据此不渲染验证框。
 *
 * 协议 v2：data.pow 为 HashWX 挑战参数（c/d/n/count）。
 * v1 客户端读不到 v1 的 difficulty 字段，会在提交答案时收到 PROTOCOL_OUTDATED，
 * 因此响应里同时给出 version，便于未来前端做前后端配套判断。
 */
export default async (c: Context): Promise<Response> => {
  try {
    let postSlug = "";
    try {
      const data = await c.req.json();
      postSlug = sanitizePostSlug(data?.post_slug);
    } catch {
      // 无请求体也允许，仅用于探测开关状态
    }

    if (!(await isVerifyEnabled())) {
      return c.json({
        code: 200,
        message: "Verification disabled",
        data: { enabled: false, version: VERIFY_PROTOCOL_VERSION },
      });
    }

    const ip = getClientIP(c);
    // post_slug 必须传进挑战：它会被签进载荷，从而把这份挑战绑定到该文章，
    // 避免一次工作量证明被拿去兑换任意文章的票据。
    const challenge = await createChallenge(ip, postSlug);

    // 认证记录：签发事件。写入是尽力而为的（内部已吞掉异常），不影响签发结果；
    // 关闭 comment_verify_log_challenge 时该事件不会被记录，见 verifyRecordService。
    await recordVerifyEvent({
      event: "challenge",
      challengeId: challenge.challenge_id,
      // 记录的是**总期望哈希次数**（而非响应里 pow.d 的单子挑战难度），
      // 与 solution 侧记录的口径一致，否则两边的 difficulty 无法比较
      difficulty: await getDifficulty(),
      postSlug,
      ip,
    });

    return c.json({
      code: 200,
      message: "Challenge issued",
      data: {
        enabled: true,
        version: VERIFY_PROTOCOL_VERSION,
        post_slug: postSlug,
        ...challenge,
      },
    });
  } catch (error) {
    LogService.error("验证挑战签发异常:", error);
    return c.json({ code: 500, message: "Internal server error" }, 500);
  }
};
