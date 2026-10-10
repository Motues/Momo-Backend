/**
 * POST /api/verify/challenge 与 POST /api/verify/solution —— 无感验证协议 v2 的 HTTP 链路。
 *
 * HashWX 第一层在测试环境里是纯 JS 替身（详见 test/stubs/hashwx.ts 与
 * test/helpers/hashwxMock.ts）：生产代码用静态 `.wasm` 导入，而 vitest-pool-workers
 * 无法加载 .wasm 模块。真实 .wasm 路径由 wrangler 运行时验证。
 *
 * 本文件统一预置固定签名密钥（verify.ts 的 cachedSecret 是模块级缓存，
 * 不能在用例之间切换密钥），因此「首次使用自动生成密钥」的行为由
 * test/unit/verifySecret.test.ts 专门覆盖。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api, rawRequest } from '../helpers/http';
import { allVerifyRecords, createSchema, rawSettings, seedSettings, testEnv } from '../helpers/db';
import { createInstrumentationChallenge, interpretProgram } from '../../src/utils/instrumentation';
import { fromBase64url, hashVerifyIp, hmacSHA256, toBase64url } from '../../src/utils/verifyCrypto';
import { solveHashwxSpec } from '../stubs/hashwx';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const IP = '203.0.113.120';
const OTHER_IP = '203.0.113.121';
const SLUG = '/posts/verify-http';

beforeEach(async () => {
	await createSchema();
	await seedSettings({ comment_verify_secret: SECRET, comment_verify_difficulty: '1000' });
});

/** 开启验证（可选：附带第二层设置项） */
async function enableVerify(extra: Record<string, string> = {}) {
	await seedSettings({ comment_verify_enabled: 'true', ...extra });
}

interface ChallengeData {
	enabled: boolean;
	version: number;
	post_slug: string;
	challenge_id: string;
	prefix: string;
	sig: string;
	expires_in: number;
	pow: { algo: string; c: string; d: number; n: number; count: number };
	instr?: { ops: number[]; fonts: number };
}

async function issueChallenge(ip = IP, body: unknown = { post_slug: SLUG }): Promise<ChallengeData> {
	const res = await api('/api/verify/challenge', { method: 'POST', ip, body });
	expect(res.status).toBe(200);
	return res.body.data as ChallengeData;
}

/** 用替身求解挑战（客户端侧的行为） */
async function solve(pow: ChallengeData['pow']): Promise<string[]> {
	return solveHashwxSpec({ c: pow.c, d: pow.d, n: pow.n, count: pow.count });
}

async function submitSolution(body: Record<string, unknown>, ip = IP) {
	return await api('/api/verify/solution', { method: 'POST', ip, body });
}

/** 构造一份能通过第二层程序比对与布局探针的答案 */
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

describe('验证相关设置项', () => {
	it('关闭验证时不生成密钥（零副作用）', async () => {
		await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		// beforeEach 预置的密钥之外的键不应被写入
		expect(await rawSettings()).toEqual({
			comment_verify_secret: SECRET,
			comment_verify_difficulty: '1000',
		});
	});

	it('GET /api/comments 下发 verify_version = "2"（前后端配套判断）', async () => {
		const res = await api(`/api/comments?post_slug=${SLUG}`, { ip: IP });
		expect(res.body.data.verify_version).toBe('2');
	});
});

