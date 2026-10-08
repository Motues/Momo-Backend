import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import router from "../src/middleware/routes";
import { db } from "../src/orm/client";
import { setSetting, getSetting } from "../src/utils/settings";
import { isTrustProxyEnabled } from "../src/utils/ip";
import { api, json, loginToken, seedComment, useTrustProxy, resetTables, clearSettings } from "./helpers";

/** 每条用例独立 IP，避免登录失败锁定（内存态）互相影响 */
let ipSequence = 0;
function uniqueIp(): string {
  ipSequence += 1;
  return `198.19.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

const RESET_KEYS = [
  "admin_name",
  "admin_password",
  "password_changed",
  "trust_proxy",
  "allow_origin",
  "ip_blacklist",
  "comment_auto_approve",
  "admin_email",
  "admin_comment_key",
  "admin_comment_key_enabled",
  "site_name",
  "placeholder_name",
  "email_enabled",
  "email_blacklist",
];

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  clearSettings(RESET_KEYS);
  delete process.env.TRUST_PROXY;
});

describe("admin 认证 — token 校验", () => {
  it("访问受保护接口缺少 Authorization 头返回 401", async () => {
    for (const path of [
      "/admin/comments/list",
      "/admin/settings",
      "/admin/stats/overview",
      "/admin/stats/users",
      "/admin/data/export/comments",
    ]) {
      const res = await router.request(path, { headers: { "cf-connecting-ip": uniqueIp() } });
      expect(res.status, path).toBe(401);
      expect((await json(res)).message).toBe("Invalid token");
    }
  });

  it("伪造 token 返回 401", async () => {
    const res = await api("/admin/comments/list", { token: "11111111-2222-3333-4444-555555555555" });
    expect(res.status).toBe(401);
  });

  it("空 Bearer 值返回 401", async () => {
    const res = await router.request("/admin/comments/list", {
      headers: { Authorization: "Bearer ", "cf-connecting-ip": uniqueIp() },
    });
    expect(res.status).toBe(401);
  });

  it("登录后携带 token 访问返回 200", async () => {
    const token = await loginToken();
    const res = await api("/admin/comments/list", { token });
    expect(res.status).toBe(200);
    expect((await json(res)).code).toBe(200);
  });

  it("不带 Bearer 前缀直接放 token 也接受（extractToken 兜底）", async () => {
    const token = await loginToken();
    const res = await router.request("/admin/comments/list", {
      headers: { Authorization: token, "cf-connecting-ip": uniqueIp() },
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /admin/login", () => {
  it("默认凭据登录成功并返回 token", async () => {
    const res = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "momo", password: "momo" },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe(200);
    expect(body.message).toBe("Login successful");
    expect(typeof body.token).toBe("string");
    expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.needChangePassword).toBe(true);
  });

  it("改密后 needChangePassword 为 false", async () => {
    await setSetting("password_changed", "true");
    await setSetting("admin_name", "momo");
    await setSetting("admin_password", "momo2");
    const res = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "momo", password: "momo2" },
    });
    expect((await json(res)).needChangePassword).toBe(false);
  });

  it("密码错误返回 401 且不返回 token", async () => {
    const res = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "momo", password: "wrong-password" },
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.code).toBe(401);
    expect(body.message).toBe("Invalid username or password");
    expect(body.token).toBeUndefined();
  });

  it("用户名错误返回 401", async () => {
    const res = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "someone-else", password: "momo" },
    });
    expect(res.status).toBe(401);
  });

  it("非字符串字段返回 400（而不是 500）", async () => {
    for (const body of [{ password: {} }, { name: [], password: "momo" }, { name: "momo", password: 123 }, {}]) {
      const res = await api("/admin/login", { method: "POST", ip: uniqueIp(), body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).message).toBe("name and password must be strings");
    }
  });

  it("请求体不是合法 JSON 返回 400", async () => {
    const res = await router.request("/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": uniqueIp() },
      body: "{{{",
    });
    expect(res.status).toBe(400);
  });

  it("同一 IP 连续失败 5 次后进入锁定（第 5 次即返回 403）", async () => {
    const ip = uniqueIp();
    for (let i = 1; i <= 4; i++) {
      const res = await api("/admin/login", {
        method: "POST",
        ip,
        body: { name: "momo", password: "bad" },
      });
      expect(res.status, `第 ${i} 次`).toBe(401);
    }
    const fifth = await api("/admin/login", {
      method: "POST",
      ip,
      body: { name: "momo", password: "bad" },
    });
    expect(fifth.status).toBe(403);
    expect((await json(fifth)).message).toContain("IP is blocked");
  });

  it("已锁定 IP 即使凭据正确也被拒绝", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      await api("/admin/login", { method: "POST", ip, body: { name: "momo", password: "bad" } });
    }
    const res = await api("/admin/login", {
      method: "POST",
      ip,
      body: { name: "momo", password: "momo" },
    });
    expect(res.status).toBe(403);
  });

  it("锁定只针对该 IP，其他 IP 不受影响", async () => {
    const blocked = uniqueIp();
    for (let i = 0; i < 5; i++) {
      await api("/admin/login", {
        method: "POST",
        ip: blocked,
        body: { name: "momo", password: "bad" },
      });
    }
    const res = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "momo", password: "momo" },
    });
    expect(res.status).toBe(200);
  });

  it("成功登录会清除该 IP 的失败计数", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 4; i++) {
      await api("/admin/login", { method: "POST", ip, body: { name: "momo", password: "bad" } });
    }
    expect(
      (await api("/admin/login", { method: "POST", ip, body: { name: "momo", password: "momo" } }))
        .status
    ).toBe(200);

    // 计数已清零：再失败 4 次仍然是 401
    for (let i = 1; i <= 4; i++) {
      const res = await api("/admin/login", {
        method: "POST",
        ip,
        body: { name: "momo", password: "bad" },
      });
      expect(res.status, `第 ${i} 次`).toBe(401);
    }
  });

  it("每次登录签发不同的 token，且旧的仍然有效（多会话并存）", async () => {
    const ip = uniqueIp();
    const first = await loginToken("momo", "momo", ip);
    const second = await loginToken("momo", "momo", ip);
    expect(first).not.toBe(second);
    expect((await api("/admin/comments/list", { token: first })).status).toBe(200);
    expect((await api("/admin/comments/list", { token: second })).status).toBe(200);
  });
});

describe("POST /admin/logout", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("登出后 token 立即失效", async () => {
    const token = await loginToken();
    const res = await api("/admin/logout", { method: "POST", token });
    expect(res.status).toBe(200);
    expect((await json(res)).message).toBe("Logged out");

    expect((await api("/admin/comments/list", { token })).status).toBe(401);
  });

  it("登出只吊销自己的 token，不影响其他会话", async () => {
    const a = await loginToken();
    const b = await loginToken();
    await api("/admin/logout", { method: "POST", token: a });
    expect((await api("/admin/comments/list", { token: b })).status).toBe(200);
  });
});

describe("GET /admin/settings", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/settings")).status).toBe(401);
  });

  it("默认返回白名单字段与 email_enabled 默认值", async () => {
    const token = await loginToken();
    await setSetting("site_name", "我的站");
    const res = await api("/admin/settings", { token });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe(200);
    expect(body.data.site_name).toBe("我的站");
    expect(body.data.email_enabled).toBe("true");
  });

  it("敏感字段读取时始终置空或被彻底排除", async () => {
    const token = await loginToken();
    await setSetting("admin_password", "$2b$10$abcdefghijklmnopqrstuv");
    await setSetting("email_password", "smtp-secret");
    await setSetting("admin_comment_key", "blogger-key");
    await setSetting("comment_verify_secret", "verify-secret");

    const body = await json(await api("/admin/settings", { token }));
    // admin_password 与 comment_verify_secret 根本不在白名单里，不会下发
    expect(body.data.admin_password).toBeUndefined();
    expect(body.data.comment_verify_secret).toBeUndefined();
    // email_password / admin_comment_key 在白名单内但被置空
    expect(body.data.email_password).toBe("");
    expect(body.data.admin_comment_key).toBe("");
  });

  it("type=basic 只返回基础分组字段", async () => {
    const token = await loginToken();
    const basicKeys = [
      "site_name",
      "admin_email",
      "comment_auto_approve",
      "blogger_badge_enabled",
      "blogger_badge_text",
      "placeholder_name",
      "placeholder_email",
      "placeholder_content",
      "placeholder_url",
    ];
    for (const key of basicKeys) await setSetting(key, "1");
    // 混入一个非基础分组的键，确认不会被返回
    await setSetting("ip_blacklist", "[]");

    const body = await json(await api("/admin/settings?type=basic", { token }));
    expect(Object.keys(body.data).sort()).toEqual([...basicKeys, "email_enabled"].sort());
    expect(body.data.ip_blacklist).toBeUndefined();
  });

  it("type=toString 会因原型链查找触发 500（已知缺陷）", async () => {
    // settings.ts:61 使用 `type in SETTINGS_GROUPS`，会命中 Object.prototype 上的成员，
    // 导致 keys 不是数组、for...of 抛 TypeError；详见最终报告中的 bug 列表。
    const token = await loginToken();
    const res = await api("/admin/settings?type=toString", { token });
    expect(res.status).toBe(500);
  });

  it("未知 type 回退到全量白名单", async () => {
    const token = await loginToken();
    await setSetting("admin_email", "admin@example.com");
    const body = await json(await api("/admin/settings?type=unknown-group", { token }));
    expect(body.data.admin_email).toBe("admin@example.com");
  });

  it("环境变量强制指定 trust_proxy 时下发 override 标记", async () => {
    const token = await loginToken();
    process.env.TRUST_PROXY = "true";
    const body = await json(await api("/admin/settings?type=security", { token }));
    expect(body.data.trust_proxy_override).toBe("env");
  });
});

describe("PUT /admin/settings", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/settings", { method: "PUT", body: { site_name: "x" } });
    expect(res.status).toBe(401);
  });

  it("白名单外的键返回 400 且不写入任何字段", async () => {
    const token = await loginToken();
    const res = await api("/admin/settings", {
      method: "PUT",
      token,
      body: { site_name: "不应写入", unknown_key: "1" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("is not allowed");
    expect(await getSetting("site_name")).toBeNull();
  });

  it("白名单字段写入后可在 GET 中读回", async () => {
    const token = await loginToken();
    const res = await api("/admin/settings", {
      method: "PUT",
      token,
      body: {
        site_name: "新站名",
        comment_auto_approve: "false",
        blogger_badge_enabled: "true",
        blogger_badge_text: "楼主",
        admin_email: "admin@example.com",
      },
    });
    expect(res.status).toBe(200);

    const body = await json(await api("/admin/settings", { token }));
    expect(body.data.site_name).toBe("新站名");
    expect(body.data.comment_auto_approve).toBe("false");
    expect(body.data.blogger_badge_enabled).toBe("true");
    expect(body.data.blogger_badge_text).toBe("楼主");
    expect(body.data.admin_email).toBe("admin@example.com");
  });

  it("数值与布尔值会被转成字符串存储", async () => {
    const token = await loginToken();
    await api("/admin/settings", { method: "PUT", token, body: { smtp_port: 587 } });
    expect(await getSetting("smtp_port")).toBe("587");
  });

  it("email_password 传空串时不覆盖已有密码", async () => {
    const token = await loginToken();
    await setSetting("email_password", "keep-me");
    await api("/admin/settings", { method: "PUT", token, body: { email_password: "" } });
    expect(await getSetting("email_password")).toBe("keep-me");
  });

  it("非法 ip_blacklist 返回 400，合法的写入", async () => {
    const token = await loginToken();
    const bad = await api("/admin/settings", {
      method: "PUT",
      token,
      body: { ip_blacklist: "not-json" },
    });
    expect(bad.status).toBe(400);
    expect(await getSetting("ip_blacklist")).toBeNull();

    const good = await api("/admin/settings", {
      method: "PUT",
      token,
      body: { ip_blacklist: JSON.stringify(["1.2.3.4", "10.0.0.0/8"]) },
    });
    expect(good.status).toBe(200);
    expect(await getSetting("ip_blacklist")).toBe('["1.2.3.4","10.0.0.0/8"]');
  });

  it("传入 trust_proxy 立即生效（不等缓存过期）", async () => {
    const token = await loginToken();
    await api("/admin/settings", { method: "PUT", token, body: { trust_proxy: "true" } });
    expect(isTrustProxyEnabled()).toBe(true);
    await api("/admin/settings", { method: "PUT", token, body: { trust_proxy: "false" } });
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("请求体是 JSON 字符串（非对象）时返回 400", async () => {
    const token = await loginToken();
    const res = await router.request("/admin/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-connecting-ip": uniqueIp(),
      },
      body: JSON.stringify("just-a-string"),
    });
    expect(res.status).toBe(400);
  });

  it("POST /admin/settings/test-email 未配置管理员邮箱返回 400", async () => {
    const token = await loginToken();
    const res = await api("/admin/settings/test-email", { method: "POST", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("Admin email is not configured");
  });

  it("POST /admin/settings/test-email 未配置 SMTP 返回 400", async () => {
    const token = await loginToken();
    await setSetting("admin_email", "admin@example.com");
    const res = await api("/admin/settings/test-email", { method: "POST", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("SMTP");
  });

  it("POST /admin/settings/test-email 缺少 token 返回 401", async () => {
    expect((await api("/admin/settings/test-email", { method: "POST" })).status).toBe(401);
  });
});

describe("PUT /admin/comments/status", () => {
  it("缺少 token 返回 401", async () => {
    const id = seedComment({ post_slug: "/posts/status" });
    expect((await api(`/admin/comments/status?id=${id}&status=approved`, { method: "PUT" })).status).toBe(
      401
    );
  });

  it("缺少/非法 id 返回 400", async () => {
    const token = await loginToken();
    expect(
      (await api("/admin/comments/status?status=approved", { method: "PUT", token })).status
    ).toBe(400);
    expect(
      (await api("/admin/comments/status?id=0&status=approved", { method: "PUT", token })).status
    ).toBe(400);
    expect(
      (await api("/admin/comments/status?id=abc&status=approved", { method: "PUT", token })).status
    ).toBe(400);
  });

  it("非法状态枚举返回 400", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/status", status: "pending" });
    const res = await api(`/admin/comments/status?id=${id}&status=spam`, { method: "PUT", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("Invalid status");
    const row = db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.status).toBe("pending");
  });

  it.each(["pending", "approved", "rejected", "deleted"])("合法状态 %s 可写入", async (status) => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/status", status: "pending" });
    const res = await api(`/admin/comments/status?id=${id}&status=${status}`, { method: "PUT", token });
    expect(res.status).toBe(200);
    const row = db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.status).toBe(status);
  });

  it("approved/rejected 只改本条，不级联子评论", async () => {
    const token = await loginToken();
    const parent = seedComment({ post_slug: "/posts/cascade", status: "pending" });
    const child = seedComment({
      post_slug: "/posts/cascade",
      status: "pending",
      parent_id: parent,
    });

    await api(`/admin/comments/status?id=${parent}&status=approved`, { method: "PUT", token });
    const childRow = db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${child}`) as any;
    expect(childRow.status).toBe("pending");
  });

  it("deleted 级联到全部子孙评论", async () => {
    const token = await loginToken();
    const root = seedComment({ post_slug: "/posts/cascade2", status: "approved" });
    const child = seedComment({ post_slug: "/posts/cascade2", status: "approved", parent_id: root });
    const grandchild = seedComment({
      post_slug: "/posts/cascade2",
      status: "approved",
      parent_id: child,
    });
    const unrelated = seedComment({ post_slug: "/posts/cascade2", status: "approved" });

    const res = await api(`/admin/comments/status?id=${root}&status=deleted`, { method: "PUT", token });
    expect(res.status).toBe(200);

    const statusOf = (id: number) =>
      (db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as any).status;
    expect(statusOf(root)).toBe("deleted");
    expect(statusOf(child)).toBe("deleted");
    expect(statusOf(grandchild)).toBe("deleted");
    expect(statusOf(unrelated)).toBe("approved");
  });

  it("pending 同样级联到子孙评论", async () => {
    const token = await loginToken();
    const root = seedComment({ post_slug: "/posts/cascade3", status: "approved" });
    const child = seedComment({ post_slug: "/posts/cascade3", status: "approved", parent_id: root });

    await api(`/admin/comments/status?id=${root}&status=pending`, { method: "PUT", token });
    const statusOf = (id: number) =>
      (db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as any).status;
    expect(statusOf(root)).toBe("pending");
    expect(statusOf(child)).toBe("pending");
  });

  it("对不存在的 id 返回 500（未做存在性校验，已知缺陷）", async () => {
    // CommentService.updateCommentStatus 在更新后查不到记录会抛 Error("Comment not found after update")，
    // 该异常未被 handler 捕获，Hono 兜底成 500；理想行为应为 404。
    const token = await loginToken();
    const res = await api("/admin/comments/status?id=999999&status=approved", { method: "PUT", token });
    expect(res.status).toBe(500);
  });

  it("负数 id 同样返回 500（未做存在性校验，已知缺陷）", async () => {
    const token = await loginToken();
    const res = await api("/admin/comments/status?id=-1&status=approved", { method: "PUT", token });
    expect(res.status).toBe(500);
  });
});

