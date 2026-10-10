import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "path";
import fs from "fs";

import corsMiddleware from "./middleware/cors";
import router from "./middleware/routes";
import LogService from "./utils/log";
import { initTrustProxy } from "./utils/ip";
import { pruneVerifyRecords } from "./orm/verifyRecordService";

const app = new Hono();

// 全局错误处理 — 防止内部错误泄露
app.onError((err, c) => {
  LogService.error("Unhandled error", err);
  return c.json({ code: 500, message: "Internal server error" }, 500);
});

// CORS
app.use("*", corsMiddleware);

// 静态文件 — 管理面板构建产物
app.use("/*", serveStatic({ root: "./public" }));

// API 路由（在静态文件之后，优先于 SPA fallback）
app.route("/", router);

// SPA fallback — 管理面板前端路由
app.get("*", async (c) => {
  const htmlPath = path.join(process.cwd(), "public", "index.html");
  if (fs.existsSync(htmlPath)) {
    return c.html(fs.readFileSync(htmlPath, "utf-8"));
  }
  return c.notFound();
});

const port = Number(process.env.PORT || 3000);

// 先把「是否信任代理头」的页面设置读入缓存，再开始监听，
// 避免最初的几个请求按默认值（不信任）处理
initTrustProxy()
  .catch((e) => LogService.error("读取 trust_proxy 设置失败", e))
  .finally(() => {
    // 启动时清一次过期的认证记录（后续由写入路径按小时惰性清理）
    pruneVerifyRecords().catch((e) => LogService.warn("清理认证记录失败", e));
    serve({ fetch: app.fetch, port });
    console.log(`Server running on http://localhost:${port}`);
  });