describe('POST /api/verify/challenge（协议 v2）', () => {
	it('验证关闭时返回 enabled = false 与 version 2', async () => {
		const res = await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Verification disabled',
			data: { enabled: false, version: 2 },
		});
	});

	it('不带请求体也能探测开关状态', async () => {
		const res = await rawRequest('/api/verify/challenge', { method: 'POST', ip: IP });
		expect(res.status).toBe(200);
		expect((await res.json() as any).data).toEqual({ enabled: false, version: 2 });
	});

	it('非法 JSON 请求体被容忍（仅用于探测开关）', async () => {
		const res = await api('/api/verify/challenge', {
			method: 'POST',
			ip: IP,
			body: '{oops',
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(200);
		expect(res.body.data).toEqual({ enabled: false, version: 2 });
	});

	it('验证开启时返回完整挑战信息（pow 为 HashWX 参数）', async () => {
		await enableVerify();
		const data = await issueChallenge();

		expect(data.enabled).toBe(true);
		expect(data.version).toBe(2);
		expect(data.post_slug).toBe(SLUG);
		expect(data.expires_in).toBe(600);
		expect(data.challenge_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(data.prefix).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(data.sig).toMatch(/^[A-Za-z0-9_-]+$/);

		expect(data.pow).toEqual({ algo: 'hashwx', c: expect.stringMatching(/^[0-9a-f]{64}$/), d: 250, n: 65536, count: 4 });
		// 默认不下发第二层
		expect(data.instr).toBeUndefined();
	});

	it('prefix 载荷是 {"v":2,"cid":…,"iph":…,"slug":…,"iat":…} 且签名可独立复算', async () => {
		await enableVerify();
		const data = await issueChallenge();
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(data.prefix)));

		// slug 参与签名：挑战绑定到这篇文章，只有它才能兑换票据
		expect(Object.keys(payload)).toEqual(['v', 'cid', 'iph', 'slug', 'iat']);
		expect(payload.v).toBe(2);
		expect(payload.cid).toBe(data.challenge_id);
		expect(payload.iph).toBe(await hashVerifyIp(IP, SECRET));
		expect(payload.slug).toBe(SLUG);
		expect(data.sig).toBe(await hmacSHA256(data.prefix, SECRET));
	});

	it('开启 comment_verify_instr_enabled 时下发第二层程序', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const data = await issueChallenge();

		expect(data.instr).toBeDefined();
		expect(data.instr!.fonts).toBe(17);
		expect(await createInstrumentationChallenge(data.challenge_id, SECRET)).toEqual({
			ops: data.instr!.ops,
			fonts: data.instr!.fonts,
		});
	});

	it('post_slug 中的脚本被剥离并裁剪到 200 字符（与 Node 的 checkContent 口径一致）', async () => {
		await enableVerify();
		// checkContent 会移除 <script>…</script> 整块
		const data = await issueChallenge(IP, { post_slug: '<script>x</script>/posts/x' });
		expect(data.post_slug).toBe('/posts/x');

		const long = await issueChallenge(IP, { post_slug: 'x'.repeat(300) });
		expect(long.post_slug).toHaveLength(200);
	});

	it('post_slug 非字符串时被强制转换为字符串', async () => {
		await enableVerify();
		expect((await issueChallenge(IP, { post_slug: 123 })).post_slug).toBe('123');
		expect((await issueChallenge(IP, { post_slug: { a: 1 } })).post_slug).toBe('[object Object]');
		expect((await issueChallenge(IP, {})).post_slug).toBe('');
	});

	it('难度（总哈希次数）取设置项并按上下限钳制后再均分', async () => {
		await enableVerify();
		await seedSettings({ comment_verify_difficulty: '512000' });
		expect((await issueChallenge()).pow.d).toBe(128000);
		// 999 => 钳到 1000 => 250
		await seedSettings({ comment_verify_difficulty: '999' });
		expect((await issueChallenge()).pow.d).toBe(250);
		// 旧值 12 => 4096 => 1024
		await seedSettings({ comment_verify_difficulty: '12' });
		expect((await issueChallenge()).pow.d).toBe(1024);
	});

	it('IP 优先取 cf-connecting-ip，其次 x-real-ip', async () => {
		await enableVerify();
		// 两个请求使用不同 IP → 得到的挑战应互不相同（且都能用于各自 IP）
		const a = await issueChallenge(IP);
		const b = await issueChallenge(OTHER_IP);
		expect(a.prefix).not.toBe(b.prefix);

		// x-real-ip 作为回落来源同样参与 IP 绑定
		const res = await rawRequest('/api/verify/challenge', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-real-ip': OTHER_IP },
			body: JSON.stringify({ post_slug: SLUG }),
		});
		const data = (await res.json() as any).data as ChallengeData;
		expect(JSON.parse(new TextDecoder().decode(fromBase64url(data.prefix))).iph).toBe(
			await hashVerifyIp(OTHER_IP, SECRET)
		);
	});
});

