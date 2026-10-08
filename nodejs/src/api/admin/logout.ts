import type { Context } from "hono";
import { checkKey, extractToken, revokeTempKey } from "../../utils/security";
import LogService from "../../utils/log";

/**
 * 登出：吊销当前 token。
 * 已过期/无效的 token 同样返回 200，避免泄露 token 状态。
 */
export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  revokeTempKey(key);
  LogService.info("Admin logged out");

  return c.json({ code: 200, message: "Logged out" });
};
