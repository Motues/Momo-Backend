/**
 * POST /api/verify/challenge 与 POST /api/verify/solution —— 无感验证 HTTP 链路。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api, rawRequest } from '../helpers/http';
import { createSchema, seedSettings, testEnv } from '../helpers/db';
import { workFor } from '../../src/utils/verifyCrypto';

const IP = '203.0.113.120';
const OTHER_IP = '203.0.113.121';
const SLUG = '/posts/verify-http';

beforeEach(async () => {
	await createSchema();
});

/** 开启验证并设置一个可在测试里暴力求解的难度 */
async function enableVerify(difficulty = 8) {
	await seedSettings({ comment_verify_enabled: 'true', comment_verify_difficulty: String(difficulty) });
}

async function issueChallenge(ip = IP, body: unknown = { post_slug: SLUG }) {
	const res = await api('/api/verify/challenge', { method: 'POST', ip, body });
	expect(res.status).toBe(200);
	return res.body.data as {
		enabled: boolean;
		post_slug: string;
		challenge_id: string;
		prefix: string;
		difficulty: number;
		expires_in: number;
		sig: string;
	};
}

async function solve(prefix: string, difficulty: number): Promise<number> {
	for (let nonce = 0; nonce < 5_000_000; nonce++) {
		if ((await workFor(prefix, nonce)) >= difficulty) return nonce;
	}
	throw new Error('求解失败');
}

async function submitSolution(body: Record<string, unknown>, ip = IP) {
	return await api('/api/verify/solution', { method: 'POST', ip, body });
}

describe('验证相关设置项', () => {
	// ⚠️ 顺序敏感：verify.ts 会把签名密钥缓存在模块级变量里，
	// 只有本文件里「第一次真正调用 getSecret()」的用例才能观察到「生成并落库」。
	// 因此这个 describe 必须声明在文件最前面。
	it('首次开启验证时会在 Settings 中生成 64 位十六进制密钥', async () => {
		await enableVerify();
		await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		const row = await testEnv.MOMO_DB.prepare('SELECT value FROM Settings WHERE key = ?')
			.bind('comment_verify_secret')
			.first<{ value: string }>();
		expect(row?.value).toMatch(/^[0-9a-f]{64}$/);
	});

	it('关闭验证时不生成密钥（零副作用）', async () => {
		await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		const row = await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as c FROM Settings WHERE key = ?')
			.bind('comment_verify_secret')
			.first<{ c: number }>();
		expect(row?.c).toBe(0);
	});
});