describe('POST /api/verify/solution（协议 v2）', () => {
	it('验证关闭时直接返回 enabled = false（即使参数是垃圾）', async () => {
		const res = await submitSolution({ prefix: 'garbage', sig: 'garbage', nonces: 'x', elapsed_ms: -1 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Verification disabled',
			data: { enabled: false, version: 2 },
		});
	});

	it('蜜罐字段被填写时返回 403 honeypot', async () => {
		await enableVerify();
		const res = await submitSolution({ post_slug: SLUG, hp: 'i-am-a-bot' });
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ code: 403, message: 'Verification failed', reason: 'honeypot' });
	});

	it('蜜罐字段为空串 / 空白 / null / 未提供时不做蜜罐判定', async () => {
		await enableVerify();
		for (const hp of ['', '   ', null, undefined]) {
			const res = await submitSolution({ post_slug: SLUG, hp, prefix: 'p', sig: 's', nonces: ['1'], elapsed_ms: 500 });
			expect(res.body.reason).toBe('bad signature');
		}
	});

	it('非法 JSON 请求体返回 500', async () => {
		await enableVerify();
		const res = await api('/api/verify/solution', {
			method: 'POST',
			ip: IP,
			body: '{oops',
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(500);
	});

	it('缺少 prefix / sig 返回 403 missing challenge', async () => {
		await enableVerify();
		const res = await submitSolution({ post_slug: SLUG, nonces: ['1'], elapsed_ms: 500 });
		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('missing challenge');
	});

	it('签名错误返回 403 bad signature', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: `${challenge.sig}x`,
			nonces: ['1', '2', '3', '4'],
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('bad signature');
	});

	it('v1 客户端（载荷没有 v 字段）返回 403 PROTOCOL_OUTDATED', async () => {
		await enableVerify();
		const v1Json = JSON.stringify({
			cid: 'v1-cid',
			iph: await hashVerifyIp(IP, SECRET),
			iat: Date.now(),
		});
		const prefix = toBase64url(v1Json);
		const res = await submitSolution({
			post_slug: SLUG,
			prefix,
			sig: await hmacSHA256(prefix, SECRET),
			nonces: ['1', '2', '3', '4'],
			elapsed_ms: 500,
		});
		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('PROTOCOL_OUTDATED');
	});

	it('工作量不足返回 403 insufficient work', async () => {
		await seedSettings({ comment_verify_difficulty: '1000000' });
		await enableVerify();
		const challenge = await issueChallenge();
		expect(challenge.pow.d).toBe(250000);

		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: ['0', '0', '0', '0'],
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('insufficient work');
	});

	it('nonces 数量不对返回 403 solution count mismatch', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: ['1', '2', '3'],
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('solution count mismatch');
	});

	it('耗时过短（< 50ms）返回 403 implausible timing', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 49,
		});
		expect(res.body.reason).toBe('implausible timing');
	});

	it('换 IP 提交返回 403 ip mismatch', async () => {
		await enableVerify();
		const challenge = await issueChallenge(IP);
		const res = await submitSolution(
			{ post_slug: SLUG, prefix: challenge.prefix, sig: challenge.sig, nonces: await solve(challenge.pow), elapsed_ms: 500 },
			OTHER_IP
		);
		expect(res.body.reason).toBe('ip mismatch');
	});

	it('nonces 含负数返回 403 bad nonce', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: [-1, '2', '3', '4'],
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('bad nonce');
	});

	it('正确解题后签发票据（v2）', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		});

		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Verification passed');
		expect(res.body.data.enabled).toBe(true);
		expect(res.body.data.version).toBe(2);
		expect(res.body.data.expires_in).toBe(300);
		expect(res.body.data.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

		const [body] = (res.body.data.ticket as string).split('.');
		expect(JSON.parse(new TextDecoder().decode(fromBase64url(body))).v).toBe(2);
	});

	it('nonces 以 JSON 数字提交同样可用', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: (await solve(challenge.pow)).map(Number),
			elapsed_ms: 500,
		});
		expect(res.status).toBe(200);
	});

	it('挑战单次使用：同一 prefix 二次兑换返回 403 challenge already used', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonces = await solve(challenge.pow);
		const payload = {
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces,
			elapsed_ms: 500,
		};

		expect((await submitSolution(payload)).status).toBe(200);
		const second = await submitSolution(payload);
		expect(second.status).toBe(403);
		expect(second.body.reason).toBe('challenge already used');
	});

	it('并发提交同一挑战时只有一次能兑换成功（防重放不能有竞态）', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const body = {
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		};

		// 关键点：防重放的「查重 → 标记已用」必须是一段不出现 await 的同步临界区。
		// workerd 没有同步 SHA-256，因此工作量校验被拆成「异步派生种子 + 同步比较」两阶段，
		// 临界区里只剩同步的 checkHashwxEvidence；若把派生留在临界区中间，
		// 两个并发请求会都通过查重、都标记成功，各换一张票据。
		const [first, second] = await Promise.all([submitSolution(body), submitSolution(body)]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 403]);
	});

	it('挑战绑定文章：为 A 签发的挑战不能用来兑换 B 的票据', async () => {
		await enableVerify();
		const challenge = await issueChallenge(IP, { post_slug: '/posts/a' });

		// 挑战载荷里必须带 slug，且等于签发时传入的文章
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(challenge.prefix)));
		expect(payload.slug).toBe('/posts/a');

		const nonces = await solve(challenge.pow);
		const base = { prefix: challenge.prefix, sig: challenge.sig, nonces, elapsed_ms: 500 };

		// 1) 用另一篇文章兑换 —— 必须被拒，reason 明确区分于「算力不足」
		const crossPost = await submitSolution({ ...base, post_slug: '/posts/b' });
		expect(crossPost.status).toBe(403);
		expect(crossPost.body.reason).toBe('slug mismatch');

		// 2) 空文章名也不行（与任何被签名的 slug 都不相等）
		const emptySlug = await submitSolution({ ...base });
		expect(emptySlug.status).toBe(403);
		expect(emptySlug.body.reason).toBe('slug mismatch');

		// 3) 用原文章兑换应当成功，且票据确实绑定到 A（说明前两次不是被别的原因顺带拦下的）
		const correct = await submitSolution({ ...base, post_slug: '/posts/a' });
		expect(correct.status).toBe(200);
		const ticket = correct.body.data.ticket as string;
		const [body] = ticket.split('.');
		expect(JSON.parse(new TextDecoder().decode(fromBase64url(body))).slug).toBe('/posts/a');
	});

	it('净化口径一致：带脚本的 post_slug 在签发与兑换两处得到同一个 slug', async () => {
		await enableVerify();
		// 签发时 "<script>x</script>/posts/x" 被净化成 "/posts/x"，
		// 兑换时若使用同一套净化规则，就应当匹配挑战载荷里签的 slug（否则是假拒绝）
		const challenge = await issueChallenge(IP, { post_slug: '<script>x</script>/posts/x' });
		expect(challenge.post_slug).toBe('/posts/x');

		const res = await submitSolution({
			post_slug: '<script>x</script>/posts/x',
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		});
		expect(res.status).toBe(200);

		// 票据必须能真正用来提交评论：postComment 也必须用同一套净化规则比对 slug，
		// 否则含脚本片段的文章标识会让合法访客永远收到假 VERIFY_REQUIRED。
		const comment = await api('/api/comments', {
			method: 'POST',
			ip: IP,
			body: {
				post_slug: '<script>x</script>/posts/x',
				author: '净化回归',
				email: 'sanitize@example.com',
				content: '票据应当可用',
				verify_ticket: res.body.data.ticket,
			},
		});
		expect(comment.status).toBe(200);
		expect(comment.body.reason).toBeUndefined();
	});

	it('开启第二层时缺少 instr 返回 403 malformed registers', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('malformed registers');
	});

	it('开启第二层时正确答案可以通过并拿到票据', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
			instr: await correctInstr(challenge.challenge_id),
		});
		expect(res.status).toBe(200);
		expect(res.body.data.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	});

	it('block_automated=true 时命中自动化特征返回 403', async () => {
		await enableVerify({
			comment_verify_instr_enabled: 'true',
			comment_verify_block_automated: 'true',
		});
		const challenge = await issueChallenge();
		const answer = await correctInstr(challenge.challenge_id);
		answer.env.cd = 1;

		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
			instr: answer,
		});
		expect(res.status).toBe(403);
		expect(res.body.reason).toContain('webdriver_true');
	});
});

