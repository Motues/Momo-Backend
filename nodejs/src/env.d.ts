declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PORT?: string;
      DATABASE_URL: string;
      /**
       * 是否信任反向代理下发的客户端 IP 头（CF-Connecting-IP / X-Real-IP / X-Forwarded-For）。
       * 默认关闭；仅当部署在 Nginx / Cloudflare 等可信代理之后时设为 "true"。
       */
      TRUST_PROXY?: string;
    }
  }
}

export {};
