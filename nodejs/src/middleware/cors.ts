import { cors } from "hono/cors";
import { getSetting } from "../utils/settings";

const CheckAllowOrigins = async (requestOrigin: string): Promise<string> => {
  if (!requestOrigin) return "";

  const allowOriginStr = await getSetting("allow_origin");
  if (!allowOriginStr) return "";

  const allowedOrigins = allowOriginStr.split(",").map((s) => s.trim()).filter(Boolean);

  // 显式配置 * 时按 * 处理（API 使用 Bearer token，不依赖 Cookie 凭据）
  if (allowedOrigins.includes("*")) return "*";
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return "";
};

// 注意：不启用 credentials —— 管理接口一律使用 Authorization: Bearer，
// 同时下发 Allow-Origin: * 与 Allow-Credentials: true 在浏览器中本就是无效组合。
const corsMiddleware = cors({
  origin: async (origin) => {
    return CheckAllowOrigins(origin || "");
  },
  credentials: false,
});

export default corsMiddleware;
