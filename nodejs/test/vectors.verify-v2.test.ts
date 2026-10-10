import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setSetting } from "../src/utils/settings";
import { hashIp, honeypotField, createChallenge, createTicket } from "../src/utils/verify";

/**
 * 协议 v2 的跨语言固定向量验收测试。
 *
 * fixture 由 nodejs/scripts/gen-verify-vectors.ts 生成，Go 与 Worker 的测试读同一份文件。
 * 这里在 Node 侧做两件事：
 *   1. 用**独立的本地实现**复算 fixture 里的每一个值（钉住口径本身）；
 *   2. 断言被测实现的实际输出与本地复算一致（钉住实现没有漂移）。
 *
 * 任何一端改了冒号分隔符、base64url 填充、字段顺序或派生标签，都会被这里抓住。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "verify-v2.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

/** 与实现无关的本地副本 */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hmacLocal(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}
function sha256HexLocal(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
/** base64url → UTF-8 字符串（与实现无关的本地副本） */
function fromB64url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

describe("协议 v2 跨语言固定向量（fixture 验收）", () => {
  beforeAll(async () => {
    // 固定签名密钥，必须在任何验证调用之前写入（getSecret 有模块级缓存）
    await setSetting("comment_verify_secret", fixture.secret);
  });

  afterAll(() => {
    // 不删除密钥：同文件其它用例（如果有）仍需要它保持一致
  });

  it("fixture 结构完整", () => {
    for (const key of [
      "secret",
      "ip",
      "slug",
      "cid",
      "ipHash",
      "honeypot",
      "prefix",
      "sig",
      "hashwx",
      "instrumentation",
      "ticketBody",
      "ticketSig",
    ]) {
      expect(fixture[key], `fixture 缺少 ${key}`).toBeDefined();
    }
    expect(fixture.hashwx).toMatchObject({ d: 250, n: 65536, count: 4 });
  });

  it("IP 哈希与蜜罐字段名口径未漂移", () => {
    expect(sha256HexLocal(`ip:${fixture.secret}:${fixture.ip}`).slice(0, 16)).toBe(fixture.ipHash);
    expect(`v_${sha256HexLocal(`hp:${fixture.secret}:${fixture.slug}`).slice(0, 10)}`).toBe(fixture.honeypot);

    // 被测实现必须给出同一个值
    expect(hashIp(fixture.ip, fixture.secret)).toBe(fixture.ipHash);
    expect(honeypotField(fixture.slug, fixture.secret)).toBe(fixture.honeypot);
  });

  it("挑战载荷的字段顺序与签名口径未漂移", () => {
    // 字段顺序固定为 v / cid / iph / slug / iat；slug 被签名，挑战因此绑定到该文章
    const payload = { v: 2, cid: fixture.cid, iph: fixture.ipHash, slug: fixture.slug, iat: fixture.iat };
    expect(JSON.stringify(payload)).toBe(fixture.challengePayloadJson);
    expect(b64url(fixture.challengePayloadJson)).toBe(fixture.prefix);
    expect(hmacLocal(fixture.prefix, fixture.secret)).toBe(fixture.sig);
  });

  it("票据载荷的字段顺序与签名口径未漂移", () => {
    const payload = {
      v: 2,
      iph: fixture.ipHash,
      slug: fixture.slug,
      iat: fixture.iat,
      exp: fixture.exp,
      jti: fixture.jti,
    };
    expect(JSON.stringify(payload)).toBe(fixture.ticketPayloadJson);
    expect(b64url(fixture.ticketPayloadJson)).toBe(fixture.ticketBody);
    expect(hmacLocal(fixture.ticketBody, fixture.secret)).toBe(fixture.ticketSig);
  });

  it("HashWX 挑战的派生标签与公式未漂移", () => {
    expect(sha256HexLocal(`hashwx:C:${fixture.secret}:${fixture.cid}`)).toBe(fixture.hashwx.c);
  });

  it("实测实现：createChallenge 派生的 c 与本地复算一致，且挑战绑定文章", async () => {
    // 用真实路径签发一次，再用本地公式复算 c —— 这钉住了实现里的派生标签与拼接顺序
    const challenge = await createChallenge(fixture.ip, fixture.slug);
    const expectedC = sha256HexLocal(`hashwx:C:${fixture.secret}:${challenge.challenge_id}`);

    expect(challenge.pow.algo).toBe("hashwx");
    expect(challenge.pow.c).toBe(expectedC);
    expect(challenge.pow.n).toBe(fixture.hashwx.n);
    expect(challenge.pow.count).toBe(fixture.hashwx.count);
    expect(challenge.expires_in).toBe(600);
    expect(challenge.prefix).toBeTruthy();
    expect(challenge.sig).toBe(hmacLocal(challenge.prefix, fixture.secret));

    // 载荷里必须带 slug，且等于签发时传入的文章
    const payload = JSON.parse(fromB64url(challenge.prefix));
    expect(payload.slug).toBe(fixture.slug);
  });

  it("实测实现：票据签名与本地复算一致（字段顺序 + HMAC）", async () => {
    const ticket = await createTicket(fixture.ip, fixture.slug);
    const dot = ticket.lastIndexOf(".");
    const body = ticket.slice(0, dot);
    const sig = ticket.slice(dot + 1);

    expect(sig).toBe(hmacLocal(body, fixture.secret));

    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    expect(Object.keys(payload)).toEqual(["v", "iph", "slug", "iat", "exp", "jti"]);
    expect(payload.v).toBe(2);
    expect(payload.iph).toBe(fixture.ipHash);
  });

  it("Instrumentation 程序派生与两份 fixture 自洽", () => {
    // 同一（密钥, cid）在 verify-v2.json 与 instrumentation-v2.json 里必须得到同一程序
    const instrFixturePath = path.resolve(__dirname, "..", "..", "doc", "vectors", "instrumentation-v2.json");
    const instrFixture = JSON.parse(fs.readFileSync(instrFixturePath, "utf8"));
    const sameCid = instrFixture.vectors.find((v: any) => v.cid === fixture.cid);

    expect(sameCid, `instrumentation fixture 里缺少 cid=${fixture.cid} 的向量`).toBeDefined();
    expect(fixture.instrumentation.seed).toBe(sameCid.seed);
    expect(fixture.instrumentation.ops).toEqual(sameCid.ops);
    expect(fixture.instrumentation.regs).toEqual(sameCid.regs);
  });
});
