import { describe, it, expect } from "vitest";
import router from "../src/middleware/routes";

/**
 * GET /health —— 容器 HEALTHCHECK / 编排探针使用的公开端点。
 * 三端（Node / Go / Worker）响应结构必须一致。
 */
describe("GET /health", () => {
  it("数据库可用时返回 200 与统一结构", async () => {
    const res = await router.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 200,
      message: "ok",
      data: { status: "ok", database: "ok" },
    });
  });

  it("不需要 Authorization 头", async () => {
    const res = await router.request("/health");
    expect(res.status).not.toBe(401);
  });
});
