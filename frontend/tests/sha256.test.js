import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256, sha256Text, sha256Hex, toHex } from '../src/verify/sha256';

/**
 * 这套 SHA-256 现在只服务于 HashWX 的种子派生（seed = SHA256(c ‖ u8le(i) ‖ u64le(block))），
 * 但它是纯 JS 实现，仍然必须与三端后端逐字节一致，因此保留标准向量与交叉校验。
 *
 * 注意：v1 的 SHA-256 工作量证明（挖矿）已随协议 v2 移除，
 * 这部分测试只覆盖摘要本身。
 */

const nodeSha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256 —— 标准向量', () => {
	it('空字符串', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('abc（NIST FIPS 180-2 向量）', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('56 字节向量（跨越填充边界）', () => {
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

describe('sha256 —— 填充长度边界（55/56/64/65 字节）', () => {
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

describe('sha256 —— 与 Node 原生 crypto 交叉校验', () => {
	const samples = [
		'',
		'a',
		'secret',
		'The quick brown fox jumps over the lazy dog',
		'中文测试字符串',
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

	it('任意字节序列（含 0x00 与 >0x7f）也一致', () => {
		for (const bytes of [
			Uint8Array.from([0, 1, 2, 127, 128, 200, 255]),
			Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff),
			Uint8Array.from({ length: 129 }, (_, i) => (i * 31) & 0xff),
			Uint8Array.from([0]),
			Uint8Array.from([0xff, 0x00, 0xff, 0x00]),
		]) {
			const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
			expect(toHex(sha256(bytes))).toBe(expected);
		}
	});

	it('sha256Text 等价于 sha256(UTF-8 编码)', () => {
		const text = '中文 mixed 🎉 123';
		expect(toHex(sha256Text(text))).toBe(toHex(sha256(new TextEncoder().encode(text))));
	});

	it('返回长度固定为 32 字节', () => {
		expect(sha256Text('任意内容').length).toBe(32);
	});
});
