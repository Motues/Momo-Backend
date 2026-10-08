/**
 * /admin/users/blacklist —— 邮箱黑名单的增删，并验证其与前台提交的联动。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, rawSetting, seedSettings } from '../helpers/db';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

async function add(email: unknown) {
	return await api('/admin/users/blacklist', { method: 'POST', headers: authed(), body: { email } });
}

async function remove(email: string) {
	return await api(`/admin/users/blacklist?email=${encodeURIComponent(email)}`, {
		method: 'DELETE',
		headers: authed(),
	});
}

describe('POST /admin/users/blacklist', () => {
	it('缺少 email 返回 400', async () => {
		expect((await add(undefined)).status).toBe(400);
		expect((await add('')).status).toBe(400);
		expect((await add('   ')).status).toBe(400);
	});

	it('加入黑名单并小写归一化后落库', async () => {
		const res = await add('  Spam@Example.COM  ');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'User added to blacklist',
			data: { email: 'spam@example.com', blacklisted: true },
		});
		expect(await rawSetting('email_blacklist')).toBe('["spam@example.com"]');
	});

	it('重复加入返回 already in blacklist 且不产生重复项', async () => {
		await add('a@example.com');
		const res = await add('A@EXAMPLE.COM');
		expect(res.body.message).toBe('User is already in blacklist');
		expect(await rawSetting('email_blacklist')).toBe('["a@example.com"]');
	});

	it('保留已有条目', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['first@example.com']) });
		await add('second@example.com');
		expect(JSON.parse((await rawSetting('email_blacklist')) as string)).toEqual([
			'first@example.com',
			'second@example.com',
		]);
	});

	it('已有黑名单为非法 JSON 时视为空列表后追加', async () => {
		await seedSettings({ email_blacklist: 'not-json' });
		expect((await add('a@example.com')).status).toBe(200);
		expect(await rawSetting('email_blacklist')).toBe('["a@example.com"]');
	});

	it('已有黑名单不是数组时视为空列表', async () => {
		await seedSettings({ email_blacklist: '{"a":1}' });
		await add('a@example.com');
		expect(await rawSetting('email_blacklist')).toBe('["a@example.com"]');
	});

	it('已有黑名单中的空串条目被过滤', async () => {
		await seedSettings({ email_blacklist: '[""]' });
		await add('a@example.com');
		expect(await rawSetting('email_blacklist')).toBe('["a@example.com"]');
	});

	it('非法 JSON 请求体返回 400（json() 有 catch 兜底）', async () => {
		const res = await api('/admin/users/blacklist', {
			method: 'POST',
			headers: { ...authed(), 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(res.status).toBe(400);
	});

	it('非字符串 email 会被 String() 强制转换后接受（记录既有行为）', async () => {
		const res = await add(12345);
		expect(res.status).toBe(200);
		expect(await rawSetting('email_blacklist')).toBe('["12345"]');
	});
});

describe('DELETE /admin/users/blacklist', () => {
	it('缺少 email 返回 400', async () => {
		expect((await api('/admin/users/blacklist', { method: 'DELETE', headers: authed() })).status).toBe(400);
		expect((await api('/admin/users/blacklist?email=', { method: 'DELETE', headers: authed() })).status).toBe(400);
	});

	it('移除已存在的邮箱', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['a@example.com', 'b@example.com']) });
		const res = await remove('a@example.com');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'User removed from blacklist',
			data: { email: 'a@example.com', blacklisted: false },
		});
		expect(JSON.parse((await rawSetting('email_blacklist')) as string)).toEqual(['b@example.com']);
	});

	it('不区分大小写匹配', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['a@example.com']) });
		const res = await remove('A@Example.com');
		expect(res.body.message).toBe('User removed from blacklist');
		expect(await rawSetting('email_blacklist')).toBe('[]');
	});

	it('移除不存在的邮箱返回 not in blacklist', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['a@example.com']) });
		const res = await remove('zzz@example.com');
		expect(res.body.message).toBe('User is not in blacklist');
		expect(await rawSetting('email_blacklist')).toBe('["a@example.com"]');
	});

	it('黑名单为空时移除返回 not in blacklist', async () => {
		expect((await remove('a@example.com')).body.message).toBe('User is not in blacklist');
	});
});

describe('邮箱黑名单与前台提交联动', () => {
	it('加入黑名单后该邮箱无法再提交评论', async () => {
		expect((await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.90',
			body: { post_slug: '/p', author: 'A', email: 'spam@example.com', content: 'hi' },
		})).status).toBe(200);

		await add('spam@example.com');

		const res = await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.91',
			body: { post_slug: '/p', author: 'A', email: 'SPAM@example.com', content: 'hi' },
		});
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Your email has been blocked');
	});

	it('移出黑名单后可以重新提交', async () => {
		await add('spam@example.com');
		expect((await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.92',
			body: { post_slug: '/p', author: 'A', email: 'spam@example.com', content: 'hi' },
		})).status).toBe(403);

		await remove('spam@example.com');
		expect((await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.93',
			body: { post_slug: '/p', author: 'A', email: 'spam@example.com', content: 'hi' },
		})).status).toBe(200);
	});

	it('加入黑名单后用户列表会标记 blacklisted', async () => {
		await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.94',
			body: { post_slug: '/p', author: 'Spammer', email: 'spam@example.com', content: 'hi' },
		});
		await add('spam@example.com');
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.body.data.users[0].blacklisted).toBe(true);
	});
});
