import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
	sha256Bytes,
	sha256Hex,
	leadingZeroBits,
	mineNonce,
	CancelledError,
} from '../src/verify/pow';

/** 用 Node 原生实现做交叉校验（纯 JS 实现必须与之一致） */
const nodeSha256 = (message) => createHash('sha256').update(message, 'utf8').digest('hex');

/** 与三端后端一致的校验口径 */
const verify = (prefix, nonce, difficulty) =>
	leadingZeroBits(sha256Bytes(`${prefix}:${nonce}`)) >= difficulty;

/**
 * 跨语言测试向量：Go / Worker / 前端共用同一份值。
 * secret = a1b2...f801
 * prefix = eyJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsImlhdCI6MTczMDAwMDAwMDAwMH0
 */
const VECTOR_PREFIX =
	'eyJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsImlhdCI6MTczMDAwMDAwMDAwMH0';

describe('pow —— sha256Hex 标准向量', () => {
	it('空字符串（只有一个填充块）', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('abc（NIST FIPS 180-2 向量）', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('56 字节向量（正好跨越填充边界）', () => {
		expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
		);
	});

	it('112 字节向量（两个块）', () => {
		const input =
			'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
		expect(sha256Hex(input)).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
	});

	it('UTF-8 多字节：中文', () => {
		expect(sha256Hex('中文')).toBe('72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21');
	});

	it('UTF-8 多字节：表情/假名混排', () => {
		expect(sha256Hex('(ノಠ益ಠ)ノ彡┻━┻')).toBe(
			'3c662b362f8dc9eb0b09740b61e850159f0543579a557bff02c72d8316a6ce0a'
		);
	});
});

describe('pow —— sha256Hex 填充长度边界（55/56/64/65 字节）', () => {
	const cases = [
		[55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
		[56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
		[64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
		[65, '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0'],
	];

	for (const [len, expected] of cases) {
		it(`${len} 个 'a' 的摘要正确`, () => {
			expect(sha256Hex('a'.repeat(len))).toBe(expected);
		});
	}

	it('1000 个字符（多块）摘要正确', () => {
		expect(sha256Hex('a'.repeat(1000))).toBe(
			'41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'
		);
	});
});

describe('pow —— 与 Node 原生 crypto 交叉校验', () => {
	const samples = [
		'',
		'a',
		'secret',
		'The quick brown fox jumps over the lazy dog',
		'The quick brown fox jumps over the lazy dog.',
		'中文测试字符串',
		'prefix:12345',
		'x'.repeat(63),
		'x'.repeat(64),
		'x'.repeat(65),
		'x'.repeat(4096),
		'混合 mixed 内容 with emoji 🎉 and 数字 123',
	];

	for (const sample of samples) {
		it(`与 node:crypto 一致（样本长度 ${sample.length}）`, () => {
			expect(sha256Hex(sample)).toBe(nodeSha256(sample));
		});
	}
});

describe('pow —— sha256Bytes 字节级契约', () => {
	it('返回长度 32 的 Uint8Array', () => {
		const bytes = sha256Bytes('abc');
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(32);
	});

	it('字节内容与十六进制表示一致', () => {
		const hex = sha256Hex('hello');
		const bytes = sha256Bytes('hello');
		expect(Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(hex);
	});

	it('摘要全部为零字节时不会越界（构造不可能但可测的边界）', () => {
		expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
	});

	it('重复调用结果稳定（模块级复用缓冲区不会串味）', () => {
		const a = sha256Hex('abc');
		sha256Hex('def'.repeat(100));
		expect(sha256Hex('abc')).toBe(a);
	});
});

describe('pow —— leadingZeroBits 计数规则', () => {
	const table = [
		[[], 0],
		[[0x00], 8],
		[[0x00, 0x00], 16],
		[[0x00, 0x00, 0x10], 19],
		[[0x01], 7],
		[[0x02], 6],
		[[0x03], 6],
		[[0x04], 5],
		[[0x0f], 4],
		[[0x10], 3],
		[[0x3f], 2],
		[[0x40], 1],
		[[0x7f], 1],
		[[0x80], 0],
		[[0xff], 0],
	];

	for (const [bytes, expected] of table) {
		it(`[${bytes.map((b) => '0x' + b.toString(16)).join(', ')}] -> ${expected} 位`, () => {
			expect(leadingZeroBits(Uint8Array.from(bytes))).toBe(expected);
		});
	}

	it('只统计到第一个非零字节为止', () => {
		expect(leadingZeroBits(Uint8Array.from([0x00, 0x00, 0xff, 0x00]))).toBe(16);
	});

	it('结果上限为字节数 * 8', () => {
		expect(leadingZeroBits(new Uint8Array(3))).toBe(24);
	});
});

describe('pow —— 跨语言共享向量', () => {
	it('sha256Hex(prefix + ":12345") 与三端一致', () => {
		expect(sha256Hex(`${VECTOR_PREFIX}:12345`)).toBe(
			'3666b012819465fb626048a08afdd8eb462b9a2bc120883d246264cec94a5947'
		);
	});

	it('nonce 12345 的前导 0 比特恰好为 2', () => {
		expect(leadingZeroBits(sha256Bytes(`${VECTOR_PREFIX}:12345`))).toBe(2);
	});

	it('该向量满足难度 2', () => {
		expect(verify(VECTOR_PREFIX, 12345, 2)).toBe(true);
	});

	it('该向量不满足难度 3（错误 nonce 会被拒绝）', () => {
		expect(verify(VECTOR_PREFIX, 12345, 3)).toBe(false);
	});

	it('相邻 nonce 不满足难度 2（说明校验确实是按位判断）', () => {
		expect(verify(VECTOR_PREFIX, 12344, 2)).toBe(false);
	});

	it('向量附近的 nonce 2 不满足难度 2（前导 0 比特为 0）', () => {
		expect(leadingZeroBits(sha256Bytes(`${VECTOR_PREFIX}:2`))).toBe(0);
		expect(verify(VECTOR_PREFIX, 2, 2)).toBe(false);
	});

	it('nonce 0 恰好有 4 位前导 0，因此满足难度 2 但不满足难度 5', () => {
		expect(leadingZeroBits(sha256Bytes(`${VECTOR_PREFIX}:0`))).toBe(4);
		expect(verify(VECTOR_PREFIX, 0, 2)).toBe(true);
		expect(verify(VECTOR_PREFIX, 0, 5)).toBe(false);
	});
});

describe('pow —— mineNonce 难度边界', () => {
	it('难度 0：立刻返回 nonce = 0、attempts = 1', async () => {
		const solution = await mineNonce('prefix', 0, () => false);
		expect(solution).toEqual({ nonce: 0, attempts: 1 });
	});

	it('难度 0 + 已取消：先检查取消，抛 CancelledError', async () => {
		await expect(mineNonce('prefix', 0, () => true)).rejects.toBeInstanceOf(CancelledError);
	});

	it('负难度按 0 处理（位运算比较天然成立）', async () => {
		const solution = await mineNonce('prefix', -5, () => false);
		expect(solution.nonce).toBe(0);
	});

	for (const difficulty of [1, 2, 3, 4, 8, 12]) {
		it(`难度 ${difficulty}：解满足前导 0 比特要求`, async () => {
			const solution = await mineNonce('momo-test', difficulty, () => false);
			expect(verify('momo-test', solution.nonce, difficulty)).toBe(true);
		});
	}

	it('难度 16：仍能在合理时间内解出', async () => {
		const solution = await mineNonce('momo-test-16', 16, () => false);
		expect(verify('momo-test-16', solution.nonce, 16)).toBe(true);
	}, 20000);

	it('解是从 0 开始递增搜索得到的第一个解（最小 nonce）', async () => {
		const difficulty = 8;
		const solution = await mineNonce('minimal', difficulty, () => false);
		for (let n = 0; n < solution.nonce; n++) {
			expect(verify('minimal', n, difficulty), `nonce ${n} 不应满足难度`).toBe(false);
		}
	});
});

describe('pow —— mineNonce 返回值语义', () => {
	it('attempts === nonce + 1（表示实际算过的哈希次数）', async () => {
		const solution = await mineNonce('attempts', 8, () => false);
		expect(solution.attempts).toBe(solution.nonce + 1);
	});

	it('同一输入重复求解结果完全一致（确定性）', async () => {
		const first = await mineNonce('deterministic', 8, () => false);
		const second = await mineNonce('deterministic', 8, () => false);
		expect(second).toEqual(first);
	});

	it('不同前缀得到各自的解', async () => {
		const a = await mineNonce('prefix-a', 8, () => false);
		const b = await mineNonce('prefix-b', 8, () => false);
		expect(verify('prefix-a', a.nonce, 8)).toBe(true);
		expect(verify('prefix-b', b.nonce, 8)).toBe(true);
	});
});

describe('pow —— mineNonce 前缀边界', () => {
	it('空前缀可用（摘要口径为 ":nonce"）', async () => {
		const solution = await mineNonce('', 4, () => false);
		expect(verify('', solution.nonce, 4)).toBe(true);
		expect(sha256Hex(`:${solution.nonce}`)).toBe(nodeSha256(`:${solution.nonce}`));
	});

	it('含中文/emoji 的前缀按 UTF-8 处理，与 node:crypto 一致', async () => {
		const prefix = '前缀🎉';
		const solution = await mineNonce(prefix, 4, () => false);
		expect(verify(prefix, solution.nonce, 4)).toBe(true);
		expect(sha256Hex(`${prefix}:${solution.nonce}`)).toBe(nodeSha256(`${prefix}:${solution.nonce}`));
	});

	it('含冒号的前缀不会改变拼接口径（仍为 prefix + ":" + nonce）', async () => {
		const prefix = 'a:b:c';
		const solution = await mineNonce(prefix, 4, () => false);
		expect(verify(prefix, solution.nonce, 4)).toBe(true);
	});

	it('超长前缀也能求出解', async () => {
		const prefix = 'p'.repeat(5000);
		const solution = await mineNonce(prefix, 4, () => false);
		expect(verify(prefix, solution.nonce, 4)).toBe(true);
	});
});

describe('pow —— 取消与终止', () => {
	it('一开始就取消：抛 CancelledError', async () => {
		await expect(mineNonce('x', 32, () => true)).rejects.toBeInstanceOf(CancelledError);
	});

	it('CancelledError 的 name 与 message 固定', async () => {
		const error = await mineNonce('x', 32, () => true).catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('CancelledError');
		expect(error.message).toBe('verification cancelled');
	});

	it('每算一次哈希之前都会检查一次取消', async () => {
		const isCancelled = vi.fn(() => false);
		await mineNonce('count', 0, isCancelled);
		expect(isCancelled).toHaveBeenCalledTimes(1);
	});

	it('不可能完成的难度会在取消后立即结束（含分批让出主线程的路径）', async () => {
		let calls = 0;
		const isCancelled = () => ++calls > 10;
		// 难度 64 在现实中无解；batchSize=4 会走 2 次让出后触发取消
		await expect(mineNonce('impossible', 64, isCancelled, 4)).rejects.toBeInstanceOf(CancelledError);
		expect(calls).toBe(11);
	});

	it('batchSize = 1 时也能正常解出（每轮都让出主线程）', async () => {
		const solution = await mineNonce('tiny-batch', 6, () => false, 1);
		expect(verify('tiny-batch', solution.nonce, 6)).toBe(true);
	});
});
