/**
 * /admin/comments/list、/admin/comments/status、/admin/comments/edit —— 后台评论管理。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { allComments, createSchema, getComment, seedComment, seedSettings } from '../helpers/db';
import { MAX_AUTHOR, MAX_CONTENT, MAX_URL } from '../../src/utils/security';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

describe('GET /admin/comments/list', () => {
	it('空库返回空列表与 totalPage 0', async () => {
		const res = await api('/admin/comments/list', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.data.comments).toEqual([]);
		expect(res.body.data.pagination).toEqual({ page: 1, limit: 10, totalPage: 0 });
	});

	it('返回完整字段并映射为驼峰命名', async () => {
		await seedComment({
			post_slug: '/posts/demo',
			author: 'Alice',
			email: 'alice@example.com',
			url: 'https://me.example.com',
			ip_address: '1.2.3.4',
			os: 'Windows 10',
			browser: 'Chrome 120',
			content_text: 'hi',
			content_html: '<p>hi</p>',
			status: 'pending',
			pub_date: 1730000000000,
		});
		const res = await api('/admin/comments/list', { headers: authed() });
		expect(res.body.data.comments[0]).toEqual({
			id: 1,
			pubDate: '2024-10-27T03:33:20.000Z',
			postSlug: '/posts/demo',
			author: 'Alice',
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

	it('按 pub_date 倒序', async () => {
		await seedComment({ author: 'Old', pub_date: 1700000000000 });
		await seedComment({ author: 'New', pub_date: 1750000000000 });
		const res = await api('/admin/comments/list', { headers: authed() });
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['New', 'Old']);
	});

	it('status 过滤生效，totalPage 按过滤后的总数计算', async () => {
		await seedComment({ author: 'A', status: 'pending' });
		await seedComment({ author: 'B', status: 'approved' });
		await seedComment({ author: 'C', status: 'approved' });
		const res = await api('/admin/comments/list?status=approved', { headers: authed() });
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['B', 'C']);
		expect(res.body.data.pagination.totalPage).toBe(1);
	});

	it('未知 status 返回空列表但分页信息仍按该状态统计', async () => {
		await seedComment({ status: 'approved' });
		const res = await api('/admin/comments/list?status=nonexistent', { headers: authed() });
		expect(res.body.data.comments).toEqual([]);
		expect(res.body.data.pagination.totalPage).toBe(0);
	});

	it('每页固定 10 条并支持翻页', async () => {
		for (let i = 0; i < 25; i++) {
			await seedComment({ author: `A${i}`, pub_date: 1700000000000 + i * 1000 });
		}
		const first = await api('/admin/comments/list?page=1', { headers: authed() });
		expect(first.body.data.comments).toHaveLength(10);
		expect(first.body.data.pagination.totalPage).toBe(3);
		// 倒序 → 第 1 页是最新的 A24..A15
		expect(first.body.data.comments[0].author).toBe('A24');

		const third = await api('/admin/comments/list?page=3', { headers: authed() });
		expect(third.body.data.comments).toHaveLength(5);
		expect(third.body.data.comments[0].author).toBe('A4');
	});

	it('page 非法 / 负数被钳制为 1', async () => {
		await seedComment();
		for (const page of ['abc', '0', '-2']) {
			const res = await api(`/admin/comments/list?page=${page}`, { headers: authed() });
			expect(res.body.data.pagination.page).toBe(1);
		}
	});

	it('超出末页返回空数组', async () => {
		await seedComment();
		const res = await api('/admin/comments/list?page=99', { headers: authed() });
		expect(res.body.data.comments).toEqual([]);
	});
});

describe('PUT /admin/comments/status', () => {
	it('缺少 id 或 status 返回 400', async () => {
		expect((await api('/admin/comments/status?status=approved', { method: 'PUT', headers: authed() })).status).toBe(400);
		expect((await api('/admin/comments/status?id=1', { method: 'PUT', headers: authed() })).status).toBe(400);
		expect((await api('/admin/comments/status', { method: 'PUT', headers: authed() })).status).toBe(400);
	});

	it('非白名单状态返回 400 且不改库', async () => {
		const id = await seedComment({ status: 'pending' });
		const res = await api(`/admin/comments/status?id=${id}&status=hacked`, { method: 'PUT', headers: authed() });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain('Invalid status');
		expect((await getComment(id))?.status).toBe('pending');
	});

	it.each(['pending', 'approved', 'rejected', 'deleted'])('合法状态 %s 更新成功', async (status) => {
		const id = await seedComment({ status: 'pending' });
		const res = await api(`/admin/comments/status?id=${id}&status=${status}`, { method: 'PUT', headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Comment status updated');
		expect((await getComment(id))?.status).toBe(status);
	});

	it('状态值大小写敏感', async () => {
		const id = await seedComment();
		expect((await api(`/admin/comments/status?id=${id}&status=APPROVED`, { method: 'PUT', headers: authed() })).status).toBe(400);
	});

	it('不存在的 id 也返回 200（UPDATE 影响 0 行）', async () => {
		const res = await api('/admin/comments/status?id=99999&status=approved', { method: 'PUT', headers: authed() });
		expect(res.status).toBe(200);
	});

	it('deleted 会级联到全部子孙评论', async () => {
		const root = await seedComment({ author: 'Root' });
		const child = await seedComment({ author: 'Child', parent_id: root });
		const grandchild = await seedComment({ author: 'Grand', parent_id: child });
		const unrelated = await seedComment({ author: 'Other' });

		await api(`/admin/comments/status?id=${root}&status=deleted`, { method: 'PUT', headers: authed() });

		expect((await getComment(root))?.status).toBe('deleted');
		expect((await getComment(child))?.status).toBe('deleted');
		expect((await getComment(grandchild))?.status).toBe('deleted');
		expect((await getComment(unrelated))?.status).toBe('approved');
	});

	it('pending 同样级联（打回一条评论时其回复不应继续可见）', async () => {
		const root = await seedComment({ author: 'Root', status: 'approved' });
		const child = await seedComment({ author: 'Child', parent_id: root, status: 'approved' });
		await api(`/admin/comments/status?id=${root}&status=pending`, { method: 'PUT', headers: authed() });
		expect((await getComment(root))?.status).toBe('pending');
		expect((await getComment(child))?.status).toBe('pending');
	});

	it('approved 只改本条，不影响子评论', async () => {
		const root = await seedComment({ author: 'Root', status: 'pending' });
		const child = await seedComment({ author: 'Child', parent_id: root, status: 'deleted' });
		await api(`/admin/comments/status?id=${root}&status=approved`, { method: 'PUT', headers: authed() });
		expect((await getComment(root))?.status).toBe('approved');
		expect((await getComment(child))?.status).toBe('deleted');
	});

	it('rejected 只改本条，不影响子评论', async () => {
		const root = await seedComment({ author: 'Root', status: 'pending' });
		const child = await seedComment({ author: 'Child', parent_id: root, status: 'pending' });
		await api(`/admin/comments/status?id=${root}&status=rejected`, { method: 'PUT', headers: authed() });
		expect((await getComment(root))?.status).toBe('rejected');
		expect((await getComment(child))?.status).toBe('pending');
	});

	it('级联只向下，不影响父评论', async () => {
		const root = await seedComment({ author: 'Root', status: 'approved' });
		const child = await seedComment({ author: 'Child', parent_id: root, status: 'approved' });
		await api(`/admin/comments/status?id=${child}&status=deleted`, { method: 'PUT', headers: authed() });
		expect((await getComment(root))?.status).toBe('approved');
		expect((await getComment(child))?.status).toBe('deleted');
	});
});

describe('PUT /admin/comments/edit', () => {
	async function edit(body: unknown) {
		return await api('/admin/comments/edit', { method: 'PUT', headers: authed(), body });
	}

	it('缺少 id 返回 400', async () => {
		const res = await edit({ author: 'X' });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Invalid request parameters');
	});

	it('id 为 0 也视为缺失', async () => {
		expect((await edit({ id: 0, author: 'X' })).status).toBe(400);
	});

	it('没有可更新字段且 id 不存在时返回 400', async () => {
		const res = await edit({ id: 99999 });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('No fields to update');
	});

	it('id 不存在但给了 content_text 时返回 200（重新渲染后 sets 非空）', async () => {
		expect((await edit({ id: 99999, content_text: 'x' })).status).toBe(200);
	});

	it('字段类型不是字符串返回 400', async () => {
		const id = await seedComment();
		for (const field of ['author', 'email', 'content_text', 'url']) {
			const res = await edit({ id, [field]: 123 });
			expect(res.status).toBe(400);
			expect(res.body.message).toBe('Invalid field type');
		}
	});

	it('更新 author / email / url', async () => {
		const id = await seedComment();
		const res = await edit({ id, author: 'NewName', email: 'new@example.com', url: 'https://new.example.com' });
		expect(res.status).toBe(200);
		const row = await getComment(id);
		expect(row?.author).toBe('NewName');
		expect(row?.email).toBe('new@example.com');
		expect(row?.url).toBe('https://new.example.com');
	});

	it('email 两端空白被裁剪', async () => {
		const id = await seedComment();
		await edit({ id, email: '  trim@example.com  ' });
		expect((await getComment(id))?.email).toBe('trim@example.com');
	});

	it('url 走协议白名单', async () => {
		const id = await seedComment();
		await edit({ id, url: 'javascript:alert(1)' });
		expect((await getComment(id))?.url).toBe('');
	});

	it('author 被净化', async () => {
		const id = await seedComment();
		await edit({ id, author: 'A<script>x</script>B' });
		expect((await getComment(id))?.author).toBe('AB');
	});

	it('更新 content_text 时同步重新渲染 content_html', async () => {
		const id = await seedComment({ content_text: 'old', content_html: '<p>old</p>' });
		await edit({ id, content_text: '**bold**' });
		const row = await getComment(id);
		expect(row?.content_text).toBe('**bold**');
		expect(row?.content_html).toBe('<p><strong>bold</strong></p>\n');
	});

	it('content_text 中的脚本被净化，且不会留下 <script>', async () => {
		const id = await seedComment();
		await edit({ id, content_text: 'safe<script>alert(1)</script>' });
		const row = await getComment(id);
		expect(row?.content_text).toBe('safe');
		expect(row?.content_html).not.toContain('<script>');
	});

	it('客户端传入的 content_html 被忽略（永远由正文重新渲染）', async () => {
		const id = await seedComment({ content_text: 'plain' });
		await edit({ id, author: 'X', content_html: '<img src=x onerror=alert(1)>' });
		const row = await getComment(id);
		expect(row?.content_html).toBe('<p>plain</p>\n');
		expect(row?.content_html).not.toContain('onerror');
	});

	it('只改 author 时 content_html 依据库中原正文重新渲染', async () => {
		const id = await seedComment({ content_text: '**from db**', content_html: 'stale' });
		await edit({ id, author: 'X' });
		expect((await getComment(id))?.content_html).toBe('<p><strong>from db</strong></p>\n');
	});

	it('超长字段返回 400', async () => {
		const id = await seedComment();
		expect((await edit({ id, author: 'x'.repeat(MAX_AUTHOR + 1) })).status).toBe(400);
		expect((await edit({ id, content_text: 'x'.repeat(MAX_CONTENT + 1) })).status).toBe(400);
		expect((await edit({ id, url: `https://a.com/${'x'.repeat(MAX_URL)}` })).status).toBe(400);
		expect((await edit({ id, email: `${'a'.repeat(300)}@b.c` })).status).toBe(400);
	});

	it('恰好等于上限的长度通过', async () => {
		const id = await seedComment();
		expect((await edit({ id, author: 'x'.repeat(MAX_AUTHOR) })).status).toBe(200);
		expect((await edit({ id, content_text: 'x'.repeat(MAX_CONTENT) })).status).toBe(200);
	});

	it('长度校验基于净化后的值', async () => {
		const id = await seedComment();
		// 净化会移除 script 块，净化后长度回到上限以内
		const payload = 'x'.repeat(MAX_CONTENT) + '<script>alert(1)</script>';
		expect((await edit({ id, content_text: payload })).status).toBe(200);
	});

	it('不在白名单的字段（如 status）被忽略', async () => {
		const id = await seedComment({ status: 'pending' });
		await edit({ id, status: 'approved', author: 'X' });
		const row = await getComment(id);
		expect(row?.status).toBe('pending');
		expect(row?.author).toBe('X');
	});

	it('编辑不会影响其它评论', async () => {
		const first = await seedComment({ author: 'First' });
		const second = await seedComment({ author: 'Second' });
		await edit({ id: first, author: 'Changed' });
		const rows = await allComments();
		expect(rows.find((r) => r.id === second)?.author).toBe('Second');
	});
});
