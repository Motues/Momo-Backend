/**
 * src/utils/verify.ts —— 无感验证（协议 v2：HashWX 挑战 / 单次使用 / 票据）在 D1 上的完整链路。
 *
 * 测试环境的两个关键前提：
 *
 * 1. **HashWX 是替身**：生产代码用静态 `.wasm` 导入，而 vitest-pool-workers 无法加载 .wasm
 *    （见 test/stubs/hashwx.ts 与 test/helpers/hashwxMock.ts）。setup file 已把
 *    `src/utils/hashwx.ts` 整体替换成纯 JS 替身，因此本文件里需要遍历 nonce 的用例
 *    用替身的 `solveHashwxSpec` 求解；协议逻辑（派生标签、签名、时效、IP 绑定、单次使用、
 *    PROTOCOL_OUTDATED、设置项、蜜罐）测的都是**真实实现**。
 *    真实 .wasm 路径由 wrangler 运行时验证。
 *
 * 2. **模块级密钥缓存**：verify.ts 会把首次生成的签名密钥缓存在 `cachedSecret`，
 *    而 isolatedStorage 只回滚数据库、不回滚模块状态。因此每个用例都在 beforeEach 里
 *    把 `comment_verify_secret` 预置为固定 SECRET，这样所有签名都能独立复算。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSchema, rawSettings, seedSettings, testEnv } from '../helpers/db';
import {
	TICKET_TTL_SECONDS,
	VERIFY_PROTOCOL_VERSION,
	createChallenge,
	createTicket,
	getDifficulty,
	getPublicVerifyConfig,
	isInstrumentationEnabled,
	isVerifyEnabled,
	shouldBlockAutomated,
	verifySolution,
	verifyTicket,
} from '../../src/utils/verify';
import { createInstrumentationChallenge, interpretProgram } from '../../src/utils/instrumentation';
import {
	fromBase64url,
	hashVerifyIp,
	hmacSHA256,
	honeypotFieldName,
	toBase64url,
} from '../../src/utils/verifyCrypto';
import { solveHashwxSpec } from '../stubs/hashwx';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const IP = '::ffff:127.0.0.1';
const OTHER_IP = '10.9.8.7';
const SLUG = '/posts/vector-check';
/** 向量中的蜜罐字段名（secret + slug 与向量相同，因此可以直接比对） */
const VECTOR_HONEYPOT = 'v_77dc2477f6';

/** 测试统一使用很小的总难度：替身求解 4 个子挑战（d=250）约 1000 次 SHA-256，毫秒级 */
const TEST_DIFFICULTY = '1000';
const TEST_SUB_DIFFICULTY = 250;

const bindings = testEnv;

beforeEach(async () => {
	await createSchema();
	await seedSettings({ comment_verify_secret: SECRET, comment_verify_difficulty: TEST_DIFFICULTY });
});

/** 让验证处于「开启」状态 */
async function enableVerify(extra: Record<string, string> = {}): Promise<void> {
	await seedSettings({ comment_verify_enabled: 'true', ...extra });
}

type Pow = { c: string; d: number; n: number; count: number };

/** 用替身求解一个 HashWX 挑战，返回与子挑战一一对应的十进制字符串 */
async function solve(pow: Pow): Promise<string[]> {
	return solveHashwxSpec({ c: pow.c, d: pow.d, n: pow.n, count: pow.count });
}

/** 用固定密钥手工构造一个带合法签名的前缀 */
async function craftPrefix(payload: unknown): Promise<{ prefix: string; sig: string }> {
	const prefix = toBase64url(typeof payload === 'string' ? payload : JSON.stringify(payload));
	return { prefix, sig: await hmacSHA256(prefix, SECRET) };
}

function decodePrefix(prefix: string): { v: number; cid: string; iph: string; slug: string; iat: number } {
	return JSON.parse(new TextDecoder().decode(fromBase64url(prefix)));
}

