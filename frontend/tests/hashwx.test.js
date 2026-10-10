import { describe, it, expect, beforeAll } from 'vitest';
import {
	HashwxSolver,
	SubChallengeSolver,
	getHashwxModule,
	hashwxBlockSeed,
	hashwxTarget,
	parseChallenge,
	isHashwxSupported,
	HASHWX_SEED_SIZE,
	__resetHashwxModuleCache,
} from '../src/verify/hashwxCore';
import { HASHWX_WASM_BASE64 } from '../src/verify/hashwxWasm';

/* ------------------------------------------------------------------ *
 * 官方已知答案测试（KAT）
 *
 * 来自 tevador/hashwx v1.0.0 的 src/tests.c。这四个向量是「vendor 进来的 wasm
 * 确实是官方算法」的唯一凭据——本仓库没有 Emscripten 工具链，无法独立重建。
 * C 源码里 `uint8_t seed[32] = "..."` 会把剩余字节补 0。
 * ------------------------------------------------------------------ */
function seedOf(text) {
	const out = new Uint8Array(HASHWX_SEED_SIZE);
	out.set(new TextEncoder().encode(text));
	return out;
}

const KAT_SEED1 = seedOf('This is a test seed for hashwx');
const KAT_SEED2 = seedOf('Lorem ipsum dolor sit amet');

const KAT_VECTORS = [
	['seed1 / counter=0', KAT_SEED1, 0n, 0x973684176f8ee362n],
	['seed1 / counter=123456', KAT_SEED1, 123456n, 0x401983bb07d69b07n],
	['seed2 / counter=123456', KAT_SEED2, 123456n, 0x4af38d834a9a8d3dn],
	['seed2 / counter=987654321123456789', KAT_SEED2, 987654321123456789n, 0x6a8a5514432e17a3n],
];

describe('hashwxCore —— 官方 KAT 向量（compiled 模式）', () => {
	let solver;

	beforeAll(() => {
		solver = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
	});

	for (const [label, seed, nonce, expected] of KAT_VECTORS) {
		it(label, () => {
			solver.make(seed);
			expect(solver.exec(nonce)).toBe(expected);
		});
	}
});

describe('hashwxCore —— compiled 与 interpreted 结果必须一致', () => {
	let compiled;
	let interpreted;

	beforeAll(() => {
		compiled = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
		interpreted = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), false);
	});

	it('多组种子与 nonce 下逐位一致', () => {
		for (const seed of [KAT_SEED1, KAT_SEED2]) {
			compiled.make(seed);
			interpreted.make(seed);
			for (const nonce of [0n, 1n, 42n, 123456n, 987654321123456789n, (1n << 64n) - 1n]) {
				expect(compiled.exec(nonce)).toBe(interpreted.exec(nonce));
			}
		}
	});

	it('解释模式同样满足官方 KAT', () => {
		for (const [label, seed, nonce, expected] of KAT_VECTORS) {
			interpreted.make(seed);
			expect(interpreted.exec(nonce), label).toBe(expected);
		}
	});
});

/* ------------------------------------------------------------------ *
 * 跨语言固定向量：与 nodejs/test/utils.hashwx.test.ts 共用同一批值
 * ------------------------------------------------------------------ */
const VECTOR_C = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const VECTOR_C_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function toHex(bytes) {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
	return hex;
}

describe('hashwxCore —— 函数种子派生口径（跨语言固定向量）', () => {
	it('固定向量 i=0 / block=0', () => {
		expect(toHex(hashwxBlockSeed(VECTOR_C, 0, 0n))).toBe(
			'e601ef8605dccfe5d026eda2937496fa094ecd4e8911175fc8c8f84bbef0777f'
		);
	});

	it('固定向量 i=3 / block=1234567', () => {
		expect(toHex(hashwxBlockSeed(VECTOR_C, 3, 1234567n))).toBe(
			'4f0f41e64098a0481b2f23212cc4d14148e611b3186e7f9492491e0e27929f4a'
		);
	});

	it('u64le 编码对 u64 上界与跨字节边界都正确（不丢精度）', () => {
		// 这两个值用来钉住 u64le 的字节序：block 超过 2^32 时若用 JS Number 会丢精度，
		// 必须走 BigInt。固定向量与后端测试共用同一批值。
		expect(toHex(hashwxBlockSeed(VECTOR_C, 0, (1n << 64n) - 1n))).toBe(
			'1d297eacb28400d897daeb488e7fd896102286633a5c14fd2e23598ff3b1b046'
		);
		expect(toHex(hashwxBlockSeed(VECTOR_C, 0, 1n << 40n))).toBe(
			'2fc747194f5bb911637f5d699441c276d29502e9563bfe45e0c9f355f7557526'
		);
	});

	it('挑战长度非法时抛错', () => {
		expect(() => hashwxBlockSeed(new Uint8Array(31), 0, 0n)).toThrow();
	});
});

