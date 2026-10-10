#!/usr/bin/env node
/**
 * 生成协议 v2 的跨语言固定向量
 *
 * 为什么需要：协议 v2 的挑战/票据全部由（密钥, 挑战 id）派生，三端（Node / Go / Worker）
 * 必须逐字节一致。任何一处差一个冒号、一处 base64url 带上了填充、一处字段顺序不同，
 * 都会让「一端签发的挑战，另一端校验不了」。
 *
 * 生成口径刻意**在脚本里独立复算**（而不是调用实现内部的私有函数），
 * 这样 fixture 同时也是一次对实现口径的独立复核。
 *
 * 用法（在 nodejs 目录下）:
 *   npx ts-node scripts/gen-verify-vectors.ts
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { generateProgram, interpretProgram } from "../src/utils/instrumentation";

/** 与 nodejs/test/utils.verify.test.ts、go、worker 测试共用的固定值 */
const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";
const IP = "::ffff:127.0.0.1";
const SLUG = "/posts/vector-check";
const IAT = 1730000000000;
const EXP = 1730000300000;
const JTI = "dGVzdC1qdGk";
/** 与 instrumentation 固定向量的第一个 cid 相同，两份 fixture 应互相印证 */
const CID = "dmVjdG9yLTE";
/** 该难度下按 count=4 均分得到 d=250 */
const DIFFICULTY = 1000;

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

// ---- 挑战载荷：字段顺序固定为 v / cid / iph / slug / iat ----
const ipHash = sha256Hex(`ip:${SECRET}:${IP}`).slice(0, 16);
const challengePayloadJson = JSON.stringify({ v: 2, cid: CID, iph: ipHash, slug: SLUG, iat: IAT });
const prefix = b64url(challengePayloadJson);
const sig = hmac(prefix, SECRET);

// ---- 蜜罐字段名 ----
const honeypot = `v_${sha256Hex(`hp:${SECRET}:${SLUG}`).slice(0, 10)}`;

// ---- HashWX 挑战派生 ----
const challengeBytes = crypto.createHash("sha256").update(`hashwx:C:${SECRET}:${CID}`, "utf8").digest();
const count = 4;

// ---- Instrumentation 程序派生（与 instrumentation-v2.json 的第一个向量同源）----
const programSeed = crypto.createHash("sha256").update(`instr:prog:${SECRET}:${CID}`, "utf8").digest();
const program = generateProgram(programSeed);
const programResult = interpretProgram(program);
if (!programResult.ok) throw new Error("生成的程序无法被解释：这是实现缺陷");

// ---- 票据：字段顺序固定为 v / iph / slug / iat / exp / jti ----
const ticketPayloadJson = JSON.stringify({
  v: 2,
  iph: ipHash,
  slug: SLUG,
  iat: IAT,
  exp: EXP,
  jti: JTI,
});
const ticketBody = b64url(ticketPayloadJson);
const ticketSig = hmac(ticketBody, SECRET);

const payload = {
  _comment:
    "由 nodejs/scripts/gen-verify-vectors.ts 生成，请勿手工编辑。" +
    "协议 v2 的全部签名与派生口径都由这批值钉死；Node / Go / Worker 三端测试都要复算它，" +
    "任何一端漂移都会被测试抓住。",
  secret: SECRET,
  ip: IP,
  slug: SLUG,
  iat: IAT,
  exp: EXP,
  jti: JTI,
  cid: CID,
  difficulty: DIFFICULTY,

  ipHash,
  honeypot,

  challengePayloadJson,
  prefix,
  sig,

  hashwx: {
    c: challengeBytes.toString("hex"),
    d: Math.round(DIFFICULTY / count),
    n: 65536,
    count,
  },

  instrumentation: {
    seed: programSeed.toString("hex"),
    ops: program.ops,
    regs: programResult.regs,
  },

  ticketPayloadJson,
  ticketBody,
  ticketSig,
};

const outPath = path.resolve(__dirname, "..", "..", "doc", "vectors", "verify-v2.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");

console.log(`[gen-verify-vectors] 已写入 ${path.relative(process.cwd(), outPath)}`);
console.log(`  ipHash   = ${ipHash}`);
console.log(`  honeypot = ${honeypot}`);
console.log(`  prefix   = ${prefix}`);
console.log(`  sig      = ${sig}`);
console.log(`  hashwx.c = ${payload.hashwx.c}`);
console.log(`  instr    = ${program.ops.length / 3} ops -> [${programResult.regs.join(", ")}]`);
console.log(`  ticket   = ${ticketBody}.${ticketSig}`);