describe('isVerifyEnabled / isInstrumentationEnabled / shouldBlockAutomated', () => {
	it('默认（未配置）全部为关闭', async () => {
		expect(await isVerifyEnabled(bindings)).toBe(false);
		expect(await isInstrumentationEnabled(bindings)).toBe(false);
		expect(await shouldBlockAutomated(bindings)).toBe(false);
	});

	it('仅字符串 "true" 视为开启', async () => {
		await seedSettings({
			comment_verify_enabled: 'true',
			comment_verify_instr_enabled: 'true',
			comment_verify_block_automated: 'true',
		});
		expect(await isVerifyEnabled(bindings)).toBe(true);
		expect(await isInstrumentationEnabled(bindings)).toBe(true);
		expect(await shouldBlockAutomated(bindings)).toBe(true);
	});

	it('"TRUE" / "1" / 空串都不算开启', async () => {
		for (const value of ['TRUE', 'True', '1', '', 'yes']) {
			await seedSettings({
				comment_verify_enabled: value,
				comment_verify_instr_enabled: value,
				comment_verify_block_automated: value,
			});
			expect(await isVerifyEnabled(bindings)).toBe(false);
			expect(await isInstrumentationEnabled(bindings)).toBe(false);
			expect(await shouldBlockAutomated(bindings)).toBe(false);
		}
	});
});

describe('getDifficulty（协议 v2：总期望哈希次数 + v1 旧值迁移）', () => {
	it('未配置时使用默认总工作量 1000000', async () => {
		// 去掉 beforeEach 预置的难度
		await testEnv.MOMO_DB.prepare("DELETE FROM Settings WHERE key = 'comment_verify_difficulty'").run();
		expect(await getDifficulty(bindings)).toBe(1_000_000);
	});

	it('非法值回落到默认总工作量', async () => {
		for (const raw of ['abc', '', '0', '-5']) {
			await seedSettings({ comment_verify_difficulty: raw });
			expect(await getDifficulty(bindings)).toBe(1_000_000);
		}
	});

	it('合法值原样返回（新语义：总哈希次数）', async () => {
		await seedSettings({ comment_verify_difficulty: '1000' });
		expect(await getDifficulty(bindings)).toBe(1000);
		await seedSettings({ comment_verify_difficulty: '512000' });
		expect(await getDifficulty(bindings)).toBe(512000);
	});

	it('兼容 v1 历史配置：≤26 按 2^值 迁移为总工作量', async () => {
		// v1 语义是「前导 0 比特数」，8 位约等于 256 次哈希，低于下限后被钳到 1000
		await seedSettings({ comment_verify_difficulty: '8' });
		expect(await getDifficulty(bindings)).toBe(1000);
		// 12 位 => 4096 次，高于下限，原样迁移
		await seedSettings({ comment_verify_difficulty: '12' });
		expect(await getDifficulty(bindings)).toBe(4096);
		// parseInt 语义：带后缀取前缀数字（与 v1 的容错口径一致）
		await seedSettings({ comment_verify_difficulty: '12abc' });
		expect(await getDifficulty(bindings)).toBe(4096);
		// dashboard 的「高」档：20 位 => 1048576 次（这也是迁移上限）
		await seedSettings({ comment_verify_difficulty: '20' });
		expect(await getDifficulty(bindings)).toBe(1_048_576);
		// 21–26 位换算后是 209 万–6710 万次：在 v1 时代那本就是分钟级谜题，
		// 因此统一钳到最高档，避免升级后把访客卡住。
		await seedSettings({ comment_verify_difficulty: '21' });
		expect(await getDifficulty(bindings)).toBe(1_048_576);
		await seedSettings({ comment_verify_difficulty: '26' });
		expect(await getDifficulty(bindings)).toBe(1_048_576);
		// 27 已超出 v1 取值上界，按新语义当作总工作量 27，被下限钳到 1000
		await seedSettings({ comment_verify_difficulty: '27' });
		expect(await getDifficulty(bindings)).toBe(1000);
	});

	it('上下限：低于 1000 钳到 1000，高于 1e9 钳到 1e9', async () => {
		await seedSettings({ comment_verify_difficulty: '999' });
		expect(await getDifficulty(bindings)).toBe(1000);
		await seedSettings({ comment_verify_difficulty: '1000000000' });
		expect(await getDifficulty(bindings)).toBe(1_000_000_000);
		await seedSettings({ comment_verify_difficulty: '1000000001' });
		expect(await getDifficulty(bindings)).toBe(1_000_000_000);
		await seedSettings({ comment_verify_difficulty: '999999999999' });
		expect(await getDifficulty(bindings)).toBe(1_000_000_000);
	});
});

