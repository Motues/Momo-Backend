/**
 * src/utils/verifyCrypto.ts —— 无感验证纯算法层。
 *
 * 这里的函数是三端（Node.js / Go / Worker）共享的口径定义，
 * 因此除常规边界用例外，还必须把 go/internal/pkg/utils/verify_consistency_test.go
 * 中固定的跨语言向量逐字钉死。向量一旦对不上就是真实的三端漂移，不允许放宽断言。
 */
import { describe, it, expect } from 'vitest';
import {
	base64urlBytes,
	fromBase64url,
	hashVerifyIp,
	hmacSHA256,
	honeypotFieldName,
	leadingZeroBits,
	sha256Bytes,
	sha256Hex,
	timingSafeEqual,
	toBase64url,
	toHex,
	workFor,
} from '../../src/utils/verifyCrypto';

/* ----------------------- 跨语言一致性向量（逐字复制自 Go） ---------------------- */
const VECTOR_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const VECTOR_IP = '::ffff:127.0.0.1';
const VECTOR_SLUG = '/posts/vector-check';
const VECTOR_IP_HASH = '20fa49e706f48b01';
const VECTOR_HONEYPOT = 'v_77dc2477f6';
const VECTOR_PREFIX =
	'eyJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsImlhdCI6MTczMDAwMDAwMDAwMH0';
const VECTOR_SIG = 'OdtEE6BBCwUhnC5GTRoIcWALl_Wcv5qOfrwVT6tenK0';
const VECTOR_NONCE = 12345;
const VECTOR_LEADING = 2;
const VECTOR_PAYLOAD_JSON =
	'{"cid":"dGVzdC1jaGFsbGVuZ2U","iph":"20fa49e706f48b01","iat":1730000000000}';

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
		const bytes = new TextEncoder().encode(VECTOR_PAYLOAD_JSON);
		expect(fromBase64url(VECTOR_PREFIX)).toEqual(bytes);
		expect(fromBase64url(`${VECTOR_PREFIX}==`)).toEqual(bytes);
		expect(fromBase64url(`${VECTOR_PREFIX}=`)).toEqual(bytes);
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

	it('base64url(JSON 载荷) 与固定 prefix 逐字节一致', () => {
		expect(toBase64url(VECTOR_PAYLOAD_JSON)).toBe(VECTOR_PREFIX);
	});

	it('固定 prefix 解码后就是约定的 JSON 载荷原文', () => {
		expect(new TextDecoder().decode(fromBase64url(VECTOR_PREFIX))).toBe(VECTOR_PAYLOAD_JSON);
	});

	it('prefix 签名 = base64url(HMAC-SHA256(prefix, secret))', async () => {
		expect(await hmacSHA256(VECTOR_PREFIX, VECTOR_SECRET)).toBe(VECTOR_SIG);
	});

	it('workFor(prefix, 12345) 的前导 0 比特数为 2', async () => {
		expect(await workFor(VECTOR_PREFIX, VECTOR_NONCE)).toBe(VECTOR_LEADING);
	});
});

describe('verifyCrypto —— leadingZeroBits', () => {
	it('空数组返回 0', () => {
		expect(leadingZeroBits(new Uint8Array([]))).toBe(0);
	});

	it('按字节累加整字节的 0', () => {
		expect(leadingZeroBits(new Uint8Array([0x00]))).toBe(8);
		expect(leadingZeroBits(new Uint8Array([0x00, 0x00]))).toBe(16);
		expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x00]))).toBe(24);
	});

	it('首个非零字节按最高位到最低位计算', () => {
		expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
		expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
		expect(leadingZeroBits(new Uint8Array([0x7f]))).toBe(1);
		expect(leadingZeroBits(new Uint8Array([0x40]))).toBe(1);
		expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
		expect(leadingZeroBits(new Uint8Array([0x0f]))).toBe(4);
	});

	it('前导零字节与非零字节混合', () => {
		expect(leadingZeroBits(new Uint8Array([0x00, 0x0f]))).toBe(12);
		expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x01]))).toBe(23);
	});

	it('全零数组等于字节数 × 8', () => {
		expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
	});
});

describe('verifyCrypto —— workFor', () => {
	it('对同一 prefix/nonce 稳定，且与 leadingZeroBits(SHA256(prefix:nonce)) 等价', async () => {
		const expected = leadingZeroBits(await sha256Bytes(`${VECTOR_PREFIX}:${VECTOR_NONCE}`));
		expect(await workFor(VECTOR_PREFIX, VECTOR_NONCE)).toBe(expected);
		expect(await workFor(VECTOR_PREFIX, VECTOR_NONCE)).toBe(VECTOR_LEADING);
	});

	it('不同 nonce 得到不同成果（存在满足难度的解）', async () => {
		const results = await Promise.all(
			Array.from({ length: 64 }, (_, i) => workFor('probe-prefix', i))
		);
		expect(new Set(results).size).toBeGreaterThan(1);
		expect(Math.max(...results)).toBeGreaterThanOrEqual(1);
	});

	it('nonce 以十进制拼接（非十六进制）', async () => {
		// ':255' 与 ':0xff' 必须被区分
		expect(await workFor('p', 255)).toBe(
			leadingZeroBits(await sha256Bytes('p:255'))
		);
	});
});
