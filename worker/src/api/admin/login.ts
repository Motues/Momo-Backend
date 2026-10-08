import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { checkAdminCredentials, isDefaultAdmin } from '../../utils/settings';

// 简单配置：允许尝试 5 次，锁定 30 分钟
const MAX_ATTEMPTS = 5;
const LOCK_TIME = 30 * 60; // 秒

export const adminLogin = async (c: Context<{ Bindings: Bindings }>) => {
  const data = await c.req.json().catch(() => null);

  // 类型校验：非字符串（如 {"password":{}}）直接 400，
  // 否则 bcrypt 会抛错变成 500，且该次失败不计入锁定计数
  if (typeof data?.name !== 'string' || typeof data?.password !== 'string') {
    return c.json({ code: 400, message: "name and password must be strings" }, 400);
  }

  // cf-connecting-ip 由 Cloudflare 在边缘覆写，客户端无法伪造
  const ip = c.req.header('cf-connecting-ip') || "127.0.0.1";
  
  const blockKey = `block:${ip}`;
  const attemptKey = `attempts:${ip}`;

  // 1. 检查 IP 是否被封禁
  const isBlocked = await c.env.MOMO_AUTH_KV.get(blockKey);
  if (isBlocked) {
    return c.json({ code: 403, message: "IP is blocked due to multiple failed login attempts" }, 403);
  }

  // 2. 验证用户名密码
  const isValid = await checkAdminCredentials(c.env, data.name, data.password);

  if (!isValid) {
    // --- 登录失败逻辑 ---
    // 获取当前失败次数
    const attempts = parseInt(await c.env.MOMO_AUTH_KV.get(attemptKey) || "0") + 1;
    
    if (attempts >= MAX_ATTEMPTS) {
      // 达到上限，封禁 30 分钟
      await c.env.MOMO_AUTH_KV.put(blockKey, "1", { expirationTtl: LOCK_TIME });
      await c.env.MOMO_AUTH_KV.delete(attemptKey); // 清除尝试计数
      return c.json({
        code: 403,
        message: "IP is blocked due to multiple failed login"
      }, 403);
    } else {
      // 记录失败次数，设置 10 分钟内连续失败才计数
      await c.env.MOMO_AUTH_KV.put(attemptKey, attempts.toString(), { expirationTtl: 600 });
      return c.json({
        code: 401,
        message: "Invalid username or password",
        }, 401);
    }
  }

  // --- 3. 登录成功逻辑 ---
  await c.env.MOMO_AUTH_KV.delete(attemptKey);

  // 生成 Token (你的 tempKey)
  const tempKey = crypto.randomUUID();

  // 将 Token 存入 KV，有效期 20 分钟 (1200秒)
  // 我们存入一个对象，包含用户名和登录 IP，增加安全性
  await c.env.MOMO_AUTH_KV.put(`token:${tempKey}`, JSON.stringify({
    user: data.name,
    ip: ip
  }), { expirationTtl: 1200 });

  const needChangePassword = await isDefaultAdmin(c.env);

  return c.json({
      code: 200,
      message: "Login successful",
      token: tempKey,
      needChangePassword
  });
};