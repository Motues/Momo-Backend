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
  VERIFY_PROTOCOL_VERSION,
  TICKET_TTL_SECONDS,
} from "../src/utils/verify";
import { hashwxHash, hashwxTarget, hashwxBlockSeed, type HashwxSpec } from "../src/utils/hashwx";

/* ------------------------------------------------------------------ *
 * 跨语言固定向量（协议 v2）
 *
 * ⚠️ 这批向量已经重算为 v2 口径（载荷带 v 字段、票据 v=2、工作量证明换成 HashWX）。
 * Go 端（go/internal/pkg/utils/verify_consistency_test.go、verify_vectors_test.go）
 * 与 Worker 端（worker/test/unit/verify.test.ts、verifyCrypto.test.ts）
 * **目前仍是 v1 实现与 v1 向量**，尚未同步为 v2——那是后续阶段的独立改动。
 * 三端同步完成后，本文件的向量必须与这两端逐字节一致。
 *
 * 向量一旦变化就说明口径漂移，必须先确认实现改动的正确性再重算，绝不放宽。
 * ------------------------------------------------------------------ */
const VECTOR_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";
const VECTOR_IP = "::ffff:127.0.0.1";
const VECTOR_SLUG = "/posts/vector-check";
const VECTOR_IP_HASH = "20fa49e706f48b01";
const VECTOR_HONEYPOT = "v_77dc2477f6";
const VECTOR_CID = "dGVzdC1jaGFsbGVuZ2U";
const VECTOR_IAT = 1730000000000;
// 挑战载荷的字段顺序固定为 v / cid / iph / slug / iat —— slug 是被签名的，
// 挑战因此绑定到 VECTOR_SLUG 这篇文章，换文章兑换必须被拒（reason: slug mismatch）
const VECTOR_PAYLOAD_JSON =
  '{"v":2,"cid":"dGVzdC1jaGFsbGVuZ2U","iph":"20fa49e706f48b01","slug":"/posts/vector-check","iat":1730000000000}';
const VECTOR_PREFIX =
  "eyJ2IjoyLCJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsInNsdWciOiIvcG9zdHMvdmVjdG9yLWNoZWNrIiwiaWF0IjoxNzMwMDAwMDAwMDAwfQ";
const VECTOR_SIG = "vx10Bbrzk4OmSi4ERsiNaUe7rpi--iYlR7aaujSdvHY";

/**
 * 由（密钥, cid）确定性派生的 HashWX 挑战：SHA256("hashwx:C:" + secret + ":" + cid)。
 * 这个值不参与签名（prefix 载荷里没有它），但服务端校验时会独立重算，
 * 因此把它与下面的解一起钉死，等于同时钉住了「派生规则 + HashWX 口径」。
 */
const VECTOR_DERIVED_C = "a099cea92cd4121011dcba68e899b38a9dc83651fb238d5634c81b88ecc845bd";
/** 对应 difficulty=1000（子挑战 d=250）、n=65536、count=4 的合法解 */
const VECTOR_NONCES = ["5", "746", "41", "176"];

const VECTOR_TICKET_IAT = 1730000000000;
const VECTOR_TICKET_EXP = 1730000300000;
const VECTOR_TICKET_JTI = "dGVzdC1qdGk";
const VECTOR_TICKET_JSON =
  '{"v":2,"iph":"20fa49e706f48b01","slug":"/posts/vector-check","iat":1730000000000,"exp":1730000300000,"jti":"dGVzdC1qdGk"}';
const VECTOR_TICKET_BODY =
  "eyJ2IjoyLCJpcGgiOiIyMGZhNDllNzA2ZjQ4YjAxIiwic2x1ZyI6Ii9wb3N0cy92ZWN0b3ItY2hlY2siLCJpYXQiOjE3MzAwMDAwMDAwMDAsImV4cCI6MTczMDAwMDMwMDAwMCwianRpIjoiZEdWemRDMXFkR2sifQ";
const VECTOR_TICKET_SIG = "gY6N_usmwrL_g5AUoVCFTFEqOrybEomwuq7QzaP4XKs";

/**
 * HashWX 固定向量（取代 v1 的「SHA256(prefix:nonce) 前导 0 比特数」用例）。
 * C 取 0x00..0x1f，与 utils.hashwx.test.ts 的固定向量保持同一批数据。
 */
