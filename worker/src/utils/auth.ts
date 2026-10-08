import { Context, Next } from 'hono';
import { Bindings } from '../bindings';

export const adminAuth = async (c: Context<{ Bindings: Bindings }>, next: Next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ code: 401, message: "Unauthorized" }, 401);

  const sessionData = await c.env.MOMO_AUTH_KV.get(`token:${token}`);
  if (!sessionData) {
    return c.json({ code: 401, message: "Token expired or invalid" }, 401);
  }

  // 说明（S11）：此处**不**校验登录 IP。
  // cf-connecting-ip 由 Cloudflare 覆写、本身可信，但移动网络与双栈客户端在会话期间
  // 出口 IP 会变化，严格绑定会造成大量误杀；token 仅有 20 分钟有效期。
  // 如需更严格的会话绑定，可在此处比对 JSON.parse(sessionData).ip 与
  // c.req.header('cf-connecting-ip')，并做好误杀宽限。
  await next();
};
