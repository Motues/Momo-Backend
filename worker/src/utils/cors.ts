import { cors } from 'hono/cors'

export const customCors = (allowOriginStr: string | undefined) => {
  // 1. 将环境变量字符串解析为数组
  // 如果环境变量不存在，则默认为空数组
  const allowedOrigins = allowOriginStr 
    ? allowOriginStr.split(',').map(origin => origin.trim()) 
    : []

  return cors({
    origin: (origin) => {
      // 如果请求的 origin 在白名单中，或者是本地文件(null)
      if (!origin || allowedOrigins.includes(origin)) {
        return origin
      }
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
}