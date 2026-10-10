#!/usr/bin/env node
/**
 * dist 产物冒烟测试
 *
 * 为什么需要它：vitest 用 ESM 转换执行 TS，与 `tsc` 产出的 CommonJS 并不等价。
 * 已经踩过一次：局部变量命名为 `exports` 会遮蔽 CommonJS 的模块 `exports` 对象，
 * 导致同文件内 `exports.XXX` 全部变成 undefined——测试全绿，但 `dist` 一跑就崩。
 *
 * 因此每次改动验证相关代码后，除了 `pnpm test`，还应跑：
 *   pnpm test:dist
 *
 * 当前覆盖：HashWX 官方 KAT + 完整挑战往返。
 */

const path = require("path");

const distPath = path.resolve(__dirname, "..", "dist", "utils", "hashwx.js");

let hashwx;
try {
  hashwx = require(distPath);
} catch (e) {
  console.error(`[smoke-dist] 无法加载 ${distPath}，请先执行 pnpm build`);
  console.error(e);
  process.exit(1);
}

function seedOf(text) {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text));
  return out;
}

const KAT = [
  ["seed1 / counter=0", seedOf("This is a test seed for hashwx"), 0n, 0x973684176f8ee362n],
  ["seed1 / counter=123456", seedOf("This is a test seed for hashwx"), 123456n, 0x401983bb07d69b07n],
  ["seed2 / counter=123456", seedOf("Lorem ipsum dolor sit amet"), 123456n, 0x4af38d834a9a8d3dn],
  ["seed2 / counter=987654321123456789", seedOf("Lorem ipsum dolor sit amet"), 987654321123456789n, 0x6a8a5514432e17a3n],
];

let failed = 0;

for (const [label, seed, nonce, expected] of KAT) {
  let actual;
  try {
    actual = hashwx.hashwxHash(seed, nonce);
  } catch (e) {
    console.log(`FAIL  ${label}  抛出异常: ${e.message}`);
    failed++;
    continue;
  }
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} got=0x${actual.toString(16).padStart(16, "0")}`
  );
}

// 端到端往返：签发 -> 解题 -> 校验（难度取小值，保证脚本秒级完成）
const spec = hashwx.mintHashwxSpec({ difficulty: 1200, count: 3 });
const challenge = Buffer.from(spec.c, "hex");
const target = hashwx.hashwxTarget(spec.d);
const nonces = [];

for (let i = 0; i < spec.count; i++) {
  let nonce = 0n;
  for (;;) {
    const seed = hashwx.hashwxBlockSeed(challenge, i, nonce / BigInt(spec.n));
    if (hashwx.hashwxHash(seed, nonce) <= target) break;
    nonce++;
    if (nonce > 5_000_000n) {
      console.error(`[smoke-dist] 子挑战 ${i} 求解超限`);
      process.exit(1);
    }
  }
  nonces.push(nonce.toString());
}

const roundTrip = hashwx.verifyHashwxSolutions(spec, nonces);
if (roundTrip.ok !== true) {
  console.log(`FAIL  挑战往返校验  ${JSON.stringify(roundTrip)}`);
  failed++;
} else {
  console.log(`PASS  挑战往返校验  nonces=[${nonces.join(", ")}]`);
}

console.log(failed === 0 ? "\n[smoke-dist] 全部通过" : `\n[smoke-dist] ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
