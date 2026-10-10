import crypto from "crypto";
import { HASHWX_WASM_BASE64 } from "./hashwxWasm";

/**
 * HashWX 工作量证明（第一层验证）— Node.js 实现
 *
 * 算法来自 tevador/hashwx v1.0.0（LGPL-3.0，详见 vendor/hashwx/README.md）。
 * 与本项目自有的 SHA-256 PoW 相比，HashWX 每个挑战都从一个种子生成**一次性函数**，
 * 函数内部包含大量分支与 16KB 未对齐 scratchpad 访问，GPU 相对 CPU 的吞吐优势
 * 从 SHA-256 的约 150 倍降到约 2 倍。
 *
 * 协议口径（三端与前端必须逐字节一致）：
 *   target = U64_MAX / d
 *   seed(i, block) = SHA256(C(32字节) ‖ u8le(i) ‖ u64le(block))
 *   找到 nonce 使 hash(seed(i, nonce / n), nonce) <= target
 *   block 为 nonce / n 的整数除法（n 为每个函数覆盖的 nonce 数）
 *
 * 与 Cap 的差异（有意为之，不影响安全性）：
 *   Cap 为每个子挑战签发独立的随机 C；这里只签发一个 C，第 i 个子挑战由
 *   u8le(i) 参与派生。这样单个签名载荷就能覆盖全部子挑战，且派生规则更易跨语言对齐。
 *
 * 服务端只用「解释模式」（HASHWX_INTERPRETED）：每次校验只执行一次哈希，
 * 省掉生成内层模块的 JIT 开销，实测单次校验约 100–150µs。
 */

// ---------- 常量 ----------

export const HASHWX_SEED_SIZE = 32;
export const HASHWX_CHALLENGE_SIZE = 32;

/** 每个生成函数覆盖的 nonce 数。浏览器端编译开销大，取值偏大以摊薄（与上游建议一致） */
export const HASHWX_DEFAULT_NONCES_PER_HASH = 65536;

/** 总期望哈希次数，按 count 均分到各子挑战 */
export const HASHWX_DEFAULT_DIFFICULTY = 1_000_000;

/** 子挑战个数。上游建议 4 个：总期望工作量不变，但能显著压平解题耗时的长尾 */
export const HASHWX_DEFAULT_CHALLENGE_COUNT = 4;

export const HASHWX_MAX_DIFFICULTY = 1_000_000_000;
export const HASHWX_MAX_NONCES_PER_HASH = 1_048_576;
export const HASHWX_MAX_CHALLENGE_COUNT = 64;

const U64_MAX = (1n << 64n) - 1n;

// ---------- WASM 装载 ----------

interface HashwxExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  hashwx_alloc: (type: number) => number;
  hashwx_seed: (ctx: number) => number;
  hashwx_make: (ctx: number, seedPtr: number) => void;
  hashwx_exec: (ctx: number, nonce: bigint) => bigint;
  hashwx_free: (ctx: number) => void;
}

const HASHWX_INTERPRETED = 0;

/**
 * 注意：这里的字段名不能叫 `exports`。
 * 本项目编译为 CommonJS，局部变量 `exports` 会遮蔽模块导出的 `exports` 对象，
 * 让同文件内的 `exports.XXX` 引用全部失效（tsc 产物下才会暴露，vitest 的 ESM 转换不会）。
 */
interface HashwxHandle {
  wasm: HashwxExports;
  ctx: number;
  seedPtr: number;
}

let cachedInstance: HashwxHandle | null = null;

/**
 * 惰性装载 WASM 并分配一个常驻上下文。
 *
 * Node 是单线程且这里全程同步，因此一个常驻上下文不会并发交叉；
 * 如果将来引入异步并发的调用点，需要改为上下文池。
 */
function getInstance(): HashwxHandle {
  if (cachedInstance) return cachedInstance;

  const bytes = Buffer.from(HASHWX_WASM_BASE64, "base64");
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as HashwxExports;
  if (typeof wasm._initialize === "function") wasm._initialize();

  const ctx = wasm.hashwx_alloc(HASHWX_INTERPRETED);
  if (ctx <= 0) throw new Error(`hashwx_alloc 失败: ${ctx}`);

  cachedInstance = { wasm, ctx, seedPtr: wasm.hashwx_seed(ctx) };
  return cachedInstance;
}

/** 把 32 字节种子写入常驻 seed 缓冲区 */
function writeSeed(seed: Uint8Array): void {
  const { wasm, seedPtr } = getInstance();
  if (seed.length !== HASHWX_SEED_SIZE) throw new Error(`seed 必须为 ${HASHWX_SEED_SIZE} 字节`);
  new Uint8Array(wasm.memory.buffer, seedPtr, HASHWX_SEED_SIZE).set(seed);
}

/**
 * 用一个 32 字节种子生成函数并对单个 nonce 求值。
 *
 * 这是最小可用的原语：**每次调用都会重新生成一次函数**（解释模式下生成约 2 万周期，
 * 与单次哈希同量级）。校验时每个子挑战只调用一次，开销可以忽略；
 * 但不要把它放进「遍历 nonce」的循环里——那会白白多花约 5 倍机器。
 * 服务端不需要遍历 nonce，遍历只发生在客户端（见前端 hashwxCore.ts 的 SubChallengeSolver）。
 */
