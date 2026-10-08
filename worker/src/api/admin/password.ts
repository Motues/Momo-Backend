import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { checkAdminCredentials, changeAdminPassword } from '../../utils/settings';

/** 吊销全部已签发的会话（改密/登出后调用） */
async function revokeAllTokens(env: Bindings, exceptToken?: string) {
  let cursor: string | undefined;
  do {
    const listed = await env.MOMO_AUTH_KV.list({ prefix: 'token:', cursor });
    for (const key of listed.keys) {
      if (exceptToken && key.name === `token:${exceptToken}`) continue;
      await env.MOMO_AUTH_KV.delete(key.name);
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

export const changePassword = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json().catch(() => null);
  const { old_name, old_password, new_name, new_password } = (body ?? {}) as Record<string, unknown>;

  if (
    typeof old_name !== 'string' || typeof old_password !== 'string' ||
    typeof new_name !== 'string' || typeof new_password !== 'string' ||
    !old_name || !old_password || !new_name || !new_password
  ) {
    return c.json({ code: 400, message: "old_name, old_password, new_name, new_password are required" }, 400);
  }

  if (new_password.length < 4) {
    return c.json({ code: 400, message: "New password must be at least 4 characters" }, 400);
  }

  const valid = await checkAdminCredentials(c.env, old_name, old_password);
  if (!valid) {
    return c.json({ code: 401, message: "Current credentials are incorrect" }, 401);
  }

  await changeAdminPassword(c.env, new_name, new_password);

  // 吊销全部已签发的 token：改密后旧 token 立即失效
  const currentToken = c.req.header('Authorization')?.replace('Bearer ', '');
  await revokeAllTokens(c.env, currentToken);

  console.log(`Admin credentials changed: ${old_name} -> ${new_name}`);

  return c.json({
    code: 200,
    message: "Admin credentials updated successfully. Please login again.",
  });
};

export const adminLogout = async (c: Context<{ Bindings: Bindings }>) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    await c.env.MOMO_AUTH_KV.delete(`token:${token}`);
  }
  return c.json({ code: 200, message: "Logged out" });
};