describe('getPublicVerifyConfig', () => {
	it('关闭时返回 false + 空蜜罐字段 + version 2，且不产生任何写库副作用', async () => {
		const before = await rawSettings();
		const config = await getPublicVerifyConfig(bindings, SLUG);
		expect(config).toEqual({ verify_enabled: 'false', verify_honeypot: '', verify_version: '2' });
		expect(await rawSettings()).toEqual(before);
	});

	it('开启时返回 true，并按文章派生蜜罐字段名', async () => {
		await enableVerify();
		const config = await getPublicVerifyConfig(bindings, SLUG);
		expect(config.verify_enabled).toBe('true');
		expect(config.verify_version).toBe(String(VERIFY_PROTOCOL_VERSION));
		// secret 与 slug 都等于跨语言向量，因此可直接比对固定值
		expect(config.verify_honeypot).toBe(VECTOR_HONEYPOT);
		expect(config.verify_honeypot).toBe(await honeypotFieldName(SLUG, SECRET));
	});

	it('不同文章得到不同蜜罐字段名', async () => {
		await enableVerify();
		const a = await getPublicVerifyConfig(bindings, '/posts/a');
		const b = await getPublicVerifyConfig(bindings, '/posts/b');
		expect(a.verify_honeypot).not.toBe(b.verify_honeypot);
		expect(a.verify_honeypot).toMatch(/^v_[0-9a-f]{10}$/);
	});
});

describe('createChallenge（协议 v2）', () => {
	it('返回约定的字段集合、有效期与 HashWX 参数', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);

		expect(challenge.expires_in).toBe(600);
		// 16 字节 base64url 无填充 => 22 个字符
		expect(challenge.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(challenge.prefix).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge.sig).toMatch(/^[A-Za-z0-9_-]+$/);

		// HashWX：总难度 1000 按 count=4 均分到各子挑战
		expect(challenge.pow.algo).toBe('hashwx');
		expect(challenge.pow.c).toMatch(/^[0-9a-f]{64}$/);
		expect(challenge.pow.d).toBe(TEST_SUB_DIFFICULTY);
		expect(challenge.pow.n).toBe(65536);
		expect(challenge.pow.count).toBe(4);
	});

	it('prefix 载荷为 {"v":2,"cid":…,"iph":…,"slug":…,"iat":…}（字段顺序固定）', async () => {
		await enableVerify();
		const before = Date.now();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const payload = decodePrefix(challenge.prefix);

		// slug 也被签进载荷：挑战因此绑定到这篇文章，只有同一篇文章才能兑换票据
		expect(Object.keys(payload)).toEqual(['v', 'cid', 'iph', 'slug', 'iat']);
		expect(payload.v).toBe(VERIFY_PROTOCOL_VERSION);
		expect(payload.cid).toBe(challenge.challenge_id);
		expect(payload.iph).toBe(await hashVerifyIp(IP, SECRET));
		expect(payload.slug).toBe(SLUG);
		expect(payload.iat).toBeGreaterThanOrEqual(before);
		expect(payload.iat).toBeLessThanOrEqual(Date.now());
	});

	it('签名可以用同一密钥独立复算', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(challenge.sig).toBe(await hmacSHA256(challenge.prefix, SECRET));
	});

	it('每次签发都得到不同的 challenge_id 与不同的 c', async () => {
		await enableVerify();
		const first = await createChallenge(bindings, IP, SLUG);
		const second = await createChallenge(bindings, IP, SLUG);
		expect(first.challenge_id).not.toBe(second.challenge_id);
		expect(first.prefix).not.toBe(second.prefix);
		expect(first.pow.c).not.toBe(second.pow.c);
	});

	it('难度跟随设置项（总工作量 / count）', async () => {
		await enableVerify();
		await seedSettings({ comment_verify_difficulty: '512000' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(challenge.pow.d).toBe(128000);
		// 旧值 12 => 4096 次 => d = 1024
		await seedSettings({ comment_verify_difficulty: '12' });
		expect((await createChallenge(bindings, IP, SLUG)).pow.d).toBe(1024);
		// 999 被钳到 1000 => d = 250
		await seedSettings({ comment_verify_difficulty: '999' });
		expect((await createChallenge(bindings, IP, SLUG)).pow.d).toBe(250);
	});

	it('默认不下发第二层程序（instr 字段整个缺席）', async () => {
		await enableVerify();
		expect((await createChallenge(bindings, IP, SLUG)).instr).toBeUndefined();
	});

	it('开启 comment_verify_instr_enabled 时下发程序与字体采样条数', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(challenge.instr).toBeDefined();

		// 程序必须由（密钥, cid）确定性派生：与直接调用派生函数的结果逐位一致
		const expected = await createInstrumentationChallenge(challenge.challenge_id, SECRET);
		expect(challenge.instr!.ops).toEqual(expected.ops);
		expect(challenge.instr!.fonts).toBe(17);
		expect(challenge.instr!.ops.length % 3).toBe(0);
	});

	it('IP 只影响 iph，不影响挑战参数派生', async () => {
		await enableVerify();
		const a = await createChallenge(bindings, IP, SLUG);
		const b = await createChallenge(bindings, OTHER_IP, SLUG);
		expect(decodePrefix(a.prefix).iph).not.toBe(decodePrefix(b.prefix).iph);
		// c 只由（密钥, cid）决定，与 IP 无关
		expect(a.pow.c).toBe(await sha256HexLocal(`hashwx:C:${SECRET}:${a.challenge_id}`));
	});
});

