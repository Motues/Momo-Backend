/**
 * src/utils/verify.ts —— 无感验证（挑战 / 解题 / 票据）在 D1+KV 上的完整链路。
 *
 * 说明：verify.ts 会把首次生成的签名密钥缓存在模块级变量 `cachedSecret` 中，
 * 而 isolatedStorage 只回滚数据库、不回滚模块状态。为了让签名在用例之间保持可复现，
 * 每个用例都在 beforeEach 里把 `comment_verify_secret` 预置为跨语言测试向量里的密钥，
 * 于是本文件所有签名都可以用同一个 SECRET 独立复算。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSchema, rawSettings, seedSettings, testEnv } from '../helpers/db';
import {
	TICKET_TTL_SECONDS,
	createChallenge,
	createTicket,
	getDifficulty,
	getPublicVerifyConfig,
	isVerifyEnabled,
	verifySolution,
	verifyTicket,
} from '../../src/utils/verify';
import {
	fromBase64url,
	hashVerifyIp,
	hmacSHA256,
	toBase64url,
	workFor,
} from '../../src/utils/verifyCrypto';

/** 与 go/internal/pkg/utils/verify_consistency_test.go 完全一致的密钥 */
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const IP = '::ffff:127.0.0.1';
const OTHER_IP = '10.9.8.7';
const SLUG = '/posts/vector-check';
/** 向量中的蜜罐字段名（secret + slug 与向量相同，因此可以直接比对） */
const VECTOR_HONEYPOT = 'v_77dc2477f6';

const bindings = testEnv;

beforeEach(async () => {
	await createSchema();
	await seedSettings({ comment_verify_secret: SECRET });
});

/** 让验证处于「开启 + 指定难度」状态 */
async function enableVerify(difficulty = 8): Promise<void> {
	await seedSettings({ comment_verify_enabled: 'true', comment_verify_difficulty: String(difficulty) });
}

/** 暴力求解一个满足难度的 nonce */
async function solve(prefix: string, difficulty: number): Promise<number> {
	for (let nonce = 0; nonce < 5_000_000; nonce++) {
		if ((await workFor(prefix, nonce)) >= difficulty) return nonce;
	}
	throw new Error(`未能在合理范围内为 prefix 求解难度 ${difficulty}`);
}

/** 找一个明确不满足难度的 nonce（用于 insufficient work 分支） */
async function findLazyNonce(prefix: string, difficulty: number): Promise<number> {
	for (let nonce = 0; nonce < 100_000; nonce++) {
		if ((await workFor(prefix, nonce)) < difficulty) return nonce;
	}
	throw new Error('未能找到不满足难度的 nonce');
}

/** 用固定密钥手工构造一个带合法签名的前缀 */
async function craftPrefix(payload: unknown): Promise<{ prefix: string; sig: string }> {
	const prefix = toBase64url(typeof payload === 'string' ? payload : JSON.stringify(payload));
	return { prefix, sig: await hmacSHA256(prefix, SECRET) };
}

function decodePrefix(prefix: string): { cid: string; iph: string; iat: number } {
	return JSON.parse(new TextDecoder().decode(fromBase64url(prefix)));
}

describe('isVerifyEnabled', () => {
	it('默认（未配置）为关闭', async () => {
		expect(await isVerifyEnabled(bindings)).toBe(false);
	});

	it('仅字符串 "true" 视为开启', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		expect(await isVerifyEnabled(bindings)).toBe(true);
	});

	it('"TRUE" / "1" / 空串都不算开启', async () => {
		for (const value of ['TRUE', 'True', '1', '', 'yes']) {
			await seedSettings({ comment_verify_enabled: value });
			expect(await isVerifyEnabled(bindings)).toBe(false);
		}
	});
});

describe('getDifficulty', () => {
	it('未配置时使用默认难度 18', async () => {
		expect(await getDifficulty(bindings)).toBe(18);
	});

	it('无法解析时回落到默认难度', async () => {
		await seedSettings({ comment_verify_difficulty: 'abc' });
		expect(await getDifficulty(bindings)).toBe(18);
		await seedSettings({ comment_verify_difficulty: '' });
		expect(await getDifficulty(bindings)).toBe(18);
	});

	it('低于下限 8 时被抬到 8', async () => {
		await seedSettings({ comment_verify_difficulty: '0' });
		expect(await getDifficulty(bindings)).toBe(8);
		await seedSettings({ comment_verify_difficulty: '5' });
		expect(await getDifficulty(bindings)).toBe(8);
	});

	it('高于上限 26 时被压到 26', async () => {
		await seedSettings({ comment_verify_difficulty: '27' });
		expect(await getDifficulty(bindings)).toBe(26);
		await seedSettings({ comment_verify_difficulty: '999' });
		expect(await getDifficulty(bindings)).toBe(26);
	});

	it('边界值 8 / 26 原样通过', async () => {
		await seedSettings({ comment_verify_difficulty: '8' });
		expect(await getDifficulty(bindings)).toBe(8);
		await seedSettings({ comment_verify_difficulty: '26' });
		expect(await getDifficulty(bindings)).toBe(26);
	});

	it('parseInt 语义：带后缀取前缀数字', async () => {
		await seedSettings({ comment_verify_difficulty: '12abc' });
		expect(await getDifficulty(bindings)).toBe(12);
	});
});

