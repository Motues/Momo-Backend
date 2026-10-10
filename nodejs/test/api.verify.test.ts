import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { hashIp } from "../src/utils/verify";
import { hashwxHash, hashwxTarget, hashwxBlockSeed, type HashwxSpec } from "../src/utils/hashwx";
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
  "comment_auto_approve",
  "email_verify_enabled",
  "admin_email",
  "admin_comment_key",
  "admin_comment_key_enabled",
];

/**
 * 固定签名密钥（协议 v2）。
 *
 * 本文件的用例需要本地伪造 v1 载荷 / v1 票据来验证「协议版本探测」与「旧票据拒绝」，
 * 因此必须让整个文件用同一个已知密钥。
 *
 * ⚠️ 这里不能把 comment_verify_secret 放进 RESET_KEYS：
 * verify.ts 的 getSecret() 有模块级缓存，且只在首次调用时读库。文件里第一个用例是
 * 「关闭态」，压根不会触发 getSecret()；若 afterEach 此时把密钥删掉，下一个用例才会
 * 首次读库，就会读到空值并现场生成随机密钥，与本地签名用的固定密钥不一致。
 * 所以密钥在 beforeAll 里写入一次，并全程保留。
 */
const VECTOR_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";

/** 测试统一使用很小的难度，避免纯解释模式的 HashWX 让用例变慢 */
const TEST_DIFFICULTY = "1000";

/** 与被测实现同算法的本地副本，用于钉住口径 */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacLocal(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

/**
 * 本地求解 HashWX（与服务端同口径），返回每个子挑战的 nonce 十进制字符串。
 * 难度保持很小（总工作量 1000 / 4 子挑战），保证用例在毫秒级完成。
 */
function solveHashwx(spec: HashwxSpec): string[] {
  const challenge = Buffer.from(spec.c, "hex");
  const target = hashwxTarget(spec.d);
  const n = BigInt(spec.n);
  const nonces: string[] = [];

  for (let i = 0; i < spec.count; i++) {
    let nonce = 0n;
    for (; nonce < 5_000_000n; nonce++) {
      if (hashwxHash(hashwxBlockSeed(challenge, i, nonce / n), nonce) <= target) break;
    }
    if (nonce >= 5_000_000n) throw new Error(`子挑战 ${i} 求解超限`);
    nonces.push(nonce.toString());
  }

  return nonces;
}

/** 走完「挑战 → 求解 HashWX → 兑换票据」全流程 */
async function obtainTicket(ip: string, postSlug: string): Promise<string> {
  const challenge = (
    await json(
      await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: postSlug } })
    )
  ).data;
  const nonces = solveHashwx(challenge.pow);
  const solved = await api("/api/verify/solution", {
    method: "POST",
    ip,
    body: {
      post_slug: postSlug,
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonces,
      elapsed_ms: 1000,
    },
  });
  expect(solved.status).toBe(200);
  return (await json(solved)).data.ticket as string;
}

/* ------------------------------------------------------------------ *
 * VerifyRecord 埋点助手
 * ------------------------------------------------------------------ */

/** 读取某个挑战 id 下的全部认证记录（按写入顺序，即 id 升序） */
function verifyRecordsOf(challengeId: string): any[] {
  return db.all(
    sql`SELECT * FROM "VerifyRecord" WHERE "challenge_id" = ${challengeId} ORDER BY "id" ASC`
  ) as any[];
}

/** 认证记录总行数（用于「未开启验证时不写任何记录」的前后对比） */
function countVerifyRecords(): number {
  return (db.get(sql`SELECT COUNT(*) AS n FROM "VerifyRecord"`) as { n: number }).n;
}

/** 从 v2 挑战 prefix 载荷里取出 cid（与服务端 extractChallengeId 同口径） */
function cidFromPrefix(prefix: string): string {
  const payload = JSON.parse(
    Buffer.from(prefix.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
  return String(payload.cid);
}

beforeAll(async () => {
  // 必须早于任何触发 getSecret() 的调用（密钥只读库一次），见上方注释
  await setSetting("comment_verify_secret", VECTOR_SECRET);
});

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  clearSettings(RESET_KEYS);
});