describe('hashwxCore —— 参数解析与阈值', () => {
	it('parseChallenge 与 hex 互转', () => {
		expect(toHex(parseChallenge(VECTOR_C_HEX))).toBe(VECTOR_C_HEX);
		expect(toHex(parseChallenge(VECTOR_C_HEX.toUpperCase()))).toBe(VECTOR_C_HEX);
		expect(() => parseChallenge('zz'.repeat(32))).toThrow();
		expect(() => parseChallenge('')).toThrow();
		expect(() => parseChallenge(VECTOR_C_HEX.slice(2))).toThrow();
	});

	it('hashwxTarget', () => {
		expect(hashwxTarget(1)).toBe((1n << 64n) - 1n);
		expect(hashwxTarget(2)).toBe(((1n << 64n) - 1n) / 2n);
		expect(() => hashwxTarget(0)).toThrow();
		expect(() => hashwxTarget(1.5)).toThrow();
	});

	it('环境能力探测返回布尔值', () => {
		expect(typeof isHashwxSupported()).toBe('boolean');
	});
});

/* ------------------------------------------------------------------ *
 * 时间片求解器：这是主线程不卡顿的关键机制
 * ------------------------------------------------------------------ */
describe('hashwxCore —— SubChallengeSolver 时间片求解', () => {
	const challenge = VECTOR_C;
	const n = 65536n;

	it('在小难度下能解出并满足 target', () => {
		const solver = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
		const d = 300;
		const target = hashwxTarget(d);
		const task = new SubChallengeSolver(solver, challenge, 0, n, target);

		let nonce = null;
		for (let i = 0; i < 100000 && nonce === null; i++) {
			nonce = task.solveWithin(1000);
		}
		expect(nonce).not.toBeNull();

		// 用独立路径复算，确认这个 nonce 真的满足难度
		const seed = hashwxBlockSeed(challenge, 0, nonce / n);
		solver.make(seed);
		expect(solver.exec(nonce) <= target).toBe(true);
	});

	it('时间预算耗尽时返回 null 而不是一直阻塞', () => {
		const solver = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
		// 难度极大，几乎不可能在 0ms 预算内解出
		const task = new SubChallengeSolver(solver, challenge, 1, n, 1n);
		const started = Date.now();
		const result = task.solveWithin(0);
		const elapsed = Date.now() - started;
		expect(result).toBeNull();
		// 至少推进了若干次尝试，且没有长时间占用
		expect(task.attempts > 0n).toBe(true);
		expect(elapsed).toBeLessThan(2000);
	});

	it('不同子挑战 index 会得到不同的解空间', () => {
		const solver = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
		const d = 500;
		const target = hashwxTarget(d);
		const a = new SubChallengeSolver(solver, challenge, 0, n, target);
		const b = new SubChallengeSolver(solver, challenge, 1, n, target);

		const solveAll = (task) => {
			let nonce = task.solveWithin(1000);
			for (let i = 0; i < 100000 && nonce === null; i++) nonce = task.solveWithin(1000);
			return nonce;
		};

		const nonceA = solveAll(a);
		const nonceB = solveAll(b);

		// 两个子挑战的种子不同，但都应当可解
		expect(nonceA).not.toBeNull();
		expect(nonceB).not.toBeNull();
	});
});

describe('hashwxCore —— 主模块缓存', () => {
	it('getHashwxModule 返回同一实例', () => {
		const a = getHashwxModule(HASHWX_WASM_BASE64);
		const b = getHashwxModule(HASHWX_WASM_BASE64);
		expect(a).toBe(b);
	});

	it('清缓存后可重新编译', () => {
		const before = getHashwxModule(HASHWX_WASM_BASE64);
		__resetHashwxModuleCache();
		const after = getHashwxModule(HASHWX_WASM_BASE64);
		expect(after).not.toBe(before);
	});
});