describe('验证票据与评论提交的端到端串联', () => {
	it('挑战 → 解题 → 票据 → 提交评论成功', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const solution = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		});
		const ticket = solution.body.data.ticket as string;

		const res = await api('/api/comments', {
			method: 'POST',
			ip: IP,
			body: {
				post_slug: SLUG,
				author: 'Alice',
				email: 'alice@example.com',
				content: 'verified!',
				verify_ticket: ticket,
			},
		});
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Comment submitted');
	});

	it('没有票据时提交评论被拒（VERIFY_REQUIRED）', async () => {
		await enableVerify();
		const res = await api('/api/comments', {
			method: 'POST',
			ip: IP,
			body: { post_slug: SLUG, author: 'Alice', email: 'alice@example.com', content: 'no ticket' },
		});
		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('VERIFY_REQUIRED');
	});

	it('票据是针对另一篇文章签发的，提交评论被拒', async () => {
		await enableVerify();
		const challenge = await issueChallenge(IP, { post_slug: '/posts/other' });
		const solution = await submitSolution({
			post_slug: '/posts/other',
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
		});
		const res = await api('/api/comments', {
			method: 'POST',
			ip: IP,
			body: {
				post_slug: SLUG,
				author: 'Alice',
				email: 'alice@example.com',
				content: 'cross-slug',
				verify_ticket: solution.body.data.ticket,
			},
		});
		expect(res.status).toBe(403);
	});
});

