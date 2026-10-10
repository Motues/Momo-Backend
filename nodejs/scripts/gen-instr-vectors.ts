#!/usr/bin/env node
/**
 * 生成 Instrumentation 的跨语言固定向量
 *
 * 为什么需要：第二层的程序由服务端生成、由客户端解释执行。服务端用「影子 DOM 模型」
 * 推算期望寄存器，客户端用真实 DOM 执行 —— 这两套解释器必须逐位等价，
 * 否则所有访客都会被判为「程序结果不匹配」。
 *
 * 本脚本把「程序 + 期望寄存器」固化成共享 fixture：
 *   doc/vectors/instrumentation-v2.json
 * Node 端与前端测试都读同一份文件并各自复算，任何一侧的语义漂移都会被测试抓住。
 *
 * 用法（在 nodejs 目录下）:
 *   npx ts-node scripts/gen-instr-vectors.ts
 */

import fs from "fs";
import path from "path";
import { generateProgram, interpretProgram } from "../src/utils/instrumentation";

/** 与服务端派生口径一致的种子构造：SHA256("instr:prog:" + secret + ":" + cid) */
import crypto from "crypto";

const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";
const CHALLENGE_IDS = ["dmVjdG9yLTE", "dmVjdG9yLTI", "dmVjdG9yLTM"];

function programSeed(challengeId: string, secret: string): Buffer {
  return crypto.createHash("sha256").update(`instr:prog:${secret}:${challengeId}`, "utf8").digest();
}

const vectors = CHALLENGE_IDS.map((cid) => {
  const seed = programSeed(cid, SECRET);
  const program = generateProgram(seed);
  const expected = interpretProgram(program);
  if (!expected.ok) throw new Error(`挑战 ${cid} 生成的程序无法被解释：这是实现缺陷`);
  return {
    cid,
    seed: seed.toString("hex"),
    ops: program.ops,
    regs: expected.regs,
  };
});

const outPath = path.resolve(__dirname, "..", "..", "doc", "vectors", "instrumentation-v2.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const payload = {
  _comment:
    "由 nodejs/scripts/gen-instr-vectors.ts 生成，请勿手工编辑。" +
    "程序由服务端从此处的 seed 派生；regs 是服务端影子模型推算的期望值。" +
    "Node 与前端测试都复算这两项，用来钉住两个解释器的语义一致。",
  secret: SECRET,
  vectors,
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(`[gen-instr-vectors] 已写入 ${path.relative(process.cwd(), outPath)}`);
for (const v of vectors) {
  console.log(`  cid=${v.cid} ops=${v.ops.length / 3} regs=[${v.regs.join(", ")}]`);
}