describe("PUT /admin/comments/edit", () => {
  it("缺少 token 返回 401", async () => {
    const id = seedComment({ post_slug: "/posts/edit" });
    expect(
      (await api("/admin/comments/edit", { method: "PUT", body: { id, author: "x" } })).status
    ).toBe(401);
  });

  it("缺少 id / 无可更新字段返回 400", async () => {
    const token = await loginToken();
    expect(
      (await api("/admin/comments/edit", { method: "PUT", token, body: { author: "x" } })).status
    ).toBe(400);
    const id = seedComment({ post_slug: "/posts/edit" });
    const res = await api("/admin/comments/edit", { method: "PUT", token, body: { id } });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe("No fields to update");
  });

  it("字段类型错误返回 400", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit" });
    for (const field of ["author", "email", "content_text", "content_html", "url"]) {
      const res = await api("/admin/comments/edit", {
        method: "PUT",
        token,
        body: { id, [field]: 123 },
      });
      expect(res.status, field).toBe(400);
      expect((await json(res)).message).toBe("Invalid field type");
    }
  });

  it("超出长度上限返回 400", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit" });
    const res = await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: { id, content_text: "x".repeat(2001) },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe("Field length limit exceeded");
  });

  it("更新作者/邮箱并落库", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit" });
    const res = await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: { id, author: "新昵称", email: "  new@example.com  " },
    });
    expect(res.status).toBe(200);

    const row = db.get(sql`SELECT * FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.author).toBe("新昵称");
    expect(row.email).toBe("new@example.com"); // 邮箱被 trim
  });

  it("只改 content_text 时自动重新渲染 content_html", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit", content_html: "<p>旧</p>" });
    await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: { id, content_text: "**加粗**" },
    });
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.content_text).toBe("**加粗**");
    expect(row.content_html).toContain("<strong>加粗</strong>");
  });

  it("url 走协议白名单，content_html 被净化", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit" });
    await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: {
        id,
        url: "javascript:alert(1)",
        content_html: '<p>ok</p><script>alert(1)</script>',
      },
    });
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.url).toBe("");
    expect(row.content_html).toBe("<p>ok</p>");
  });

  it("后台改作者时同样过滤 XSS", async () => {
    const token = await loginToken();
    const id = seedComment({ post_slug: "/posts/edit" });
    await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: { id, author: "<script>x</script>清理后" },
    });
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "id" = ${id}`) as any;
    expect(row.author).toBe("清理后");
  });

  it("对不存在的 id 返回 500（未做存在性校验，已知缺陷）", async () => {
    const token = await loginToken();
    const res = await api("/admin/comments/edit", {
      method: "PUT",
      token,
      body: { id: 999999, author: "x" },
    });
    expect(res.status).toBe(500);
  });
});

