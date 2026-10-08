import type { Context } from "hono";
import { generateTempKey } from "../../utils/security";
import { checkAdminCredentials, isDefaultAdmin } from "../../utils/settings";
import { getClientIP } from "../../utils/ip";
import LogService from "../../utils/log";
import { isIPBlocked, recordFailedAttempt, recordSuccessfulLogin } from "../../utils/ipSecurity";

export default async (c: Context): Promise<Response> => {
  const data = await c.req.json().catch(() => null);
  const ip = getClientIP(c);

  // 类型校验：非字符串（如 {"password":{}}）直接 400，
  // 否则 bcrypt 会抛错并被全局 handler 吞成 500，而该次失败不会计入锁定计数
  if (typeof data?.name !== "string" || typeof data?.password !== "string") {
    return c.json({ code: 400, message: "name and password must be strings" }, 400);
  }

  // 检查IP是否被阻止
  if (isIPBlocked(ip)) {
    LogService.warn("Blocked IP attempted to login", { ip });
    return c.json(
      {
        code: 403,
        message: "IP is blocked due to multiple failed login attempts",
      },
      403
    );
  }

  if (!(await checkAdminCredentials(data.name, data.password))) {
    const isBlocked = recordFailedAttempt(ip);
    LogService.warn("Login failed", { ip, failedAttempts: isBlocked });
    if (isBlocked) {
      return c.json(
        {
          code: 403,
          message: "IP is blocked due to multiple failed login attempts",
        },
        403
      );
    }
    return c.json({ code: 401, message: "Invalid username or password" }, 401);
  }

  // 登录成功后清除失败尝试记录
  recordSuccessfulLogin(ip);
  LogService.info("Login successful", { ip });

  // 生成临时密钥（键为随机 ID，不再使用用户名）
  const tempKey = await generateTempKey();
  const needChangePassword = await isDefaultAdmin();

  return c.json({
    code: 200,
    message: "Login successful",
    token: tempKey,
    needChangePassword,
  });
};