describe('POST /api/verify/challenge', () => {
	it('验证关闭时返回 enabled = false', async () => {
		const res = await api('/api/verify/challenge', { method: 'POST', ip: IP, body: { post_slug: SLUG } });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Verification disabled',
			data: { enabled: false },
		});
	});

	it('不带请求体也能探测开关状态', async () => {
		const res = await rawRequest('/api/verify/challenge', { method: 'POST', ip: IP });
		expect(res.status).toBe(200);
		expect((await res.json() as any).data).toEqual({ enabled: false });
	});

	it('非法 JSON 请求体被容忍（仅用于探测开关）', async () => {
		const res = await api('/api/verify/challenge', {
			method: 'POST',
			ip: IP,
			body: '{oops',
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(200);
		expect(res.body.data).toEqual({ enabled: false });
	});

	it('验证开启时返回完整挑战信息', async () => {
		await enableVerify(12);
		const data = await issueChallenge();
		expect(data.enabled).toBe(true);
		expect(data.post_slug).toBe(SLUG);
		expect(data.difficulty).toBe(12);
		expect(data.expires_in).toBe(600);
		expect(data.challenge_id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(data.prefix).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(data.sig).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('post_slug 中的 HTML 被剥离并裁剪到 200 字符', async () => {
		await enableVerify();
		const data = await issueChallenge(IP, { post_slug: '  /posts/<b>x</b>  ' });
		expect(data.post_slug).toBe('/posts/x');

		const long = await issueChallenge(IP, { post_slug: 'x'.repeat(300) });
		expect(long.post_slug).toHaveLength(200);
	});

	it('post_slug 非字符串时被强制转换为字符串', async () => {
		await enableVerify();
		expect((await issueChallenge(IP, { post_slug: 123 })).post_slug).toBe('123');
		expect((await issueChallenge(IP, {})).post_slug).toBe('');
	});

	it('挑战难度取设置项并按上下限钳制', async () => {
		await enableVerify(9);
		expect((await issueChallenge()).difficulty).toBe(9);
		await seedSettings({ comment_verify_difficulty: '99' });
		expect((await issueChallenge()).difficulty).toBe(26);
	});

	it('IP 优先取 cf-connecting-ip，其次 x-real-ip', async () => {
		await enableVerify();
		// 两个请求使用不同 IP → 得到的挑战应互不相同（且都能用于各自 IP）
		const a = await issueChallenge(IP);
		const b = await issueChallenge(OTHER_IP);
		expect(a.prefix).not.toBe(b.prefix);
	});
});

describe('POST /api/verify/solution', () => {
	it('验证关闭时直接返回 enabled = false（即使参数是垃圾）', async () => {
		const res = await submitSolution({ prefix: 'garbage', sig: 'garbage', nonce: 'x', elapsed_ms: -1 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Verification disabled',
			data: { enabled: false },
		});
	});

	it('蜜罐字段被填写时返回 403 honeypot', async () => {
		await enableVerify();
		const res = await submitSolution({ post_slug: SLUG, hp: 'i-am-a-bot' });
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ code: 403, message: 'Verification failed', reason: 'honeypot' });
	});

	it('蜜罐字段为空串 / null / 未提供时不做蜜罐判定', async () => {
		await enableVerify();
		for (const hp of ['', '   ', null, undefined]) {
			const res = await submitSolution({ post_slug: SLUG, hp, prefix: 'p', sig: 's', nonce: 0, elapsed_ms: 500 });
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
		const res = await submitSolution({ post_slug: SLUG, nonce: 0, elapsed_ms: 500 });
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
			nonce: 0,
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('bad signature');
	});

	it('工作量不足返回 403 insufficient work', async () => {
		await enableVerify(20);
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce: 0,
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('insufficient work');
	});

	it('耗时过短返回 403 implausible timing', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
			elapsed_ms: 10,
		});
		expect(res.body.reason).toBe('implausible timing');
	});

	it('换 IP 提交返回 403 ip mismatch', async () => {
		await enableVerify();
		const challenge = await issueChallenge(IP);
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const res = await submitSolution(
			{ post_slug: SLUG, prefix: challenge.prefix, sig: challenge.sig, nonce, elapsed_ms: 500 },
			OTHER_IP
		);
		expect(res.body.reason).toBe('ip mismatch');
	});

	it('nonce 为负数返回 403 bad nonce', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce: -1,
			elapsed_ms: 500,
		});
		expect(res.body.reason).toBe('bad nonce');
	});

	it('正确解题后签发票据', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonce = await solve(challenge.prefix, challenge.difficulty);

		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
			elapsed_ms: 500,
		});
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Verification passed');
		expect(res.body.data.enabled).toBe(true);
		expect(res.body.data.expires_in).toBe(300);
		expect(res.body.data.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	});

	it('nonce 以字符串形式提交同样可用', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const res = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce: String(nonce),
			elapsed_ms: 500,
		});
		expect(res.status).toBe(200);
	});

	it('同一 nonce 不能重复兑换（replayed nonce）', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const payload = {
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
			elapsed_ms: 500,
		};
		expect((await submitSolution(payload)).status).toBe(200);
		const second = await submitSolution(payload);
		expect(second.status).toBe(403);
		expect(second.body.reason).toBe('replayed nonce');
	});
});

describe('验证票据与评论提交的端到端串联', () => {
	it('挑战 → 解题 → 票据 → 提交评论成功', async () => {
		await enableVerify();
		const challenge = await issueChallenge();
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const solution = await submitSolution({
			post_slug: SLUG,
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
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
		const nonce = await solve(challenge.prefix, challenge.difficulty);
		const solution = await submitSolution({
			post_slug: '/posts/other',
			prefix: challenge.prefix,
			sig: challenge.sig,
			nonce,
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
