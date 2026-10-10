import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  hashwxHash,
  hashwxTarget,
  hashwxBlockSeed,
  mintHashwxSpec,
  parseHashwxChallenge,
  parseHashwxNonce,
  verifyHashwxSolutions,
  HASHWX_SEED_SIZE,
  HASHWX_CHALLENGE_SIZE,
  HASHWX_DEFAULT_NONCES_PER_HASH,
  HASHWX_DEFAULT_DIFFICULTY,
  HASHWX_DEFAULT_CHALLENGE_COUNT,
  HASHWX_MAX_DIFFICULTY,
  HASHWX_MAX_NONCES_PER_HASH,
  HASHWX_MAX_CHALLENGE_COUNT,
  type HashwxSpec,
} from "../src/utils/hashwx";

/* ------------------------------------------------------------------ *
 * 官方已知答案测试（KAT）
 *
 * 来自 tevador/hashwx v1.0.0 的 src/tests.c。这四个向量是「vendor 进来的
 * wasm 确实实现了官方算法」的唯一凭据——本仓库没有 Emscripten 工具链，
 * 无法独立重建该二进制，所以这组用例必须保持存在且不可放宽。
 *
 * C 源码里 `uint8_t seed[32] = "..."` 会把剩余字节补 0。
 * ------------------------------------------------------------------ */
function seedOf(text: string): Uint8Array {
  const out = new Uint8Array(HASHWX_SEED_SIZE);
  out.set(new TextEncoder().encode(text));
  return out;
}

const KAT_SEED1 = seedOf("This is a test seed for hashwx");
const KAT_SEED2 = seedOf("Lorem ipsum dolor sit amet");

const KAT_VECTORS: Array<[string, Uint8Array, bigint, bigint]> = [
  ["seed1 / counter=0", KAT_SEED1, 0n, 0x973684176f8ee362n],
  ["seed1 / counter=123456", KAT_SEED1, 123456n, 0x401983bb07d69b07n],
  ["seed2 / counter=123456", KAT_SEED2, 123456n, 0x4af38d834a9a8d3dn],
  ["seed2 / counter=987654321123456789", KAT_SEED2, 987654321123456789n, 0x6a8a5514432e17a3n],
];