describe('getPublicVerifyConfig', () => {
	it('关闭时返回 false + 空蜜罐字段，且不产生任何写库副作用', async () => {
		const before = await rawSettings();
		const config = await getPublicVerifyConfig(bindings, SLUG);
		expect(config).toEqual({ verify_enabled: 'false', verify_honeypot: '' });
		expect(await rawSettings()).toEqual(before);
	});

	it('开启时返回 true，并按文章派生蜜罐字段名', async () => {
		await enableVerify();
		const config = await getPublicVerifyConfig(bindings, SLUG);
		expect(config.verify_enabled).toBe('true');
		// secret 与 slug 都等于跨语言向量，因此可直接比对固定值
		expect(config.verify_honeypot).toBe(VECTOR_HONEYPOT);
	});

	it('不同文章得到不同蜜罐字段名', async () => {
		await enableVerify();
		const a = await getPublicVerifyConfig(bindings, '/posts/a');
		const b = await getPublicVerifyConfig(bindings, '/posts/b');
		expect(a.verify_honeypot).not.toBe(b.verify_honeypot);
		expect(a.verify_honeypot).toMatch(/^v_[0-9a-f]{10}$/);
	});
});

describe('createChallenge', () => {
	it('返回约定的字段集合与有效期（600 秒）', async () => {
		await enableVerify(12);
		const challenge = await createChallenge(bindings, IP);
		expect(challenge.expires_in).toBe(600);
		expect(challenge.difficulty).toBe(12);
		expect(challenge.challenge_id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge.prefix).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge.sig).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('prefix 载荷中的 iph 与 iat 符合约定', async () => {
		await enableVerify(8);
		const before = Date.now();
		const challenge = await createChallenge(bindings, IP);
		const payload = decodePrefix(challenge.prefix);

		expect(payload.cid).toBe(challenge.challenge_id);
		expect(payload.iph).toBe(await hashVerifyIp(IP, SECRET));
		expect(payload.iat).toBeGreaterThanOrEqual(before);
		expect(payload.iat).toBeLessThanOrEqual(Date.now());
	});

	it('签名可以用同一密钥独立复算', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		expect(challenge.sig).toBe(await hmacSHA256(challenge.prefix, SECRET));
	});

	it('每次签发都得到不同的 challenge_id', async () => {
		await enableVerify(8);
		const first = await createChallenge(bindings, IP);
		const second = await createChallenge(bindings, IP);
		expect(first.challenge_id).not.toBe(second.challenge_id);
		expect(first.prefix).not.toBe(second.prefix);
	});

	it('难度跟随设置项', async () => {
		await enableVerify(9);
		expect((await createChallenge(bindings, IP)).difficulty).toBe(9);
		await seedSettings({ comment_verify_difficulty: '99' });
		expect((await createChallenge(bindings, IP)).difficulty).toBe(26);
	});
});

