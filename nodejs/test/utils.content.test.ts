import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { getResponseComment, getResponseCommentAdmin } from "../src/utils/content";
import { setSetting } from "../src/utils/settings";
import { honeypotField } from "../src/utils/verify";
import { makeComment } from "./helpers";

const SLUG = "/posts/content-test";

/** 生成 n 条平铺评论（id 从 1 开始，发布时间递增） */
function makeMany(n: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) =>
    makeComment({
      id: i + 1,
      pub_date: new Date(Date.UTC(2024, 0, 1, 0, i)),
      content_text: `评论 ${i + 1}`,
      ...overrides,
    })
  );
}

describe("utils/content — getResponseComment 平面模式", () => {
  it("comments 为 null 时返回空列表与默认配置项", async () => {
    const res = await getResponseComment(null, 3, 15, false, SLUG);
    expect(res.code).toBe(200);
    expect(res.message).toBe("Comments fetched successfully");
    expect(res.data.comments).toEqual([]);
    expect(res.data.pagination).toEqual({ page: 3, limit: 15, totalPage: 0 });
    expect(res.data.blogger_badge_enabled).toBe("false");
    expect(res.data.blogger_badge_text).toBe("");
    expect(res.data.placeholder_name).toBe("");
    expect(res.data.placeholder_email).toBe("");
    expect(res.data.placeholder_content).toBe("");
    expect(res.data.placeholder_url).toBe("");
    expect(res.data.admin_comment_key_configured).toBe("false");
    expect(res.data.admin_email_hash).toBe("");
    expect(res.data.verify_enabled).toBe("false");
    expect(res.data.verify_honeypot).toBe("");
  });

  it("空数组时 totalPage 兜底为 1", async () => {
    const res = await getResponseComment([], 1, 20, false, SLUG);
    expect(res.data.comments).toEqual([]);
    expect(res.data.pagination.totalPage).toBe(1);
  });

  it("字段映射：id/作者/头像/正文/ISO 时间/父级", async () => {
    const res = await getResponseComment(
      [
        makeComment({
          id: 7,
          author: "张三",
          email: "test@example.com",
          url: "https://example.com",
          content_text: "纯文本",
          content_html: "<p>纯文本</p>",
          parent_id: 3,
        }),
      ],
      1,
      20,
      false,
      SLUG
    );
    const comment = (res.data.comments as any[])[0];
    expect(comment.id).toBe(7);
    expect(comment.author).toBe("张三");
    expect(comment.url).toBe("https://example.com");
    expect(comment.contentText).toBe("纯文本");
    expect(comment.contentHtml).toBe("<p>纯文本</p>");
    expect(comment.pubDate).toBe("2024-01-02T03:04:05.000Z");
    expect(comment.parentId).toBe(3);
    expect(comment.avatar).toBe(
      "https://open.motues.top/avatar?name=55502f40dc8b7c769880b10874abc9d0&mode=cravatar&variant=beam"
    );
  });

  it("url 为空时下发 undefined 而不是 null", async () => {
    const res = await getResponseComment([makeComment({ url: null })], 1, 20, false, SLUG);
    expect((res.data.comments as any[])[0].url).toBeUndefined();
  });

  it("isBlogger 仅在邮箱等于 admin_email 时为 true", async () => {
    await setSetting("admin_email", "admin@example.com");
    const res = await getResponseComment(
      [
        makeComment({ id: 1, email: "admin@example.com" }),
        makeComment({ id: 2, email: "someone@example.com" }),
      ],
      1,
      20,
      false,
      SLUG
    );
    const [first, second] = res.data.comments as any[];
    expect(first.isBlogger).toBe(true);
    expect(second.isBlogger).toBe(false);
  });

  it("徽章与占位符配置原样下发", async () => {
    await setSetting("blogger_badge_enabled", "true");
    await setSetting("blogger_badge_text", "博主");
    await setSetting("placeholder_name", "昵称");
    await setSetting("placeholder_email", "邮箱");
    await setSetting("placeholder_content", "说点什么");
    await setSetting("placeholder_url", "网站");
    const res = await getResponseComment([], 1, 20, false, SLUG);
    expect(res.data.blogger_badge_enabled).toBe("true");
    expect(res.data.blogger_badge_text).toBe("博主");
    expect(res.data.placeholder_name).toBe("昵称");
    expect(res.data.placeholder_email).toBe("邮箱");
    expect(res.data.placeholder_content).toBe("说点什么");
    expect(res.data.placeholder_url).toBe("网站");
  });

  it("admin_email_hash 仅在博主密钥功能开启时下发（避免离线枚举管理员邮箱）", async () => {
    await setSetting("admin_email", "Admin@Example.com");
    await setSetting("admin_comment_key", "secret-key");
    await setSetting("admin_comment_key_enabled", "false");

    const disabled = await getResponseComment([], 1, 20, false, SLUG);
    expect(disabled.data.admin_email_hash).toBe("");
    expect(disabled.data.admin_comment_key_configured).toBe("false");

    await setSetting("admin_comment_key_enabled", "true");
    const enabled = await getResponseComment([], 1, 20, false, SLUG);
    expect(enabled.data.admin_email_hash).toBe(
      crypto.createHash("sha256").update("admin@example.com").digest("hex")
    );
    expect(enabled.data.admin_comment_key_configured).toBe("true");
  });

  it("开启人机验证时下发 verify_enabled 与蜜罐字段", async () => {
    const secret = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
    await setSetting("comment_verify_secret", secret);
    await setSetting("comment_verify_enabled", "true");
    const res = await getResponseComment([], 1, 20, false, SLUG);
    expect(res.data.verify_enabled).toBe("true");
    expect(res.data.verify_honeypot).toBe(honeypotField(SLUG, secret));
  });

  it("分页：按页截取且 totalPage 向上取整", async () => {
    const comments = makeMany(25);
    const page1 = await getResponseComment(comments, 1, 10, false, SLUG);
    expect((page1.data.comments as any[]).map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(page1.data.pagination).toEqual({ page: 1, limit: 10, totalPage: 3 });

    const page3 = await getResponseComment(comments, 3, 10, false, SLUG);
    expect((page3.data.comments as any[]).map((c) => c.id)).toEqual([21, 22, 23, 24, 25]);
  });

  it("页码越界返回空列表但 totalPage 正确", async () => {
    const res = await getResponseComment(makeMany(25), 99, 10, false, SLUG);
    expect(res.data.comments).toEqual([]);
    expect(res.data.pagination).toEqual({ page: 99, limit: 10, totalPage: 3 });
  });

  it("limit=0 时防御性下限为 1（不会出现 Infinity/空页）", async () => {
    const res = await getResponseComment(makeMany(3), 1, 0, false, SLUG);
    expect((res.data.comments as any[]).length).toBe(1);
    expect(res.data.pagination).toEqual({ page: 1, limit: 0, totalPage: 3 });
  });
});

describe("utils/content — getResponseComment 嵌套模式", () => {
  it("父子关系被解析为 replies", async () => {
    const comments = [
      makeComment({ id: 1, parent_id: null, content_text: "根" }),
      makeComment({ id: 2, parent_id: 1, content_text: "回复1" }),
      makeComment({ id: 3, parent_id: 1, content_text: "回复2" }),
      makeComment({ id: 4, parent_id: null, content_text: "根2" }),
      makeComment({ id: 5, parent_id: 2, content_text: "二级回复" }),
    ];
    const res = await getResponseComment(comments, 1, 20, true, SLUG);
    const roots = res.data.comments as any[];
    expect(roots.map((c) => c.id)).toEqual([1, 4]);
    expect(roots[0].replies.map((c: any) => c.id)).toEqual([2, 3]);
    expect(roots[0].replies[0].replies.map((c: any) => c.id)).toEqual([5]);
    expect(roots[0].replies[0].pubDate).toBe("2024-01-02T03:04:05.000Z");
    expect(roots[1].replies).toEqual([]);
  });

  it("父评论不在结果集中时孤儿评论被丢弃", async () => {
    const comments = [
      makeComment({ id: 1, parent_id: null }),
      makeComment({ id: 9, parent_id: 999 }),
    ];
    const res = await getResponseComment(comments, 1, 20, true, SLUG);
    const roots = res.data.comments as any[];
    expect(roots.map((c) => c.id)).toEqual([1]);
  });

  it("嵌套分页只对根评论生效", async () => {
    const comments = [
      makeComment({ id: 1, parent_id: null }),
      makeComment({ id: 2, parent_id: 1 }),
      makeComment({ id: 3, parent_id: 1 }),
      makeComment({ id: 4, parent_id: null }),
      makeComment({ id: 5, parent_id: 4 }),
    ];
    const res = await getResponseComment(comments, 1, 1, true, SLUG);
    const roots = res.data.comments as any[];
    expect(roots.length).toBe(1);
    expect(roots[0].id).toBe(1);
    expect(roots[0].replies.length).toBe(2);
    expect(res.data.pagination).toEqual({ page: 1, limit: 1, totalPage: 2 });
  });

  it("嵌套模式同样带 isBlogger 标记", async () => {
    await setSetting("admin_email", "admin@example.com");
    const res = await getResponseComment(
      [makeComment({ id: 1, email: "admin@example.com", parent_id: null })],
      1,
      20,
      true,
      SLUG
    );
    expect((res.data.comments as any[])[0].isBlogger).toBe(true);
  });
});

describe("utils/content — getResponseCommentAdmin", () => {
  it("comments 为 null 时返回空列表与固定分页", async () => {
    const res = await getResponseCommentAdmin(null, 2);
    expect(res.code).toBe(200);
    expect(res.data.comments).toEqual([]);
    expect(res.data.pagination).toEqual({ page: 1, limit: 20, totalPage: 0 });
  });

  it("固定每页 10 条并映射后台字段", async () => {
    const res = await getResponseCommentAdmin(
      [
        makeComment({
          id: 5,
          pub_date: new Date("2024-03-04T05:06:07.000Z"),
          post_slug: "/posts/a",
          ip_address: "1.2.3.4",
          os: "Windows 10",
          browser: "Chrome 120",
          status: "pending",
          url: null,
        }),
      ],
      1
    );
    expect(res.data.pagination).toEqual({ page: 1, limit: 10, totalPage: 1 });
    const comment = res.data.comments[0] as any;
    expect(comment.id).toBe(5);
    expect(comment.pubDate).toBe("2024-03-04T05:06:07.000Z");
    expect(comment.postSlug).toBe("/posts/a");
    expect(comment.ipAddress).toBe("1.2.3.4");
    expect(comment.os).toBe("Windows 10");
    expect(comment.browser).toBe("Chrome 120");
    expect(comment.status).toBe("pending");
    expect(comment.url).toBeUndefined();
  });

  it("空字段回退为空串", async () => {
    const res = await getResponseCommentAdmin(
      [makeComment({ ip_address: null, os: null, browser: null })],
      1
    );
    const comment = res.data.comments[0] as any;
    expect(comment.ipAddress).toBe("");
    expect(comment.os).toBe("");
    expect(comment.browser).toBe("");
  });

  it("分页：25 条数据 → 3 页，第 3 页 5 条", async () => {
    const comments = makeMany(25);
    const page2 = await getResponseCommentAdmin(comments, 2);
    expect((page2.data.comments as any[]).map((c) => c.id)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(page2.data.pagination).toEqual({ page: 2, limit: 10, totalPage: 3 });

    const page3 = await getResponseCommentAdmin(comments, 3);
    expect((page3.data.comments as any[]).length).toBe(5);
  });
});
