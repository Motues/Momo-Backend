import { cors } from 'hono/cors'

export const customCors = (allowOriginStr: string | undefined) => {
  // 1. 将环境变量字符串解析为数组
  // 如果环境变量不存在，则默认为空数组（即拒绝所有跨域请求）
  const allowedOrigins = allowOriginStr
    ? allowOriginStr.split(',').map(origin => origin.trim()).filter(Boolean)
    : []

  // 显式配置 * 时按通配处理
  const allowAll = allowedOrigins.includes('*')

  return cors({
    origin: (origin) => {
      if (!origin) return origin
      if (allowAll) return '*'
      // 精确匹配白名单
      if (allowedOrigins.includes(origin)) return origin
      return undefined
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    // 不启用 credentials：管理接口一律使用 Authorization: Bearer，
    // 同时下发 Allow-Origin: * 与 Allow-Credentials: true 在浏览器中本就是无效组合。
    credentials: false,
  })
}
