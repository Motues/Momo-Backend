/**
 * /admin/data/export/* 与 /admin/data/import/* —— 备份数据的导出、导入与往返一致性。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { allComments, createSchema, getComment, rawSettings, seedComment, seedSettings, testEnv } from '../helpers/db';
import pkg from '../../package.json';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

describe('GET /admin/data/export/settings', () => {
	it('返回元信息与白名单设置', async () => {
		await seedSettings({ site_name: 'Momo Blog', admin_email: 'a@b.c' });
		const res = await api('/admin/data/export/settings', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.data.type).toBe('settings');
		expect(res.body.data.version).toBe(pkg.version);
		expect(res.body.data.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(res.body.data.settings.site_name).toBe('Momo Blog');
		expect(res.body.data.settings.admin_email).toBe('a@b.c');
	});

	it('敏感字段被置空并记录在 sensitiveOmitted', async () => {
		await seedSettings({ email_password: 'smtp-secret', admin_comment_key: 'comment-key' });
		const res = await api('/admin/data/export/settings', { headers: authed() });
		expect(res.body.data.settings.email_password).toBe('');
		expect(res.body.data.settings.admin_comment_key).toBe('');
		expect(res.body.data.sensitiveOmitted.sort()).toEqual(['admin_comment_key', 'email_password']);
	});

	it('敏感字段为空时不记入 sensitiveOmitted', async () => {
		await seedSettings({ email_password: '' });
		const res = await api('/admin/data/export/settings', { headers: authed() });
		expect(res.body.data.sensitiveOmitted).toEqual([]);
	});

	it('白名单外的键不会被导出', async () => {
		await seedSettings({ secret_key: 'leak-me', site_name: 'Momo' });
		const res = await api('/admin/data/export/settings', { headers: authed() });
		expect(res.body.data.settings.secret_key).toBeUndefined();
	});

	it('email_enabled 未配置时导出默认 "true"', async () => {
		const res = await api('/admin/data/export/settings', { headers: authed() });
		expect(res.body.data.settings.email_enabled).toBe('true');
	});
});

describe('GET /admin/data/export/comments', () => {
	it('空库导出 total 0', async () => {
		const res = await api('/admin/data/export/comments', { headers: authed() });
		expect(res.body.data.type).toBe('comments');
		expect(res.body.data.total).toBe(0);
		expect(res.body.data.comments).toEqual([]);
	});

	it('导出全部字段并按 pub_date 升序', async () => {
		await seedComment({ author: 'New', pub_date: 1750000000000 });
		await seedComment({
			author: 'Old',
			pub_date: 1730000000000,
			url: 'https://me.example.com',
			ip_address: '1.2.3.4',
			os: 'Windows 10',
			browser: 'Chrome 120',
			content_text: 'hi',
			content_html: '<p>hi</p>',
			status: 'pending',
		});
		const res = await api('/admin/data/export/comments', { headers: authed() });
		expect(res.body.data.total).toBe(2);
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['Old', 'New']);

		const old = res.body.data.comments[0];
		expect(old).toEqual({
			id: 2,
			pubDate: new Date(1730000000000).toISOString(),
			postSlug: '/posts/demo',
			author: 'Old',
			email: 'alice@example.com',
			url: 'https://me.example.com',
			ipAddress: '1.2.3.4',
			os: 'Windows 10',
			browser: 'Chrome 120',
			contentText: 'hi',
			contentHtml: '<p>hi</p>',
			status: 'pending',
		});
	});

	it('可空字段回落到空串或 undefined', async () => {
		await seedComment({ url: null, ip_address: null, os: null, browser: null, parent_id: null });
		const res = await api('/admin/data/export/comments', { headers: authed() });
		const row = res.body.data.comments[0];
		expect(row.url).toBeUndefined();
		expect(row.ipAddress).toBe('');
		expect(row.os).toBe('');
		expect(row.browser).toBe('');
		expect(row.parentId).toBeUndefined();
	});

	it('parentId 有值时导出', async () => {
		const parent = await seedComment({ author: 'P' });
		await seedComment({ author: 'C', parent_id: parent });
		const res = await api('/admin/data/export/comments', { headers: authed() });
		expect(res.body.data.comments[1].parentId).toBe(parent);
	});
});

describe('POST /admin/data/import/comments', () => {
	async function importComments(body: unknown) {
		return await api('/admin/data/import/comments', { method: 'POST', headers: authed(), body });
	}

	it('缺少 comments 数组返回 400', async () => {
		expect((await importComments({})).status).toBe(400);
		expect((await importComments({ comments: 'x' })).status).toBe(400);
		expect((await importComments('null')).status).toBe(400);
	});

	it('非法 JSON 返回 500（json() 无 catch）', async () => {
		const res = await api('/admin/data/import/comments', {
			method: 'POST',
			headers: { ...authed(), 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(res.status).toBe(500);
	});

	it('成功导入并返回条数', async () => {
		const res = await importComments({
			comments: [
				{
					postSlug: '/posts/a',
					author: 'Alice',
					email: 'a@example.com',
					contentText: 'hello',
					pubDate: '2024-03-05T06:07:08.000Z',
					status: 'approved',
					url: 'https://me.example.com',
					ipAddress: '1.2.3.4',
					os: 'Windows 10',
					browser: 'Chrome',
				},
			],
		});
		expect(res.status).toBe(200);
		expect(res.body.data.imported).toBe(1);
		expect(res.body.message).toContain('成功 1 条');

		const rows = await allComments();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			post_slug: '/posts/a',
			author: 'Alice',
			email: 'a@example.com',
			content_text: 'hello',
			url: 'https://me.example.com',
			ip_address: '1.2.3.4',
			os: 'Windows 10',
			browser: 'Chrome',
			status: 'approved',
		});
	});

	it('ISO 字符串 pubDate 转为毫秒整数', async () => {
		await importComments({
			comments: [{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'x', pubDate: '2024-03-05T06:07:08.000Z' }],
		});
		expect((await allComments())[0].pub_date).toBe(1709618828000);
	});

	it('缺少 pubDate 时回落到当前时间（毫秒整数）', async () => {
		const before = Date.now();
		await importComments({ comments: [{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'x' }] });
		const pubDate = (await allComments())[0].pub_date as number;
		expect(Number.isInteger(pubDate)).toBe(true);
		expect(pubDate).toBeGreaterThanOrEqual(before);
		expect(pubDate).toBeLessThanOrEqual(Date.now());
	});

	it('支持下划线字段名（post_slug / content_text / pub_date）', async () => {
		await importComments({
			comments: [{ post_slug: '/p', author: 'A', email: 'a@b.c', content_text: 'x', pub_date: 1730000000000 }],
		});
		const row = (await allComments())[0];
		expect(row.post_slug).toBe('/p');
		expect(row.content_text).toBe('x');
		expect(row.pub_date).toBe(1730000000000);
	});

	it('缺少 status 时默认 pending（最安全）', async () => {
		await importComments({ comments: [{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'x' }] });
		expect((await allComments())[0].status).toBe('pending');
	});

	it('contentHtml 不被采信，由正文重新渲染并净化', async () => {
		await importComments({
			comments: [
				{
					postSlug: '/p',
					author: 'A',
					email: 'a@b.c',
					contentText: '**bold**',
					contentHtml: '<img src=x onerror=alert(1)>',
				},
			],
		});
		const row = (await allComments())[0];
		expect(row.content_html).toBe('<p><strong>bold</strong></p>\n');
		expect(row.content_html).not.toContain('onerror');
	});

	it('author / postSlug / contentText 被净化', async () => {
		await importComments({
			comments: [
				{
					postSlug: '/p<script>x</script>',
					author: 'A<script>x</script>',
					email: 'a@b.c',
					contentText: 'safe<script>x</script>',
				},
			],
		});
		const row = (await allComments())[0];
		expect(row.post_slug).toBe('/p');
		expect(row.author).toBe('A');
		expect(row.content_text).toBe('safe');
	});

	it('url 走协议白名单，非法协议落库为 NULL', async () => {
		await importComments({
			comments: [{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'x', url: 'javascript:alert(1)' }],
		});
		expect((await allComments())[0].url).toBeNull();
	});

	it('缺字段的记录被跳过并逐条报错', async () => {
		const res = await importComments({
			comments: [
				{ author: 'A', email: 'a@b.c', contentText: 'x' },
				{ postSlug: '/p', email: 'a@b.c', contentText: 'x' },
				{ postSlug: '/p', author: 'A', contentText: 'x' },
				{ postSlug: '/p', author: 'A', email: 'a@b.c' },
				{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'ok' },
			],
		});
		expect(res.status).toBe(200);
		expect(res.body.data.imported).toBe(1);
		expect(res.body.data.errors).toEqual([
			'第 1 条缺少 postSlug',
			'第 2 条缺少 author',
			'第 3 条缺少 email',
			'第 4 条缺少 contentText',
		]);
		expect(res.body.message).toContain('失败 4 条');
	});

	it('超长字段的记录被跳过', async () => {
		const res = await importComments({
			comments: [{ postSlug: '/p', author: 'x'.repeat(101), email: 'a@b.c', contentText: 'x' }],
		});
		expect(res.body.data.imported).toBe(0);
		expect(res.body.data.errors[0]).toContain('超出长度限制');
	});

	it('无 errors 时 errors 字段不出现', async () => {
		const res = await importComments({
			comments: [{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'x' }],
		});
		expect(res.body.data.errors).toBeUndefined();
	});

	it('空数组导入返回 0 条', async () => {
		const res = await importComments({ comments: [] });
		expect(res.body.data.imported).toBe(0);
		expect(await allComments()).toEqual([]);
	});

	it('部分成功时其余记录仍然入库', async () => {
		const res = await importComments({
			comments: [
				{ postSlug: '/p', author: 'A', email: 'a@b.c', contentText: 'first' },
				{ author: 'Bad' },
				{ postSlug: '/p', author: 'C', email: 'c@b.c', contentText: 'third' },
			],
		});
		expect(res.body.data.imported).toBe(2);
		expect((await allComments()).map((r) => r.content_text)).toEqual(['first', 'third']);
	});

	it('parentId 会落库（先导入父再导入子）', async () => {
		await importComments({
			comments: [
				{ postSlug: '/p', author: 'P', email: 'p@b.c', contentText: 'parent' },
				{ postSlug: '/p', author: 'C', email: 'c@b.c', contentText: 'child', parentId: 1 },
			],
		});
		expect((await getComment(2))?.parent_id).toBe(1);
	});
});

describe('POST /admin/data/import/settings', () => {
	async function importSettings(body: unknown) {
		return await api('/admin/data/import/settings', { method: 'POST', headers: authed(), body });
	}

	it('非对象请求体返回 400', async () => {
		expect((await importSettings('null')).status).toBe(400);
		expect((await importSettings('"str"')).status).toBe(400);
	});

	it('导入白名单设置并返回 updated 列表', async () => {
		const res = await importSettings({ site_name: 'Momo', admin_email: 'a@b.c' });
		expect(res.status).toBe(200);
		expect(res.body.data.updated.sort()).toEqual(['admin_email', 'site_name']);
		expect(await rawSettings()).toMatchObject({ site_name: 'Momo', admin_email: 'a@b.c' });
	});

	it('白名单外的键被静默忽略', async () => {
		const res = await importSettings({ secret_key: 'x', site_name: 'Momo' });
		expect(res.body.data.updated).toEqual(['site_name']);
		expect(await rawSettings()).not.toHaveProperty('secret_key');
	});

	it('敏感字段为空串时表示「不修改」，不覆盖已有值', async () => {
		await seedSettings({ email_password: 'existing', admin_comment_key: 'key' });
		const res = await importSettings({ email_password: '', admin_comment_key: '', site_name: 'Momo' });
		expect(res.body.data.updated).toEqual(['site_name']);
		expect((await rawSettings()).email_password).toBe('existing');
		expect((await rawSettings()).admin_comment_key).toBe('key');
	});

	it('敏感字段有值时正常覆盖', async () => {
		await seedSettings({ email_password: 'old' });
		await importSettings({ email_password: 'new' });
		expect((await rawSettings()).email_password).toBe('new');
	});

	it('null / undefined 值被跳过', async () => {
		const res = await importSettings({ site_name: null, admin_email: 'a@b.c' });
		expect(res.body.data.updated).toEqual(['admin_email']);
	});

	it('ip_blacklist 校验失败返回 400', async () => {
		const res = await importSettings({ ip_blacklist: '["bad"]' });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain('ip_blacklist must be a JSON array');
	});

	it('ip_blacklist 合法时导入成功', async () => {
		await importSettings({ ip_blacklist: '["10.0.0.0/8"]' });
		expect((await rawSettings()).ip_blacklist).toBe('["10.0.0.0/8"]');
	});

	it('审核自动化规则非法时整批拒绝，合法时写入', async () => {
		const bad = await importSettings({ site_name: '不应写入', comment_spam_max_links: '51' });
		expect(bad.status).toBe(400);
		expect(bad.body.message).toBe('comment_spam_max_links must be an integer between 0 and 50');
		expect(await rawSettings()).not.toHaveProperty('site_name');

		const good = await importSettings({
			comment_spam_keywords: '["加微信"]',
			comment_spam_max_links: '5',
			comment_spam_min_length: '0',
			comment_spam_duplicate_window: '60',
		});
		expect(good.status).toBe(200);
		expect((await rawSettings()).comment_spam_max_links).toBe('5');
		expect((await rawSettings()).comment_spam_keywords).toBe('["加微信"]');
	});

	it('非法 JSON 返回 500（json() 无 catch）', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: { ...authed(), 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(res.status).toBe(500);
	});
});

describe('导出 → 导入 往返', () => {
	it('设置：导出后清空再导入，关键配置一致（敏感字段除外）', async () => {
		await seedSettings({
			site_name: 'Momo Blog',
			admin_email: 'admin@example.com',
			comment_auto_approve: 'false',
			allow_origin: 'https://a.com',
			email_password: 'smtp-secret',
		});
		const exported = (await api('/admin/data/export/settings', { headers: authed() })).body.data.settings as Record<
			string,
			string
		>;

		await testEnv.MOMO_DB.prepare('DELETE FROM Settings').run();
		const res = await api('/admin/data/import/settings', { method: 'POST', headers: authed(), body: exported });
		expect(res.status).toBe(200);

		const after = await rawSettings();
		expect(after.site_name).toBe('Momo Blog');
		expect(after.admin_email).toBe('admin@example.com');
		expect(after.comment_auto_approve).toBe('false');
		expect(after.allow_origin).toBe('https://a.com');
		// 导出时已被置空 → 导入时按「不修改」处理，因而不会写入空值
		expect(after.email_password).toBeUndefined();
	});

	it('评论：导出后导入到空库，内容与状态一致', async () => {
		await seedComment({
			post_slug: '/posts/x',
			author: 'Alice',
			email: 'alice@example.com',
			content_text: '**hello**',
			content_html: '<p><strong>hello</strong></p>\n',
			pub_date: 1730000000000,
			status: 'approved',
			url: 'https://me.example.com',
		});
		const exported = (await api('/admin/data/export/comments', { headers: authed() })).body.data.comments;

		await testEnv.MOMO_DB.prepare('DELETE FROM Comment').run();
		const res = await api('/admin/data/import/comments', { method: 'POST', headers: authed(), body: { comments: exported } });
		expect(res.body.data.imported).toBe(1);

		const rows = await allComments();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			post_slug: '/posts/x',
			author: 'Alice',
			email: 'alice@example.com',
			content_text: '**hello**',
			content_html: '<p><strong>hello</strong></p>\n',
			pub_date: 1730000000000,
			status: 'approved',
			url: 'https://me.example.com',
		});
	});
});
