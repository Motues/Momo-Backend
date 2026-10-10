import type { Context } from "hono";
import { getClientIP } from "../../utils/ip";
import {
  createTicket,
  getDifficulty,
  isVerifyEnabled,
  verifySolution,
  TICKET_TTL_SECONDS,
  VERIFY_PROTOCOL_VERSION,
} from "../../utils/verify";
import { sanitizePostSlug } from "../../utils/security";
import { recordVerifyEvent } from "../../orm/verifyRecordService";
import LogService from "../../utils/log";

/**
 * 校验无感验证答案并签发票据（POST /api/verify/solution）
 *
 * 请求体（协议 v2）: { post_slug, prefix, sig, nonces: string[], elapsed_ms, hp? }
 * 成功返回 ticket，前端在提交评论时带上。
 *
 * 兼容性：v1 客户端提交的是单个 `nonce` 字段，没有 `nonces`。
 * 这种情况下 prefix 载荷里的 v 仍是 1，verifySolution 会返回 PROTOCOL_OUTDATED，
 * 让旧版组件与「答案算错」区分开，便于排障与前端提示升级。
 */
export default async (c: Context): Promise<Response> => {
  try {
    if (!(await isVerifyEnabled())) {
      return c.json({
        code: 200,
        message: "Verification disabled",
        data: { enabled: false, version: VERIFY_PROTOCOL_VERSION },
      });
    }

    const data = await c.req.json();
    const ip = getClientIP(c);
    const postSlug = sanitizePostSlug(data?.post_slug);
    const elapsedMs = Number(data?.elapsed_ms);
    // 记录用的公共字段：即使校验失败也尽量把「是哪一次认证」记下来
    const recordBase = {
      challengeId: extractChallengeId(data?.prefix),
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      difficulty: await getDifficulty(),
      postSlug,
      ip,
    };

    // 蜜罐字段被填写 => 认定为脚本，静默拒绝
    const honeypot = data?.hp;
    if (honeypot !== undefined && honeypot !== null && String(honeypot).trim() !== "") {
      LogService.warn("人机验证蜜罐命中，已拒绝:", { ip });
      await recordVerifyEvent({ event: "fail", reason: "honeypot", ...recordBase });
      return c.json({ code: 403, message: "Verification failed", reason: "honeypot" }, 403);
    }

    const check = await verifySolution({
      prefix: String(data?.prefix || ""),
      sig: String(data?.sig || ""),
      nonces: data?.nonces,
      elapsedMs: Number(data?.elapsed_ms),
      ip,
      // 必须与签发挑战时的 post_slug 完全一致（挑战载荷里的 slug 由签名保护）
      postSlug,
      instr: data?.instr,
    });

    if (!check.ok) {
      await recordVerifyEvent({ event: "fail", reason: check.reason, ...recordBase });
      return c.json({ code: 403, message: "Verification failed", reason: check.reason }, 403);
    }

    const ticket = await createTicket(ip, postSlug);
    await recordVerifyEvent({ event: "pass", ...recordBase });
    return c.json({
      code: 200,
      message: "Verification passed",
      data: { enabled: true, version: VERIFY_PROTOCOL_VERSION, ticket, expires_in: TICKET_TTL_SECONDS },
    });
  } catch (error) {
    LogService.error("验证答案校验异常:", error);
    return c.json({ code: 500, message: "Internal server error" }, 500);
  }
};

/**
 * 从挑战 prefix 里取出挑战 id（cid），仅用于把同一次认证的记录串起来。
 *
 * 这里**不做任何可信性判断**（签名校验是 verifySolution 的职责）：拿到的 cid
 * 只是被当作不透明的分组标签，因此必须严格限制长度与类型，避免把攻击者构造的
 * 超长内容写进记录表。取不到就返回 null，记录照常写入。
 */
function extractChallengeId(prefix: unknown): string | null {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > 4096) return null;
  try {
    const json = Buffer.from(prefix.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as { cid?: unknown };
    const cid = payload?.cid;
    if (typeof cid !== "string" || cid.length === 0 || cid.length > 64) return null;
    return cid;
  } catch {
    return null;
  }
}