/** 与实现无关的本地摘要副本（只用于交叉验证派生标签） */
async function sha256HexLocal(text: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	);
	return Array.from(digest)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('verifySolution —— 失败分支', () => {
	it('缺少 prefix 或 sig 时返回 missing challenge', async () => {
		await enableVerify();
		const base = { nonces: ['1', '2', '3', '4'], elapsedMs: 500, ip: IP, postSlug: SLUG };
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
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: `${challenge.sig}tampered`,
				nonces: ['1', '2', '3', '4'],
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'bad signature' });
	});

	it('prefix 不是合法 base64url / 不是 JSON 时返回 malformed prefix', async () => {
		await enableVerify();
		const { prefix, sig } = await craftPrefix('!!!not-json!!!');
		expect(await verifySolution(bindings, { prefix, sig, nonces: [], elapsedMs: 500, ip: IP, postSlug: SLUG })).toEqual({
			ok: false,
			reason: 'malformed prefix',
		});
	});

	it('prefix 解出的载荷不是对象或字段形状不对时返回 malformed payload', async () => {
		await enableVerify();
		// 注意：这些载荷都带 v=2（否则会先被协议版本检查拦成 PROTOCOL_OUTDATED）
		for (const payload of [
			'null',
			'"str"',
			'123',
			'{"v":2,"cid":"a"}',
			'{"v":2,"cid":1,"iph":"x","slug":"/posts/x","iat":1}',
			'{"v":2,"cid":"a","iph":1,"slug":"/posts/x","iat":1}',
			'{"v":2,"cid":"a","iph":"x","slug":1,"iat":1}',
			'{"v":2,"cid":"a","iph":"x","slug":"/posts/x","iat":"1"}',
		]) {
			const crafted = await craftPrefix(payload);
			expect(
				await verifySolution(bindings, {
					prefix: crafted.prefix,
					sig: crafted.sig,
					nonces: ['1', '2', '3', '4'],
					elapsedMs: 500,
					ip: IP, postSlug: SLUG,
				}),
				payload
			).toEqual({ ok: false, reason: 'malformed payload' });
		}
	});

	it('v1 载荷（无 v 字段 / v=1）返回 PROTOCOL_OUTDATED 而不是「答案算错」', async () => {
		await enableVerify();
		const iph = await hashVerifyIp(IP, SECRET);
		const now = Date.now();

		// v1 载荷没有 v 字段，也没有 slug（形状校验必须先让位于版本校验）
		const v1 = await craftPrefix({ cid: 'v1-cid', iph, iat: now });
		expect(
			await verifySolution(bindings, {
				prefix: v1.prefix,
				sig: v1.sig,
				nonces: ['1', '2', '3', '4'],
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'PROTOCOL_OUTDATED' });

		// 显式 v=1 同样拒绝
		const explicit = await craftPrefix({ v: 1, cid: 'v1-cid-2', iph, iat: now });
		expect(
			await verifySolution(bindings, {
				prefix: explicit.prefix,
				sig: explicit.sig,
				nonces: ['1', '2', '3', '4'],
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'PROTOCOL_OUTDATED' });

		// 空对象同样先报版本：v 缺失属于「前后端不配套」而不是「载荷畸形」
		const empty = await craftPrefix('{}');
		expect(
			await verifySolution(bindings, {
				prefix: empty.prefix,
				sig: empty.sig,
				nonces: ['1', '2', '3', '4'],
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'PROTOCOL_OUTDATED' });

		// 协议版本判定先于 IP / 时效 / 时序 / 算力：IP 不对、时间也过期，仍然先报版本不匹配
		expect(
			await verifySolution(bindings, {
				prefix: v1.prefix,
				sig: v1.sig,
				nonces: [],
				elapsedMs: 0,
				ip: OTHER_IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'PROTOCOL_OUTDATED' });
	});

	it('挑战超过 10 分钟返回 challenge expired', async () => {
		await enableVerify();
		const { prefix, sig } = await craftPrefix({
			v: 2,
			cid: 'expired-cid',
			iph: await hashVerifyIp(IP, SECRET),
			slug: SLUG,
			iat: Date.now() - 11 * 60 * 1000,
		});
		expect(
			await verifySolution(bindings, { prefix, sig, nonces: ['1', '2', '3', '4'], elapsedMs: 500, ip: IP, postSlug: SLUG })
		).toEqual({ ok: false, reason: 'challenge expired' });
	});

	it('签发时间在未来超过 60 秒返回 challenge from the future', async () => {
		await enableVerify();
		const { prefix, sig } = await craftPrefix({
			v: 2,
			cid: 'future-cid',
			iph: await hashVerifyIp(IP, SECRET),
			slug: SLUG,
			iat: Date.now() + 2 * 60 * 1000,
		});
		expect(
			await verifySolution(bindings, { prefix, sig, nonces: ['1', '2', '3', '4'], elapsedMs: 500, ip: IP, postSlug: SLUG })
		).toEqual({ ok: false, reason: 'challenge from the future' });
	});

	it('漂移 60 秒以内的「未来」时间被容忍（继续往下走）', async () => {
		await enableVerify();
		const { prefix, sig } = await craftPrefix({
			v: 2,
			cid: 'skew-cid',
			iph: await hashVerifyIp(IP, SECRET),
			slug: SLUG,
			iat: Date.now() + 30 * 1000,
		});
		// 时钟偏移可容忍，因此继续往下走并因子挑战数量不匹配而失败
		expect(
			await verifySolution(bindings, { prefix, sig, nonces: [], elapsedMs: 500, ip: IP, postSlug: SLUG })
		).toEqual({ ok: false, reason: 'solution count mismatch' });
	});

	it('换 IP 解题返回 ip mismatch', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: OTHER_IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'ip mismatch' });
	});

	it('耗时不可信（过快 / 过慢 / NaN / Infinity）返回 implausible timing', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		for (const elapsedMs of [0, 49, 10 * 60 * 1000 + 1, NaN, Infinity]) {
			expect(
				await verifySolution(bindings, {
					prefix: challenge.prefix,
					sig: challenge.sig,
					nonces: ['1', '2', '3', '4'],
					elapsedMs,
					ip: IP, postSlug: SLUG,
				}),
				`elapsedMs=${elapsedMs}`
			).toEqual({ ok: false, reason: 'implausible timing' });
		}
	});

	it('时序下限 50ms 与上界 10 分钟本身是合法值', async () => {
		await enableVerify();

		const lower = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: lower.prefix,
				sig: lower.sig,
				nonces: await solve(lower.pow),
				elapsedMs: 50,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: true });

		const upper = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: upper.prefix,
				sig: upper.sig,
				nonces: await solve(upper.pow),
				elapsedMs: 10 * 60 * 1000,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: true });
	});

	it('nonces 数量不匹配 / 非数组时返回 solution count mismatch', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const base = { prefix: challenge.prefix, sig: challenge.sig, elapsedMs: 500, ip: IP, postSlug: SLUG };

		for (const nonces of [undefined, 'nope', [], ['1'], ['1', '2', '3', '4', '5'], 42]) {
			expect(await verifySolution(bindings, { ...base, nonces }), JSON.stringify(nonces)).toEqual({
				ok: false,
				reason: 'solution count mismatch',
			});
		}
	});

	it('nonces 元素为负数 / 非整数 / 畸形字符串时返回 bad nonce', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const base = { prefix: challenge.prefix, sig: challenge.sig, elapsedMs: 500, ip: IP, postSlug: SLUG };

		// 坏值必须放在第 0 位：校验逐个子挑战短路返回，放后面会被「算力不足」先拦下
		for (const bad of [-1, 1.5, NaN, '0x10', '', 'abc', null, 2n ** 70n]) {
			expect(
				await verifySolution(bindings, { ...base, nonces: [bad, '2', '3', '4'] }),
				String(bad)
			).toEqual({ ok: false, reason: 'bad nonce' });
		}
	});

	it('工作量不足返回 insufficient work', async () => {
		// 难度放大到 100 万（子挑战 d=250000），nonce 全 0 必然算力不足
		await enableVerify({ comment_verify_difficulty: '1000000' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(challenge.pow.d).toBe(250000);

		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: ['0', '0', '0', '0'],
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'insufficient work' });
	});

	it('乱填 c 无法通过（c 不参与签名，但服务端会用密钥重新派生）', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		// 用另一个 c 求解出来的 nonces 提交（相当于攻击者自选低难度挑战）
		const forged = await solve({ ...challenge.pow, c: 'ab'.repeat(32), d: 1 });
		expect(forged.length).toBe(challenge.pow.count);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: forged,
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'insufficient work' });
	});
});

