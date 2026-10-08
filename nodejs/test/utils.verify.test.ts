import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { getSetting, setSetting } from "../src/utils/settings";
import {
  hashIp,
  honeypotField,
  isVerifyEnabled,
  getDifficulty,
  getPublicVerifyConfig,
  createChallenge,
  verifySolution,
  createTicket,
  verifyTicket,
  TICKET_TTL_SECONDS,
} from "../src/utils/verify";

/* ------------------------------------------------------------------ *
 * 跨语言固定向量（与 go/internal/pkg/utils/verify_consistency_test.go 完全一致）
 * 这三组值一旦变化就说明 Node/Go/Worker 三端口径漂移，必须同步修改实现。
 * ------------------------------------------------------------------ */
const VECTOR_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";
const VECTOR_IP = "::ffff:127.0.0.1";
const VECTOR_SLUG = "/posts/vector-check";
const VECTOR_IP_HASH = "20fa49e706f48b01";
const VECTOR_HONEYPOT = "v_77dc2477f6";
const VECTOR_PREFIX =
  "eyJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsImlhdCI6MTczMDAwMDAwMDAwMH0";
const VECTOR_SIG = "OdtEE6BBCwUhnC5GTRoIcWALl_Wcv5qOfrwVT6tenK0";
const VECTOR_NONCE = 12345;
const VECTOR_LEADING_ZERO_BITS = 2;
const VECTOR_IAT = 1730000000000;
const VECTOR_PAYLOAD_JSON =
  '{"cid":"dGVzdC1jaGFsbGVuZ2U","iph":"20fa49e706f48b01","iat":1730000000000}';

