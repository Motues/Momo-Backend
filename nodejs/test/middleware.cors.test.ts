import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import corsMiddleware from "../src/middleware/cors";
import { setSetting } from "../src/utils/settings";
import { clearSettings } from "./helpers";

/**
 * app.ts 会给路由挂上 CORS 中间件（本测试不导入 app.ts，避免启动真实服务），
 * 这里把同一个中间件挂到一个最小 Hono 应用上，验证 allow_origin 设置的行为。
 */
function makeApp(): Hono {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

async function allowOriginFor(origin?: string): Promise<string | null> {
  const res = await makeApp().request("/ping", {
    headers: origin === undefined ? {} : { Origin: origin },
  });
  return res.headers.get("access-control-allow-origin");
}

beforeEach(() => {
  clearSettings(["allow_origin"]);
});

afterEach(() => {
  clearSettings(["allow_origin"]);
});

describe("middleware/cors — allow_origin 白名单", () => {
  it("请求没有 Origin 头时不下发 CORS 头", async () => {
    await setSetting("allow_origin", "*");
    expect(await allowOriginFor()).toBeNull();
  });

  it("未配置 allow_origin 时不下发 CORS 头", async () => {
    expect(await allowOriginFor("https://a.com")).toBeNull();
  });

  it("allow_origin 为空串时不下发 CORS 头", async () => {
    await setSetting("allow_origin", "");
    expect(await allowOriginFor("https://a.com")).toBeNull();
  });

  it("配置 * 时返回 *（API 使用 Bearer token，不依赖 Cookie）", async () => {
    await setSetting("allow_origin", "*");
    expect(await allowOriginFor("https://a.com")).toBe("*");
  });

  it("白名单内的来源被回显，白名单外不下发", async () => {
    await setSetting("allow_origin", "https://a.com, https://b.com");
    expect(await allowOriginFor("https://a.com")).toBe("https://a.com");
    expect(await allowOriginFor("https://b.com")).toBe("https://b.com");
    expect(await allowOriginFor("https://evil.com")).toBeNull();
  });

  it("大小写与结尾斜杠不匹配（精确比较）", async () => {
    await setSetting("allow_origin", "https://a.com");
    expect(await allowOriginFor("https://A.com")).toBeNull();
    expect(await allowOriginFor("https://a.com/")).toBeNull();
  });

  it("只有空白项的配置不产生任何放行", async () => {
    await setSetting("allow_origin", "  ,  , ");
    expect(await allowOriginFor("https://a.com")).toBeNull();
  });

  it("列表中的 * 优先级最高", async () => {
    await setSetting("allow_origin", "https://a.com,*");
    expect(await allowOriginFor("https://evil.com")).toBe("*");
  });

  it("预检请求（OPTIONS）返回 204 且带上允许的方法", async () => {
    await setSetting("allow_origin", "https://a.com");
    const res = await makeApp().request("/ping", {
      method: "OPTIONS",
      headers: {
        Origin: "https://a.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://a.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("预检请求来源不在白名单时不下发 CORS 头", async () => {
    await setSetting("allow_origin", "https://a.com");
    const res = await makeApp().request("/ping", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("不下发 Access-Control-Allow-Credentials（与 * 组合本就无效）", async () => {
    await setSetting("allow_origin", "https://a.com");
    const res = await makeApp().request("/ping", { headers: { Origin: "https://a.com" } });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