describe('verifySolution —— 成功与防重放', () => {
	it('正确解出后返回 ok', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: true });
	});

	it('nonce 也可以是 JSON 数字（小数值走 number 分支）', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const nonces = (await solve(challenge.pow)).map((n) => Number(n));
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces,
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: true });
	});

	it('挑战单次使用：兑换成功后同一 prefix 不能再提交（即使换 nonces）', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const nonces = await solve(challenge.pow);
		const params = { prefix: challenge.prefix, sig: challenge.sig, nonces, elapsedMs: 500, ip: IP, postSlug: SLUG };

		expect(await verifySolution(bindings, params)).toEqual({ ok: true });
		expect(await verifySolution(bindings, params)).toEqual({ ok: false, reason: 'challenge already used' });
		// 换一组同样（碰巧）达标的 nonces 也不行：防重放的键是 cid，不是 nonce
		expect(await verifySolution(bindings, { ...params, nonces: ['0', '0', '0', '0'] })).toEqual({
			ok: false,
			reason: 'challenge already used',
		});
	});

	it('失败的分支不消耗挑战（同一挑战仍可正常兑换）', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		const nonces = await solve(challenge.pow);
		const base = { prefix: challenge.prefix, sig: challenge.sig, nonces, ip: IP, postSlug: SLUG };

		expect(await verifySolution(bindings, { ...base, elapsedMs: 10 })).toEqual({
			ok: false,
			reason: 'implausible timing',
		});
		expect(await verifySolution(bindings, { ...base, elapsedMs: 500 })).toEqual({ ok: true });
	});
});

