/**
 * 测试替身：HashWX 第一层的纯 JS 替代实现。
 *
 * ⚠️ 为什么需要替身（这一点很重要，请勿删除本说明）：
 *
 * HashWX 算法本身（`worker/vendor/hashwx.wasm`）在 Node 侧已用 tevador 官方的
 * 已知答案测试（KAT，见 nodejs/test/utils.hashwx.test.ts）验证过，Worker 用的是**同一个
 * 二进制**（sha256 b1a0dbb3…d6aff5，与 nodejs/vendor/hashwx/README.md 记录一致）。
 * 但本测试环境（vitest-pool-workers）**无法加载 .wasm 模块**：
 * 相对 specifier 会被解析到 vite-node 包目录下，报
 * `No such module ".../vite-node/vendor/hashwx.wasm?mf_vitest_force=CompiledWasm"`；
 * 我们试过在 vitest.config.mts 里按完整 specifier 精确 alias、也试过换 bare specifier，均无效。
 *
 * 因此测试用 `vi.mock` 把 `src/utils/hashwx.ts` 整体替换成本文件（见 test/helpers/hashwxMock.ts，
 * 由 vitest.config.mts 的 setupFiles 注入）。**真实 .wasm 路径只能由 wrangler 运行时验证**
 * （`npx wrangler dev` 打 /api/verify/challenge + /api/verify/solution），单元测试不覆盖它。
 *
 * 替身的设计原则：
 * 1. 导出面与真实模块**逐个对齐**（常量名、函数签名、错误 reason 文案都一致），
 *    这样 verify.ts 的协议测试（挑战派生、票据、单次使用、PROTOCOL_OUTDATED、设置项、蜜罐）
 *    测的是真实的协议逻辑，只有「哈希原语」被换掉。
 * 2. 种子派生公式与真实实现**完全一致**：`SHA256(C ‖ u8le(index) ‖ u64le(block))`。
 * 3. 只用 SHA-256 计数器式哈希代替「一次性生成函数」：仍然是 64 位、均匀分布、
 *    对 (seed, nonce) 确定性 —— 于是「期望解 1/d 的 nonce」这一统计性质与真实实现相同，
 *    需要遍历 nonce 的用例时长也接近真实情况。
 * 4. 自洽：`verifyHashwxSolutions(mintHashwxSpec(...), nonces)` 对本文件算出的解必然通过。
 */

// ---------- 常量（与 src/utils/hashwx.ts 一致） ----------

export const HASHWX_SEED_SIZE = 32;
export const HASHWX_CHALLENGE_SIZE = 32;
export const HASHWX_DEFAULT_NONCES_PER_HASH = 65536;
export const HASHWX_DEFAULT_DIFFICULTY = 1_000_000;
export const HASHWX_DEFAULT_CHALLENGE_COUNT = 4;
export const HASHWX_MAX_DIFFICULTY = 1_000_000_000;
export const HASHWX_MAX_NONCES_PER_HASH = 1_048_576;
export const HASHWX_MAX_CHALLENGE_COUNT = 64;

const U64_MAX = (1n << 64n) - 1n;

