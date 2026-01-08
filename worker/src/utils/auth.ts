import { Context, Next } from 'hono';
import { Bindings } from '../bindings';

export const adminAuth = async (c: Context<{ Bindings: Bindings }>, next: Next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ message: "Unauthorized" }, 401);

  const sessionData = await c.env.MOMO_AUTH_KV.get(`token:${token}`);
  if (!sessionData) {
    return c.json({ message: "Token expired or invalid" }, 401);
  }

  const session = JSON.parse(sessionData);
  const currentIp = c.req.header('cf-connecting-ip');

  // 安全检查：如果 IP 发生变化（比如 Token 被盗），要求重新登录
//   if (session.ip !== currentIp) {
//     await c.env.MOMO_AUTH_KV.delete(`token:${token}`);
//     return c.json({ message: "Security alert: IP changed" }, 401);
//   }

  await next();
};