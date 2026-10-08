import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { saveVerificationToken } from "../src/utils/email";
import { api, json, seedComment, useTrustProxy, resetTables, clearSettings } from "./helpers";

let ipSequence = 0;
function uniqueIp(): string {
  ipSequence += 1;
  return `198.20.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

const RESET_KEYS = [
  "comment_verify_enabled",
  "comment_verify_difficulty",
  "comment_verify_secret",
  "comment_auto_approve",
  "email_verify_enabled",
  "admin_email",
];

/** 本地 PoW 求解（与实现同算法） */
function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

function solveNonce(prefix: string, difficulty: number): number {
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const digest = crypto.createHash("sha256").update(`${prefix}:${nonce}`, "utf8").digest();
    if (leadingZeroBits(digest) >= difficulty) return nonce;
  }
  throw new Error("未能在上限内找到满足难度的 nonce");
}

/** 走完「挑战 → 求解 → 兑换票据」全流程 */
async function obtainTicket(ip: string, postSlug: string): Promise<string> {
  const challenge = (await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: postSlug } })))
    .data;
  const nonce = solveNonce(challenge.prefix, challenge.difficulty);
  const solved = await api("/api/verify/solution", {
    method: "POST",
    ip,
    body: {
      post_slug: postSlug,
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonce,
      elapsed_ms: 1000,
    },
  });
  expect(solved.status).toBe(200);
  return (await json(solved)).data.ticket as string;
}

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  clearSettings(RESET_KEYS);
});

describe("POST /api/verify/challenge", () => {
  it("未开启验证时返回 enabled=false", async () => {
    const res = await api("/api/verify/challenge", { method: "POST", ip: uniqueIp() });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      code: 200,
      message: "Verification disabled",
      data: { enabled: false },
    });
  });

  it("开启后签发挑战，并回显 post_slug", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "8");

    const res = await api("/api/verify/challenge", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: "/posts/verify" },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe(200);
    expect(body.data.enabled).toBe(true);
    expect(body.data.post_slug).toBe("/posts/verify");
    expect(body.data.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.data.difficulty).toBe(8);
    expect(body.data.expires_in).toBe(600);
    expect(typeof body.data.prefix).toBe("string");
    expect(typeof body.data.sig).toBe("string");
    expect(body.data.prefix.length).toBeGreaterThan(10);
  });

  it("无请求体也能签发挑战（仅探测开关）", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/challenge", { method: "POST", ip: uniqueIp() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.enabled).toBe(true);
    expect(body.data.post_slug).toBe("");
  });

  it("post_slug 会被净化并截断到 200 字符", async () => {
    await setSetting("comment_verify_enabled", "true");

    const sanitized = await json(
      await api("/api/verify/challenge", {
        method: "POST",
        ip: uniqueIp(),
        body: { post_slug: "<script>x</script>/posts/a" },
      })
    );
    expect(sanitized.data.post_slug).toBe("/posts/a");

    const long = await json(
      await api("/api/verify/challenge", {
        method: "POST",
        ip: uniqueIp(),
        body: { post_slug: `/${"a".repeat(300)}` },
      })
    );
    expect(long.data.post_slug).toHaveLength(200);
  });

  it("非字符串 post_slug 不会导致 500", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/challenge", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: { a: 1 } },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data.post_slug).toBe("[object Object]");
  });
});

describe("POST /api/verify/solution", () => {
  it("未开启验证时直接返回 enabled=false", async () => {
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { prefix: "x", sig: "y", nonce: 1, elapsed_ms: 1000 },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ enabled: false });
  });

  it("完整流程可拿到票据，并能用于提交评论", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "8");

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/ok" } }))
    ).data;
    const nonce = solveNonce(challenge.prefix, challenge.difficulty);

    const solved = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/ok",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonce,
        elapsed_ms: 1000,
      },
    });
    expect(solved.status).toBe(200);
    const solvedBody = await json(solved);
    expect(solvedBody.code).toBe(200);
    expect(solvedBody.data.enabled).toBe(true);
    expect(solvedBody.data.expires_in).toBe(300);

    const comment = await api("/api/comments", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/ok",
        author: "访客",
        email: "g@example.com",
        content: "带票据的评论",
        verify_ticket: solvedBody.data.ticket,
      },
    });
    expect(comment.status).toBe(200);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/ok'`) as any;
    expect(row.content_text).toBe("带票据的评论");
  });

  it("答案错误返回 403 并给出 reason", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "26"); // 保证 nonce=0 一定算力不足

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/bad" } }))
    ).data;

    const res = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/bad",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonce: 0,
        elapsed_ms: 1000,
      },
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe(403);
    expect(body.message).toBe("Verification failed");
    expect(body.reason).toBe("insufficient work");
  });

  it("缺少签名返回 403 bad signature", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: "/posts/x", prefix: "", sig: "", nonce: 1, elapsed_ms: 1000 },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing challenge");
  });

  it("蜜罐字段被填写时静默拒绝", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: "/posts/x", prefix: "p", sig: "s", nonce: 1, elapsed_ms: 1000, hp: "bot" },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("honeypot");
  });

  it("蜜罐字段为空白时视为未填写", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: "/posts/x", prefix: "p", sig: "s", nonce: 1, elapsed_ms: 1000, hp: "   " },
    });
    // 越过蜜罐检查后因签名错误被拒
    expect((await json(res)).reason).toBe("bad signature");
  });

  it("票据绑定 IP：换 IP 提交评论会被拒", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "8");

    const ip = uniqueIp();
    const ticket = await obtainTicket(ip, "/posts/ipbind");
    const comment = await api("/api/comments", {
      method: "POST",
      ip: uniqueIp(), // 另一个 IP
      body: {
        post_slug: "/posts/ipbind",
        author: "访客",
        email: "g@example.com",
        content: "x",
        verify_ticket: ticket,
      },
    });
    expect(comment.status).toBe(403);
    expect((await json(comment)).reason).toBe("VERIFY_REQUIRED");
  });

  it("票据绑定文章：换 slug 提交评论会被拒", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "8");

    const ip = uniqueIp();
    const ticket = await obtainTicket(ip, "/posts/slug-a");
    const comment = await api("/api/comments", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/slug-b",
        author: "访客",
        email: "g@example.com",
        content: "x",
        verify_ticket: ticket,
      },
    });
    expect(comment.status).toBe(403);
  });

  it("伪造票据（篡改签名）会被拒", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "8");

    const ip = uniqueIp();
    const ticket = await obtainTicket(ip, "/posts/tamper");
    const comment = await api("/api/comments", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/tamper",
        author: "访客",
        email: "g@example.com",
        content: "x",
        verify_ticket: `${ticket}broken`,
      },
    });
    expect(comment.status).toBe(403);
  });
});

