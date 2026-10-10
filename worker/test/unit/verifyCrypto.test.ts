/**
 * src/utils/verifyCrypto.ts —— 无感验证纯算法层（协议 v2）。
 *
 * 这里的函数是三端（Node.js / Go / Worker）共享的口径定义，因此除常规边界用例外，
 * 还必须把跨语言固定向量逐字钉死。向量一旦对不上就是真实的三端漂移，不允许放宽断言。
 *
 * 协议 v2 的载荷 / 签名 / 票据向量全部集中在 doc/vectors/verify-v2.json，
 * 由 test/unit/vectors.verify-v2.test.ts 逐项复算；
 * 本文件只钉「与协议版本无关」的基础原语。
 * v1 的「SHA256(prefix:nonce) 前导 0 比特数」已随协议 v2 一起移除，相应用例也已删除。
 */
import { describe, it, expect } from 'vitest';
import {
	base64urlBytes,
	fromBase64url,
	hashVerifyIp,
	hmacSHA256,
	honeypotFieldName,
	sha256Bytes,
	sha256Hex,
	timingSafeEqual,
	toBase64url,
	toHex,
} from '../../src/utils/verifyCrypto';

/* ----------------------- 跨语言一致性向量（与 Go / Node 共享） ---------------------- */
const VECTOR_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const VECTOR_IP = '::ffff:127.0.0.1';
const VECTOR_SLUG = '/posts/vector-check';
const VECTOR_IP_HASH = '20fa49e706f48b01';
const VECTOR_HONEYPOT = 'v_77dc2477f6';

describe('verifyCrypto —— base64url 编解码', () => {
	it('编码结果不含填充，且使用 URL 安全字符', () => {
		// 0xfb 0xff 会同时产生 + 与 /（标准 base64）
		const encoded = base64urlBytes(new Uint8Array([0xfb, 0xff, 0xbf]));
		expect(encoded).toBe('-_-_');
		expect(encoded).not.toContain('=');
		expect(encoded).not.toMatch(/[+/]/);
	});

	it('空字节数组编码为空串', () => {
		expect(base64urlBytes(new Uint8Array([]))).toBe('');
		expect(toBase64url('')).toBe('');
		expect(fromBase64url('')).toEqual(new Uint8Array([]));
	});

	it('ASCII 往返一致', () => {
		expect(fromBase64url(toBase64url('hello'))).toEqual(new TextEncoder().encode('hello'));
	});

	it('UTF-8 中文往返一致', () => {
		const text = '评论系统 —— 无感验证 ✓';
		const decoded = new TextDecoder().decode(fromBase64url(toBase64url(text)));
		expect(decoded).toBe(text);
	});

	it('容忍带填充（= / ==）的输入', () => {
		const payload = '{"v":2,"cid":"x"}';
		const prefix = toBase64url(payload);
		const bytes = new TextEncoder().encode(payload);
		expect(fromBase64url(prefix)).toEqual(bytes);
		expect(fromBase64url(`${prefix}==`)).toEqual(bytes);
		expect(fromBase64url(`${prefix}=`)).toEqual(bytes);
	});

	it('容忍标准 base64 字母表（+ 与 /）', () => {
		expect(fromBase64url('-_-_')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
		expect(fromBase64url('+/+/')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
	});
});

describe('verifyCrypto —— 十六进制与摘要', () => {
	it('toHex 按小写两位补零输出', () => {
		expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
		expect(toHex(new Uint8Array([]))).toBe('');
	});

	it('sha256Hex 命中公开测试向量', async () => {
		await expect(sha256Hex('')).resolves.toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		await expect(sha256Hex('abc')).resolves.toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('sha256Bytes 与 sha256Hex 结果一致', async () => {
		expect(toHex(await sha256Bytes('abc'))).toBe(await sha256Hex('abc'));
	});

	it('hmacSHA256 命中 RFC 4231 Test Case 2 向量', async () => {
		expect(await hmacSHA256('what do ya want for nothing?', 'Jefe')).toBe(
			'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM'
		);
	});

	it('hmacSHA256 对相同输入稳定、对密钥敏感', async () => {
		const a = await hmacSHA256('data', 'key-a');
		expect(await hmacSHA256('data', 'key-a')).toBe(a);
		expect(await hmacSHA256('data', 'key-b')).not.toBe(a);
		expect(await hmacSHA256('other', 'key-a')).not.toBe(a);
	});
});

describe('verifyCrypto —— timingSafeEqual', () => {
	it('相同字符串返回 true（含空串）', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('', '')).toBe(true);
	});

	it('长度不同直接返回 false', () => {
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
		expect(timingSafeEqual('', 'a')).toBe(false);
	});

	it('长度相同但内容不同返回 false（含只差一位）', () => {
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('ABC', 'abc')).toBe(false);
	});
});

describe('verifyCrypto —— 跨语言一致性向量', () => {
	it('IP 加盐哈希 = hex(SHA256("ip:"+secret+":"+ip))[:16]', async () => {
		expect(await hashVerifyIp(VECTOR_IP, VECTOR_SECRET)).toBe(VECTOR_IP_HASH);
	});

	it('IP 哈希结果固定为 16 位十六进制', async () => {
		const hash = await hashVerifyIp('10.1.2.3', VECTOR_SECRET);
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it('蜜罐字段名 = "v_" + hex(SHA256("hp:"+secret+":"+slug))[:10]', async () => {
		expect(await honeypotFieldName(VECTOR_SLUG, VECTOR_SECRET)).toBe(VECTOR_HONEYPOT);
		expect(await honeypotFieldName('/other', VECTOR_SECRET)).toMatch(/^v_[0-9a-f]{10}$/);
	});

	it('蜜罐字段名对 slug 敏感（同 IP 不同文章必须不同）', async () => {
		expect(await honeypotFieldName('/posts/a', VECTOR_SECRET)).not.toBe(
			await honeypotFieldName('/posts/b', VECTOR_SECRET)
		);
	});
});
