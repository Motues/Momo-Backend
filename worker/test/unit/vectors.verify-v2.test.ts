/**
 * 协议 v2 的跨语言固定向量验收测试 —— doc/vectors/verify-v2.json。
 *
 * fixture 由 nodejs/scripts/gen-verify-vectors.ts 生成，Node / Go / Worker 三端测试读**同一份文件**。
 * 这里在 Worker 侧做三件事：
 *   1. 用**独立写在本文件里的**本地实现（WebCrypto + btoa/atob，不 import 被测模块）
 *      复算 fixture 里的每一个值 —— 钉住口径本身；
 *   2. 断言被测实现的实际输出与本地复算一致 —— 钉住实现没有漂移；
 *   3. 把 verify-v2.json 与 instrumentation-v2.json 交叉校验（同一 cid 必须得到同一程序）。
 *
 * 任何一端改了冒号分隔符、base64url 填充、字段顺序或派生标签，都会被这里抓住。
 *
 * ⚠️ HashWX 第一层在测试环境里是替身（见 test/stubs/hashwx.ts）：真实 .wasm 无法在
 * vitest-pool-workers 里加载，只能由 wrangler 运行时验证。因此本文件对 fixture 的
 * `hashwx.c`（派生**标签**与公式）做真实断言，对「哈希原语本身」不做断言。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fixture from '../../../doc/vectors/verify-v2.json';
import instrFixture from '../../../doc/vectors/instrumentation-v2.json';
import { createSchema, seedSettings, testEnv } from '../helpers/db';
import {
	VERIFY_PROTOCOL_VERSION,
	createChallenge,
	createTicket,
	getDifficulty,
	getPublicVerifyConfig,
	verifySolution,
	verifyTicket,
} from '../../src/utils/verify';
// 替身模块（setup file 已把 src/utils/hashwx.ts 整体映射到这里），用于「客户端侧」求解
import { mintHashwxSpec, solveHashwxSpec } from '../stubs/hashwx';

const bindings = testEnv;

const SECRET = fixture.secret;
const IP = fixture.ip;
const SLUG = fixture.slug;

/* ------------------ 与实现无关的本地副本（独立复算用） ------------------ */

function bytesToB64url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(text: string): string {
	return bytesToB64url(new TextEncoder().encode(text));
}

async function localSha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	);
	let hex = '';
	for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
	return hex;
}

async function localHmac(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToB64url(new Uint8Array(sig));
}

