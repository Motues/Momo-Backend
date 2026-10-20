import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { api, json, loginToken, seedComment, useTrustProxy, resetTables } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  for (const key of [
    "email_blacklist",
    "admin_email",
    "link_security_enabled",
    "link_dormant_days",
  ]) {
    db.run(sql`DELETE FROM "Settings" WHERE "key" = ${key}`);
  }
});

const todayKey = () => new Date().toISOString().slice(0, 10);

describe("GET /admin/stats/overview", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/stats/overview")).status).toBe(401);
  });

  it("空库返回全 0 与默认 7 天趋势", async () => {
    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.code).toBe(200);
    expect(body.data.totalComments).toBe(0);
    expect(body.data.totalUsers).toBe(0);
    expect(body.data.totalPosts).toBe(0);
    expect(body.data.statusDistribution).toEqual({ approved: 0, pending: 0, deleted: 0 });
    expect(body.data.recentComments).toHaveLength(7);
    expect(body.data.topCommenters).toEqual([]);
    // 新增字段在空库下同样要给出确定的零值 / 空数组（而不是 null）
    expect(body.data.topPosts).toEqual([]);
    expect(body.data.latestComments).toEqual([]);
    expect(body.data.deviceDistribution).toEqual([]);
    expect(body.data.browserDistribution).toEqual([]);
    expect(body.data.osDistribution).toEqual([]);
    expect(body.data.windowComments).toBe(0);
    expect(body.data.prevWindowComments).toBe(0);
    expect(body.data.commentsDelta).toBeNull();
    expect(body.data.windowUsers).toBe(0);
    expect(body.data.prevWindowUsers).toBe(0);
    expect(body.data.usersDelta).toBeNull();
    expect(body.data.todayComments).toBe(0);
    expect(body.data.last7DaysComments).toBe(0);
  });

  it("统计总数、状态分布、文章数与用户数", async () => {
    seedComment({ post_slug: "/a", author: "甲", email: "a@x.com", status: "approved" });
    seedComment({ post_slug: "/a", author: "甲", email: "a@x.com", status: "pending" });
    seedComment({ post_slug: "/b", author: "乙", email: "b@x.com", status: "deleted" });
    seedComment({ post_slug: "/b", author: "乙", email: "b@x.com", status: "rejected" });
    seedComment({ post_slug: "/c", author: "甲", email: "a@x.com", status: "approved" });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.totalComments).toBe(5);
    expect(body.data.totalPosts).toBe(3);
    expect(body.data.totalUsers).toBe(2); // author|email 组合去重
    // rejected 不计入任何一个分布桶
    expect(body.data.statusDistribution).toEqual({ approved: 2, pending: 1, deleted: 1 });
  });

  it("同名不同邮箱算作不同用户", async () => {
    seedComment({ post_slug: "/a", author: "甲", email: "a@x.com" });
    seedComment({ post_slug: "/a", author: "甲", email: "a2@x.com" });
    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.totalUsers).toBe(2);
  });

  it("topCommenters 按评论数排序且最多 5 个", async () => {
    for (let i = 0; i < 6; i++) {
      seedComment({ post_slug: "/a", author: `用户${i}`, email: `u${i}@x.com` });
    }
    // 用户0 额外 3 条，成为榜首
    for (let i = 0; i < 3; i++) seedComment({ post_slug: "/a", author: "用户0", email: "u0@x.com" });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.topCommenters).toHaveLength(5);
    expect(body.data.topCommenters[0].author).toBe("用户0");
    expect(body.data.topCommenters[0].count).toBe(4);
    expect(body.data.topCommenters[0].lastCommentDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("最近 7 天趋势包含今天的评论数", async () => {
    seedComment({ post_slug: "/a" });
    seedComment({ post_slug: "/a" });
    seedComment({ post_slug: "/a", pub_date: Date.now() - 100 * DAY });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    const trend = body.data.recentComments as { date: string; count: number }[];
    expect(trend).toHaveLength(7);
    const today = trend.find((t) => t.date === todayKey());
    expect(today?.count).toBe(2);
    // 100 天前的评论不在 7 天窗口内
    const total = trend.reduce((sum, t) => sum + t.count, 0);
    expect(total).toBe(2);
  });

  it("range=all / range=0 返回最近 12 个月聚合", async () => {
    seedComment({ post_slug: "/a", pub_date: Date.now() - 100 * DAY });
    const token = await loginToken();

    for (const range of ["all", "0"]) {
      const body = await json(await api(`/admin/stats/overview?range=${range}`, { token }));
      const trend = body.data.recentComments as { date: string; count: number }[];
      expect(trend, range).toHaveLength(12);
      expect(trend[0].date).toMatch(/^\d{4}-\d{2}$/);
      // 100 天前的评论落在最近 12 个月内
      expect(trend.reduce((sum, t) => sum + t.count, 0)).toBe(1);
    }
  });

  it("range=N 返回 N 天，非法值与负数回退 7 天，超大值截断到 365", async () => {
    const token = await loginToken();

    const thirty = await json(await api("/admin/stats/overview?range=30", { token }));
    expect(thirty.data.recentComments).toHaveLength(30);

    const abc = await json(await api("/admin/stats/overview?range=abc", { token }));
    expect(abc.data.recentComments).toHaveLength(7);

    const negative = await json(await api("/admin/stats/overview?range=-5", { token }));
    expect(negative.data.recentComments).toHaveLength(7);

    const huge = await json(await api("/admin/stats/overview?range=999", { token }));
    expect(huge.data.recentComments).toHaveLength(365);
  });
});

