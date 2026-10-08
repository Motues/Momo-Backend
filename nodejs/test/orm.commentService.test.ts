import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import CommentService from "../src/orm/commentService";
import { resetTables } from "./helpers";

/**
 * ORM 层用例。
 * 其中「数据库 schema 初始化」用例承接了原 test/smoke.test.ts 的建表断言。
 */
beforeEach(() => {
  resetTables();
});

describe("ORM — 数据库 schema 初始化", () => {
  it("导入 client.ts 即建好四张表（Comment / Settings / EmailVerification / SchemaMigration）", () => {
    const tables = (
      db.all(sql`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`) as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("Comment");
    expect(tables).toContain("Settings");
    expect(tables).toContain("EmailVerification");
    expect(tables).toContain("SchemaMigration");
  });

  it("Comment 表字段与三端口径一致（pub_date 为 INTEGER 毫秒）", () => {
    const columns = (
      db.all(sql`PRAGMA table_info("Comment")`) as { name: string; type: string }[]
    ).reduce<Record<string, string>>((acc, col) => {
      acc[col.name] = col.type;
      return acc;
    }, {});

    expect(Object.keys(columns).sort()).toEqual(
      [
        "id",
        "pub_date",
        "post_slug",
        "author",
        "email",
        "url",
        "ip_address",
        "device",
        "browser",
        "content_text",
        "content_html",
        "parent_id",
        "status",
        "os",
        "user_agent",
      ].sort()
    );
    expect(columns.pub_date).toBe("INTEGER");
    expect(columns.parent_id).toBe("INTEGER");
    expect(columns.status).toBe("TEXT");
  });

  it("Settings 表以 key 为主键，Comment 表默认 status 为 pending", () => {
    const settingsColumns = (
      db.all(sql`PRAGMA table_info("Settings")`) as { name: string; pk: number }[]
    ).filter((c) => c.pk === 1);
    expect(settingsColumns.map((c) => c.name)).toEqual(["key"]);

    db.run(sql`INSERT INTO "Comment" ("post_slug","author","email","content_text","content_html") VALUES ('/x','a','a@x.com','t','<p>t</p>')`);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/x'`) as any;
    expect(row.status).toBe("pending");
    // pub_date 默认值 strftime('%s')*1000（秒级精度）
    expect(row.pub_date % 1000).toBe(0);
  });

  it("Settings 表 key 冲突时不再插入重复行", () => {
    db.run(sql`INSERT INTO "Settings" ("key","value") VALUES ('k','v1')`);
    // 使用 INSERT OR REPLACE 才能更新；直接插入应抛错（验证主键约束存在）
    expect(() =>
      db.run(sql`INSERT INTO "Settings" ("key","value") VALUES ('k','v2')`)
    ).toThrow();
  });
});

describe("ORM CommentService — 写入与读取", () => {
  it("createComment 返回带自增 id 的完整对象", async () => {
    const created = await CommentService.createComment({
      pub_date: 1700000000000,
      post_slug: "/svc/create",
      author: "作者",
      email: "a@x.com",
      url: "",
      ip_address: "1.2.3.4",
      os: "Windows 10",
      browser: "Chrome 120",
      device: "",
      user_agent: "UA",
      content_text: "内容",
      content_html: "<p>内容</p>",
      parent_id: null,
      status: "approved",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.pub_date).toBeInstanceOf(Date);
    expect(created.pub_date.getTime()).toBe(1700000000000);
    expect(created.post_slug).toBe("/svc/create");

    const fetched = await CommentService.getCommentById(created.id);
    expect(fetched?.content_text).toBe("内容");
  });

  it("getCommentById 对不存在的 id 返回 null", async () => {
    expect(await CommentService.getCommentById(999999)).toBeNull();
  });

  it("getCommentBySlug 只返回 approved 的评论", async () => {
    const create = (status: string, pubDate: number) =>
      CommentService.createComment({
        pub_date: pubDate,
        post_slug: "/svc/slug",
        author: "a",
        email: "a@x.com",
        content_text: status,
        content_html: "",
        parent_id: null,
        status,
      });
    await create("approved", 1);
    await create("pending", 2);
    await create("deleted", 3);
    await create("rejected", 4);
    await CommentService.createComment({
      pub_date: 5,
      post_slug: "/svc/other",
      author: "a",
      email: "a@x.com",
      content_text: "别的",
      content_html: "",
      parent_id: null,
      status: "approved",
    });

    const comments = await CommentService.getCommentBySlug("/svc/slug");
    expect(comments?.map((c) => c.content_text)).toEqual(["approved"]);
  });

  it("getAllComments 按 pub_date 倒序，并支持状态筛选", async () => {
    const create = (status: string, pubDate: number, text: string) =>
      CommentService.createComment({
        pub_date: pubDate,
        post_slug: "/svc/all",
        author: "a",
        email: "a@x.com",
        content_text: text,
        content_html: "",
        parent_id: null,
        status,
      });
    await create("approved", 100, "旧");
    await create("pending", 300, "新");
    await create("approved", 200, "中");

    const all = await CommentService.getAllComments();
    expect(all.map((c) => c.content_text)).toEqual(["新", "中", "旧"]);

    const approved = await CommentService.getAllComments("approved");
    expect(approved.map((c) => c.content_text)).toEqual(["中", "旧"]);
  });

  it("getlastCommentByIP 按 pub_date 倒序返回该 IP 的评论", async () => {
    const create = (ip: string, pubDate: number, text: string) =>
      CommentService.createComment({
        pub_date: pubDate,
        post_slug: "/svc/ip",
        author: "a",
        email: "a@x.com",
        ip_address: ip,
        content_text: text,
        content_html: "",
        parent_id: null,
        status: "approved",
      });
    await create("1.1.1.1", 100, "第一条");
    await create("1.1.1.1", 200, "第二条");
    await create("2.2.2.2", 300, "别人的");

    const rows = await CommentService.getlastCommentByIP("1.1.1.1");
    expect(rows?.map((c) => c.content_text)).toEqual(["第二条", "第一条"]);

    const none = await CommentService.getlastCommentByIP("9.9.9.9");
    expect(none).toEqual([]);
  });
});

describe("ORM CommentService — 状态与删除", () => {
  async function seed(status = "approved", parentId: number | null = null) {
    return CommentService.createComment({
      pub_date: Date.now(),
      post_slug: "/svc/status",
      author: "a",
      email: "a@x.com",
      content_text: "x",
      content_html: "",
      parent_id: parentId,
      status,
    });
  }

  it("approved/rejected 只影响本条", async () => {
    const parent = await seed("pending");
    const child = await seed("pending", parent.id);

    await CommentService.updateCommentStatus(parent.id, "approved");
    expect((await CommentService.getCommentById(parent.id))?.status).toBe("approved");
    expect((await CommentService.getCommentById(child.id))?.status).toBe("pending");

    await CommentService.updateCommentStatus(parent.id, "rejected");
    expect((await CommentService.getCommentById(parent.id))?.status).toBe("rejected");
    expect((await CommentService.getCommentById(child.id))?.status).toBe("pending");
  });

  it("deleted/pending 级联到全部子孙节点", async () => {
    const root = await seed("approved");
    const child = await seed("approved", root.id);
    const grandchild = await seed("approved", child.id);
    const unrelated = await seed("approved");

    await CommentService.updateCommentStatus(root.id, "deleted");
    const statusOf = async (id: number) => (await CommentService.getCommentById(id))?.status;
    expect(await statusOf(root.id)).toBe("deleted");
    expect(await statusOf(child.id)).toBe("deleted");
    expect(await statusOf(grandchild.id)).toBe("deleted");
    expect(await statusOf(unrelated.id)).toBe("approved");

    await CommentService.updateCommentStatus(root.id, "pending");
    expect(await statusOf(root.id)).toBe("pending");
    expect(await statusOf(grandchild.id)).toBe("pending");
  });

  it("deleteComment 软删除整棵子树（含中间层）", async () => {
    const root = await seed("approved");
    const child = await seed("approved", root.id);
    const grandchild = await seed("approved", child.id);
    const other = await seed("approved");

    await CommentService.deleteComment(root.id);

    const statusOf = async (id: number) => (await CommentService.getCommentById(id))?.status;
    expect(await statusOf(root.id)).toBe("deleted");
    expect(await statusOf(child.id)).toBe("deleted");
    expect(await statusOf(grandchild.id)).toBe("deleted");
    expect(await statusOf(other.id)).toBe("approved");
  });

  it("updateComment 只接受白名单字段", async () => {
    const comment = await seed("approved");
    const updated = await CommentService.updateComment(comment.id, {
      author: "新作者",
      content_text: "新内容",
      status: "rejected",
      pub_date: 1,
      post_slug: "/hacked",
      ip_address: "9.9.9.9",
      unknown: "x",
    });
    expect(updated.author).toBe("新作者");
    expect(updated.content_text).toBe("新内容");
    // 非白名单字段被忽略
    expect(updated.status).toBe("approved");
    expect(updated.post_slug).toBe("/svc/status");
    expect(updated.pub_date.getTime()).not.toBe(1);
    expect(updated.ip_address).toBeNull(); // seed() 未写 ip_address
  });

  it("updateComment 可把 url 置为 null", async () => {
    const created = await CommentService.createComment({
      pub_date: Date.now(),
      post_slug: "/svc/url",
      author: "a",
      email: "a@x.com",
      url: "https://example.com",
      content_text: "x",
      content_html: "",
      parent_id: null,
      status: "approved",
    });
    const updated = await CommentService.updateComment(created.id, { url: null });
    expect(updated.url).toBeNull();
  });
});

describe("ORM CommentService — 分页与统计辅助", () => {
  it("getUserComments 固定每页 10 条并返回分页信息", async () => {
    for (let i = 0; i < 12; i++) {
      await CommentService.createComment({
        pub_date: 1000 + i,
        post_slug: `/p${i}`,
        author: "甲",
        email: "a@x.com",
        content_text: `第${i}条`,
        content_html: "",
        parent_id: null,
        status: "approved",
      });
    }

    const page1 = await CommentService.getUserComments("甲", "a@x.com", 1);
    expect(page1.comments).toHaveLength(10);
    expect(page1.pagination).toEqual({ page: 1, limit: 10, totalPage: 2 });
    expect(page1.comments[0].contentText).toBe("第11条"); // 最新在前

    const page2 = await CommentService.getUserComments("甲", "a@x.com", 2);
    expect(page2.comments).toHaveLength(2);
  });

  it("getStatsOverview 统计唯一文章与用户", async () => {
    const add = (slug: string, author: string, email: string) =>
      CommentService.createComment({
        pub_date: Date.now(),
        post_slug: slug,
        author,
        email,
        content_text: "x",
        content_html: "",
        parent_id: null,
        status: "approved",
      });
    await add("/a", "甲", "a@x.com");
    await add("/a", "甲", "a@x.com");
    await add("/b", "乙", "b@x.com");

    const stats = await CommentService.getStatsOverview(7);
    expect(stats.totalComments).toBe(3);
    expect(stats.totalPosts).toBe(2);
    expect(stats.totalUsers).toBe(2);
    expect(stats.recentComments).toHaveLength(7);
  });

  it("getUserList 支持搜索与黑名单标记", async () => {
    await CommentService.createComment({
      pub_date: Date.now(),
      post_slug: "/u",
      author: "Alice",
      email: "alice@x.com",
      content_text: "x",
      content_html: "",
      parent_id: null,
      status: "approved",
    });
    db.run(sql`INSERT INTO "Settings" ("key","value") VALUES ('email_blacklist', '["alice@x.com"]')`);

    const result = await CommentService.getUserList(1, 20, "alice", "all");
    expect(result.users).toHaveLength(1);
    expect(result.users[0].author).toBe("Alice");
    expect(result.users[0].blacklisted).toBe(true);
    expect(result.users[0].commentCount).toBe(1);
    expect(result.pagination).toEqual({ page: 1, limit: 20, totalPage: 1 });
  });
});