const VECTOR_HASHWX_C = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const VECTOR_HASHWX_SEED_I0_B0 =
  "e601ef8605dccfe5d026eda2937496fa094ecd4e8911175fc8c8f84bbef0777f";
const VECTOR_HASHWX_HASH_I0_N0 = 0xc156fc97050bb949n;

/** 测试统一使用很小的难度，避免纯解释模式的 HashWX 让用例变慢 */
const TEST_DIFFICULTY = "1000";
/** 总难度 1000 按 count=4 均分后的子挑战难度 */
const TEST_SUB_DIFFICULTY = 250;

/** 与被测实现同算法的本地副本，用于钉住口径（Go / Worker 侧测试同样自行计算） */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacLocal(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

function fromB64url(input: string): string {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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

/**
 * 本地求解 HashWX（与服务端 verifyHashwxSolutions 同口径），
 * 返回每个子挑战的 nonce 十进制字符串。
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

describe("utils/verify — 默认关闭态", () => {
  it("默认不开启人机验证", async () => {
    expect(await isVerifyEnabled()).toBe(false);
  });

  it("关闭时公开配置返回 false/空蜜罐字段，且不生成密钥（零副作用）", async () => {
    const config = await getPublicVerifyConfig("/posts/a");
    expect(config).toEqual({
      verify_enabled: "false",
      verify_honeypot: "",
      verify_version: String(VERIFY_PROTOCOL_VERSION),
    });
    expect(await getSetting("comment_verify_secret")).toBeNull();
  });
});

describe("utils/verify — 跨语言固定向量（协议 v2）", () => {
  beforeAll(async () => {
    // 必须在任何会触发 getSecret() 的调用之前写入固定密钥（密钥有模块级缓存）
    await setSetting("comment_verify_secret", VECTOR_SECRET);
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);
  });

  it("协议版本常量为 2", () => {
    expect(VERIFY_PROTOCOL_VERSION).toBe(2);
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

  it("base64url 与 v2 载荷口径一致（字段顺序 v/cid/iph/slug/iat）", () => {
    expect(b64url(VECTOR_PAYLOAD_JSON)).toBe(VECTOR_PREFIX);
    expect(fromB64url(VECTOR_PREFIX)).toBe(VECTOR_PAYLOAD_JSON);
    // 字段顺序会影响签名字节，必须逐字节钉死
    expect(fromB64url(VECTOR_PREFIX).indexOf('"v":2')).toBe(1);
    expect(JSON.parse(fromB64url(VECTOR_PREFIX))).toEqual({
      v: 2,
      cid: VECTOR_CID,
      iph: VECTOR_IP_HASH,
      slug: VECTOR_SLUG,
      iat: VECTOR_IAT,
    });
  });

  it("prefix 签名 = base64url(HMAC-SHA256(prefix, secret))", () => {
    expect(hmacLocal(VECTOR_PREFIX, VECTOR_SECRET)).toBe(VECTOR_SIG);
  });

  it("HashWX 固定向量：种子派生与哈希值（取代 v1 的前导 0 比特用例）", () => {
    const challenge = Buffer.from(VECTOR_HASHWX_C, "hex");

    // 种子口径：SHA256(C ‖ u8le(index) ‖ u64le(block))
    expect(hashwxBlockSeed(challenge, 0, 0n).toString("hex")).toBe(VECTOR_HASHWX_SEED_I0_B0);

    // 哈希口径：拿固定种子对固定 nonce 求值
    const hash = hashwxHash(hashwxBlockSeed(challenge, 0, 0n), 0n);
    expect(hash).toBe(VECTOR_HASHWX_HASH_I0_N0);

    // 与 target 的关系：目标阈值 U64_MAX / d
    expect(hashwxTarget(1000)).toBe(18446744073709551n);
    expect(hashwxTarget(100000)).toBe(184467440737095n);
    expect(hash <= hashwxTarget(1000)).toBe(false);
    expect(hash <= hashwxTarget(100000)).toBe(false);
  });

  it("固定向量能通过签名/IP/时效/HashWX 全链路校验（证明各端口径未漂移）", async () => {
    // iat=1730000000000 是过去时间，冻结时钟到其后 1 秒内才不算过期
    const result = await withFrozenNow(VECTOR_IAT + 1000, () =>
      verifySolution({
        prefix: VECTOR_PREFIX,
        sig: VECTOR_SIG,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: VECTOR_IP,
      
        postSlug: VECTOR_SLUG,
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it("固定向量兑换成功后同一挑战不可再次兑换（挑战单次使用）", async () => {
    const result = await withFrozenNow(VECTOR_IAT + 2000, () =>
      verifySolution({
        prefix: VECTOR_PREFIX,
        sig: VECTOR_SIG,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: VECTOR_IP,
      
        postSlug: VECTOR_SLUG,
      })
    );
    expect(result).toEqual({ ok: false, reason: "challenge already used" });
  });

  it("固定向量遇到不同 IP 返回 ip mismatch", async () => {
    const result = await withFrozenNow(VECTOR_IAT + 1000, () =>
      verifySolution({
        prefix: VECTOR_PREFIX,
        sig: VECTOR_SIG,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: "10.0.0.1",
      
        postSlug: VECTOR_SLUG,
      })
    );
    expect(result).toEqual({ ok: false, reason: "ip mismatch" });
  });

  it("签名字节被篡改即拒绝", async () => {
    const tampered = `${VECTOR_SIG.slice(0, -1)}X`;
    const result = await verifySolution({
      prefix: VECTOR_PREFIX,
      sig: tampered,
      nonces: VECTOR_NONCES,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("真实时间下固定向量已过期（说明签名先于时效通过）", async () => {
    const result = await verifySolution({
      prefix: VECTOR_PREFIX,
      sig: VECTOR_SIG,
      nonces: VECTOR_NONCES,
      elapsedMs: 1000,
      ip: VECTOR_IP,
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "challenge expired" });
  });

  it("v1 载荷（无 v 字段 / v=1）返回 PROTOCOL_OUTDATED 而不是「答案算错」", async () => {
    const iph = hashIp(VECTOR_IP, VECTOR_SECRET);
    const now = Date.now();

    // v1 载荷没有 v 字段
    const v1 = await signPayload({ cid: "v1-cid", iph, iat: now });
    expect(
      await verifySolution({
        prefix: v1.prefix,
        sig: v1.sig,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: VECTOR_IP,
      
        postSlug: VECTOR_SLUG,
      })
    ).toEqual({ ok: false, reason: "PROTOCOL_OUTDATED" });

    // 显式 v=1 同样拒绝
    const explicit = await signPayload({ v: 1, cid: "v1-cid-2", iph, iat: now });
    expect(
      await verifySolution({
        prefix: explicit.prefix,
        sig: explicit.sig,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: VECTOR_IP,
      
        postSlug: VECTOR_SLUG,
      })
    ).toEqual({ ok: false, reason: "PROTOCOL_OUTDATED" });

    // 协议版本判定先于 IP / 时效 / 算力：IP 不对也必须先报版本不匹配
    expect(
      await verifySolution({
        prefix: v1.prefix,
        sig: v1.sig,
        nonces: VECTOR_NONCES,
        elapsedMs: 1000,
        ip: "10.0.0.1",
      
        postSlug: VECTOR_SLUG,
      })
    ).toEqual({ ok: false, reason: "PROTOCOL_OUTDATED" });
  });
});

describe("utils/verify — 挑战签发与答案校验", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);
  });

  it("createChallenge 返回结构正确的 v2 挑战", async () => {
    const challenge = await createChallenge(VECTOR_IP, VECTOR_SLUG);

    expect(challenge.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 字节 base64url
    expect(challenge.expires_in).toBe(600); // 10 分钟
    expect(hmacLocal(challenge.prefix, VECTOR_SECRET)).toBe(challenge.sig);

    // 工作量证明参数：HashWX，总难度 1000 均分到 4 个子挑战
    expect(challenge.pow.algo).toBe("hashwx");
    expect(challenge.pow.c).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.pow.d).toBe(TEST_SUB_DIFFICULTY);
    expect(challenge.pow.n).toBe(65536);
    expect(challenge.pow.count).toBe(4);

    const payload = JSON.parse(fromB64url(challenge.prefix));
    expect(payload.v).toBe(VERIFY_PROTOCOL_VERSION);
    expect(payload.iph).toBe(hashIp(VECTOR_IP, VECTOR_SECRET));
    expect(payload.cid).toBe(challenge.challenge_id);
    expect(Math.abs(Date.now() - payload.iat)).toBeLessThan(5000);
  });

  it("挑战参数由（密钥, cid）确定性派生：同 cid 必然同 c", async () => {
    // 派生规则本身也钉死：本地按同一口径重算固定向量
    expect(
      crypto.createHash("sha256").update(`hashwx:C:${VECTOR_SECRET}:${VECTOR_CID}`, "utf8").digest("hex")
    ).toBe(VECTOR_DERIVED_C);

    // 不同挑战的 cid 不同 => c 不同（挑战不落在签名载荷里，靠 cid 派生保证唯一）
    const first = await createChallenge(VECTOR_IP, VECTOR_SLUG);
    const second = await createChallenge(VECTOR_IP, VECTOR_SLUG);
    expect(first.challenge_id).not.toBe(second.challenge_id);
    expect(first.pow.c).not.toBe(second.pow.c);
  });

  it("正确解答通过校验，同一挑战二次兑换被拒（挑战单次使用）", async () => {
    const challenge = await createChallenge("198.51.100.1", VECTOR_SLUG);
    const nonces = solveHashwx(challenge.pow);

    const first = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonces,
      elapsedMs: 1000,
      ip: "198.51.100.1",
    
      postSlug: VECTOR_SLUG,
    });
    expect(first).toEqual({ ok: true });

    const replay = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonces,
      elapsedMs: 1000,
      ip: "198.51.100.1",
    
      postSlug: VECTOR_SLUG,
    });
    expect(replay).toEqual({ ok: false, reason: "challenge already used" });
  });

  it("换一个 IP 使用同一挑战被拒", async () => {
    const challenge = await createChallenge("198.51.100.2", VECTOR_SLUG);
    const nonces = solveHashwx(challenge.pow);
    const result = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonces,
      elapsedMs: 1000,
      ip: "198.51.100.3",
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "ip mismatch" });
  });

  it("缺少 prefix 或 sig 直接拒绝", async () => {
    const params = { prefix: "", sig: "", nonces: VECTOR_NONCES, elapsedMs: 1000, ip: VECTOR_IP };
    expect(await verifySolution(params)).toEqual({ ok: false, reason: "missing challenge" });
    expect(await verifySolution({ ...params, prefix: "abc" ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "missing challenge",
    });
  });

  it("解答耗时过低/过高/非数字都视为脚本", async () => {
    const challenge = await createChallenge("198.51.100.4", VECTOR_SLUG);
    const nonces = solveHashwx(challenge.pow);
    const base = { prefix: challenge.prefix, sig: challenge.sig, nonces, ip: "198.51.100.4" };

    // MIN_SOLVE_MS = 50：49 视为物理上不可能
    expect(await verifySolution({ ...base, elapsedMs: 49 ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "implausible timing",
    });
    expect(await verifySolution({ ...base, elapsedMs: 10 * 60 * 1000 + 1 ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "implausible timing",
    });
    expect(await verifySolution({ ...base, elapsedMs: Number.NaN ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "implausible timing",
    });

    // 时序被拒不会消耗挑战，因此边界值 50 仍然可以正常兑换
    expect(await verifySolution({ ...base, elapsedMs: 50 ,
      postSlug: VECTOR_SLUG,
    })).toEqual({ ok: true });
  });

  it("nonces 数量不匹配 / 非数组被拒", async () => {
    const challenge = await createChallenge("198.51.100.5", VECTOR_SLUG);
    const base = { prefix: challenge.prefix, sig: challenge.sig, elapsedMs: 1000, ip: "198.51.100.5" };

    expect(await verifySolution({ ...base, nonces: undefined ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
    expect(await verifySolution({ ...base, nonces: "nope" ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
    expect(await verifySolution({ ...base, nonces: ["1", "2", "3"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
    expect(await verifySolution({ ...base, nonces: ["1", "2", "3", "4", "5"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
  });

  it("nonces 元素为负数 / 非整数 / 畸形字符串时拒绝", async () => {
    const challenge = await createChallenge("198.51.100.6", VECTOR_SLUG);
    const base = { prefix: challenge.prefix, sig: challenge.sig, elapsedMs: 1000, ip: "198.51.100.6" };

    // 坏值必须放在第 0 位：校验逐个子挑战短路返回，放后面会被「算力不足」先拦下
    expect(await verifySolution({ ...base, nonces: [-1, "2", "3", "4"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "bad nonce",
    });
    expect(await verifySolution({ ...base, nonces: [1.5, "2", "3", "4"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "bad nonce",
    });
    expect(await verifySolution({ ...base, nonces: [Number.NaN, "2", "3", "4"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "bad nonce",
    });
    expect(await verifySolution({ ...base, nonces: ["0x10", "2", "3", "4"] ,
      postSlug: VECTOR_SLUG,
    })).toEqual({
      ok: false,
      reason: "bad nonce",
    });
  });

  it("工作量不足时拒绝", async () => {
    // 难度放大到 100 万（子挑战 d=250000），nonce 全 0 必然算力不足
    await setSetting("comment_verify_difficulty", "1000000");
    const challenge = await createChallenge("198.51.100.7", VECTOR_SLUG);
    expect(challenge.pow.d).toBe(250000);

    const result = await verifySolution({
      prefix: challenge.prefix,
      sig: challenge.sig,
      nonces: ["0", "0", "0", "0"],
      elapsedMs: 1000,
      ip: "198.51.100.7",
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "insufficient work" });

    await setSetting("comment_verify_difficulty", TEST_DIFFICULTY);
  });

  it("prefix 被篡改（签名失效）即拒绝", async () => {
    const challenge = await createChallenge("198.51.100.8", VECTOR_SLUG);
    const tampered = `${challenge.prefix.slice(0, -1)}A`;
    const result = await verifySolution({
      prefix: tampered,
      sig: challenge.sig,
      nonces: ["0", "0", "0", "0"],
      elapsedMs: 1000,
      ip: "198.51.100.8",
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("签名有效但载荷不是 JSON → malformed prefix", async () => {
    const secret = (await getSetting("comment_verify_secret")) as string;
    const badPrefix = b64url("not-json-at-all");
    const result = await verifySolution({
      prefix: badPrefix,
      sig: hmacLocal(badPrefix, secret),
      nonces: ["0", "0", "0", "0"],
      elapsedMs: 1000,
      ip: VECTOR_IP,
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "malformed prefix" });
  });

  it("签名有效但载荷缺字段或不是对象 → malformed payload", async () => {
    for (const payload of [{ v: 2, cid: "x" }, { v: 2, iph: VECTOR_IP_HASH }, null, 123]) {
      const { prefix, sig } = await signPayload(payload);
      const result = await verifySolution({
        prefix,
        sig,
        nonces: ["0", "0", "0", "0"],
        elapsedMs: 1000,
        ip: VECTOR_IP,
      
        postSlug: VECTOR_SLUG,
      });
      expect(result).toEqual({ ok: false, reason: "malformed payload" });
    }
  });

  it("签名有效但时间戳来自未来 → challenge from the future", async () => {
    const { prefix, sig } = await signPayload({
      v: 2,
      cid: "cid-future",
      iph: hashIp(VECTOR_IP, VECTOR_SECRET),
      slug: VECTOR_SLUG,
      iat: Date.now() + 120_000,
    });
    const result = await verifySolution({
      prefix,
      sig,
      nonces: ["0", "0", "0", "0"],
      elapsedMs: 1000,
      ip: VECTOR_IP,
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "challenge from the future" });
  });

  it("签名有效但超过 10 分钟有效期 → challenge expired", async () => {
    const { prefix, sig } = await signPayload({
      v: 2,
      cid: "cid-expired",
      iph: hashIp(VECTOR_IP, VECTOR_SECRET),
      slug: VECTOR_SLUG,
      iat: Date.now() - (10 * 60 * 1000 + 1000),
    });
    const result = await verifySolution({
      prefix,
      sig,
      nonces: ["0", "0", "0", "0"],
      elapsedMs: 1000,
      ip: VECTOR_IP,
    
      postSlug: VECTOR_SLUG,
    });
    expect(result).toEqual({ ok: false, reason: "challenge expired" });
  });

  it("TTL 边界：未过期仍能兑换，过期即拒绝（时钟冻结）", async () => {
    // 未过期：冻结到签发后 10 分钟减 1 毫秒
    const fresh = await createChallenge("198.51.100.9", VECTOR_SLUG);
    const freshPayload = JSON.parse(fromB64url(fresh.prefix));
    const nonces = solveHashwx(fresh.pow);
    expect(
      await withFrozenNow(freshPayload.iat + 10 * 60 * 1000 - 1, () =>
        verifySolution({
          prefix: fresh.prefix,
          sig: fresh.sig,
          nonces,
          elapsedMs: 1000,
          ip: "198.51.100.9",
        
          postSlug: VECTOR_SLUG,
        })
      )
    ).toEqual({ ok: true });

    // 已过期：冻结到签发后 10 分钟加 1 毫秒
    const stale = await createChallenge("198.51.100.10", VECTOR_SLUG);
    const stalePayload = JSON.parse(fromB64url(stale.prefix));
    expect(
      await withFrozenNow(stalePayload.iat + 10 * 60 * 1000 + 1, () =>
        verifySolution({
          prefix: stale.prefix,
          sig: stale.sig,
          nonces: solveHashwx(stale.pow),
          elapsedMs: 1000,
          ip: "198.51.100.10",
        
          postSlug: VECTOR_SLUG,
        })
      )
    ).toEqual({ ok: false, reason: "challenge expired" });
  });
});

describe("utils/verify — 票据签发与校验", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
  });

  it("票据有效期常量为 300 秒（5 分钟）", () => {
    expect(TICKET_TTL_SECONDS).toBe(300);
  });

  it("跨语言固定向量：票据 body 与签名", () => {
    expect(b64url(VECTOR_TICKET_JSON)).toBe(VECTOR_TICKET_BODY);
    expect(hmacLocal(VECTOR_TICKET_BODY, VECTOR_SECRET)).toBe(VECTOR_TICKET_SIG);
    // 字段顺序 v/iph/slug/iat/exp/jti 会影响签名字节，必须逐字节钉死
    expect(JSON.parse(fromB64url(VECTOR_TICKET_BODY))).toEqual({
      v: 2,
      iph: VECTOR_IP_HASH,
      slug: VECTOR_SLUG,
      iat: VECTOR_TICKET_IAT,
      exp: VECTOR_TICKET_EXP,
      jti: VECTOR_TICKET_JTI,
    });
  });

  it("固定向量票据在有效期内通过、过期后失效（证明票据口径未漂移）", async () => {
    const ticket = `${VECTOR_TICKET_BODY}.${VECTOR_TICKET_SIG}`;
    // exp 是 2024 年的时间点，冻结到有效期内
    expect(
      await withFrozenNow(VECTOR_TICKET_IAT + 1000, () =>
        verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)
      )
    ).toBe(true);
    expect(
      await withFrozenNow(VECTOR_TICKET_EXP + 1, () => verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG))
    ).toBe(false);
    // 真实时间下早已过期
    expect(await verifyTicket(ticket, VECTOR_IP, VECTOR_SLUG)).toBe(false);
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

  it("v1 票据（v=1）一律拒绝，其他版本号同样拒绝", async () => {
    for (const v of [1, 3, undefined, "2", null]) {
      const body = b64url(
        JSON.stringify({
          v,
          iph: hashIp(VECTOR_IP, VECTOR_SECRET),
          slug: VECTOR_SLUG,
          slug: VECTOR_SLUG,
          iat: Date.now(),
          exp: Date.now() + 60_000,
          jti: "x",
        })
      );
      expect(
        await verifyTicket(`${body}.${hmacLocal(body, VECTOR_SECRET)}`, VECTOR_IP, VECTOR_SLUG)
      ).toBe(false);
    }
  });

  it("exp 缺失或非数字 → 无效", async () => {
    for (const exp of [undefined, "soon"]) {
      const body = b64url(
        JSON.stringify({
          v: 2,
          iph: hashIp(VECTOR_IP, VECTOR_SECRET),
          slug: VECTOR_SLUG,
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
        v: 2,
        iph: hashIp(VECTOR_IP, VECTOR_SECRET),
        slug: VECTOR_SLUG,
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

  it("getDifficulty 未配置时使用默认总工作量 1000000", async () => {
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'comment_verify_difficulty'`);
    expect(await getDifficulty()).toBe(1_000_000);
  });

  it("getDifficulty 非法值回退默认，合法值原样返回", async () => {
    for (const raw of ["abc", "", "0", "-5"]) {
      await setSetting("comment_verify_difficulty", raw);
      expect(await getDifficulty()).toBe(1_000_000);
    }
    await setSetting("comment_verify_difficulty", "1000");
    expect(await getDifficulty()).toBe(1000);
    await setSetting("comment_verify_difficulty", "512000");
    expect(await getDifficulty()).toBe(512000);
  });

  it("getDifficulty 兼容 v1 历史配置：≤26 按 2^值 迁移为总工作量", async () => {
    // v1 语义是「前导 0 比特数」，8 位约等于 256 次哈希，低于下限后被钳到 1000
    await setSetting("comment_verify_difficulty", "8");
    expect(await getDifficulty()).toBe(1000);
    // 12 位 => 4096 次，高于下限，原样迁移
    await setSetting("comment_verify_difficulty", "12");
    expect(await getDifficulty()).toBe(4096);
    // 12abc 走 parseInt，与 v1 的容错口径一致
    await setSetting("comment_verify_difficulty", "12abc");
    expect(await getDifficulty()).toBe(4096);
    // dashboard 的「高」档：20 位 => 1048576 次，原样迁移（这也是迁移上限）
    await setSetting("comment_verify_difficulty", "20");
    expect(await getDifficulty()).toBe(1_048_576);
    // 21–26 位换算后是 209 万–6710 万次：在 v1 时代那本就是分钟级谜题（纯 JS 挖这么多次），
    // 因此统一钳到最高档，避免升级后把访客卡住。
    await setSetting("comment_verify_difficulty", "21");
    expect(await getDifficulty()).toBe(1_048_576);
    await setSetting("comment_verify_difficulty", "26");
    expect(await getDifficulty()).toBe(1_048_576);
    // 27 已超出 v1 取值上界，按新语义当作总工作量 27，被下限钳到 1000
    await setSetting("comment_verify_difficulty", "27");
    expect(await getDifficulty()).toBe(1000);
  });

  it("getDifficulty 上下限：低于 1000 钳到 1000，高于 1e9 钳到 1e9", async () => {
    await setSetting("comment_verify_difficulty", "999");
    expect(await getDifficulty()).toBe(1000);
    await setSetting("comment_verify_difficulty", "1000000000");
    expect(await getDifficulty()).toBe(1_000_000_000);
    await setSetting("comment_verify_difficulty", "1000000001");
    expect(await getDifficulty()).toBe(1_000_000_000);
    await setSetting("comment_verify_difficulty", "999999999999");
    expect(await getDifficulty()).toBe(1_000_000_000);
  });

  it("getDifficulty：0 / 负数 / 非数字都退回默认强度（而不是退到下限）", async () => {
    // 口径说明（三端必须一致）：
    // 值为 0、负数或解析不出数字时，视为**配置无效**，返回默认强度 1000000；
    // 只有「合法的正整数但低于下限」才钳到 MIN_TOTAL_WORK（1000）。
    //
    // 这样选的原因：把损坏的配置（例如被误写成 "0"）退到下限 1000 几乎等于关掉防护，
    // 而退回默认强度是安全的失败方向。注意 "8" 属于「合法的旧语义值」，
    // 会先按 2^8 迁移成 256，再因为低于下限被钳到 1000 —— 与上面这条规则不同。
    const DEFAULT = 1_000_000;

    for (const raw of ["0", "-5", "-1", "abc", "", "  "]) {
      await setSetting("comment_verify_difficulty", raw);
      expect(await getDifficulty(), `raw=${JSON.stringify(raw)}`).toBe(DEFAULT);
    }

    // parseInt 容忍尾部垃圾（与 v1 一致）："1.5x" 解析成 1 → 迁移成 2 → 被下限钳到 1000
    await setSetting("comment_verify_difficulty", "1.5x");
    expect(await getDifficulty()).toBe(1000);
    // 合法但低于下限 → 钳到下限
    await setSetting("comment_verify_difficulty", "999");
    expect(await getDifficulty()).toBe(1000);
    // 旧语义值 → 先迁移（2^8 = 256），再被下限钳到 1000
    await setSetting("comment_verify_difficulty", "8");
    expect(await getDifficulty()).toBe(1000);
  });

  it("isVerifyEnabled 仅在值为字符串 true 时开启", async () => {
    await setSetting("comment_verify_enabled", "TRUE");
    expect(await isVerifyEnabled()).toBe(false);
    await setSetting("comment_verify_enabled", "true");
    expect(await isVerifyEnabled()).toBe(true);
    await setSetting("comment_verify_enabled", "false");
    expect(await isVerifyEnabled()).toBe(false);
  });

  it("开启后公开配置下发按文章派生的蜜罐字段与协议版本", async () => {
    await setSetting("comment_verify_enabled", "true");
    const config = await getPublicVerifyConfig(VECTOR_SLUG);
    expect(config.verify_enabled).toBe("true");
    expect(config.verify_honeypot).toBe(VECTOR_HONEYPOT);
    expect(config.verify_version).toBe("2");
    expect(await getSetting("comment_verify_secret")).toBe(VECTOR_SECRET);
  });
});