describe("GET /admin/stats/users", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/stats/users")).status).toBe(401);
  });

  it("空库返回空列表", async () => {
    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    expect(body.data.users).toEqual([]);
    expect(body.data.pagination).toEqual({ page: 1, limit: 20, totalPage: 0 });
  });

  it("按 author+email 分组并统计各状态数量", async () => {
    const old = Date.now() - 5 * DAY;
    seedComment({ author: "甲", email: "a@x.com", status: "approved", pub_date: old });
    seedComment({ author: "甲", email: "a@x.com", status: "pending" });
    seedComment({ author: "甲", email: "a@x.com", status: "deleted" });
    seedComment({ author: "乙", email: "b@x.com", status: "approved" });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    expect(body.data.users).toHaveLength(2);

    const jia = body.data.users.find((u: any) => u.author === "甲");
    expect(jia.email).toBe("a@x.com");
    expect(jia.commentCount).toBe(3);
    expect(jia.approvedCount).toBe(1);
    expect(jia.pendingCount).toBe(1);
    expect(jia.deletedCount).toBe(1);
    expect(jia.blacklisted).toBe(false);
    expect(jia.emailVerified).toBe(false);
    expect(jia.emailVerifiedAt).toBe("");
    expect(new Date(jia.firstCommentDate).getTime()).toBeLessThan(
      new Date(jia.lastCommentDate).getTime()
    );
  });

  it("search 按昵称或邮箱模糊匹配（不区分大小写）", async () => {
    seedComment({ author: "Alice", email: "alice@example.com" });
    seedComment({ author: "Bob", email: "bob@example.com" });

    const token = await loginToken();
    const byAuthor = await json(await api("/admin/stats/users?search=ali", { token }));
    expect(byAuthor.data.users).toHaveLength(1);
    expect(byAuthor.data.users[0].author).toBe("Alice");

    const byEmail = await json(await api("/admin/stats/users?search=BOB@EXAMPLE", { token }));
    expect(byEmail.data.users).toHaveLength(1);
    expect(byEmail.data.users[0].author).toBe("Bob");

    const none = await json(await api("/admin/stats/users?search=nobody", { token }));
    expect(none.data.users).toEqual([]);
  });

  it("标记黑名单邮箱，并支持 verified=true/false 过滤", async () => {
    seedComment({ author: "黑名单用户", email: "bad@example.com" });
    seedComment({ author: "已验证用户", email: "verified@example.com" });
    seedComment({ author: "普通用户", email: "plain@example.com" });
    await setSetting("email_blacklist", JSON.stringify(["BAD@example.com"]));

    db.run(sql`
      INSERT INTO "EmailVerification" ("email","token","expires_at","verified","created_at","verified_at")
      VALUES ('verified@example.com','t1',${new Date(Date.now() + DAY).toISOString()},1,${new Date().toISOString()},${new Date().toISOString()})
    `);

    const token = await loginToken();
    const all = await json(await api("/admin/stats/users", { token }));
    const bad = all.data.users.find((u: any) => u.email === "bad@example.com");
    const verified = all.data.users.find((u: any) => u.email === "verified@example.com");
    expect(bad.blacklisted).toBe(true);
    expect(verified.emailVerified).toBe(true);
    expect(verified.emailVerifiedAt).not.toBe("");

    const onlyVerified = await json(await api("/admin/stats/users?verified=true", { token }));
    expect(onlyVerified.data.users.map((u: any) => u.email)).toEqual(["verified@example.com"]);

    const onlyUnverified = await json(await api("/admin/stats/users?verified=false", { token }));
    expect(onlyUnverified.data.users.map((u: any) => u.email).sort()).toEqual([
      "bad@example.com",
      "plain@example.com",
    ]);

    // 无法识别的取值不过滤
    const bogus = await json(await api("/admin/stats/users?verified=maybe", { token }));
    expect(bogus.data.users).toHaveLength(3);
  });

  it("分页：limit 上限 100，page=0 回退到 1", async () => {
    for (let i = 0; i < 3; i++) {
      seedComment({ author: `用户${i}`, email: `u${i}@x.com` });
    }
    const token = await loginToken();

    const clamped = await json(await api("/admin/stats/users?limit=999&page=0", { token }));
    expect(clamped.data.pagination).toEqual({ page: 1, limit: 100, totalPage: 1 });

    const paged = await json(await api("/admin/stats/users?limit=2&page=2", { token }));
    expect(paged.data.users).toHaveLength(1);
    expect(paged.data.pagination).toEqual({ page: 2, limit: 2, totalPage: 2 });
  });
});

