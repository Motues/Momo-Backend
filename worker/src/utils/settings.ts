import { Bindings } from '../bindings';
import { compare, hash, genSalt } from 'bcryptjs';

export const DEFAULT_ADMIN_NAME = "momo";
export const DEFAULT_ADMIN_PASSWORD = "momo";

export async function getSetting(env: Bindings, key: string): Promise<string | null> {
  try {
    const row = await env.MOMO_DB.prepare(
      "SELECT value FROM Settings WHERE key = ?"
    ).bind(key).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSetting(env: Bindings, key: string, value: string): Promise<void> {
  await env.MOMO_DB.prepare(
    `INSERT INTO Settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value).run();
}

export async function getAllSettings(env: Bindings): Promise<Record<string, string>> {
  try {
    const { results } = await env.MOMO_DB.prepare(
      "SELECT key, value FROM Settings"
    ).all<{ key: string; value: string }>();
    const map: Record<string, string> = {};
    for (const row of results || []) {
      map[row.key] = row.value;
    }
    return map;
  } catch {
    return {};
  }
}

export async function isDefaultAdmin(env: Bindings): Promise<boolean> {
  const changed = await getSetting(env, "password_changed");
  return changed !== "true";
}

export async function checkAdminCredentials(env: Bindings, name: string, password: string): Promise<boolean> {
  const dbName = await getSetting(env, "admin_name");
  const dbPass = await getSetting(env, "admin_password");

  if (dbName && dbPass) {
    // bcrypt hash 检测（三端统一为 $2 前缀，避免明文以 $ 开头时被误判）
    if (dbPass.startsWith('$2')) {
      // 哈希分支同样必须校验用户名：否则同一密码可用任意用户名登录，
      // 并产生多个并存的会话
      if (name !== dbName) {
        return false;
      }
      return await compare(password, dbPass);
    }
    // 明文兼容 + 自动升级为 hash
    if (name === dbName && password === dbPass) {
      const salt = await genSalt(10);
      const hashed = await hash(password, salt);
      await setSetting(env, "admin_password", hashed);
      return true;
    }
    return false;
  }

  return name === DEFAULT_ADMIN_NAME && password === DEFAULT_ADMIN_PASSWORD;
}

export async function changeAdminPassword(env: Bindings, name: string, password: string): Promise<void> {
  const salt = await genSalt(10);
  const hashed = await hash(password, salt);
  await setSetting(env, "admin_name", name);
  await setSetting(env, "admin_password", hashed);
  await setSetting(env, "password_changed", "true");
}

export async function isEmailEnabled(env: Bindings): Promise<boolean> {
  const enabled = await getSetting(env, "email_enabled");
  return enabled !== "false";
}

export async function getTemplate(env: Bindings, key: string, fallback: string): Promise<string> {
  const t = await getSetting(env, key);
  return t || fallback;
}