describe('verifySolution —— 挑战绑定文章（slug mismatch 回归）', () => {
	/**
	 * 安全回归：修复前挑战载荷只有 {v, cid, iph, iat}，post_slug 来自未签名的请求体，
	 * 于是一次工作量证明可以在同一 IP 上换成任意文章的票据。若下面的跨文章用例
	 * 返回 ok: true，说明文章绑定又回到了未签名路径上。
	 */
	it('为文章 A 签发的挑战用文章 B 兑换必须被拒（slug mismatch）', async () => {
		await enableVerify();
		const a = await createChallenge(bindings, IP, '/posts/a');
		const nonces = await solve(a.pow);

		// 1) 换到 B：必须被拒，且 reason 明确区分于「算力不足」
		expect(
			await verifySolution(bindings, {
				prefix: a.prefix,
				sig: a.sig,
				nonces,
				elapsedMs: 500,
				ip: IP,
				postSlug: '/posts/b',
			})
		).toEqual({ ok: false, reason: 'slug mismatch' });

		// 2) 空文章名同样不行（它和任何被签名的 slug 都不相等）
		expect(
			await verifySolution(bindings, {
				prefix: a.prefix,
				sig: a.sig,
				nonces,
				elapsedMs: 500,
				ip: IP,
				postSlug: '',
			})
		).toEqual({ ok: false, reason: 'slug mismatch' });

		// 3) 确认前两次不是被别的原因顺带拦下的：换回 A 应当成功
		expect(
			await verifySolution(bindings, {
				prefix: a.prefix,
				sig: a.sig,
				nonces,
				elapsedMs: 500,
				ip: IP,
				postSlug: '/posts/a',
			})
		).toEqual({ ok: true });
	});

	it('文章绑定与挑战参数一起被签名：篡改载荷里的 slug 会先被签名拦下', async () => {
		await enableVerify();
		const a = await createChallenge(bindings, IP, '/posts/a');
		const payload = decodePrefix(a.prefix);
		expect(payload.slug).toBe('/posts/a');

		// 把签名载荷整体改成 B 的文章名，但沿用 A 的签名
		const forged = await craftPrefix({ ...payload, slug: '/posts/b' });
		expect(
			await verifySolution(bindings, {
				prefix: forged.prefix,
				sig: a.sig,
				nonces: ['0', '0', '0', '0'],
				elapsedMs: 500,
				ip: IP,
				postSlug: '/posts/b',
			})
		).toEqual({ ok: false, reason: 'bad signature' });
	});

	it('同一挑战在不同文章下的失败顺序与 Node 一致：先报 slug mismatch，不消耗挑战', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, '/posts/a');
		const nonces = await solve(challenge.pow);
		const base = { prefix: challenge.prefix, sig: challenge.sig, nonces, elapsedMs: 500, ip: IP };

		// 文章不对时即使 IP 也不对，仍然先报 slug mismatch（绑定检查在 IP 之前）
		expect(await verifySolution(bindings, { ...base, ip: OTHER_IP, postSlug: '/posts/b' })).toEqual({
			ok: false,
			reason: 'slug mismatch',
		});

		// 文章不对的失败不消耗挑战：同一挑战仍能在原文上兑换
		expect(await verifySolution(bindings, { ...base, postSlug: '/posts/a' })).toEqual({ ok: true });
	});
});