export function hashwxHash(seed: Uint8Array, nonce: bigint): bigint {
  const { wasm, ctx, seedPtr } = getInstance();
  if (nonce < 0n || nonce > U64_MAX) throw new Error("nonce 超出 u64 范围");
  writeSeed(seed);
  wasm.hashwx_make(ctx, seedPtr);
  return BigInt.asUintN(64, wasm.hashwx_exec(ctx, nonce));
}

// ---------- 协议计算 ----------

/** 目标阈值：U64_MAX / d */
export function hashwxTarget(difficulty: number): bigint {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > HASHWX_MAX_DIFFICULTY) {
    throw new Error(`难度必须是 [1, ${HASHWX_MAX_DIFFICULTY}] 内的整数`);
  }
  return U64_MAX / BigInt(difficulty);
}

/**
 * 第 index 个子挑战、第 block 个哈希函数的种子。
 * 口径：SHA256(C ‖ u8le(index) ‖ u64le(block))
 */
export function hashwxBlockSeed(challenge: Uint8Array, index: number, block: bigint): Buffer {
  if (challenge.length !== HASHWX_CHALLENGE_SIZE) {
    throw new Error(`挑战必须为 ${HASHWX_CHALLENGE_SIZE} 字节`);
  }
  const buf = Buffer.alloc(HASHWX_CHALLENGE_SIZE + 1 + 8);
  Buffer.from(challenge).copy(buf, 0);
  buf[HASHWX_CHALLENGE_SIZE] = index & 0xff;
  buf.writeBigUInt64LE(block, HASHWX_CHALLENGE_SIZE + 1);
  return crypto.createHash("sha256").update(buf).digest();
}

export interface HashwxSpec {
  /** 32 字节挑战，hex 编码下发 */
  c: string;
  /** 每个子挑战的期望哈希次数 */
  d: number;
  /** 每个生成函数覆盖的 nonce 数 */
  n: number;
  /** 子挑战个数 */
  count: number;
}

/**
 * 构造挑战参数。difficulty 为总期望哈希次数，按 count 均分。
 *
 * 注意「约」：这里是 `Math.round(total / count)`，且每个子挑战至少为 1，
 * 因此实际总工作量可能与配置值有偏差（例如 total=1001/count=4 → 实际 1000；
 * total=1/count=8 → 实际 8）。这不影响安全——校验用的始终是服务端自己派生的同一个
 * spec——但设置项说明与文档应写成「约 N 次」，不要承诺精确值。
 *
 * challenge 省略时随机生成；本项目由服务端从（密钥, 挑战 id）确定性派生后传入，
 * 这样签名载荷不必携带挑战本身，校验时也能独立重算。
 */
export function mintHashwxSpec(options: {
  challenge?: Uint8Array;
  difficulty?: number;
  noncesPerHash?: number;
  count?: number;
} = {}): HashwxSpec {
  const total = options.difficulty ?? HASHWX_DEFAULT_DIFFICULTY;
  const n = options.noncesPerHash ?? HASHWX_DEFAULT_NONCES_PER_HASH;
  const count = options.count ?? HASHWX_DEFAULT_CHALLENGE_COUNT;
  const challenge = options.challenge ?? crypto.randomBytes(HASHWX_CHALLENGE_SIZE);

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
    c: Buffer.from(challenge).toString("hex"),
    // 与 Cap 一致：把总难度均分到各子挑战，至少为 1
    d: Math.max(1, Math.round(total / count)),
    n,
    count,
  };
}

/** 解析下发的 hex 挑战；非法返回 null */
export function parseHashwxChallenge(hex: unknown): Buffer | null {
  if (typeof hex !== "string" || hex.length !== HASHWX_CHALLENGE_SIZE * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** 把提交上来的 nonce 解析为 u64；接受数字或十进制字符串 */
export function parseHashwxNonce(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= U64_MAX ? value : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  // 20 位以内才可能落在 u64 范围内（u64 max 为 20 位）
  if (!/^[0-9]{1,20}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= U64_MAX ? parsed : null;
}

export type HashwxCheck = { ok: true } | { ok: false; reason: string };

/**
 * 校验 HashWX 答案：对每个子挑战重算一次哈希，全部命中才算通过。
 *
 * 注意 spec 必须来自**服务端签名过的载荷**，不能取自客户端提交，
 * 否则攻击者可以自行降低难度。
 */
export function verifyHashwxSolutions(spec: HashwxSpec, nonces: unknown): HashwxCheck {
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

  const target = hashwxTarget(spec.d);
  const n = BigInt(spec.n);

  for (let i = 0; i < spec.count; i++) {
    const nonce = parseHashwxNonce(nonces[i]);
    if (nonce === null) return { ok: false, reason: "bad nonce" };
    const seed = hashwxBlockSeed(challenge, i, nonce / n);
    if (hashwxHash(seed, nonce) > target) {
      return { ok: false, reason: "insufficient work" };
    }
  }

  return { ok: true };
}
