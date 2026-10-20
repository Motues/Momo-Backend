import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { api, json, loginToken, seedComment, useTrustProxy, resetTables, clearSettings } from "./helpers";

/**
 * 管理端用户列表的**网站链接状态筛选**（`GET /admin/stats/users?linkStatus=`）
 * 与「人工确认来源」字段（`urlTrustedSource`）。
 *
 * 关键约束：过滤必须发生在**分页之前**——`totalPage` 要反映过滤后的集合，
 * 否则面板上会出现「筛选后翻页全是空页」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = "/posts/link-filter";

const TOUCHED_SETTINGS = [
  "link_security_enabled",
  "link_dormant_days",
  "email_blacklist",
  "admin_email",
  "admin_emails",
  "notify_email",
];

/** 很久没来评论 → 判为休眠 */
const seedDormant = (email: string, author: string, url = "https://dormant.example.com") =>
  seedComment({
    post_slug: PAGE,
    author,
    email,
    url,
    pub_date: Date.now() - 90 * DAY_MS,
    status: "approved",
  });

/** 刚评论过 → 正常 */
const seedNormal = (email: string, author: string, url = "https://normal.example.com") =>
  seedComment({ post_slug: PAGE, author, email, url, pub_date: Date.now() - 1000, status: "approved" });

/** 从没留过链接 */
const seedNoUrl = (email: string, author: string) =>
  seedComment({ post_slug: PAGE, author, email, url: null, pub_date: Date.now() - 1000 });

/** 直接插一条提醒记录（本文件不关心发信，只借它的令牌走「本人确认」） */
function insertNotice(email: string, url: string, token: string, expiresAt: string) {
  db.run(sql`
    INSERT INTO "DormantNotice" ("email", "url", "last_comment_at", "token", "expires_at", "notified_at", "notify_count")
    VALUES (${email}, ${url}, ${Date.now() - 90 * DAY_MS}, ${token}, ${expiresAt}, ${new Date().toISOString()}, 1)
  `);
}

async function usersOf(token: string, query = "") {
  const body = await json(await api(`/admin/stats/users${query}`, { token }));
  return body.data;
}

const emailsOf = (data: any) => data.users.map((u: any) => u.email).sort();

beforeEach(async () => {
  useTrustProxy();
  resetTables();
  await setSetting("link_security_enabled", "true");
});

afterEach(() => {
  clearSettings(TOUCHED_SETTINGS);
});

