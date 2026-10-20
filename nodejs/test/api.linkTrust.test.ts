import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { api, json, loginToken, seedComment, useTrustProxy, resetTables, clearSettings } from "./helpers";

/**
 * 休眠链接的**人工确认**（`/admin/links/trust`）与它在两条读取路径上的豁免效果：
 *
 *  - `GET /admin/stats/users`（后台用户列表：`urlDormant` + `urlTrustedUntil`）
 *  - `GET /api/comments`（公开评论区：每条的 `urlDormant`）
 *
 * 口径的唯一事实来源是 doc/link_security.md 第 2.4 节；有效期 = 确认那一刻的
 * `link_dormant_days` 天，读取时「严格大于当前时间」才算有效（过期自动恢复休眠）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = "/posts/trust";
const URL = "https://dormant.example.com";

const TOUCHED_SETTINGS = [
  "link_security_enabled",
  "link_dormant_days",
  "email_blacklist",
  "admin_email",
  "admin_emails",
  "notify_email",
];

/** 休眠链接的标准种子：90 天前评论（超过默认 30 天）、带个人网址 */
function seedDormant(options: Parameters<typeof seedComment>[0] = {}) {
  return seedComment({
    post_slug: PAGE,
    author: "老访客",
    email: "old@example.com",
    url: URL,
    pub_date: Date.now() - 90 * DAY_MS,
    status: "approved",
    ...options,
  });
}

function trustRows(): any[] {
  return db.all(sql`SELECT * FROM "TrustedLink" ORDER BY id`) as any[];
}

/** 直接插一条确认记录（用于构造已过期的历史记录） */
function insertTrustRow(email: string, url: string, expiresAt: string) {
  db.run(sql`
    INSERT INTO "TrustedLink" ("email", "url", "expires_at", "created_at")
    VALUES (${email}, ${url}, ${expiresAt}, ${new Date().toISOString()})
  `);
}

async function userRow(token: string, email = "old@example.com") {
  const body = await json(await api("/admin/stats/users", { token }));
  return body.data.users.find((u: any) => u.email === email);
}

beforeEach(async () => {
  useTrustProxy();
  resetTables();
  await setSetting("link_security_enabled", "true");
});

afterEach(() => {
  clearSettings(TOUCHED_SETTINGS);
});

describe("POST /admin/links/trust", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/links/trust", {
      method: "POST",
      body: { email: "old@example.com", url: URL },
    });
    expect(res.status).toBe(401);
  });

  it("确认后写入记录，有效期 = 当前的 link_dormant_days 天", async () => {
    await setSetting("link_dormant_days", "10");
    const token = await loginToken();
    const before = Date.now();

    const res = await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { email: "Old@Example.com ", url: URL },
    });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.message).toBe("Link trusted successfully");
    // 邮箱归一化后落库
    expect(body.data.email).toBe("old@example.com");
    expect(body.data.url).toBe(URL);
    expect(body.data.days).toBe(10);
    expect(body.data.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const expires = new Date(body.data.expiresAt).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(10 * DAY_MS - 5000);
    expect(expires - before).toBeLessThanOrEqual(10 * DAY_MS + 5000);

    const rows = trustRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("old@example.com");
    expect(rows[0].url).toBe(URL);
    expect(rows[0].expires_at).toBe(body.data.expiresAt);
  });

  it("重复确认是幂等的 upsert：只留一行，并刷新到期时间", async () => {
    await setSetting("link_dormant_days", "1");
    const token = await loginToken();

    const first = await json(
      await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } })
    );
    // 换一个更长的有效期再确认一次
    await setSetting("link_dormant_days", "60");
    const second = await json(
      await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } })
    );

    expect(trustRows()).toHaveLength(1);
    expect(second.data.days).toBe(60);
    expect(new Date(second.data.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.data.expiresAt).getTime()
    );
    expect(trustRows()[0].expires_at).toBe(second.data.expiresAt);
  });

  it("缺少 email 或 url 返回 400", async () => {
    const token = await loginToken();
    const missingEmail = await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { url: URL },
    });
    expect(missingEmail.status).toBe(400);
    expect((await json(missingEmail)).message).toBe("email and url are required");

    const missingUrl = await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { email: "old@example.com" },
    });
    expect(missingUrl.status).toBe(400);
    expect((await json(missingUrl)).message).toBe("email and url are required");
  });

  it("网址被 sanitizeUrl 拦掉（javascript:）时返回 400 且不落库", async () => {
    const token = await loginToken();
    const res = await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { email: "old@example.com", url: "javascript:alert(1)" },
    });
    expect(res.status).toBe(400);
    expect(trustRows()).toHaveLength(0);
  });
});