describe("POST /api/verify/challenge", () => {
  it("未开启验证时返回 enabled=false 与协议版本", async () => {
    const before = countVerifyRecords();
    const res = await api("/api/verify/challenge", { method: "POST", ip: uniqueIp() });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      code: 200,
      message: "Verification disabled",
      data: { enabled: false, version: 2 },
    });
    // 未开启验证时不产生任何认证记录（默认关闭必须是零副作用）
    expect(countVerifyRecords()).toBe(before);
  });

  it("开启后签发 v2 挑战（HashWX 参数），并回显 post_slug", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const res = await api("/api/verify/challenge", {
      method: "POST",
      ip,
      body: { post_slug: "/posts/verify" },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe(200);
    expect(body.data.enabled).toBe(true);
    expect(body.data.version).toBe(2);
    expect(body.data.post_slug).toBe("/posts/verify");
    expect(body.data.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.data.expires_in).toBe(600);
    expect(typeof body.data.prefix).toBe("string");
    expect(typeof body.data.sig).toBe("string");
    expect(body.data.prefix.length).toBeGreaterThan(10);

    // 工作量证明参数：总难度 1000 均分到 4 个子挑战
    expect(body.data.pow).toEqual({
      algo: "hashwx",
      c: expect.stringMatching(/^[0-9a-f]{64}$/),
      d: 250,
      n: 65536,
      count: 4,
    });
    // v1 的 difficulty 字段已彻底移除（旧前端据此判断会拿到 undefined）
    expect(body.data.difficulty).toBeUndefined();

    // 埋点：签发挑战必须落一条 challenge 记录，challenge_id 与响应一致
    const records = verifyRecordsOf(body.data.challenge_id);
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe("challenge");
    expect(records[0].challenge_id).toBe(body.data.challenge_id);
    // 记录的是**总期望哈希次数**，不是响应里 pow.d 的单子挑战难度
    expect(records[0].difficulty).toBe(Number(TEST_DIFFICULTY));
    expect(records[0].difficulty).not.toBe(body.data.pow.d);
    expect(records[0].post_slug).toBe("/posts/verify");
    expect(records[0].ip_address).toBe(ip);
    expect(records[0].reason).toBeNull();
    expect(records[0].elapsed_ms).toBeNull();
    // created_at 是 Unix 毫秒（若是秒级，管理面板的时间列会退回 1970 年）
    expect(Math.abs(Number(records[0].created_at) - Date.now())).toBeLessThan(5000);
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
  it("未开启验证时直接返回 enabled=false 与协议版本", async () => {
    const before = countVerifyRecords();
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { prefix: "x", sig: "y", nonces: [], elapsed_ms: 1000 },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ enabled: false, version: 2 });
    expect(countVerifyRecords()).toBe(before);
  });

  it("完整流程可拿到票据，并能用于提交评论", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/ok" } }))
    ).data;
    const nonces = solveHashwx(challenge.pow);

    const solved = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/ok",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces,
        elapsed_ms: 1000,
      },
    });
    expect(solved.status).toBe(200);
    const solvedBody = await json(solved);
    expect(solvedBody.code).toBe(200);
    expect(solvedBody.data.enabled).toBe(true);
    expect(solvedBody.data.version).toBe(2);
    expect(solvedBody.data.expires_in).toBe(300);

    // 埋点：同一次认证（同一 cid）先有 challenge、后有 pass；
    // elapsed_ms 原样记录请求体里的值，而不是服务端自己测的耗时
    const cid = cidFromPrefix(challenge.prefix);
    expect(cid).toBe(challenge.challenge_id);
    const records = verifyRecordsOf(cid);
    expect(records.map((r) => r.event)).toEqual(["challenge", "pass"]);
    expect(records[0].difficulty).toBe(Number(TEST_DIFFICULTY));
    expect(records[1].difficulty).toBe(Number(TEST_DIFFICULTY));
    expect(records[1].reason).toBeNull();
    expect(records[1].elapsed_ms).toBe(1000);
    expect(records[1].post_slug).toBe("/posts/ok");
    expect(records[1].ip_address).toBe(ip);
    expect(records[1].challenge_id).toBe(challenge.challenge_id);

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

  it("v1 客户端（单个 nonce、载荷无 v 字段）返回 PROTOCOL_OUTDATED", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    // v1 载荷没有 v 字段，签名口径与 v2 相同
    const payload = { cid: "legacy-cid", iph: hashIp(ip, VECTOR_SECRET), iat: Date.now() };
    const prefix = b64url(JSON.stringify(payload));

    const res = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/legacy",
        prefix,
        sig: hmacLocal(prefix, VECTOR_SECRET),
        nonce: 0, // v1 字段名
        elapsed_ms: 1000,
      },
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.message).toBe("Verification failed");
    // 旧前端能据此区分「需要升级组件」与「答案算错」
    expect(body.reason).toBe("PROTOCOL_OUTDATED");
  });

  it("答案错误返回 403 并给出 reason", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "1000000"); // 子挑战 d=250000，nonce 全 0 必然算力不足

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
        nonces: ["0", "0", "0", "0"],
        elapsed_ms: 1000,
      },
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe(403);
    expect(body.message).toBe("Verification failed");
    expect(body.reason).toBe("insufficient work");

    // 埋点：失败记录必须带**服务端给出的 reason**（而不是客户端可控的字段）
    const cid = cidFromPrefix(challenge.prefix);
    expect(cid).toBe(challenge.challenge_id);
    const records = verifyRecordsOf(cid);
    expect(records.map((r) => r.event)).toEqual(["challenge", "fail"]);
    expect(records[1].reason).toBe(body.reason);
    expect(records[1].elapsed_ms).toBe(1000);
    expect(records[1].difficulty).toBe(1000000);
    expect(records[1].post_slug).toBe("/posts/bad");
    expect(records[1].ip_address).toBe(ip);
  });

  it("nonces 数量不匹配返回 403 solution count mismatch", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/count" } }))
    ).data;

    const res = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/count",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces: ["1", "2", "3"],
        elapsed_ms: 1000,
      },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("solution count mismatch");
  });

  it("挑战单次使用：同一挑战二次兑换被拒", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/replay" } }))
    ).data;
    const nonces = solveHashwx(challenge.pow);
    const request = () =>
      api("/api/verify/solution", {
        method: "POST",
        ip,
        body: {
          post_slug: "/posts/replay",
          prefix: challenge.prefix,
          sig: challenge.sig,
          nonces,
          elapsed_ms: 1000,
        },
      });

    expect((await request()).status).toBe(200);

    const replay = await request();
    expect(replay.status).toBe(403);
    expect((await json(replay)).reason).toBe("challenge already used");
  });

  it("挑战绑定文章：为 A 签发的挑战不能用来兑换 B 的票据", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/a" } }))
    ).data;
    // 挑战载荷里必须带 slug，且等于签发时传入的文章
    const payload = JSON.parse(Buffer.from(challenge.prefix.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    expect(payload.slug).toBe("/posts/a");

    const nonces = solveHashwx(challenge.pow);

    // 1) 用另一篇文章兑换 —— 必须被拒
    const crossPost = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/b",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces,
        elapsed_ms: 1000,
      },
    });
    expect(crossPost.status).toBe(403);
    expect((await json(crossPost)).reason).toBe("slug mismatch");

    // 2) 空文章名也不行（空串与被签名的 slug 不同）
    const emptySlug = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: { prefix: challenge.prefix, sig: challenge.sig, nonces, elapsed_ms: 1000 },
    });
    expect((await json(emptySlug)).reason).toBe("slug mismatch");

    // 3) 用原文章兑换应当成功，且票据确实绑定到 A —— 说明前两次不是被别的原因顺带拦下的
    const correct = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/a",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces,
        elapsed_ms: 1000,
      },
    });
    expect(correct.status).toBe(200);
    const ticket = (await json(correct)).data.ticket as string;
    const ticketBody = ticket.slice(0, ticket.lastIndexOf("."));
    const ticketPayload = JSON.parse(
      Buffer.from(ticketBody.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    expect(ticketPayload.slug).toBe("/posts/a");
  });

  it("含被净化片段的文章标识：签出的票据必须能真正兑换（否则真人会一直收到假 VERIFY_REQUIRED）", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);
    await setSetting("comment_auto_approve", "true");

    const ip = uniqueIp();
    // checkContent 会把 <script>…</script> 去掉，因此「净化后的 slug」是 /posts/end
    const rawSlug = "/posts/<script>alert(1)</script>end";
    const normalizedSlug = "/posts/end";

    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: rawSlug } }))
    ).data;
    const payload = JSON.parse(
      Buffer.from(challenge.prefix.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    expect(payload.slug).toBe(normalizedSlug);

    const solved = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: rawSlug,
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces: solveHashwx(challenge.pow),
        elapsed_ms: 1000,
      },
    });
    expect(solved.status).toBe(200);
    const ticket = (await json(solved)).data.ticket as string;

    // 用**原始** slug 提交评论：票据比对走的是同一套净化规则，必须通过
    const comment = await api("/api/comments", {
      method: "POST",
      ip,
      body: {
        post_slug: rawSlug,
        author: "净化回归",
        email: "sanitize@example.com",
        content: "票据应当可用",
        verify_ticket: ticket,
      },
    });
    expect(comment.status).toBe(200);
    expect((await json(comment)).reason).toBeUndefined();
  });

  it("并发提交同一挑战时只有一次能兑换成功（防重放不能有竞态）", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

    const ip = uniqueIp();
    const challenge = (
      await json(await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/race" } }))
    ).data;
    const nonces = solveHashwx(challenge.pow);

    const request = () =>
      api("/api/verify/solution", {
        method: "POST",
        ip,
        body: {
          post_slug: "/posts/race",
          prefix: challenge.prefix,
          sig: challenge.sig,
          nonces,
          elapsed_ms: 1000,
        },
      });

    // 关键点：防重放的「查重 → 工作量校验 → 标记已用」必须是一段不出现 await 的同步临界区。
    // 若中间夹着 await（历史上 spec 派生就夹在中间），两个并发请求会都通过查重、都标记成功、
    // 各换一张票据 —— 挑战「单次使用」在并发下就失效了。
    const [first, second] = await Promise.all([request(), request()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 403]);

    const rejected = first.status === 403 ? first : second;
    expect((await json(rejected)).reason).toBe("challenge already used");
  });

  it("缺少签名返回 403 missing challenge", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: { post_slug: "/posts/x", prefix: "", sig: "", nonces: ["1"], elapsed_ms: 1000 },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing challenge");
  });

  it("蜜罐字段被填写时静默拒绝", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: {
        post_slug: "/posts/x",
        prefix: "p",
        sig: "s",
        nonces: ["1"],
        elapsed_ms: 1000,
        hp: "bot",
      },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("honeypot");
  });

  it("蜜罐字段为空白时视为未填写", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip: uniqueIp(),
      body: {
        post_slug: "/posts/x",
        prefix: "p",
        sig: "s",
        nonces: ["1"],
        elapsed_ms: 1000,
        hp: "   ",
      },
    });
    // 越过蜜罐检查后因签名错误被拒
    expect((await json(res)).reason).toBe("bad signature");
  });

  it("票据绑定 IP：换 IP 提交评论会被拒", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

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
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

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
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);

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

  it("v1 票据（v=1）一律拒绝", async () => {
    await setSetting("comment_verify_enabled", "true");

    const ip = uniqueIp();
    const postSlug = "/posts/v1ticket";
    const now = Date.now();
    // 签名完全合法，只是版本号是 v1 —— 必须仍然被拒
    const body = b64url(
      JSON.stringify({
        v: 1,
        iph: hashIp(ip, VECTOR_SECRET),
        slug: postSlug,
        iat: now,
        exp: now + 60_000,
        jti: "legacy",
      })
    );
    const forged = `${body}.${hmacLocal(body, VECTOR_SECRET)}`;

    const comment = await api("/api/comments", {
      method: "POST",
      ip,
      body: {
        post_slug: postSlug,
        author: "访客",
        email: "g@example.com",
        content: "x",
        verify_ticket: forged,
      },
    });
    expect(comment.status).toBe(403);
    expect((await json(comment)).reason).toBe("VERIFY_REQUIRED");
  });

  it("管理者放行路径：管理员密钥通过时无需票据，访客仍必须携带票据", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);
    await setSetting("admin_email", "blogger@example.com");
    await setSetting("admin_comment_key", "blogger-secret");
    await setSetting("admin_comment_key_enabled", "true");

    const postSlug = "/posts/admin-bypass";

    // 博主：管理员邮箱 + 正确密钥，不携带 verify_ticket 也应放行
    const allowed = await api("/api/comments", {
      method: "POST",
      ip: uniqueIp(),
      body: {
        post_slug: postSlug,
        author: "博主",
        email: "blogger@example.com",
        content: "博主评论",
        admin_key: "blogger-secret",
      },
    });
    expect(allowed.status).toBe(200);

    // 管理员邮箱但密钥不对 => 拒绝，说明放行取决于密钥本身
    const denied = await api("/api/comments", {
      method: "POST",
      ip: uniqueIp(),
      body: {
        post_slug: postSlug,
        author: "博主",
        email: "blogger@example.com",
        content: "x",
        admin_key: "wrong-secret",
      },
    });
    expect(denied.status).toBe(403);
    expect((await json(denied)).message).toBe("Invalid admin key");

    // 普通访客没有管理员密钥时，仍然必须携带有效票据
    const visitor = await api("/api/comments", {
      method: "POST",
      ip: uniqueIp(),
      body: {
        post_slug: postSlug,
        author: "访客",
        email: "g@example.com",
        content: "x",
      },
    });
    expect(visitor.status).toBe(403);
    expect((await json(visitor)).reason).toBe("VERIFY_REQUIRED");
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