describe("GET /api/verify-email/verify", () => {
  function verifyPage(token: string, email: string) {
    return api(
      `/api/verify-email/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`,
      { ip: uniqueIp() }
    );
  }

  it("缺少参数返回失败页面（HTML）", async () => {
    const res = await api("/api/verify-email/verify", { ip: uniqueIp() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("验证失败");
    expect(html).toContain("缺少验证参数");
  });

  it("未知 token 返回「验证链接无效」", async () => {
    const html = await (await verifyPage("no-such-token", "a@example.com")).text();
    expect(html).toContain("验证链接无效");
  });

  it("有效 token 验证成功并批准该邮箱的待审评论", async () => {
    const email = "verify-ok@example.com";
    const token = "token-ok";
    await saveVerificationToken(email, token, new Date(Date.now() + 86400000).toISOString());
    const pending = seedComment({ email, status: "pending" });
    const otherPending = seedComment({ email: "other@example.com", status: "pending" });

    const html = await (await verifyPage(token, email)).text();
    expect(html).toContain("验证成功");
    expect(html).toContain("共 1 条评论已通过审核");

    const record = db.get(
      sql`SELECT * FROM "EmailVerification" WHERE "token" = ${token}`
    ) as any;
    expect(record.verified).toBe(1);
    expect(record.verified_at).not.toBeNull();

    const statusOf = (id: number) =>
      (db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as any).status;
    expect(statusOf(pending)).toBe("approved");
    expect(statusOf(otherPending)).toBe("pending");
  });

  it("没有待审评论时提示验证成功但不提数量", async () => {
    const email = "verify-nopending@example.com";
    await saveVerificationToken(email, "token-nopending", new Date(Date.now() + 86400000).toISOString());
    const html = await (await verifyPage("token-nopending", email)).text();
    expect(html).toContain("验证成功");
    expect(html).not.toContain("条评论已通过审核");
  });

  it("重复验证返回「该邮箱已验证通过」", async () => {
    const email = "verify-twice@example.com";
    await saveVerificationToken(email, "token-twice", new Date(Date.now() + 86400000).toISOString());
    await verifyPage("token-twice", email);
    const html = await (await verifyPage("token-twice", email)).text();
    expect(html).toContain("该邮箱已验证通过");
  });

  it("过期的 token 返回「验证链接已过期」", async () => {
    const email = "verify-expired@example.com";
    await saveVerificationToken(email, "token-expired", new Date(Date.now() - 1000).toISOString());
    const html = await (await verifyPage("token-expired", email)).text();
    expect(html).toContain("验证链接已过期");

    const record = db.get(
      sql`SELECT "verified" FROM "EmailVerification" WHERE "token" = 'token-expired'`
    ) as any;
    expect(record.verified).toBe(0);
  });

  it("token 与邮箱不匹配时视为无效", async () => {
    const email = "verify-mismatch@example.com";
    await saveVerificationToken(email, "token-mismatch", new Date(Date.now() + 86400000).toISOString());
    const html = await (await verifyPage("token-mismatch", "someone-else@example.com")).text();
    expect(html).toContain("验证链接无效");
  });
});