describe("GET /admin/stats/users — 按网站链接状态筛选", () => {
  /** 四种状态各一个用户：休眠 / 正常 / 已确认 / 无链接 */
  async function seedAllStates(token: string) {
    seedDormant("dormant@example.com", "休眠用户");
    seedNormal("normal@example.com", "正常用户");
    seedNormal("trusted@example.com", "已确认用户", "https://trusted.example.com");
    seedNoUrl("none@example.com", "无链接用户");
    await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { email: "trusted@example.com", url: "https://trusted.example.com" },
    });
  }

  it("dormant / normal / trusted / none 各自只返回对应状态", async () => {
    const token = await loginToken();
    await seedAllStates(token);

    expect(emailsOf(await usersOf(token, "?linkStatus=dormant"))).toEqual(["dormant@example.com"]);
    expect(emailsOf(await usersOf(token, "?linkStatus=normal"))).toEqual(["normal@example.com"]);
    expect(emailsOf(await usersOf(token, "?linkStatus=trusted"))).toEqual(["trusted@example.com"]);
    expect(emailsOf(await usersOf(token, "?linkStatus=none"))).toEqual(["none@example.com"]);
    // 不筛选时四个都在
    expect(emailsOf(await usersOf(token))).toHaveLength(4);
  });

  it("别名与大小写：无法识别的取值不筛选", async () => {
    const token = await loginToken();
    await seedAllStates(token);

    for (const value of ["all", "maybe", "", "%20"]) {
      const data = await usersOf(token, `?linkStatus=${encodeURIComponent(value)}`);
      expect(data.users, value).toHaveLength(4);
    }
    // 大小写不敏感：Dormant 也算合法筛选
    expect(emailsOf(await usersOf(token, "?linkStatus=Dormant"))).toEqual(["dormant@example.com"]);
  });

  it("过滤发生在分页之前：totalPage 反映筛选后的集合", async () => {
    const token = await loginToken();
    seedDormant("d1@example.com", "休眠1");
    seedDormant("d2@example.com", "休眠2");
    seedDormant("d3@example.com", "休眠3");
    seedNormal("n1@example.com", "正常1");

    const filtered = await usersOf(token, "?linkStatus=dormant&limit=1&page=1");
    expect(filtered.users).toHaveLength(1);
    expect(filtered.pagination).toEqual({ page: 1, limit: 1, totalPage: 3 });

    const page3 = await usersOf(token, "?linkStatus=dormant&limit=1&page=3");
    expect(page3.users).toHaveLength(1);
    expect(page3.users[0].urlDormant).toBe(true);

    // 不筛选时是 4 个用户 → 4 页
    const all = await usersOf(token, "?limit=1");
    expect(all.pagination.totalPage).toBe(4);
  });

  it("可与 search 组合筛选", async () => {
    const token = await loginToken();
    await seedAllStates(token);

    const data = await usersOf(token, "?linkStatus=dormant&search=dormant@");
    expect(emailsOf(data)).toEqual(["dormant@example.com"]);

    const none = await usersOf(token, "?linkStatus=dormant&search=trusted");
    expect(none.users).toEqual([]);
  });

  it("功能关闭时没有休眠用户（dormant 为空集，normal 覆盖原来那些）", async () => {
    const token = await loginToken();
    seedDormant("dormant@example.com", "休眠用户");
    seedNormal("normal@example.com", "正常用户");
    await setSetting("link_security_enabled", "false");

    expect((await usersOf(token, "?linkStatus=dormant")).users).toEqual([]);
    expect(emailsOf(await usersOf(token, "?linkStatus=normal"))).toEqual([
      "dormant@example.com",
      "normal@example.com",
    ]);
  });
});

describe("GET /admin/stats/users — 确认来源 urlTrustedSource", () => {
  it("管理员人工确认 → admin；未确认 → 空串", async () => {
    const token = await loginToken();
    seedNormal("a@example.com", "甲", "https://a.example.com");
    seedNormal("b@example.com", "乙", "https://b.example.com");

    await api("/admin/links/trust", {
      method: "POST",
      token,
      body: { email: "a@example.com", url: "https://a.example.com" },
    });

    const data = await usersOf(token);
    const a = data.users.find((u: any) => u.email === "a@example.com");
    const b = data.users.find((u: any) => u.email === "b@example.com");
    expect(a.urlTrustedSource).toBe("admin");
    expect(a.urlTrustedUntil).not.toBe("");
    expect(b.urlTrustedSource).toBe("");
    expect(b.urlTrustedUntil).toBe("");
  });

  it("评论者本人从提醒页确认 → self，且该链接不再休眠", async () => {
    const token = await loginToken();
    seedDormant("me@example.com", "本人", "https://me.example.com");
    const expiresAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    insertNotice("me@example.com", "https://me.example.com", "token-self-1", expiresAt);

    const before = (await usersOf(token)).users[0];
    expect(before.urlDormant).toBe(true);

    const res = await api("/api/link-dormant/confirm?token=token-self-1", { method: "POST" });
    expect(res.status).toBe(200);

    const after = (await usersOf(token)).users[0];
    expect(after.urlDormant).toBe(false);
    expect(after.urlTrustedSource).toBe("self");
    expect(after.urlTrustedUntil).not.toBe("");
    // 提醒记录被删除（同一令牌不能再用）
    const rows = db.all(sql`SELECT COUNT(*) AS n FROM "DormantNotice"`) as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});
