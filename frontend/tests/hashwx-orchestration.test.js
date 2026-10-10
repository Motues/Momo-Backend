import { describe, it, expect } from 'vitest';
import { solvePow, planWorkerCount, distributeIndexes, PowCancelledError } from '../src/verify/hashwx';
import { HashwxSolver, hashwxBlockSeed, hashwxTarget, getHashwxModule } from '../src/verify/hashwxCore';
import { HASHWX_WASM_BASE64 } from '../src/verify/hashwxWasm';

/** 固定挑战，避免用例之间互相依赖随机值 */
const VECTOR_C = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function challengeOf(overrides = {}) {
	return { c: VECTOR_C, d: 300, n: 65536, count: 2, ...overrides };
}

/** 独立复算某个 nonce 是否真的满足该子挑战的难度 */
function verifyNonce(cHex, index, n, d, nonceStr) {
	const challengeBytes = Uint8Array.from(
		cHex.match(/../g).map((byte) => parseInt(byte, 16))
	);
	const nonce = BigInt(nonceStr);
	const solver = new HashwxSolver(getHashwxModule(HASHWX_WASM_BASE64), true);
	solver.make(hashwxBlockSeed(challengeBytes, index, nonce / BigInt(n)));
	const ok = solver.exec(nonce) <= hashwxTarget(d);
	solver.free();
	return ok;
}

describe('hashwx 编排 —— Worker 数量与任务分配', () => {
	it('按核数留一个核给主线程，且不超过上限 4', () => {
		expect(planWorkerCount(4, 2)).toBe(1);
		expect(planWorkerCount(4, 4)).toBe(3);
		expect(planWorkerCount(4, 8)).toBe(4);
		expect(planWorkerCount(4, 64)).toBe(4);
	});

	it('核数未知时退化为 1 个 Worker', () => {
		expect(planWorkerCount(4, undefined)).toBe(1);
		expect(planWorkerCount(4, 0)).toBe(1);
	});

	it('Worker 数不超过子挑战数', () => {
		expect(planWorkerCount(1, 16)).toBe(1);
		expect(planWorkerCount(2, 16)).toBe(2);
	});

	it('子挑战轮转分配，负载均衡且不丢下标', () => {
		expect(distributeIndexes(4, 2)).toEqual([
			[0, 2],
			[1, 3],
		]);
		expect(distributeIndexes(4, 4)).toEqual([[0], [1], [2], [3]]);
		expect(distributeIndexes(2, 4)).toEqual([
			[0],
			[1],
		]);
		expect(distributeIndexes(5, 2).flat().sort()).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('hashwx 编排 —— 主线程降级路径', () => {
	it('Worker 不可用时仍能解出全部子挑战，且结果可独立复算', async () => {
		const challenge = challengeOf();
		const nonces = await solvePow(challenge, { createWorker: () => null });

		expect(nonces).toHaveLength(challenge.count);
		for (let i = 0; i < challenge.count; i++) {
			expect(verifyNonce(challenge.c, i, challenge.n, challenge.d, nonces[i]), `子挑战 ${i}`).toBe(true);
		}
	});

	it('count=1 时同样可用', async () => {
		const challenge = challengeOf({ count: 1, d: 200 });
		const nonces = await solvePow(challenge, { createWorker: () => null });
		expect(nonces).toHaveLength(1);
		expect(verifyNonce(challenge.c, 0, challenge.n, challenge.d, nonces[0])).toBe(true);
	});

	it('取消后抛出 PowCancelledError', async () => {
		// 难度取得很大，保证第一次检查取消时还没有解出来
		const challenge = challengeOf({ d: 50000000 });
		await expect(solvePow(challenge, { createWorker: () => null, isCancelled: () => true })).rejects.toBeInstanceOf(
			PowCancelledError
		);
	});

	it('挑战参数非法时直接拒绝，不空转', async () => {
		await expect(solvePow(challengeOf({ c: 'zz' }), { createWorker: () => null })).rejects.toThrow();
		await expect(solvePow(challengeOf({ d: 0 }), { createWorker: () => null })).rejects.toThrow();
		await expect(solvePow(challengeOf({ count: 0 }), { createWorker: () => null })).rejects.toThrow();
		await expect(solvePow(challengeOf({ n: 0 }), { createWorker: () => null })).rejects.toThrow();
	});
});

describe('hashwx 编排 —— 默认路径', () => {
	it('默认环境下也能完成求解（Worker 不可用则自动降级）', async () => {
		const challenge = challengeOf({ d: 200, count: 2 });
		const nonces = await solvePow(challenge);
		expect(nonces).toHaveLength(2);
		for (let i = 0; i < 2; i++) {
			expect(verifyNonce(challenge.c, i, challenge.n, challenge.d, nonces[i])).toBe(true);
		}
	});
});