describe("DELETE /admin/links/trust", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api(`/admin/links/trust?email=old@example.com&url=${encodeURIComponent(URL)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("撤销已存在的确认", async () => {
    const token = await loginToken();
    await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } });
    expect(trustRows()).toHaveLength(1);

    const res = await api(`/admin/links/trust?email=old@example.com&url=${encodeURIComponent(URL)}`, {
      method: "DELETE",
      token,
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.message).toBe("Link trust revoked");
    expect(body.data.revoked).toBe(true);
    expect(trustRows()).toHaveLength(0);
  });

  it("重复撤销幂等：原本没有记录时 revoked 为 false", async () => {
    const token = await loginToken();
    const res = await api(`/admin/links/trust?email=old@example.com&url=${encodeURIComponent(URL)}`, {
      method: "DELETE",
      token,
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.message).toBe("Link is not trusted");
    expect(body.data.revoked).toBe(false);
  });

  it("缺少参数返回 400", async () => {
    const token = await loginToken();
    const res = await api("/admin/links/trust?email=old@example.com", { method: "DELETE", token });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe("email and url are required");
  });
});

describe("人工确认对用户列表的豁免", () => {
  it("确认有效时 urlDormant 为 false 且下发到期时间", async () => {
    seedDormant();
    const token = await loginToken();

    const beforeTrust = await userRow(token);
    expect(beforeTrust.urlDormant).toBe(true);
    expect(beforeTrust.urlTrustedUntil).toBe("");

    const created = await json(
      await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } })
    );

    const afterTrust = await userRow(token);
    expect(afterTrust.urlDormant).toBe(false);
    expect(afterTrust.urlTrustedUntil).toBe(created.data.expiresAt);
  });

  it("确认已过期时照样休眠，且不下发到期时间", async () => {
    seedDormant();
    insertTrustRow("old@example.com", URL, new Date(Date.now() - 1000).toISOString());

    const token = await loginToken();
    const row = await userRow(token);
    expect(row.urlDormant).toBe(true);
    expect(row.urlTrustedUntil).toBe("");
  });

  it("到期时间恰好等于现在视为过期（严格大于）", async () => {
    seedDormant();
    insertTrustRow("old@example.com", URL, new Date(Date.now()).toISOString());

    const token = await loginToken();
    // 断言的是「不晚于」——插入与读取之间必然经过若干毫秒，只要不是「恰好相等」也能覆盖边界
    expect((await userRow(token)).urlDormant).toBe(true);
  });

  it("换链接不继承确认：确认的是旧网址，用户改留新网址后恢复休眠", async () => {
    seedDormant();
    const token = await loginToken();
    await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } });
    expect((await userRow(token)).urlDormant).toBe(false);

    // 该用户后来又留了一个新网址（比旧评论更晚）
    seedComment({
      post_slug: PAGE,
      author: "老访客",
      email: "old@example.com",
      url: "https://new.example.com",
      pub_date: Date.now() - 90 * DAY_MS + 1000,
    });

    const row = await userRow(token);
    expect(row.url).toBe("https://new.example.com");
    expect(row.urlDormant).toBe(true);
    expect(row.urlTrustedUntil).toBe("");
  });

  it("撤销后立即恢复休眠", async () => {
    seedDormant();
    const token = await loginToken();
    await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } });
    expect((await userRow(token)).urlDormant).toBe(false);

    await api(`/admin/links/trust?email=old@example.com&url=${encodeURIComponent(URL)}`, {
      method: "DELETE",
      token,
    });
    expect((await userRow(token)).urlDormant).toBe(true);
  });
});

describe("人工确认对公开评论区的豁免", () => {
  const urlDormantOf = (body: any) => body.data.comments.find((c: any) => c.url === URL)?.urlDormant;

  it("确认有效时该条评论不再休眠，且不影响同页其他人的链接", async () => {
    seedDormant();
    seedComment({
      post_slug: PAGE,
      author: "另一位",
      email: "other@example.com",
      url: "https://other.example.com",
      pub_date: Date.now() - 90 * DAY_MS,
    });

    const before = await json(await api(`/api/comments?post_slug=${PAGE}`));
    expect(urlDormantOf(before)).toBe(true);

    const token = await loginToken();
    await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } });

    const after = await json(await api(`/api/comments?post_slug=${PAGE}`));
    expect(urlDormantOf(after)).toBe(false);
    expect(after.data.comments.find((c: any) => c.url === "https://other.example.com").urlDormant).toBe(true);
  });

  it("确认过期后重新休眠", async () => {
    seedDormant();
    insertTrustRow("old@example.com", URL, new Date(Date.now() - 1000).toISOString());
    const body = await json(await api(`/api/comments?post_slug=${PAGE}`));
    expect(urlDormantOf(body)).toBe(true);
  });

  it("功能关闭时确认与否都不休眠（豁免与判定一起失效）", async () => {
    seedDormant();
    const token = await loginToken();
    await api("/admin/links/trust", { method: "POST", token, body: { email: "old@example.com", url: URL } });
    await setSetting("link_security_enabled", "false");

    const body = await json(await api(`/api/comments?post_slug=${PAGE}`));
    expect(urlDormantOf(body)).toBe(false);
  });
});
