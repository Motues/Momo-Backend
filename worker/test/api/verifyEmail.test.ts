/**
 * GET /api/verify-email/verify —— 邮件验证落地页（返回 HTML，不是 JSON）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { rawRequest } from '../helpers/http';
import { createSchema, getVerification, seedComment, seedVerification, testEnv } from '../helpers/db';

const EMAIL = 'alice@example.com';
const TOKEN = 'verify-token-1';

async function verify(token: string | undefined, email: string | undefined) {
	const params = new URLSearchParams();
	if (token !== undefined) params.set('token', token);
	if (email !== undefined) params.set('email', email);
	const res = await rawRequest(`/api/verify-email/verify?${params.toString()}`);
	const html = await res.text();
	return { status: res.status, contentType: res.headers.get('content-type') ?? '', html };
}

beforeEach(createSchema);

describe('GET /api/verify-email/verify —— 参数与错误分支', () => {
	it('缺少 token 或 email 时返回「缺少验证参数」页面', async () => {
		const missingBoth = await verify(undefined, undefined);
		expect(missingBoth.status).toBe(200);
		expect(missingBoth.html).toContain('缺少验证参数');
		expect(missingBoth.html).toContain('验证失败');
		expect((await verify('t', undefined)).html).toContain('缺少验证参数');
		expect((await verify(undefined, EMAIL)).html).toContain('缺少验证参数');
	});

	it('返回 HTML 页面（text/html）', async () => {
		const res = await verify('x', EMAIL);
		expect(res.contentType).toContain('text/html');
		expect(res.html).toContain('<!DOCTYPE html>');
	});

	it('未知 token 返回「验证链接无效」', async () => {
		const res = await verify('unknown-token', EMAIL);
		expect(res.html).toContain('验证链接无效');
		expect(res.html).toContain('验证失败');
	});

	it('token 存在但 email 不匹配同样视为无效', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		expect((await verify(TOKEN, 'other@example.com')).html).toContain('验证链接无效');
	});

	it('已过期的链接返回「验证链接已过期」', async () => {
		await seedVerification({
			email: EMAIL,
			token: TOKEN,
			expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
		});
		const res = await verify(TOKEN, EMAIL);
		expect(res.html).toContain('验证链接已过期');
		// 过期不会把记录标记为已验证
		expect((await getVerification(TOKEN))?.verified).toBe(0);
	});

	it('已验证过的链接重复访问提示「该邮箱已验证通过」', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN, verified: 1 });
		const res = await verify(TOKEN, EMAIL);
		expect(res.html).toContain('验证成功');
		expect(res.html).toContain('该邮箱已验证通过');
	});
});

describe('GET /api/verify-email/verify —— 成功分支', () => {
	it('验证成功并把同邮箱的待审核评论全部置为 approved', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		const pendingA = await seedComment({ email: EMAIL, status: 'pending', content_text: 'a' });
		const pendingB = await seedComment({ email: EMAIL, status: 'pending', content_text: 'b' });
		const rejected = await seedComment({ email: EMAIL, status: 'rejected', content_text: 'c' });
		const otherEmail = await seedComment({ email: 'other@example.com', status: 'pending' });

		const res = await verify(TOKEN, EMAIL);
		expect(res.html).toContain('验证成功');
		expect(res.html).toContain('共 2 条评论已通过审核');

		const rows = await testEnv.MOMO_DB.prepare('SELECT id, status FROM Comment ORDER BY id').all<{
			id: number;
			status: string;
		}>();
		const byId = Object.fromEntries((rows.results ?? []).map((r) => [r.id, r.status]));
		expect(byId[pendingA]).toBe('approved');
		expect(byId[pendingB]).toBe('approved');
		expect(byId[rejected]).toBe('rejected');
		expect(byId[otherEmail]).toBe('pending');
	});

	it('验证成功后记录 verified = 1 与 verified_at', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		await verify(TOKEN, EMAIL);
		const record = await getVerification(TOKEN);
		expect(record?.verified).toBe(1);
		expect(record?.verified_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it('没有待审核评论时只提示验证成功', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		const res = await verify(TOKEN, EMAIL);
		expect(res.html).toContain('邮箱验证成功！');
		expect(res.html).not.toContain('条评论已通过审核');
	});

	it('已经 approved 的评论不会被重复处理（计数为 0）', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		await seedComment({ email: EMAIL, status: 'approved' });
		expect((await verify(TOKEN, EMAIL)).html).not.toContain('条评论已通过审核');
	});

	it('二次访问同一条链接提示已验证通过', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		await verify(TOKEN, EMAIL);
		expect((await verify(TOKEN, EMAIL)).html).toContain('该邮箱已验证通过');
	});

	it('邮箱大小写必须完全匹配（精确等值查询）', async () => {
		await seedVerification({ email: EMAIL, token: TOKEN });
		expect((await verify(TOKEN, 'Alice@example.com')).html).toContain('验证链接无效');
	});
});
