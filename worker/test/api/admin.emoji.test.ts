/**
 * 表情设置契约 v2 —— 启用开关 + OwO 来源地址的接口验收。
 *
 * 口径与 fixture 见 doc/emoji.md 与 doc/vectors/emoji-v2.json：
 * v1 的「自定义表情包」（`emoji_packs`）与公开接口 `GET /api/emoji` 已整体删除。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, rawSetting, seedComment, seedSettings } from '../helpers/db';
import { DEFAULT_EMOJI_CDN_URL } from '../../src/utils/emoji';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

describe('PUT /admin/settings —— emoji_enabled', () => {
	it('缺少 token 返回 401', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			body: { emoji_enabled: 'true' },
		});
		expect(res.status).toBe(401);
	});

	it('合法值写入成功，且落库的是归一化（trim + 小写）后的值', async () => {
		const cases: Array<[string, string]> = [
			['true', 'true'],
			[' TRUE ', 'true'],
			['False', 'false'],
			[' false ', 'false'],
			['', ''],
			['   ', ''],
		];

		for (const [input, stored] of cases) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: bearer(token),
				body: { emoji_enabled: input },
			});
			expect(res.status, JSON.stringify(input)).toBe(200);
			expect(await rawSetting('emoji_enabled'), JSON.stringify(input)).toBe(stored);
		}
	});

	it('非法值返回 400、消息固定，且整批不落库', async () => {
		for (const value of ['1', '0', 'yes', 'on', 'true1', '否', 'null']) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: bearer(token),
				body: { emoji_enabled: value, site_name: '不应写入' },
			});
			expect(res.status, value).toBe(400);
			expect(res.body.message, value).toBe('emoji_enabled 只能是 true 或 false');
		}
		expect(await rawSetting('emoji_enabled')).toBeNull();
		expect(await rawSetting('site_name')).toBeNull();
	});

	it('emoji_packs 已从白名单移除：整键被拒绝', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_packs: '{}' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Setting "emoji_packs" is not allowed');
		expect(await rawSetting('emoji_packs')).toBeNull();
	});
});

describe('PUT /admin/settings —— emoji_cdn_url', () => {
	it('只接受 http/https、做去空格归一化，空串表示未配置', async () => {
		const bad = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_cdn_url: 'javascript:alert(1)' },
		});
		expect(bad.status).toBe(400);
		expect(bad.body.message).toBe('emoji_cdn_url 只允许 http/https 地址');
		expect(await rawSetting('emoji_cdn_url')).toBeNull();

		const ok = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_cdn_url: '  https://cdn.example.com/owo.json  ' },
		});
		expect(ok.status).toBe(200);
		expect(await rawSetting('emoji_cdn_url')).toBe('https://cdn.example.com/owo.json');

		const empty = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_cdn_url: '   ' },
		});
		expect(empty.status).toBe(200);
		expect(await rawSetting('emoji_cdn_url')).toBe('');
	});

	it('超过 500 码点被拒绝、消息固定且不落库', async () => {
		const tooLong = `https://cdn.example.com/${'a'.repeat(500)}`;
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_cdn_url: tooLong },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('emoji_cdn_url 不能超过 500 个字符');
		expect(await rawSetting('emoji_cdn_url')).toBeNull();
	});
});

describe('GET /admin/settings?type=emoji', () => {
	it('只返回两个表情键（外加既有行为注入的 email_enabled）', async () => {
		await seedSettings({
			emoji_cdn_url: 'https://cdn.example.com/owo.json',
			emoji_enabled: 'false',
		});
		const res = await api('/admin/settings?type=emoji', { headers: bearer(token) });
		expect(Object.keys(res.body.data).sort()).toEqual(['email_enabled', 'emoji_cdn_url', 'emoji_enabled']);
		expect(res.body.data.emoji_cdn_url).toBe('https://cdn.example.com/owo.json');
		expect(res.body.data.emoji_enabled).toBe('false');
		expect(res.body.data.emoji_packs).toBeUndefined();
	});

	it('未配置时表情键不会凭空出现', async () => {
		const res = await api('/admin/settings?type=emoji', { headers: bearer(token) });
		expect(Object.keys(res.body.data)).toEqual(['email_enabled']);
		expect(res.body.data.emoji_cdn_url).toBeUndefined();
		expect(res.body.data.emoji_enabled).toBeUndefined();
	});
});

describe('GET /api/comments 下发表情配置', () => {
	it('未配置时 fail-open 为启用，地址回落默认源', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: '198.18.9.1' });
		expect(res.body.data.emoji_enabled).toBe('true');
		expect(res.body.data.emoji_cdn_url).toBe(DEFAULT_EMOJI_CDN_URL);
	});

	it('已配置时下发归一化后的地址与开关；关闭时地址照常下发', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		await seedSettings({
			emoji_cdn_url: '  https://cdn.example.com/owo.json?group=Emoji  ',
			emoji_enabled: 'FALSE',
		});
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: '198.18.9.2' });
		expect(res.body.data.emoji_enabled).toBe('false');
		expect(res.body.data.emoji_cdn_url).toBe('https://cdn.example.com/owo.json?group=Emoji');
	});

	it('地址为空串 / 只有空白时回落默认源，开关照常下发', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		for (const [index, url] of ['', '   '].entries()) {
			await seedSettings({ emoji_cdn_url: url, emoji_enabled: 'false' });
			const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: `198.18.9.${10 + index}` });
			expect(res.body.data.emoji_cdn_url, JSON.stringify(url)).toBe(DEFAULT_EMOJI_CDN_URL);
			expect(res.body.data.emoji_enabled, JSON.stringify(url)).toBe('false');
		}
	});
});

describe('GET /api/emoji 已删除', () => {
	it('未命中路由返回 404', async () => {
		const res = await api('/api/emoji', { ip: '198.18.9.20' });
		expect(res.status).toBe(404);
	});
});

describe('设置导出 / 导入', () => {
	it('导出包含两个表情键，导入可原样恢复（并做归一化）', async () => {
		await seedSettings({
			emoji_cdn_url: 'https://cdn.example.com/owo.json',
			emoji_enabled: 'false',
		});

		const exported = await api('/admin/data/export/settings', { headers: bearer(token) });
		expect(exported.body.data.settings.emoji_cdn_url).toBe('https://cdn.example.com/owo.json');
		expect(exported.body.data.settings.emoji_enabled).toBe('false');
		expect(exported.body.data.settings.emoji_packs).toBeUndefined();

		const imported = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: {
				emoji_cdn_url: ' https://cdn.example.com/other.json ',
				emoji_enabled: ' TRUE ',
			},
		});
		expect(imported.status).toBe(200);
		expect(await rawSetting('emoji_cdn_url')).toBe('https://cdn.example.com/other.json');
		expect(await rawSetting('emoji_enabled')).toBe('true');
	});

	it('导入非法 emoji_enabled 被拒绝且不落库', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: { emoji_enabled: 'yes', emoji_cdn_url: 'https://cdn.example.com/owo.json' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('emoji_enabled 只能是 true 或 false');
		expect(await rawSetting('emoji_enabled')).toBeNull();
		expect(await rawSetting('emoji_cdn_url')).toBeNull();
	});

	it('导入非法 emoji_cdn_url 被拒绝且不落库', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: { emoji_cdn_url: 'ftp://a.com/owo.json', emoji_enabled: 'true' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('emoji_cdn_url 只允许 http/https 地址');
		expect(await rawSetting('emoji_cdn_url')).toBeNull();
		expect(await rawSetting('emoji_enabled')).toBeNull();
	});

	it('导入文件里的 emoji_packs 不在白名单内，被静默忽略（导入路径既有行为）', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: { emoji_packs: '{}' },
		});
		expect(res.status).toBe(200);
		expect(res.body.data.updated).toEqual([]);
		expect(await rawSetting('emoji_packs')).toBeNull();
	});
});