describe("GET /admin/stats/users/comments", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/stats/users/comments?author=a&email=b")).status).toBe(401);
  });

  it("缺少 author 或 email 返回 400", async () => {
    const token = await loginToken();
    expect((await api("/admin/stats/users/comments", { token })).status).toBe(400);
    expect((await api("/admin/stats/users/comments?author=a", { token })).status).toBe(400);
    expect((await api("/admin/stats/users/comments?email=b", { token })).status).toBe(400);
  });

  it("只返回该用户的评论，固定每页 10 条并按时间倒序", async () => {
    for (let i = 0; i < 12; i++) {
      seedComment({
        author: "甲",
        email: "a@x.com",
        post_slug: `/p${i}`,
        pub_date: Date.now() - i * 1000,
      });
    }
    seedComment({ author: "乙", email: "b@x.com", post_slug: "/other" });

    const token = await loginToken();
    const page1 = await json(
      await api("/admin/stats/users/comments?author=甲&email=a@x.com", { token })
    );
    expect(page1.data.comments).toHaveLength(10);
    expect(page1.data.pagination).toEqual({ page: 1, limit: 10, totalPage: 2 });
    expect(page1.data.comments[0].postSlug).toBe("/p0");
    expect(page1.data.comments[0].pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const page2 = await json(
      await api("/admin/stats/users/comments?author=甲&email=a@x.com&page=2", { token })
    );
    expect(page2.data.comments).toHaveLength(2);
  });

  it("page=0 回退到第 1 页", async () => {
    seedComment({ author: "甲", email: "a@x.com" });
    const token = await loginToken();
    const body = await json(
      await api("/admin/stats/users/comments?author=甲&email=a@x.com&page=0", { token })
    );
    expect(body.data.pagination.page).toBe(1);
    expect(body.data.comments).toHaveLength(1);
  });

  it("未知用户返回空列表", async () => {
    const token = await loginToken();
    const body = await json(
      await api("/admin/stats/users/comments?author=nobody&email=nobody@x.com", { token })
    );
    expect(body.data.comments).toEqual([]);
    expect(body.data.pagination.totalPage).toBe(0);
  });
});