describe('第二层依赖的 D1 状态保持干净', () => {
	it('除预置密钥与难度外，验证流程不写任何设置项', async () => {
		await enableVerify({ comment_verify_instr_enabled: 'true' });
		const challenge = await issueChallenge();
		await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 500,
			instr: await correctInstr(challenge.challenge_id),
		});

		expect(await rawSettings()).toEqual({
			comment_verify_secret: SECRET,
			comment_verify_difficulty: '1000',
			comment_verify_enabled: 'true',
			comment_verify_instr_enabled: 'true',
		});
	});

	it('testEnv 仍是可用的 D1 绑定（防止帮助函数漂移）', async () => {
		expect(typeof testEnv.MOMO_DB.prepare).toBe('function');
	});
});

/**
 * 认证记录落库（VerifyRecord）。
 *
 * 每次认证最多三条记录（challenge / pass / fail），通过 challenge_id 串联；
 * 这些断言是「三端记录口径一致」的护栏，因此逐个字段比对，而不只看行数。
 */
describe('认证记录落库（VerifyRecord）', () => {
	it('成功签发挑战后有一条 challenge 记录，challenge_id 与响应一致', async () => {
		await enableVerify();
		const data = await issueChallenge();

		const rows = await allVerifyRecords();
		expect(rows).toHaveLength(1);
		const [row] = rows;

		expect(row.event).toBe('challenge');
		expect(row.challenge_id).toBe(data.challenge_id);
		expect(row.post_slug).toBe(SLUG);
		expect(row.ip_address).toBe(IP);
		// 记录的是「总期望哈希次数」，而不是响应里 pow.d 的单子挑战难度（1000 / 4 = 250）
		expect(row.difficulty).toBe(1000);
		expect(data.pow.d).toBe(250);
		// 签发事件没有耗时与失败原因
		expect(row.elapsed_ms).toBeNull();
		expect(row.reason).toBeNull();
		// created_at 与 Comment.pub_date 同为 Unix 毫秒整数
		expect(typeof row.created_at).toBe('number');
		expect(row.created_at).toBeGreaterThan(Date.now() - 60_000);
		// 本地测试环境没有 request.cf（只有 Cloudflare 边缘会注入），地域列落库为 NULL；
		// 解析规则本身由 admin.verify.test.ts 里的 extractCfGeo 用例覆盖。
		expect(row.country).toBeNull();
		expect(row.network).toBeNull();
		expect(row.asn).toBeNull();
	});

	it('提交错误答案后有 fail 记录，reason 与服务端返回一致', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: `${challenge.sig}x`,
			nonces: ['1', '2', '3', '4'],
			elapsed_ms: 640,
		});
		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('bad signature');

		const rows = await allVerifyRecords();
		// 先签发后校验：两条记录按写入顺序排列，并靠 challenge_id 串起同一次认证
		expect(rows.map((r) => r.event)).toEqual(['challenge', 'fail']);
		const fail = rows[1];
		expect(fail.reason).toBe(res.body.reason);
		expect(fail.challenge_id).toBe(challenge.challenge_id);
		expect(fail.elapsed_ms).toBe(640);
		expect(fail.post_slug).toBe(SLUG);
		expect(fail.ip_address).toBe(IP);
		expect(fail.difficulty).toBe(1000);
	});

	it('成功通过后有 pass 记录，elapsed_ms 等于请求体里的值', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonces: await solve(challenge.pow),
			elapsed_ms: 321,
		});
		expect(res.status).toBe(200);

		const rows = await allVerifyRecords();
		expect(rows.map((r) => r.event)).toEqual(['challenge', 'pass']);
		const pass = rows[1];
		expect(pass.elapsed_ms).toBe(321);
		expect(pass.reason).toBeNull();
		expect(pass.challenge_id).toBe(challenge.challenge_id);
		expect(pass.post_slug).toBe(SLUG);
		expect(pass.difficulty).toBe(1000);
	});

	it('关闭验证时不写任何认证记录', async () => {
		// 未 enableVerify：挑战返回 enabled=false，且不应留下任何副作用
		await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		await api('/api/verify/solution', {
			method: 'POST',
			ip: IP,
			body: { post_slug: SLUG, prefix: 'p', sig: 's', nonces: ['1'], elapsed_ms: 500 },
		});
		expect(await allVerifyRecords()).toEqual([]);
	});
});