describe('verifySolution —— 失败分支', () => {
	it('缺少 prefix 或 sig 时返回 missing challenge', async () => {
		await enableVerify(8);
		const base = { nonce: 0, elapsedMs: 500, ip: IP };
		expect(await verifySolution(bindings, { ...base, prefix: '', sig: 'x' })).toEqual({
			ok: false,
			reason: 'missing challenge',
		});
		expect(await verifySolution(bindings, { ...base, prefix: 'x', sig: '' })).toEqual({
			ok: false,
			reason: 'missing challenge',
		});
	});

	it('签名不匹配时返回 bad signature', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: `${challenge.sig}tampered`,
				nonce: 0,
				elapsedMs: 500,
				ip: IP,
			})
		).toEqual({ ok: false, reason: 'bad signature' });
	});

	it('prefix 不是合法 base64url 时返回 malformed prefix', async () => {
		await enableVerify(8);
		const { prefix, sig } = await craftPrefix('!!!not-base64!!!');
		expect(
			await verifySolution(bindings, { prefix, sig, nonce: 0, elapsedMs: 500, ip: IP })
		).toEqual({ ok: false, reason: 'malformed prefix' });
	});

	it('prefix 解出的载荷结构不对时返回 malformed payload', async () => {
		await enableVerify(8);
		for (const payload of ['null', '{}', '{"cid":1,"iph":"x","iat":1}', '{"cid":"a","iph":1,"iat":1}', '"str"']) {
			const crafted = await craftPrefix(payload);
			expect(
				await verifySolution(bindings, {
					prefix: crafted.prefix,
					sig: crafted.sig,
					nonce: 0,
					elapsedMs: 500,
					ip: IP,
				})
			).toEqual({ ok: false, reason: 'malformed payload' });
		}
	});

	it('挑战超过 10 分钟返回 challenge expired', async () => {
		await enableVerify(8);
		const { prefix, sig } = await craftPrefix({
			cid: 'expired-cid',
			iph: await hashVerifyIp(IP, SECRET),
			iat: Date.now() - 11 * 60 * 1000,
		});
		expect(
			await verifySolution(bindings, { prefix, sig, nonce: 0, elapsedMs: 500, ip: IP })
		).toEqual({ ok: false, reason: 'challenge expired' });
	});

	it('签发时间在未来超过 60 秒返回 challenge from the future', async () => {
		await enableVerify(8);
		const { prefix, sig } = await craftPrefix({
			cid: 'future-cid',
			iph: await hashVerifyIp(IP, SECRET),
			iat: Date.now() + 2 * 60 * 1000,
		});
		expect(
			await verifySolution(bindings, { prefix, sig, nonce: 0, elapsedMs: 500, ip: IP })
		).toEqual({ ok: false, reason: 'challenge from the future' });
	});

	it('漂移 60 秒以内的「未来」时间被容忍', async () => {
		await enableVerify(8);
		const { prefix, sig } = await craftPrefix({
			cid: 'skew-cid',
			iph: await hashVerifyIp(IP, SECRET),
			iat: Date.now() + 30 * 1000,
		});
		// 时钟偏移可容忍，因此继续往下走并因工作量不足而失败
		const result = await verifySolution(bindings, { prefix, sig, nonce: 0, elapsedMs: 500, ip: IP });
		expect(result).toEqual({ ok: false, reason: 'insufficient work' });
	});

	it('换 IP 解题返回 ip mismatch', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonce: 0,
				elapsedMs: 500,
				ip: OTHER_IP,
			})
		).toEqual({ ok: false, reason: 'ip mismatch' });
	});

	it('耗时不可信（过快 / 过慢 / NaN）返回 implausible timing', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		for (const elapsedMs of [0, 299, 10 * 60 * 1000 + 1, NaN, Infinity]) {
			expect(
				await verifySolution(bindings, {
					prefix: challenge.prefix,
					sig: challenge.sig,
					nonce: 0,
					elapsedMs,
					ip: IP,
				})
			).toEqual({ ok: false, reason: 'implausible timing' });
		}
	});

	it('耗时下界 300ms 与上界 10 分钟本身是合法值', async () => {
		await enableVerify(8);

		const lower = await createChallenge(bindings, IP);
		const lowerNonce = await solve(lower.prefix, 8);
		expect(
			await verifySolution(bindings, {
				prefix: lower.prefix,
				sig: lower.sig,
				nonce: lowerNonce,
				elapsedMs: 300,
				ip: IP,
			})
		).toEqual({ ok: true });

		const upper = await createChallenge(bindings, IP);
		const upperNonce = await solve(upper.prefix, 8);
		expect(
			await verifySolution(bindings, {
				prefix: upper.prefix,
				sig: upper.sig,
				nonce: upperNonce,
				elapsedMs: 10 * 60 * 1000,
				ip: IP,
			})
		).toEqual({ ok: true });
	});

	it('nonce 为负数或非整数返回 bad nonce', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		for (const nonce of [-1, -100, 1.5, NaN]) {
			expect(
				await verifySolution(bindings, {
					prefix: challenge.prefix,
					sig: challenge.sig,
					nonce,
					elapsedMs: 500,
					ip: IP,
				})
			).toEqual({ ok: false, reason: 'bad nonce' });
		}
	});

	it('工作量不足返回 insufficient work', async () => {
		await enableVerify(18);
		const challenge = await createChallenge(bindings, IP);
		const nonce = await findLazyNonce(challenge.prefix, 18);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonce,
				elapsedMs: 500,
				ip: IP,
			})
		).toEqual({ ok: false, reason: 'insufficient work' });
	});

	it('难度越高，同一个 nonce 越可能不达标', async () => {
		await enableVerify(26);
		const challenge = await createChallenge(bindings, IP);
		const result = await verifySolution(bindings, {
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce: 0,
			elapsedMs: 500,
			ip: IP,
		});
		expect(result).toEqual({ ok: false, reason: 'insufficient work' });
	});
});