describe("hashwx —— 官方 KAT 向量", () => {
  for (const [label, seed, nonce, expected] of KAT_VECTORS) {
    it(label, () => {
      expect(hashwxHash(seed, nonce)).toBe(expected);
    });
  }

  it("种子长度不合法时抛错", () => {
    expect(() => hashwxHash(new Uint8Array(31), 0n)).toThrow();
  });

  it("nonce 超出 u64 时抛错", () => {
    expect(() => hashwxHash(KAT_SEED1, -1n)).toThrow();
    expect(() => hashwxHash(KAT_SEED1, 1n << 64n)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 目标阈值
 * ------------------------------------------------------------------ */
describe("hashwx —— target 计算", () => {
  it("d=1 时 target 为 u64 最大值（任何哈希都通过）", () => {
    expect(hashwxTarget(1)).toBe((1n << 64n) - 1n);
  });

  it("d=2 时 target 为 (2^64-1)/2，等价于最高位为 0", () => {
    expect(hashwxTarget(2)).toBe(((1n << 64n) - 1n) / 2n);
  });

  it("d 越大 target 越小", () => {
    expect(hashwxTarget(1000)).toBeGreaterThan(hashwxTarget(100000));
  });

  it("d 越界时抛错", () => {
    expect(() => hashwxTarget(0)).toThrow();
    expect(() => hashwxTarget(-1)).toThrow();
    expect(() => hashwxTarget(1.5)).toThrow();
    expect(() => hashwxTarget(HASHWX_MAX_DIFFICULTY + 1)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 跨语言固定向量
 *
 * 下面两个 hex 值一旦变化，就说明 Node / Go / Worker / 前端 的派生口径漂移，
 * 必须同步修改四端实现。本地副本用于钉住口径。
 * ------------------------------------------------------------------ */
const VECTOR_C = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const VECTOR_C_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const VECTOR_SEED_I0_B0 = "e601ef8605dccfe5d026eda2937496fa094ecd4e8911175fc8c8f84bbef0777f";
const VECTOR_SEED_I3_B1234567 = "4f0f41e64098a0481b2f23212cc4d14148e611b3186e7f9492491e0e27929f4a";

/** 与被测实现同算法的本地副本：C ‖ u8le(index) ‖ u64le(block) 的 SHA-256 */
function blockSeedLocal(challenge: Buffer, index: number, block: bigint): string {
  const buf = Buffer.alloc(41);
  challenge.copy(buf, 0);
  buf[32] = index & 0xff;
  buf.writeBigUInt64LE(block, 33);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("hashwx —— 函数种子派生口径", () => {
  it("C 的 hex 编码", () => {
    expect(VECTOR_C.toString("hex")).toBe(VECTOR_C_HEX);
  });

  it("固定向量 i=0 / block=0", () => {
    expect(hashwxBlockSeed(VECTOR_C, 0, 0n).toString("hex")).toBe(VECTOR_SEED_I0_B0);
  });

  it("固定向量 i=3 / block=1234567", () => {
    expect(hashwxBlockSeed(VECTOR_C, 3, 1234567n).toString("hex")).toBe(VECTOR_SEED_I3_B1234567);
  });

  it("与本地实现一致（多组参数）", () => {
    for (const index of [0, 1, 3, 17, 255]) {
      for (const block of [0n, 1n, 65535n, 65536n, 1234567n, 18446744073709551615n]) {
        expect(hashwxBlockSeed(VECTOR_C, index, block).toString("hex")).toBe(
          blockSeedLocal(VECTOR_C, index, block)
        );
      }
    }
  });

  it("index 与 block 都会改变结果", () => {
    const base = hashwxBlockSeed(VECTOR_C, 0, 0n).toString("hex");
    expect(hashwxBlockSeed(VECTOR_C, 1, 0n).toString("hex")).not.toBe(base);
    expect(hashwxBlockSeed(VECTOR_C, 0, 1n).toString("hex")).not.toBe(base);
  });

  it("挑战长度不合法时抛错", () => {
    expect(() => hashwxBlockSeed(Buffer.alloc(31), 0, 0n)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 挑战签发
 * ------------------------------------------------------------------ */
describe("hashwx —— 挑战签发", () => {
  it("默认参数与 Cap 一致（4 个子挑战、n=65536、总难度 1e6）", () => {
    const spec = mintHashwxSpec();
    expect(spec.count).toBe(HASHWX_DEFAULT_CHALLENGE_COUNT);
    expect(spec.n).toBe(HASHWX_DEFAULT_NONCES_PER_HASH);
    expect(spec.d * spec.count).toBe(HASHWX_DEFAULT_DIFFICULTY);
    expect(parseHashwxChallenge(spec.c)).not.toBeNull();
  });

  it("总难度按子挑战数均分", () => {
    expect(mintHashwxSpec({ difficulty: 1000, count: 4 }).d).toBe(250);
    expect(mintHashwxSpec({ difficulty: 1_000_000, count: 4 }).d).toBe(250_000);
    expect(mintHashwxSpec({ difficulty: 1001, count: 4 }).d).toBe(250);
  });

  it("难度低于子挑战数时每个子挑战至少为 1", () => {
    expect(mintHashwxSpec({ difficulty: 1, count: 8 }).d).toBe(1);
  });

  it("挑战随机且为 32 字节", () => {
    const a = mintHashwxSpec();
    const b = mintHashwxSpec();
    expect(a.c).not.toBe(b.c);
    expect(a.c).toHaveLength(HASHWX_CHALLENGE_SIZE * 2);
  });

  it("参数越界时抛错", () => {
    expect(() => mintHashwxSpec({ difficulty: 0 })).toThrow();
    expect(() => mintHashwxSpec({ difficulty: HASHWX_MAX_DIFFICULTY + 1 })).toThrow();
    expect(() => mintHashwxSpec({ noncesPerHash: 0 })).toThrow();
    expect(() => mintHashwxSpec({ noncesPerHash: HASHWX_MAX_NONCES_PER_HASH + 1 })).toThrow();
    expect(() => mintHashwxSpec({ count: 0 })).toThrow();
    expect(() => mintHashwxSpec({ count: HASHWX_MAX_CHALLENGE_COUNT + 1 })).toThrow();
  });
});

describe("hashwx —— 参数解析", () => {
  it("挑战 hex 解析", () => {
    expect(parseHashwxChallenge(VECTOR_C_HEX)?.toString("hex")).toBe(VECTOR_C_HEX);
    expect(parseHashwxChallenge(VECTOR_C_HEX.toUpperCase())?.toString("hex")).toBe(VECTOR_C_HEX);
    expect(parseHashwxChallenge("")).toBeNull();
    expect(parseHashwxChallenge("zz".repeat(32))).toBeNull();
    expect(parseHashwxChallenge(VECTOR_C_HEX.slice(2))).toBeNull();
    expect(parseHashwxChallenge(null)).toBeNull();
    expect(parseHashwxChallenge(123)).toBeNull();
  });

  it("nonce 解析：数字与十进制字符串等价", () => {
    expect(parseHashwxNonce(123)).toBe(123n);
    expect(parseHashwxNonce("123")).toBe(123n);
    expect(parseHashwxNonce("0")).toBe(0n);
    expect(parseHashwxNonce(18446744073709551615n)).toBe(18446744073709551615n);
  });

  it("nonce 解析：拒绝越界与畸形输入", () => {
    expect(parseHashwxNonce(-1)).toBeNull();
    expect(parseHashwxNonce(1.5)).toBeNull();
    expect(parseHashwxNonce("")).toBeNull();
    expect(parseHashwxNonce("0x10")).toBeNull();
    expect(parseHashwxNonce("123456789012345678901")).toBeNull(); // 21 位
    expect(parseHashwxNonce("99999999999999999999")).toBeNull(); // 20 位但超过 u64
    expect(parseHashwxNonce(null)).toBeNull();
    expect(parseHashwxNonce({})).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 校验与解题往返
 * ------------------------------------------------------------------ */

/** 逐个子挑战求解，返回 nonce 数组。难度保持很小，避免用例变慢 */
function solve(spec: HashwxSpec): string[] {
  const challenge = Buffer.from(spec.c, "hex");
  const target = hashwxTarget(spec.d);
  const nonces: string[] = [];

  for (let i = 0; i < spec.count; i++) {
    let nonce = 0n;
    for (;;) {
      const seed = hashwxBlockSeed(challenge, i, nonce / BigInt(spec.n));
      if (hashwxHash(seed, nonce) <= target) break;
      nonce++;
      if (nonce > 5_000_000n) throw new Error(`子挑战 ${i} 求解超限`);
    }
    nonces.push(nonce.toString());
  }

  return nonces;
}

describe("hashwx —— 校验与解题往返", () => {
  // 解释模式约 48 KH/s，d=400 × 4 子挑战 ≈ 1600 次哈希，约 40ms
  const spec: HashwxSpec = {
    c: crypto.randomBytes(32).toString("hex"),
    d: 400,
    n: HASHWX_DEFAULT_NONCES_PER_HASH,
    count: 4,
  };

  it("正确解通过校验", () => {
    const nonces = solve(spec);
    expect(nonces).toHaveLength(4);
    expect(verifyHashwxSolutions(spec, nonces)).toEqual({ ok: true });
  });

  it("错误 nonce 被拒", () => {
    const nonces = solve(spec);
    const broken = [...nonces];
    broken[2] = (BigInt(broken[2]) + 1n).toString();
    // 小概率 +1 仍满足难度，此时用例无意义，直接跳过断言
    const challenge = Buffer.from(spec.c, "hex");
    const target = hashwxTarget(spec.d);
    const bumped = BigInt(broken[2]);
    const stillOk = hashwxHash(hashwxBlockSeed(challenge, 2, bumped / BigInt(spec.n)), bumped) <= target;
    if (!stillOk) {
      expect(verifyHashwxSolutions(spec, broken)).toEqual({
        ok: false,
        reason: "insufficient work",
      });
    }
  });

  it("nonce 数量不匹配被拒", () => {
    const nonces = solve(spec);
    expect(verifyHashwxSolutions(spec, nonces.slice(0, 3))).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
    expect(verifyHashwxSolutions(spec, [])).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
    expect(verifyHashwxSolutions(spec, "nope")).toEqual({
      ok: false,
      reason: "solution count mismatch",
    });
  });

  it("畸形挑战与畸形 spec 被拒", () => {
    const nonces = solve(spec);
    expect(verifyHashwxSolutions({ ...spec, c: "not-hex" }, nonces)).toEqual({
      ok: false,
      reason: "malformed challenge",
    });
    expect(verifyHashwxSolutions({ ...spec, d: 0 }, nonces)).toEqual({
      ok: false,
      reason: "malformed spec",
    });
    expect(verifyHashwxSolutions({ ...spec, n: 0 }, nonces)).toEqual({
      ok: false,
      reason: "malformed spec",
    });
    expect(verifyHashwxSolutions({ ...spec, count: 0 }, nonces)).toEqual({
      ok: false,
      reason: "malformed spec",
    });
  });

  it("畸形 nonce 被拒", () => {
    // 坏值必须放在第 0 位：校验是逐个子挑战短路返回的，
    // 放在后面会被前面的「算力不足」先拦下，测不到解析分支。
    expect(verifyHashwxSolutions(spec, ["0x10", "2", "3", "4"])).toEqual({
      ok: false,
      reason: "bad nonce",
    });
    expect(verifyHashwxSolutions(spec, [-1, "2", "3", "4"])).toEqual({
      ok: false,
      reason: "bad nonce",
    });
  });

  it("用错误的子挑战位置校验必然失败（index 参与派生）", () => {
    const nonces = solve(spec);
    // 把第 0 个解挪到第 1 个位置：种子不同，应判定算力不足
    const swapped = [nonces[1], nonces[0], nonces[2], nonces[3]];
    expect(verifyHashwxSolutions(spec, swapped)).toEqual({
      ok: false,
      reason: "insufficient work",
    });
  });

  it("单子挑战（count=1）同样可用", () => {
    const single: HashwxSpec = { c: crypto.randomBytes(32).toString("hex"), d: 300, n: 65536, count: 1 };
    expect(verifyHashwxSolutions(single, solve(single))).toEqual({ ok: true });
  });

  it("n 取不同值时解题与校验口径自洽", () => {
    for (const n of [1, 1024, 65536]) {
      const s: HashwxSpec = { c: crypto.randomBytes(32).toString("hex"), d: 200, n, count: 2 };
      const nonces = solve(s);
      expect(verifyHashwxSolutions(s, nonces)).toEqual({ ok: true });
    }
  });

  it("挑战被篡改则解失效（种子随之改变）", () => {
    const s: HashwxSpec = { c: crypto.randomBytes(32).toString("hex"), d: 200, n: 65536, count: 2 };
    const nonces = solve(s);
    const tampered: HashwxSpec = { ...s, c: crypto.randomBytes(32).toString("hex") };
    expect(verifyHashwxSolutions(tampered, nonces)).toEqual({
      ok: false,
      reason: "insufficient work",
    });
  });
});