describe('verifySolution —— 第二层 Instrumentation', () => {
	/** 用真实派生结果构造一份能通过程序比对的答案 */
	async function correctInstr(cid: string) {
		const { ops } = await createInstrumentationChallenge(cid, SECRET);
		const expected = interpretProgram({ ops });
		return {
			regs: [...expected.regs],
			env: {
				cd: 0,
				ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
				br: '',
				ge: 1,
				dm: 8,
				tm: [10.5, 11.25, 12.5, 13.75, 14.5, 15.25],
				lw: 120.5,
				lh: 32.25,
				iw: 1200,
				ih: 800,
				ow: 1280,
				oh: 900,
				sw: 1920,
				sh: 1080,
				ex: 0,
				mob: 0,
				nt: 0,
			},
			lw: 120.5,
			lh: 32.25,
			tm: [10.5, 11.25, 12.5, 13.75, 14.5, 15.25],
		};
	}

	it('开启第二层时，正确的答案可以通过（默认不拦截自动化）', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		const result = await verifySolution(bindings, {
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsedMs: 500,
			ip: IP, postSlug: SLUG,
			instr: await correctInstr(challenge.challenge_id),
		});
		expect(result).toEqual({ ok: true });
	});

	it('开启第二层时不带 instr 会被拒（malformed registers）', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
			})
		).toEqual({ ok: false, reason: 'malformed registers' });
	});

	it('寄存器与派生结果不一致时被拒（program result mismatch）', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		const answer = await correctInstr(challenge.challenge_id);
		answer.regs[0] = (answer.regs[0] + 1) | 0;

		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
				instr: answer,
			})
		).toEqual({ ok: false, reason: 'program result mismatch' });
	});

	it('block_automated=false：命中自动化特征只记录，不拦截', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await createChallenge(bindings, IP, SLUG);
		const answer = await correctInstr(challenge.challenge_id);
		answer.env.cd = 1; // navigator.webdriver === true

		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
				instr: answer,
			})
		).toEqual({ ok: true });
	});

	it('block_automated=true：命中自动化特征即拒绝', async () => {
		await enableVerify({
			comment_verify_instr_enabled: 'true',
			comment_verify_block_automated: 'true',
		});
		const challenge = await createChallenge(bindings, IP, SLUG);
		const answer = await correctInstr(challenge.challenge_id);
		answer.env.cd = 1;

		const result = await verifySolution(bindings, {
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsedMs: 500,
			ip: IP, postSlug: SLUG,
			instr: answer,
		});
		expect(result.ok).toBe(false);
		expect((result as any).reason).toContain('webdriver_true');
	});

	it('block_automated=true：布局探针为 0（jsdom 类环境）即拒绝', async () => {
		await enableVerify({
			comment_verify_instr_enabled: 'true',
			comment_verify_block_automated: 'true',
		});
		const challenge = await createChallenge(bindings, IP, SLUG);
		const answer = await correctInstr(challenge.challenge_id);
		answer.lw = 0;

		const result = await verifySolution(bindings, {
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsedMs: 500,
			ip: IP, postSlug: SLUG,
			instr: answer,
		});
		expect(result.ok).toBe(false);
		expect((result as any).reason).toContain('layout_zero');
	});

	it('第二层校验失败时挑战仍被标记为已用（防止反复换环境向量试探）', async () => {
		await enableVerify({
			comment_verify_instr_enabled: 'true',
			comment_verify_block_automated: 'true',
		});
		const challenge = await createChallenge(bindings, IP, SLUG);
		const nonces = await solve(challenge.pow);
		const base = { prefix: challenge.prefix, sig: challenge.sig, nonces, elapsedMs: 500, ip: IP, postSlug: SLUG };

		const bad = await correctInstr(challenge.challenge_id);
		bad.env.cd = 1;
		expect((await verifySolution(bindings, { ...base, instr: bad })).ok).toBe(false);

		// 换成完全正确的答案也无法再用同一个挑战
		expect(await verifySolution(bindings, { ...base, instr: await correctInstr(challenge.challenge_id) })).toEqual(
			{ ok: false, reason: 'challenge already used' }
		);
	});

	it('关闭第二层时提交垃圾 instr 也不影响（不校验）', async () => {
		await enableVerify();
		const challenge = await createChallenge(bindings, IP, SLUG);
		expect(
			await verifySolution(bindings, {
				prefix: challenge.prefix,
				sig: challenge.sig,
				nonces: await solve(challenge.pow),
				elapsedMs: 500,
				ip: IP, postSlug: SLUG,
				instr: { regs: 'garbage', env: null },
			})
		).toEqual({ ok: true });
	});
});