describe('verifySolution —— 成功与重放', () => {
	it('正确解出后返回 ok', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonce,
				elapsedMs: 500,
				ip: IP,
			})
		).toEqual({ ok: true });
	});

	it('同一挑战的同一 nonce 不能被重复兑换', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const params = {
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
			elapsedMs: 500,
			ip: IP,
		};
		expect(await verifySolution(bindings, params)).toEqual({ ok: true });
		expect(await verifySolution(bindings, params)).toEqual({ ok: false, reason: 'replayed nonce' });
	});

	it('同一挑战换一个同样达标的 nonce 仍然可以兑换', async () => {
		await enableVerify(8);
		const challenge = await createChallenge(bindings, IP);
		const first = await solve(challenge.prefix, 8);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonce: first,
				elapsedMs: 500,
				ip: IP,
			})
		).toEqual({ ok: true });

		// 找到第二个达标且未被使用过的 nonce
		let second = first + 1;
		while ((await workFor(challenge.prefix, second)) < 8) second++;
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonce: second,
				elapsedMs: 500,
				ip: IP,
			})
		).toEqual({ ok: true });
	});
});

describe('createTicket / verifyTicket', () => {
	it('票据有效期为 5 分钟（TICKET_TTL_SECONDS）', () => {
		expect(TICKET_TTL_SECONDS).toBe(300);
	});

	it('自己签发的票据可以通过校验', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(true);
	});

	it('票据载荷符合约定（v=1、ip 哈希、slug、exp-iat=300s）', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		const [body] = ticket.split('.');
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
		expect(payload.v).toBe(1);
		expect(payload.iph).toBe(await hashVerifyIp(IP, SECRET));
		expect(payload.slug).toBe(SLUG);
		expect(payload.exp - payload.iat).toBe(300 * 1000);
		expect(typeof payload.jti).toBe('string');
	});

	it('不跨 IP 有效', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(await verifyTicket(bindings, ticket, OTHER_IP, SLUG)).toBe(false);
		// hashVerifyIp 是对「IP 原始字符串」做哈希，不做 IPv4-mapped 归一化，
		// 因此同一主机的另一种写法也不通用（三端口径一致：都以请求头原值为准）。
		expect(await verifyTicket(bindings, ticket, '127.0.0.1', SLUG)).toBe(false);
	});

	it('不跨文章有效', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(await verifyTicket(bindings, ticket, IP, '/posts/other')).toBe(false);
	});

	it('被篡改的签名不通过', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(await verifyTicket(bindings, ticket.slice(0, -4) + 'aaaa', IP, SLUG)).toBe(false);
		expect(await verifyTicket(bindings, `${ticket}x`, IP, SLUG)).toBe(false);
	});

	it('被篡改的载荷不通过（签名不再匹配）', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		const [, sig] = ticket.split('.');
		const forgedBody = toBase64url(
			JSON.stringify({ v: 1, iph: 'x', slug: SLUG, iat: Date.now(), exp: Date.now() + 300000, jti: 'y' })
		);
		expect(await verifyTicket(bindings, `${forgedBody}.${sig}`, IP, SLUG)).toBe(false);
	});

	it('空值 / 无点号 / 点号在开头都不通过', async () => {
		expect(await verifyTicket(bindings, undefined, IP, SLUG)).toBe(false);
		expect(await verifyTicket(bindings, '', IP, SLUG)).toBe(false);
		expect(await verifyTicket(bindings, 'nodot', IP, SLUG)).toBe(false);
		expect(await verifyTicket(bindings, '.sig', IP, SLUG)).toBe(false);
	});

	it('过期票据不通过', async () => {
		const now = Date.now();
		const body = toBase64url(
			JSON.stringify({
				v: 1,
				iph: await hashVerifyIp(IP, SECRET),
				slug: SLUG,
				iat: now - 600000,
				exp: now - 1,
				jti: 'expired',
			})
		);
		const ticket = `${body}.${await hmacSHA256(body, SECRET)}`;
		expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(false);
	});

	it('版本号不为 1 的票据不通过', async () => {
		const now = Date.now();
		const body = toBase64url(
			JSON.stringify({
				v: 2,
				iph: await hashVerifyIp(IP, SECRET),
				slug: SLUG,
				iat: now,
				exp: now + 300000,
				jti: 'v2',
			})
		);
		const ticket = `${body}.${await hmacSHA256(body, SECRET)}`;
		expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(false);
	});

	it('用别的密钥签发的票据不通过', async () => {
		const now = Date.now();
		const body = toBase64url(
			JSON.stringify({
				v: 1,
				iph: await hashVerifyIp(IP, SECRET),
				slug: SLUG,
				iat: now,
				exp: now + 300000,
				jti: 'other-key',
			})
		);
		const ticket = `${body}.${await hmacSHA256(body, 'a-different-secret')}`;
		expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(false);
	});
});