describe("PUT /admin/password", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/password", {
      method: "PUT",
      body: { old_name: "momo", old_password: "momo", new_name: "momo", new_password: "12345678" },
    });
    expect(res.status).toBe(401);
  });

  it("字段缺失或类型错误返回 400", async () => {
    const token = await loginToken();
    for (const body of [
      {},
      { old_name: "momo", old_password: "momo", new_name: "momo" },
      { old_name: 1, old_password: "momo", new_name: "momo", new_password: "12345678" },
    ]) {
      const res = await api("/admin/password", { method: "PUT", token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("请求体不是合法 JSON 返回 400", async () => {
    const token = await loginToken();
    const res = await router.request("/admin/password", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-connecting-ip": uniqueIp(),
      },
      body: "{{{",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("are required");
  });

  it("新密码少于 8 位返回 400", async () => {
    const token = await loginToken();
    const res = await api("/admin/password", {
      method: "PUT",
      token,
      body: { old_name: "momo", old_password: "momo", new_name: "momo", new_password: "1234567" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("at least 8 characters");
  });

  it("旧凭据错误返回 401", async () => {
    const token = await loginToken();
    const res = await api("/admin/password", {
      method: "PUT",
      token,
      body: {
        old_name: "momo",
        old_password: "wrong",
        new_name: "momo",
        new_password: "newpassword",
      },
    });
    expect(res.status).toBe(401);
    expect((await json(res)).message).toBe("Current credentials are incorrect");
  });

  it("改密成功后吊销全部会话，新密码可登录", async () => {
    const token = await loginToken();
    const res = await api("/admin/password", {
      method: "PUT",
      token,
      body: {
        old_name: "momo",
        old_password: "momo",
        new_name: "newadmin",
        new_password: "brand-new-pass",
      },
    });
    expect(res.status).toBe(200);

    // 旧 token 立即失效
    expect((await api("/admin/comments/list", { token })).status).toBe(401);

    // 新凭据可用、旧凭据失效
    const login = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "newadmin", password: "brand-new-pass" },
    });
    expect(login.status).toBe(200);
    expect((await json(login)).needChangePassword).toBe(false);

    const oldLogin = await api("/admin/login", {
      method: "POST",
      ip: uniqueIp(),
      body: { name: "momo", password: "momo" },
    });
    expect(oldLogin.status).toBe(401);
  });
});

describe("用户邮箱黑名单接口", () => {
  it("缺少 token 返回 401", async () => {
    expect(
      (await api("/admin/users/blacklist", { method: "POST", body: { email: "a@b.com" } })).status
    ).toBe(401);
    expect(
      (await api("/admin/users/blacklist?email=a@b.com", { method: "DELETE" })).status
    ).toBe(401);
  });

  it("缺少 email 返回 400", async () => {
    const token = await loginToken();
    expect((await api("/admin/users/blacklist", { method: "POST", token, body: {} })).status).toBe(400);
    expect((await api("/admin/users/blacklist", { method: "DELETE", token })).status).toBe(400);
  });

  it("添加后小写归一化写入，重复添加幂等", async () => {
    const token = await loginToken();
    const first = await api("/admin/users/blacklist", {
      method: "POST",
      token,
      body: { email: "  Bad@Example.COM " },
    });
    expect(first.status).toBe(200);
    const body = await json(first);
    expect(body.data).toEqual({ email: "bad@example.com", blacklisted: true });
    expect(await getSetting("email_blacklist")).toBe('["bad@example.com"]');

    const second = await api("/admin/users/blacklist", {
      method: "POST",
      token,
      body: { email: "BAD@example.com" },
    });
    expect(second.status).toBe(200);
    expect((await json(second)).message).toBe("User is already in blacklist");
    expect(await getSetting("email_blacklist")).toBe('["bad@example.com"]');
  });

  it("移除黑名单后可再次提交评论", async () => {
    const token = await loginToken();
    await api("/admin/users/blacklist", {
      method: "POST",
      token,
      body: { email: "blocked@example.com" },
    });
    const removed = await api("/admin/users/blacklist?email=BLOCKED@example.com", {
      method: "DELETE",
      token,
    });
    expect(removed.status).toBe(200);
    expect((await json(removed)).data).toEqual({ email: "blocked@example.com", blacklisted: false });
    expect(await getSetting("email_blacklist")).toBe("[]");
  });

  it("移除不存在的邮箱返回 200 且不报错", async () => {
    const token = await loginToken();
    const res = await api("/admin/users/blacklist?email=nobody@example.com", {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).message).toBe("User is not in blacklist");
  });
});