/**
 * 用户列表的「网站链接是否休眠」列（1.8.0 新增 `url` + `urlDormant`）。
 *
 * 身份口径与公开评论区的 `urlDormant` 完全一致（见 doc/link_security.md 第 2 节）：
 * 按归一化邮箱识别同一个人、跨文章统计最后一条评论、严格大于 N 天、
 * `rejected` / `deleted` 不计入「来过」、网址取「最近一次非空」。
 */
describe("GET /admin/stats/users — 网站链接是否休眠", () => {
  const userOf = (body: any, email: string) =>
    body.data.users.find((u: any) => u.email.trim().toLowerCase() === email);

  it("从来没有留过网址：url 为空串、urlDormant 为 false", async () => {
    seedComment({ author: "甲", email: "a@x.com", url: null, pub_date: Date.now() - 90 * DAY });
    await setSetting("link_security_enabled", "true");

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const user = userOf(body, "a@x.com");
    expect(user.url).toBe("");
    expect(user.urlDormant).toBe(false);
  });

  it("功能关闭：不标记休眠，但仍然下发用户留过的网址", async () => {
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const user = userOf(body, "a@x.com");
    expect(user.url).toBe("https://a.example.com");
    expect(user.urlDormant).toBe(false);
  });

  it("超过 N 天没来评论：标记为休眠", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 31 * DAY,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const user = userOf(body, "a@x.com");
    expect(user.url).toBe("https://a.example.com");
    expect(user.urlDormant).toBe(true);
  });

  it("刚好 N 天不算休眠（严格大于）", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 30 * DAY + 60000,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    expect(userOf(body, "a@x.com").urlDormant).toBe(false);
  });

  it("以最新链接为准：较晚的评论带新网址时取新网址", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://old.example.com",
      pub_date: Date.now() - 60 * DAY,
    });
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://new.example.com",
      pub_date: Date.now() - 31 * DAY,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const user = userOf(body, "a@x.com");
    expect(user.url).toBe("https://new.example.com");
    expect(user.urlDormant).toBe(true);
  });

  it("较晚的评论没有网址时，保留最近一次非空网址", async () => {
    await setSetting("link_security_enabled", "true");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://old.example.com",
      pub_date: Date.now() - 60 * DAY,
    });
    seedComment({ author: "甲", email: "a@x.com", url: null, pub_date: Date.now() - 60000 });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const user = userOf(body, "a@x.com");
    expect(user.url).toBe("https://old.example.com");
    // 刚刚评论过 → 不休眠
    expect(user.urlDormant).toBe(false);
  });

  it("身份按邮箱归一化：换昵称后再次评论同样解除休眠", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seedComment({
      author: "甲",
      email: "A@X.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY,
    });
    seedComment({
      author: "甲（改名）",
      email: " a@x.com ",
      url: "https://a.example.com",
      pub_date: Date.now() - DAY,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    const renamed = userOf(body, "a@x.com");
    expect(renamed.urlDormant).toBe(false);
    expect(renamed.url).toBe("https://a.example.com");
  });

  it("rejected / deleted 的评论不算「来过」", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY,
      status: "approved",
    });
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 60000,
      status: "deleted",
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    expect(userOf(body, "a@x.com").urlDormant).toBe(true);
  });

  it("天数脏值按默认 30 天处理", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "abc");
    seedComment({
      author: "甲",
      email: "a@x.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 31 * DAY,
    });
    seedComment({
      author: "乙",
      email: "b@x.com",
      url: "https://b.example.com",
      pub_date: Date.now() - 10 * DAY,
    });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/users", { token }));
    expect(userOf(body, "a@x.com").urlDormant).toBe(true);
    expect(userOf(body, "b@x.com").urlDormant).toBe(false);
  });
});

/**
 * 管理面板数据统计页新增的四块信息：时间窗口指标、热门文章、客户端分布、最新评论动态。
 *
 * 「窗口」就是 `range` 参数指定的那段时间（range=0 时是最近 12 个自然月），
 * 起点与 `recentComments` 的分桶起点**严格一致** —— 所以「窗口新增」必须等于折线图各点之和，
 * 否则页面上两个数字会互相打架。
 */
const startOfUtcDay = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** 历史脏数据：旧版本把整条 UA 写进了 browser / os / device 列 */
const RAW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

