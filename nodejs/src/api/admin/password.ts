import type { Context } from "hono";
import { checkAdminCredentials, changeAdminPassword } from "../../utils/settings";
import { checkKey, extractToken, clearAllTempKeys } from "../../utils/security";
import LogService from "../../utils/log";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const { old_name, old_password, new_name, new_password } = (body ?? {}) as Record<string, unknown>;

  if (
    typeof old_name !== "string" || typeof old_password !== "string" ||
    typeof new_name !== "string" || typeof new_password !== "string" ||
    !old_name || !old_password || !new_name || !new_password
  ) {
    return c.json(
      { code: 400, message: "old_name, old_password, new_name, new_password are required" },
      400
    );
  }

  if (new_password.length < 4) {
    return c.json({ code: 400, message: "New password must be at least 4 characters" }, 400);
  }

  // 验证旧凭据
  const valid = await checkAdminCredentials(old_name, old_password);
  if (!valid) {
    return c.json({ code: 401, message: "Current credentials are incorrect" }, 401);
  }

  // 更新密码
  await changeAdminPassword(new_name, new_password);

  // 吊销全部已签发的会话：改密后旧 token 立即失效
  clearAllTempKeys();

  LogService.info("Admin credentials changed", { oldName: old_name, newName: new_name });

  return c.json({
    code: 200,
    message: "Admin credentials updated successfully. Please login again.",
  });
};
