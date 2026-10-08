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
  for (const key of ["email_blacklist", "admin_email"]) {
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