/** 与被测实现同算法的本地副本，用于钉住口径（Go 侧测试同样自行计算） */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacLocal(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

function leadingZeroBitsLocal(buf: Buffer): number {
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

/** 用固定密钥本地签发一个 prefix（用于构造各种畸形载荷） */
async function signPayload(payload: unknown): Promise<{ prefix: string; sig: string }> {
  const secret = (await getSetting("comment_verify_secret")) as string;
  const prefix = b64url(JSON.stringify(payload));
  return { prefix, sig: hmacLocal(prefix, secret) };
}

/** 冻结 Date.now()，便于测试有效期分支 */
async function withFrozenNow<T>(ts: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(ts);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** 本地暴力求解 PoW */
function solveNonce(prefix: string, difficulty: number): number {
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const digest = crypto.createHash("sha256").update(`${prefix}:${nonce}`, "utf8").digest();
    if (leadingZeroBitsLocal(digest) >= difficulty) return nonce;
  }
  throw new Error("未能在上限内找到满足难度的 nonce");
}

describe("utils/verify — 默认关闭态", () => {
  it("默认不开启人机验证", async () => {
    expect(await isVerifyEnabled()).toBe(false);
  });

  it("关闭时公开配置返回 false/空蜜罐字段，且不生成密钥（零副作用）", async () => {
    const config = await getPublicVerifyConfig("/posts/a");
    expect(config).toEqual({ verify_enabled: "false", verify_honeypot: "" });
    expect(await getSetting("comment_verify_secret")).toBeNull();
  });
});

describe("utils/verify — 跨语言固定向量", () => {
  beforeAll(async () => {
    // 必须在任何会触发 getSecret() 的调用之前写入固定密钥（密钥有模块级缓存）
    await setSetting("comment_verify_secret", VECTOR_SECRET);
    await setSetting("comment_verify_difficulty", "2"); // 会被下限保护钳到 8
  });

  it("IP 哈希 = hex(SHA256(\"ip:\" + secret + \":\" + ip))[:16]", () => {
    expect(hashIp(VECTOR_IP, VECTOR_SECRET)).toBe(VECTOR_IP_HASH);
    expect(hashIp(VECTOR_IP, VECTOR_SECRET)).toHaveLength(16);
    expect(hashIp("10.0.0.1", VECTOR_SECRET)).not.toBe(VECTOR_IP_HASH);
  });

  it("蜜罐字段名 = \"v_\" + hex(SHA256(\"hp:\" + secret + \":\" + slug))[:10]", () => {
    expect(honeypotField(VECTOR_SLUG, VECTOR_SECRET)).toBe(VECTOR_HONEYPOT);
    expect(honeypotField(VECTOR_SLUG, VECTOR_SECRET)).toHaveLength(12);
    expect(honeypotField("/posts/other", VECTOR_SECRET)).not.toBe(VECTOR_HONEYPOT);
  });

  it("base64url 与 JSON 载荷口径一致", () => {
    expect(b64url(VECTOR_PAYLOAD_JSON)).toBe(VECTOR_PREFIX);
    const decoded = Buffer.from(
      VECTOR_PREFIX.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    expect(decoded).toBe(VECTOR_PAYLOAD_JSON);
    expect(JSON.parse(decoded)).toEqual({
      cid: "dGVzdC1jaGFsbGVuZ2U",
      iph: VECTOR_IP_HASH,
      iat: VECTOR_IAT,
    });
  });

  it("prefix 签名 = base64url(HMAC-SHA256(prefix, secret))", () => {
    expect(hmacLocal(VECTOR_PREFIX, VECTOR_SECRET)).toBe(VECTOR_SIG);
  });

  it("SHA256(prefix + \":12345\") 的前导 0 比特数为 2", () => {
    const digest = crypto.createHash("sha256").update(`${VECTOR_PREFIX}:${VECTOR_NONCE}`, "utf8").digest();
    expect(leadingZeroBitsLocal(digest)).toBe(VECTOR_LEADING_ZERO_BITS);
  });

  it("固定向量能通过签名/IP/时效校验（仅因难度下限被拒），证明签名口径未漂移", async () => {
    // iat=1730000000000 是过去时间，冻结时钟到其后 1 秒内才不算过期
    const result = await withFrozenNow(VECTOR_IAT + 1000, () =>
      verifySolution({
        prefix: VECTOR_PREFIX,
        sig: VECTOR_SIG,
        nonce: VECTOR_NONCE,
        elapsedMs: 1000,
        ip: VECTOR_IP,
      })
    );
    // 走到难度判定说明：签名 ✓、载荷 ✓、时效 ✓、IP 绑定 ✓、时序 ✓
    // 而难度被下限保护钳到 8 > 向量的 2 位前导 0，因此只会是 insufficient work
    expect(result).toEqual({ ok: false, reason: "insufficient work" });
  });

  it("固定向量遇到不同 IP 返回 ip mismatch", async () => {
    const result = await withFrozenNow(VECTOR_IAT + 1000, () =>
      verifySolution({
        prefix: VECTOR_PREFIX,
        sig: VECTOR_SIG,
        nonce: VECTOR_NONCE,
        elapsedMs: 1000,
        ip: "10.0.0.1",
      })
    );
    expect(result).toEqual({ ok: false, reason: "ip mismatch" });
  });

  it("签名字节被篡改即拒绝", async () => {
    const tampered = `${VECTOR_SIG.slice(0, -1)}X`;
    const result = await verifySolution({
      prefix: VECTOR_PREFIX,
      sig: tampered,
      nonce: VECTOR_NONCE,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("真实时间下固定向量已过期（说明签名先于时效通过）", async () => {
    const result = await verifySolution({
      prefix: VECTOR_PREFIX,
      sig: VECTOR_SIG,
      nonce: VECTOR_NONCE,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    });
    expect(result).toEqual({ ok: false, reason: "challenge expired" });
  });

  it("难度配置受上下限保护（MIN=8 / MAX=26）", async () => {
    expect(await getDifficulty()).toBe(8);
    await setSetting("comment_verify_difficulty", "99");
    expect(await getDifficulty()).toBe(26);
    await setSetting("comment_verify_difficulty", "8");
  });
});

describe("utils/verify — 挑战签发与答案校验", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
    await setSetting("comment_verify_difficulty", "8");
  });

  it("createChallenge 返回结构正确的挑战", async () => {
    const challenge = await createChallenge(VECTOR_IP);
    expect(challenge.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 字节 base64url
    expect(challenge.difficulty).toBe(8);
    expect(challenge.expires_in).toBe(600); // 10 分钟
    expect(hmacLocal(challenge.prefix, VECTOR_SECRET)).toBe(challenge.sig);
    const payload = JSON.parse(
      Buffer.from(challenge.prefix.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    expect(payload.iph).toBe(hashIp(VECTOR_IP, VECTOR_SECRET));
    expect(payload.cid).toBe(challenge.challenge_id);
    expect(Math.abs(Date.now() - payload.iat)).toBeLessThan(5000);
  });

  it("正确解答通过校验，同一 nonce 二次兑换被拒（防重放）", async () => {
    const challenge = await createChallenge("198.51.100.1");
    const nonce = solveNonce(challenge.prefix, challenge.difficulty);

    const first = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonce,
      elapsedMs: 1000,
      ip: "198.51.100.1",
    });
    expect(first).toEqual({ ok: true });

    const replay = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonce,
      elapsedMs: 1000,
      ip: "198.51.100.1",
    });
    expect(replay).toEqual({ ok: false, reason: "replayed nonce" });
  });

  it("换一个 IP 使用同一挑战被拒", async () => {
    const challenge = await createChallenge("198.51.100.2");
    const nonce = solveNonce(challenge.prefix, challenge.difficulty);
    const result = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonce,
      elapsedMs: 1000,
      ip: "198.51.100.3",
    });
    expect(result).toEqual({ ok: false, reason: "ip mismatch" });
  });

  it("缺少 prefix 或 sig 直接拒绝", async () => {
    const params = { prefix: "", sig: "", nonce: 1, elapsedMs: 1000, ip: VECTOR_IP };
    expect(await verifySolution(params)).toEqual({ ok: false, reason: "missing challenge" });
    expect(await verifySolution({ ...params, prefix: "abc" })).toEqual({
      ok: false,
      reason: "missing challenge",
    });
  });

  it("解答耗时过低/过高都视为脚本", async () => {
    const challenge = await createChallenge("198.51.100.4");
    const nonce = solveNonce(challenge.prefix, challenge.difficulty);
    const base = { prefix: challenge.prefix, sig: challenge.sig, nonce, ip: "198.51.100.4" };

    expect(await verifySolution({ ...base, elapsedMs: 299 })).toEqual({
      ok: false,
      reason: "implausible timing",
    });
    expect(await verifySolution({ ...base, elapsedMs: 10 * 60 * 1000 + 1 })).toEqual({
      ok: false,
      reason: "implausible timing",
    });
    expect(await verifySolution({ ...base, elapsedMs: Number.NaN })).toEqual({
      ok: false,
      reason: "implausible timing",
    });
  });

  it("nonce 为负数或非整数时拒绝", async () => {
    const challenge = await createChallenge("198.51.100.5");
    const base = { prefix: challenge.prefix, sig: challenge.sig, elapsedMs: 1000, ip: "198.51.100.5" };
    expect(await verifySolution({ ...base, nonce: -1 })).toEqual({ ok: false, reason: "bad nonce" });
    expect(await verifySolution({ ...base, nonce: 1.5 })).toEqual({ ok: false, reason: "bad nonce" });
    expect(await verifySolution({ ...base, nonce: Number.NaN })).toEqual({
      ok: false,
      reason: "bad nonce",
    });
  });

  it("工作量不足时拒绝", async () => {
    // 难度 26 时，绝大多数 nonce 都算不出足够的前导 0
    await setSetting("comment_verify_difficulty", "26");
    const challenge = await createChallenge("198.51.100.6");
    const result = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonce: 1,
      elapsedMs: 1000,
      ip: "198.51.100.6",
    });
    expect(result).toEqual({ ok: false, reason: "insufficient work" });
    await setSetting("comment_verify_difficulty", "8");
  });

  it("prefix 被篡改（签名失效）即拒绝", async () => {
    const challenge = await createChallenge("198.51.100.7");
    const tampered = `${challenge.prefix.slice(0, -1)}A`;
    const result = await verifySolution({
      prefix: tampered,
      sig: challenge.sig,
      nonce: 0,
      elapsedMs: 1000,
      ip: "198.51.100.7",
    });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("签名有效但载荷不是 JSON → malformed prefix", async () => {
    const secret = (await getSetting("comment_verify_secret")) as string;
    const badPrefix = b64url("not-json-at-all");
    const result = await verifySolution({
      prefix: badPrefix,
      sig: hmacLocal(badPrefix, secret),
      nonce: 0,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    });
    expect(result).toEqual({ ok: false, reason: "malformed prefix" });
  });

  it("签名有效但载荷缺字段 → malformed payload", async () => {
    const { prefix, sig } = await signPayload({ cid: "x" });
    const result = await verifySolution({
      prefix,
      sig,
      nonce: 0,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    });
    expect(result).toEqual({ ok: false, reason: "malformed payload" });
  });

  it("签名有效但时间戳来自未来 → challenge from the future", async () => {
    const { prefix, sig } = await signPayload({
      cid: "cid",
      iph: hashIp(VECTOR_IP, VECTOR_SECRET),
      iat: Date.now() + 120_000,
    });
    const result = await verifySolution({ prefix, sig, nonce: 0, elapsedMs: 1000, ip: VECTOR_IP });
    expect(result).toEqual({ ok: false, reason: "challenge from the future" });
  });

  it("签名有效但超过 10 分钟有效期 → challenge expired", async () => {
    const { prefix, sig } = await signPayload({
      cid: "cid",
      iph: hashIp(VECTOR_IP, VECTOR_SECRET),
      iat: Date.now() - (10 * 60 * 1000 + 1000),
    });
    const result = await verifySolution({ prefix, sig, nonce: 0, elapsedMs: 1000, ip: VECTOR_IP });
    expect(result).toEqual({ ok: false, reason: "challenge expired" });
  });

  it("TTL 内（1 分钟前签发）的挑战仍参与难度判断，不会被误判过期", async () => {
    const now = Date.now();
    const { prefix, sig } = await signPayload({
      cid: "cid-boundary",
      iph: hashIp(VECTOR_IP, VECTOR_SECRET),
      iat: now - 60_000,
    });
    // 直接跳到 TTL 边界之前：应继续进入难度判断（这里用难度 26 保证不是 ok）
    await setSetting("comment_verify_difficulty", "26");
    const result = await verifySolution({ prefix, sig, nonce: 0, elapsedMs: 1000, ip: VECTOR_IP });
    expect(result).toEqual({ ok: false, reason: "insufficient work" });
    await setSetting("comment_verify_difficulty", "8");
  });
});

describe("utils/verify — 票据签发与校验", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
  });

  it("票据有效期常量为 300 秒（5 分钟）", () => {
    expect(TICKET_TTL_SECONDS).toBe(300);
  });

  it("自己签发的票据可通过校验", async () => {
    const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
    expect(ticket).toContain(".");
    expect(await verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)).toBe(true);
  });

  it("票据绑定 IP：换 IP 无效", async () => {
    const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
    expect(await verifyTicket(ticket, "10.0.0.1", VECTOR_SLUG)).toBe(false);
  });

  it("票据绑定文章：换 slug 无效", async () => {
    const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
    expect(await verifyTicket(ticket, VECTOR_IP, "/posts/other")).toBe(false);
  });

  it("票据被篡改即无效", async () => {
    const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
    expect(await verifyTicket(`${ticket.slice(0, -4)}aaaa`, VECTOR_IP, VECTOR_SLUG)).toBe(false);
  });

  it("空票据、undefined、无分隔符、分隔符在首位的票据都无效", async () => {
    expect(await verifyTicket("", VECTOR_IP, VECTOR_SLUG)).toBe(false);
    expect(await verifyTicket(undefined, VECTOR_IP, VECTOR_SLUG)).toBe(false);
    expect(await verifyTicket("nodot", VECTOR_IP, VECTOR_SLUG)).toBe(false);
    expect(await verifyTicket(".sigonly", VECTOR_IP, VECTOR_SLUG)).toBe(false);
    // 载荷合法但签名缺失
    const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
    expect(await verifyTicket(`${ticket.split(".")[0]}.`, VECTOR_IP, VECTOR_SLUG)).toBe(false);
  });

  it("签名有效但载荷不是 JSON → 无效", async () => {
    const body = b64url("not-json");
    expect(await verifyTicket(`${body}.${hmacLocal(body, VECTOR_SECRET)}`, VECTOR_IP, VECTOR_SLUG)).toBe(
      false
    );
  });

  it("载荷版本号不为 1 → 无效", async () => {
    const body = b64url(
      JSON.stringify({
        v: 2,
        iph: hashIp(VECTOR_IP, VECTOR_SECRET),
        slug: VECTOR_SLUG,
        iat: Date.now(),
        exp: Date.now() + 60_000,
        jti: "x",
      })
    );
    expect(await verifyTicket(`${body}.${hmacLocal(body, VECTOR_SECRET)}`, VECTOR_IP, VECTOR_SLUG)).toBe(
      false
    );
  });

  it("exp 缺失或非数字 → 无效", async () => {
    for (const exp of [undefined, "soon"]) {
      const body = b64url(
        JSON.stringify({
          v: 1,
          iph: hashIp(VECTOR_IP, VECTOR_SECRET),
          slug: VECTOR_SLUG,
          iat: Date.now(),
          exp,
          jti: "x",
        })
      );
      expect(
        await verifyTicket(`${body}.${hmacLocal(body, VECTOR_SECRET)}`, VECTOR_IP, VECTOR_SLUG)
      ).toBe(false);
    }
  });

  it("签名合法但已过期的票据无效", async () => {
    const body = b64url(
      JSON.stringify({
        v: 1,
        iph: hashIp(VECTOR_IP, VECTOR_SECRET),
        slug: VECTOR_SLUG,
        iat: Date.now() - 10 * 60 * 1000,
        exp: Date.now() - 1000,
        jti: "x",
      })
    );
    expect(await verifyTicket(`${body}.${hmacLocal(body, VECTOR_SECRET)}`, VECTOR_IP, VECTOR_SLUG)).toBe(
      false
    );
  });

  it("TTL 内有效、超过 TTL 失效（时钟冻结）", async () => {
    const start = Date.now();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(start);
      const ticket = await createTicket(VECTOR_IP, VECTOR_SLUG);
      expect(await verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)).toBe(true);

      spy.mockReturnValue(start + 4 * 60 * 1000);
      expect(await verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)).toBe(true);

      spy.mockReturnValue(start + 5 * 60 * 1000 + 1);
      expect(await verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("utils/verify — 配置读取", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
  });

  it("getDifficulty 未配置时使用默认 18", async () => {
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'comment_verify_difficulty'`);
    expect(await getDifficulty()).toBe(18);
  });

  it("getDifficulty 非法值回退默认 18，合法值原样返回", async () => {
    await setSetting("comment_verify_difficulty", "abc");
    expect(await getDifficulty()).toBe(18);
    await setSetting("comment_verify_difficulty", "12");
    expect(await getDifficulty()).toBe(12);
  });

  it("isVerifyEnabled 仅在值为字符串 true 时开启", async () => {
    await setSetting("comment_verify_enabled", "TRUE");
    expect(await isVerifyEnabled()).toBe(false);
    await setSetting("comment_verify_enabled", "true");
    expect(await isVerifyEnabled()).toBe(true);
    await setSetting("comment_verify_enabled", "false");
    expect(await isVerifyEnabled()).toBe(false);
  });

  it("开启后公开配置下发按文章派生的蜜罐字段", async () => {
    await setSetting("comment_verify_enabled", "true");
    const config = await getPublicVerifyConfig(VECTOR_SLUG);
    expect(config.verify_enabled).toBe("true");
    expect(config.verify_honeypot).toBe(VECTOR_HONEYPOT);
    expect(await getSetting("comment_verify_secret")).toBe(VECTOR_SECRET);
  });
});