function fromB64url(input: string): string {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/');
	return new TextDecoder().decode(
		Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
	);
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

describe('协议 v2 跨语言固定向量（fixture 验收）', () => {
	beforeAll(async () => {
		// 固定签名密钥：必须在任何会触发 getSecret() 的调用之前写入
		// （verify.ts 的 cachedSecret 是模块级缓存，本文件内不会重新读取数据库）
		await createSchema();
		await seedSettings({ comment_verify_secret: SECRET, comment_verify_enabled: 'true', comment_verify_difficulty: String(fixture.difficulty) });
	});

	beforeEach(async () => {
		// isolatedStorage 会回滚每个用例的写入，因此表与设置项都要重建；
		// 密钥已在 beforeAll 缓存进模块状态，不受回滚影响。
		await createSchema();
		await seedSettings({ comment_verify_secret: SECRET, comment_verify_enabled: 'true', comment_verify_difficulty: String(fixture.difficulty) });
	});

	it('fixture 结构完整', () => {
		for (const key of [
			'secret',
			'ip',
			'slug',
			'cid',
			'ipHash',
			'honeypot',
			'prefix',
			'sig',
			'hashwx',
			'instrumentation',
			'ticketBody',
			'ticketSig',
		]) {
			expect((fixture as any)[key], `fixture 缺少 ${key}`).toBeDefined();
		}
		expect(fixture.hashwx).toMatchObject({ d: 250, n: 65536, count: 4 });
		expect(VERIFY_PROTOCOL_VERSION).toBe(2);
	});

	it('IP 哈希与蜜罐字段名口径未漂移', async () => {
		// 本地独立复算
		expect((await localSha256Hex(`ip:${SECRET}:${IP}`)).slice(0, 16)).toBe(fixture.ipHash);
		expect(`v_${(await localSha256Hex(`hp:${SECRET}:${SLUG}`)).slice(0, 10)}`).toBe(fixture.honeypot);

		// 被测实现必须给出同一个值
		const config = await getPublicVerifyConfig(bindings, SLUG);
		expect(config.verify_honeypot).toBe(fixture.honeypot);
		expect(config.verify_enabled).toBe('true');
		expect(config.verify_version).toBe('2');

		const challenge = await createChallenge(bindings, IP, SLUG);
		const payload = JSON.parse(fromB64url(challenge.prefix));
		expect(payload.iph).toBe(fixture.ipHash);
	});

	it('挑战载荷的字段顺序与签名口径未漂移', async () => {
		// 字段顺序会影响签名字节：v → cid → iph → slug → iat，逐字节钉死
		const payload = { v: 2, cid: fixture.cid, iph: fixture.ipHash, slug: SLUG, iat: fixture.iat };
		expect(JSON.stringify(payload)).toBe(fixture.challengePayloadJson);
		expect(b64url(fixture.challengePayloadJson)).toBe(fixture.prefix);
		expect(await localHmac(fixture.prefix, SECRET)).toBe(fixture.sig);
		expect(fromB64url(fixture.prefix)).toBe(fixture.challengePayloadJson);
	});

	it('票据载荷的字段顺序与签名口径未漂移', async () => {
		// 字段顺序：v → iph → slug → iat → exp → jti
		const payload = {
			v: 2,
			iph: fixture.ipHash,
			slug: SLUG,
			iat: fixture.iat,
			exp: fixture.exp,
			jti: fixture.jti,
		};
		expect(JSON.stringify(payload)).toBe(fixture.ticketPayloadJson);
		expect(b64url(fixture.ticketPayloadJson)).toBe(fixture.ticketBody);
		expect(await localHmac(fixture.ticketBody, SECRET)).toBe(fixture.ticketSig);
	});

	it('HashWX 挑战的派生标签与公式未漂移', async () => {
		// c = SHA256("hashwx:C:" + secret + ":" + cid)，冒号分隔符与顺序不可改
		expect(await localSha256Hex(`hashwx:C:${SECRET}:${fixture.cid}`)).toBe(fixture.hashwx.c);
	});

	it('实测实现：createChallenge 的 v2 字段与本地复算一致', async () => {
		const challenge = await createChallenge(bindings, IP, SLUG);
		const payload = JSON.parse(fromB64url(challenge.prefix));

		// 载荷字段顺序与内容（slug 参与签名，挑战因此绑定到 fixture 里的文章）
		expect(Object.keys(payload)).toEqual(['v', 'cid', 'iph', 'slug', 'iat']);
		expect(payload.v).toBe(2);
		expect(payload.cid).toBe(challenge.challenge_id);
		expect(payload.iph).toBe(fixture.ipHash);
		expect(payload.slug).toBe(SLUG);

		// 签名口径
		expect(challenge.sig).toBe(await localHmac(challenge.prefix, SECRET));
		expect(challenge.expires_in).toBe(600);

		// HashWX 参数：c 由（密钥, cid）派生，d 为总难度 1000 按 count=4 均分
		expect(challenge.pow.algo).toBe('hashwx');
		expect(challenge.pow.c).toBe(await localSha256Hex(`hashwx:C:${SECRET}:${challenge.challenge_id}`));
		expect(challenge.pow.c).toMatch(/^[0-9a-f]{64}$/);
		expect(challenge.pow.d).toBe(fixture.hashwx.d);
		expect(challenge.pow.n).toBe(fixture.hashwx.n);
		expect(challenge.pow.count).toBe(fixture.hashwx.count);

		// 默认不开启第二层：instr 字段整个缺席
		expect(challenge.instr).toBeUndefined();
	});

	it('实测实现：票据签名与本地复算一致（字段顺序 + HMAC + v=2）', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		const dot = ticket.lastIndexOf('.');
		const body = ticket.slice(0, dot);
		const sig = ticket.slice(dot + 1);

		expect(sig).toBe(await localHmac(body, SECRET));

		const payload = JSON.parse(fromB64url(body));
		expect(Object.keys(payload)).toEqual(['v', 'iph', 'slug', 'iat', 'exp', 'jti']);
		expect(payload.v).toBe(2);
		expect(payload.iph).toBe(fixture.ipHash);
		expect(payload.slug).toBe(SLUG);
		expect(payload.exp - payload.iat).toBe(300 * 1000);
	});

	it('fixture 的 prefix + 签名能走通全链路（时间冻结在有效期内）', async () => {
		// fixture 里的 c 是（密钥, cid）派生出来的 HashWX 挑战：用替身求解出 nonces
		const spec = mintHashwxSpec({
			challenge: hexToBytes(fixture.hashwx.c),
			difficulty: fixture.difficulty,
			noncesPerHash: fixture.hashwx.n,
			count: fixture.hashwx.count,
		});
		expect(spec).toEqual({
			c: fixture.hashwx.c,
			d: fixture.hashwx.d,
			n: fixture.hashwx.n,
			count: fixture.hashwx.count,
		});
		const nonces = await solveHashwxSpec(spec);

		const spy = vi.spyOn(Date, 'now').mockReturnValue(fixture.iat + 1000);
		try {
			// 固定向量里签的是 slug = fixture.slug：换一篇文章兑换必须被拒（且不消耗挑战）
			expect(
				await verifySolution(bindings, {
					prefix: fixture.prefix,
					sig: fixture.sig,
					nonces,
					elapsedMs: 1000,
					ip: IP,
					postSlug: '/posts/other',
				})
			).toEqual({ ok: false, reason: 'slug mismatch' });

			expect(
				await verifySolution(bindings, {
					prefix: fixture.prefix,
					sig: fixture.sig,
					nonces,
					elapsedMs: 1000,
					ip: IP,
					postSlug: SLUG,
				})
			).toEqual({ ok: true });

			// 挑战单次使用：同一 prefix 不能二次兑换（即使换个 nonces）
			expect(
				await verifySolution(bindings, {
					prefix: fixture.prefix,
					sig: fixture.sig,
					nonces,
					elapsedMs: 1000,
					ip: IP,
					postSlug: SLUG,
				})
			).toEqual({ ok: false, reason: 'challenge already used' });

			// fixture 票据在有效期内可以通过校验
			expect(await verifyTicket(bindings, `${fixture.ticketBody}.${fixture.ticketSig}`, IP, SLUG)).toBe(
				true
			);
		} finally {
			spy.mockRestore();
		}
	});

	it('Instrumentation 程序派生与两份 fixture 自洽', async () => {
		// 同一（密钥, cid）在 verify-v2.json 与 instrumentation-v2.json 里必须得到同一程序
		const sameCid = (instrFixture.vectors as Array<any>).find((v) => v.cid === fixture.cid);
		expect(sameCid, `instrumentation fixture 里缺少 cid=${fixture.cid} 的向量`).toBeDefined();
		expect(fixture.instrumentation.seed).toBe(sameCid.seed);
		expect(fixture.instrumentation.ops).toEqual(sameCid.ops);
		expect(fixture.instrumentation.regs).toEqual(sameCid.regs);

		// fixture 里的 ops 必须真的是登记程序的字节（生成器口径一致）
		const { generateProgram, interpretProgram } = await import('../../src/utils/instrumentation');
		expect((await generateProgram(hexToBytes(sameCid.seed))).ops).toEqual(sameCid.ops);
		expect(interpretProgram({ ops: sameCid.ops }).regs).toEqual(sameCid.regs);
	});

	it('v1 遗留配置在新语义下正确迁移（fixture 难度 1000 未被改写）', async () => {
		expect(await getDifficulty(bindings)).toBe(fixture.difficulty);
		await seedSettings({ comment_verify_difficulty: '12' });
		expect(await getDifficulty(bindings)).toBe(4096);
		await seedSettings({ comment_verify_difficulty: '20' });
		expect(await getDifficulty(bindings)).toBe(1_048_576);
	});
});