describe("GET /admin/stats/overview — 时间窗口指标", () => {
  it("默认 7 天窗口：窗口内 / 上一窗口计数与环比", async () => {
    const today = startOfUtcDay(Date.now());
    seedComment({ author: "甲", email: "a@x.com" });
    seedComment({ author: "乙", email: "b@x.com" });
    // 上一窗口（第 7–13 天前）
    seedComment({ author: "丙", email: "c@x.com", pub_date: today - 7 * DAY + 3600_000 });
    // 两个窗口之外
    seedComment({ author: "丁", email: "d@x.com", pub_date: today - 20 * DAY });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.windowComments).toBe(2);
    expect(body.data.prevWindowComments).toBe(1);
    expect(body.data.commentsDelta).toBe(100);
    expect(body.data.windowUsers).toBe(2);
    expect(body.data.prevWindowUsers).toBe(1);
    expect(body.data.usersDelta).toBe(100);
    expect(body.data.todayComments).toBe(2);
    expect(body.data.last7DaysComments).toBe(2);
    // 「窗口新增」与折线图各点之和一致
    const trendSum = (body.data.recentComments as { count: number }[]).reduce(
      (sum, item) => sum + item.count,
      0
    );
    expect(trendSum).toBe(body.data.windowComments);
  });

  it("窗口起点与趋势分桶一致：7 天窗口不含第 8 天以前的评论", async () => {
    const today = startOfUtcDay(Date.now());
    seedComment({ pub_date: today - 6 * DAY }); // 窗口首日
    seedComment({ pub_date: today - 7 * DAY }); // 已经出窗口

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.windowComments).toBe(1);
    expect(body.data.prevWindowComments).toBe(1);
    expect(body.data.commentsDelta).toBe(0);
  });

  it("上一窗口为空时环比为 null（而不是 0/100%）", async () => {
    seedComment({ author: "甲", email: "a@x.com" });
    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.windowComments).toBe(1);
    expect(body.data.prevWindowComments).toBe(0);
    expect(body.data.commentsDelta).toBeNull();
    expect(body.data.usersDelta).toBeNull();
  });

  it("range=30 时窗口扩大到 30 天，上一窗口随之平移", async () => {
    const today = startOfUtcDay(Date.now());
    seedComment({ pub_date: today - 20 * DAY }); // 7 天窗口外，30 天窗口内
    seedComment({ pub_date: today - 40 * DAY }); // 上一个 30 天窗口内

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview?range=30", { token }));
    expect(body.data.windowComments).toBe(1);
    expect(body.data.prevWindowComments).toBe(1);
    expect(body.data.commentsDelta).toBe(0);
  });

  it("range=0 时窗口是最近 12 个自然月，且与月度分桶之和一致", async () => {
    const today = startOfUtcDay(Date.now());
    seedComment({ pub_date: today - 100 * DAY }); // 近 12 个月内
    seedComment({ pub_date: today - 400 * DAY }); // 上一个 12 个月窗口内（约 13 个月前）

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview?range=0", { token }));
    expect(body.data.windowComments).toBe(1);
    expect(body.data.prevWindowComments).toBe(1);
    expect(body.data.commentsDelta).toBe(0);
    const trendSum = (body.data.recentComments as { count: number }[]).reduce(
      (sum, item) => sum + item.count,
      0
    );
    expect(trendSum).toBe(body.data.windowComments);
  });

  it("今日与近 7 天按 UTC 日切分：跨日边界上的评论不计入今天", async () => {
    const today = startOfUtcDay(Date.now());
    seedComment({ pub_date: today - 1 }); // 昨天 23:59:59.999
    seedComment({ pub_date: today + 60_000 }); // 今天 00:01

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.todayComments).toBe(1);
    expect(body.data.last7DaysComments).toBe(2);
  });
});