// ---------- 同步 SHA-256（替身的哈希原语） ----------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256（同步，纯 JS） */
export function sha256(bytes: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(bytes, 0);
  padded[len] = 0x80;
  const pdv = new DataView(padded.buffer);
  pdv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  pdv.setUint32(total - 4, (len * 8) >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = pdv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function writeU64le(target: Uint8Array, offset: number, value: bigint): void {
  let rest = value;
  for (let i = 0; i < 8; i++) {
    target[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

// ---------- 第一层原语（替身） ----------

/** 与真实实现同口径的种子派生：SHA256(C ‖ u8le(index) ‖ u64le(block)) */
export async function hashwxBlockSeed(
  challenge: Uint8Array,
  index: number,
  block: bigint
): Promise<Uint8Array> {
  if (challenge.length !== HASHWX_CHALLENGE_SIZE) {
    throw new Error(`挑战必须为 ${HASHWX_CHALLENGE_SIZE} 字节`);
  }
  if (block < 0n || block > U64_MAX) throw new Error("block 超出 u64 范围");

  const buf = new Uint8Array(HASHWX_CHALLENGE_SIZE + 1 + 8);
  buf.set(challenge, 0);
  buf[HASHWX_CHALLENGE_SIZE] = index & 0xff;
  writeU64le(buf, HASHWX_CHALLENGE_SIZE + 1, block);
  return sha256(buf);
}

/**
 * 替身的「一次性函数」：SHA256(seed ‖ u64le(nonce)) 的前 8 字节（大端）作为 u64。
 * 真实实现是 WASM 里生成的函数，这里只要求 64 位、确定性、分布均匀。
 */
export function hashwxHash(seed: Uint8Array, nonce: bigint): bigint {
  if (nonce < 0n || nonce > U64_MAX) throw new Error("nonce 超出 u64 范围");
  const buf = new Uint8Array(seed.length + 8);
  buf.set(seed, 0);
  writeU64le(buf, seed.length, nonce);
  const digest = sha256(buf);
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i]);
  return value;
}

export function hashwxTarget(difficulty: number): bigint {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > HASHWX_MAX_DIFFICULTY) {
    throw new Error(`难度必须是 [1, ${HASHWX_MAX_DIFFICULTY}] 内的整数`);
  }
  return U64_MAX / BigInt(difficulty);
}

export interface HashwxSpec {
  c: string;
  d: number;
  n: number;
  count: number;
}

export function mintHashwxSpec(
  options: {
    challenge?: Uint8Array;
    difficulty?: number;
    noncesPerHash?: number;
    count?: number;
  } = {}
): HashwxSpec {
  const total = options.difficulty ?? HASHWX_DEFAULT_DIFFICULTY;
  const n = options.noncesPerHash ?? HASHWX_DEFAULT_NONCES_PER_HASH;
  const count = options.count ?? HASHWX_DEFAULT_CHALLENGE_COUNT;

  let challenge = options.challenge;
  if (!challenge) {
    challenge = new Uint8Array(HASHWX_CHALLENGE_SIZE);
    crypto.getRandomValues(challenge);
  }

  if (challenge.length !== HASHWX_CHALLENGE_SIZE) {
    throw new Error(`挑战必须为 ${HASHWX_CHALLENGE_SIZE} 字节`);
  }
  if (!Number.isInteger(total) || total < 1 || total > HASHWX_MAX_DIFFICULTY) {
    throw new Error(`difficulty 必须是 [1, ${HASHWX_MAX_DIFFICULTY}] 内的整数`);
  }
  if (!Number.isInteger(n) || n < 1 || n > HASHWX_MAX_NONCES_PER_HASH) {
    throw new Error(`noncesPerHash 必须是 [1, ${HASHWX_MAX_NONCES_PER_HASH}] 内的整数`);
  }
  if (!Number.isInteger(count) || count < 1 || count > HASHWX_MAX_CHALLENGE_COUNT) {
    throw new Error(`count 必须是 [1, ${HASHWX_MAX_CHALLENGE_COUNT}] 内的整数`);
  }

  return {
    c: bytesToHex(challenge),
    d: Math.max(1, Math.round(total / count)),
    n,
    count,
  };
}

export function parseHashwxChallenge(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string" || hex.length !== HASHWX_CHALLENGE_SIZE * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  const bytes = new Uint8Array(HASHWX_CHALLENGE_SIZE);
  for (let i = 0; i < HASHWX_CHALLENGE_SIZE; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function parseHashwxNonce(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= U64_MAX ? value : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  if (!/^[0-9]{1,20}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= U64_MAX ? parsed : null;
}

export type HashwxCheck = { ok: true } | { ok: false; reason: string };

/** 同步比较阶段所需的全部材料（与 src/utils/hashwx.ts 逐字段对齐） */
export interface HashwxEvidence {
  target: bigint;
  items: Array<{ seed: Uint8Array; nonce: bigint }>;
}

export type HashwxPreparation = { ok: true; evidence: HashwxEvidence } | { ok: false; reason: string };

/** 第一阶段：形状校验 + 种子派生（与真实模块同签名、同 reason 文案） */
export async function prepareHashwxVerification(
  spec: HashwxSpec,
  nonces: unknown
): Promise<HashwxPreparation> {
  const challenge = parseHashwxChallenge(spec?.c);
  if (!challenge) return { ok: false, reason: "malformed challenge" };

  if (
    !Number.isInteger(spec.n) ||
    spec.n < 1 ||
    spec.n > HASHWX_MAX_NONCES_PER_HASH ||
    !Number.isInteger(spec.d) ||
    spec.d < 1 ||
    spec.d > HASHWX_MAX_DIFFICULTY ||
    !Number.isInteger(spec.count) ||
    spec.count < 1 ||
    spec.count > HASHWX_MAX_CHALLENGE_COUNT
  ) {
    return { ok: false, reason: "malformed spec" };
  }

  if (!Array.isArray(nonces) || nonces.length !== spec.count) {
    return { ok: false, reason: "solution count mismatch" };
  }

  const n = BigInt(spec.n);
  const items: HashwxEvidence["items"] = [];

  for (let i = 0; i < spec.count; i++) {
    const nonce = parseHashwxNonce(nonces[i]);
    if (nonce === null) return { ok: false, reason: "bad nonce" };
    items.push({ seed: await hashwxBlockSeed(challenge, i, nonce / n), nonce });
  }

  return { ok: true, evidence: { target: hashwxTarget(spec.d), items } };
}

/** 第二阶段：同步哈希比较（真实模块同样是同步的） */
export function checkHashwxEvidence(evidence: HashwxEvidence): HashwxCheck {
  for (const { seed, nonce } of evidence.items) {
    if (hashwxHash(seed, nonce) > evidence.target) {
      return { ok: false, reason: "insufficient work" };
    }
  }

  return { ok: true };
}

export async function verifyHashwxSolutions(spec: HashwxSpec, nonces: unknown): Promise<HashwxCheck> {
  const prepared = await prepareHashwxVerification(spec, nonces);
  return prepared.ok ? checkHashwxEvidence(prepared.evidence) : prepared;
}

/** 求解一个 spec（仅测试使用：真实实现从来不需要遍历 nonce） */
export async function solveHashwxSpec(spec: HashwxSpec, maxTries = 5_000_000): Promise<string[]> {
  const challenge = parseHashwxChallenge(spec.c);
  if (!challenge) throw new Error("spec.c 非法");
  const target = hashwxTarget(spec.d);
  const n = BigInt(spec.n);

  const nonces: string[] = [];
  for (let i = 0; i < spec.count; i++) {
    let nonce = 0n;
    for (; nonce < BigInt(maxTries); nonce++) {
      if (hashwxHash(await hashwxBlockSeed(challenge, i, nonce / n), nonce) <= target) break;
    }
    if (nonce >= BigInt(maxTries)) throw new Error(`子挑战 ${i} 求解超限`);
    nonces.push(nonce.toString());
  }
  return nonces;
}
