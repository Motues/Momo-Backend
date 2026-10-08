import type { Context } from "hono";
import { getClientIP } from "../../utils/ip";
import {
  createTicket,
  isVerifyEnabled,
  verifySolution,
  TICKET_TTL_SECONDS,
} from "../../utils/verify";
import { checkContent } from "../../utils/security";
import LogService from "../../utils/log";

/**
 * 校验无感验证答案并签发票据（POST /api/verify/solution）
 *
 * 请求体: { post_slug, prefix, sig, nonce, elapsed_ms, hp? }
 * 成功返回 ticket，前端在提交评论时带上。
 */
export default async (c: Context): Promise<Response> => {
  try {
    if (!(await isVerifyEnabled())) {
      return c.json({
        code: 200,
        message: "Verification disabled",
        data: { enabled: false },
      });
    }

    const data = await c.req.json();
    const ip = getClientIP(c);
    const postSlug = checkContent(String(data?.post_slug || "")).slice(0, 200);

    // 蜜罐字段被填写 => 认定为脚本，静默拒绝
    const honeypot = data?.hp;
    if (honeypot !== undefined && honeypot !== null && String(honeypot).trim() !== "") {
      LogService.warn("人机验证蜜罐命中，已拒绝:", { ip });
      return c.json({ code: 403, message: "Verification failed", reason: "honeypot" }, 403);
    }

    const nonceRaw = data?.nonce;
    const nonce = typeof nonceRaw === "number" ? nonceRaw : parseInt(String(nonceRaw ?? ""), 10);

    const check = await verifySolution({
      prefix: String(data?.prefix || ""),
      sig: String(data?.sig || ""),
      nonce,
      elapsedMs: Number(data?.elapsed_ms),
      ip,
    });

    if (!check.ok) {
      return c.json({ code: 403, message: "Verification failed", reason: check.reason }, 403);
    }

    const ticket = await createTicket(ip, postSlug);
    return c.json({
      code: 200,
      message: "Verification passed",
      data: { enabled: true, ticket, expires_in: TICKET_TTL_SECONDS },
    });
  } catch (error) {
    LogService.error("验证答案校验异常:", error);
    return c.json({ code: 500, message: "Internal server error" }, 500);
  }
};