describe("GET /admin/stats/overview — 热门文章 Top 5", () => {
  const seedPosts = (slug: string, times: number) => {
    for (let i = 0; i < times; i++) {
      seedComment({ post_slug: slug, author: `u${i}`, email: `u${i}@x.com` });
    }
  };

  it("按评论数降序、并列时按文章标识升序、最多 5 条", async () => {
    seedPosts("/a", 3);
    seedPosts("/b", 2);
    seedPosts("/d", 1);
    seedPosts("/c", 1);
    seedPosts("/e", 1);
    seedPosts("/f", 1); // 并列里排在最后，被 5 条上限截断

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    const top = body.data.topPosts as { postSlug: string; count: number; lastCommentDate: string }[];
    expect(top).toHaveLength(5);
    expect(top.map((p) => p.postSlug)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(top[0].count).toBe(3);
    expect(top[0].lastCommentDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("GET /admin/stats/overview — 客户端分布", () => {
  it("浏览器按家族名合并，空值与原始 UA 归入「未知」", async () => {
    seedComment({ browser: "Chrome 145.0.0.0" });
    seedComment({ browser: "Chrome 144.0.0.0" });
    seedComment({ browser: "Chrome 143.0.0.0" });
    seedComment({ browser: "Edge 147.0.0.0" });
    seedComment({ browser: null });
    seedComment({ browser: RAW_UA });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.browserDistribution).toEqual([
      { name: "Chrome", count: 3 },
      { name: "未知", count: 2 },
      { name: "Edge", count: 1 },
    ]);
  });

  it("操作系统去掉版本号后合并", async () => {
    seedComment({ os: "Windows 10" });
    seedComment({ os: "Windows 10.0" });
    seedComment({ os: "Windows 11" });
    seedComment({ os: null });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect(body.data.osDistribution).toEqual([
      { name: "Windows", count: 3 },
      { name: "未知", count: 1 },
    ]);
  });

  it("设备归成桌面 / 移动 / 平板 / 未知四类", async () => {
    seedComment({ device: null }); // 桌面端 ua-parser 不下发 device
    seedComment({ device: "" });
    seedComment({ device: "iPhone" });
    seedComment({ device: "iPad" });
    seedComment({ device: RAW_UA });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    // 桌面 2 条居首；其余并列 1 条时按名称的 Unicode 码点升序：平板 < 未知 < 移动
    expect(body.data.deviceDistribution).toEqual([
      { name: "桌面", count: 2 },
      { name: "平板", count: 1 },
      { name: "未知", count: 1 },
      { name: "移动", count: 1 },
    ]);
  });

  it("分布最多 5 档，超出部分由前端合并成「其他」", async () => {
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) {
      seedComment({ browser: `${name} 1.0` });
    }

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    const names = (body.data.browserDistribution as { name: string }[]).map((item) => item.name);
    expect(names).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  });
});

describe("GET /admin/stats/overview — 最新评论动态", () => {
  it("最多 5 条、按时间倒序、字段完整且状态原样下发", async () => {
    for (let i = 0; i < 7; i++) {
      seedComment({
        post_slug: `/p${i}`,
        author: `用户${i}`,
        email: `u${i}@x.com`,
        content_text: `内容${i}`,
        status: i % 2 === 1 ? "pending" : "approved",
        pub_date: Date.now() - i * 1000,
      });
    }

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    const latest = body.data.latestComments as {
      id: number;
      author: string;
      email: string;
      postSlug: string;
      contentText: string;
      status: string;
      pubDate: string;
    }[];
    expect(latest).toHaveLength(5);
    expect(latest[0]).toMatchObject({
      author: "用户0",
      email: "u0@x.com",
      postSlug: "/p0",
      contentText: "内容0",
      status: "approved",
    });
    expect(typeof latest[0].id).toBe("number");
    expect(latest[0].pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const times = latest.map((c) => new Date(c.pubDate).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // 待审核评论同样出现在动态流里（面板要能一眼看到待处理项）
    expect(latest.some((c) => c.status === "pending")).toBe(true);
  });

  it("时间相同时按 id 倒序", async () => {
    const sameTime = Date.now() - 5000;
    const first = seedComment({ author: "甲", email: "a@x.com", pub_date: sameTime });
    const second = seedComment({ author: "乙", email: "b@x.com", pub_date: sameTime });

    const token = await loginToken();
    const body = await json(await api("/admin/stats/overview", { token }));
    expect((body.data.latestComments as { id: number }[]).map((c) => c.id)).toEqual([
      second,
      first,
    ]);
  });
});
