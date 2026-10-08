import { db, schema } from "../orm/client";
import { eq } from "drizzle-orm";
import { compare, hash, genSalt } from "bcryptjs";

export const DEFAULT_ADMIN_NAME = "momo";
export const DEFAULT_ADMIN_PASSWORD = "momo";

export async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .limit(1)
      .all();
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  const existing = await getSetting(key);
  if (existing !== null) {
    await db
      .update(schema.settings)
      .set({ value, updated_at: new Date().toISOString() })
      .where(eq(schema.settings.key, key))
      .run();
  } else {
    await db
      .insert(schema.settings)
      .values({ key, value, updated_at: new Date().toISOString() })
      .run();
  }
}

export async function getAllSettings(): Promise<Record<string, string>> {
  try {
    const rows = await db.select().from(schema.settings).all();
    const map: Record<string, string> = {};
    rows.forEach((s) => {
      map[s.key] = s.value;
    });
    return map;
  } catch {
    return {};
  }
}

export async function isDefaultAdmin(): Promise<boolean> {
  const changed = await getSetting("password_changed");
  return changed !== "true";
}

export async function checkAdminCredentials(
  name: string,
  password: string
): Promise<boolean> {
  const dbName = await getSetting("admin_name");
  const dbPass = await getSetting("admin_password");

  if (dbName && dbPass) {
    // bcrypt hash 检测（三端统一为 $2 前缀，避免明文以 $ 开头时被误判）
    if (dbPass.startsWith("$2")) {
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
      await setSetting("admin_password", hashed);
      return true;
    }
    return false;
  }

  return name === DEFAULT_ADMIN_NAME && password === DEFAULT_ADMIN_PASSWORD;
}

export async function changeAdminPassword(
  name: string,
  password: string
): Promise<void> {
  const salt = await genSalt(10);
  const hashed = await hash(password, salt);
  await setSetting("admin_name", name);
  await setSetting("admin_password", hashed);
  await setSetting("password_changed", "true");
}