describe('createTicket / verifyTicket（协议 v2）', () => {
	it('票据有效期为 5 分钟（TICKET_TTL_SECONDS）', () => {
		expect(TICKET_TTL_SECONDS).toBe(300);
	});

	it('自己签发的票据可以通过校验', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(true);
	});

	it('票据载荷符合约定（v=2、字段顺序、ip 哈希、exp-iat=300s）', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		const [body] = ticket.split('.');
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));

		expect(Object.keys(payload)).toEqual(['v', 'iph', 'slug', 'iat', 'exp', 'jti']);
		expect(payload.v).toBe(VERIFY_PROTOCOL_VERSION);
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

	it('被篡改的签名 / 载荷不通过', async () => {
		const ticket = await createTicket(bindings, IP, SLUG);
		expect(await verifyTicket(bindings, ticket.slice(0, -4) + 'aaaa', IP, SLUG)).toBe(false);
		expect(await verifyTicket(bindings, `${ticket}x`, IP, SLUG)).toBe(false);

		const [, sig] = ticket.split('.');
		const forgedBody = toBase64url(
			JSON.stringify({ v: 2, iph: 'x', slug: SLUG, iat: Date.now(), exp: Date.now() + 300000, jti: 'y' })
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
				v: 2,
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

	it('v1 票据（v=1）与其他版本号一律拒绝', async () => {
		const now = Date.now();
		for (const v of [1, 3, undefined, '2', null]) {
			const body = toBase64url(
				JSON.stringify({
					v,
					iph: await hashVerifyIp(IP, SECRET),
					slug: SLUG,
					iat: now,
					exp: now + 300000,
					jti: 'version',
				})
			);
			const ticket = `${body}.${await hmacSHA256(body, SECRET)}`;
			expect(await verifyTicket(bindings, ticket, IP, SLUG), `v=${v}`).toBe(false);
		}
	});

	it('exp 缺失或非数字不通过', async () => {
		for (const exp of [undefined, 'soon']) {
			const body = toBase64url(
				JSON.stringify({
					v: 2,
					iph: await hashVerifyIp(IP, SECRET),
					slug: SLUG,
					iat: Date.now(),
					exp,
					jti: 'no-exp',
				})
			);
			const ticket = `${body}.${await hmacSHA256(body, SECRET)}`;
			expect(await verifyTicket(bindings, ticket, IP, SLUG), `exp=${exp}`).toBe(false);
		}
	});

	it('用别的密钥签发的票据不通过', async () => {
		const now = Date.now();
		const body = toBase64url(
			JSON.stringify({
				v: 2,
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

	it('TTL 边界：4 分钟仍有效，超过 5 分钟失效（时钟冻结）', async () => {
		const start = 1_730_000_000_000;
		const spy = vi.spyOn(Date, 'now').mockReturnValue(start);
		try {
			const ticket = await createTicket(bindings, IP, SLUG);
			expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(true);

			spy.mockReturnValue(start + 4 * 60 * 1000);
			expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(true);

			spy.mockReturnValue(start + 5 * 60 * 1000 + 1);
			expect(await verifyTicket(bindings, ticket, IP, SLUG)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});
