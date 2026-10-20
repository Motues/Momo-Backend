/**
 * 表情设置契约（v3：多来源）—— 启用开关 + OwO 来源地址数组的接口验收。
 *
 * 口径与 fixture 见 doc/emoji.md 与 doc/vectors/emoji-v3.json：
 * `emoji_cdn_urls`（JSON 数组，最多 5 个）是权威来源，旧的单地址键仅在数组解析为空时回落。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, rawSetting, seedComment, seedSettings } from '../helpers/db';
import { DEFAULT_EMOJI_CDN_URL, EMOJI_CDN_URLS_ERRORS } from '../../src/utils/emoji';

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

describe('PUT /admin/settings —— emoji_cdn_urls（契约 v3 多来源）', () => {
	it('合法值落库为归一化后的 JSON 数组（trim + 去空）', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: bearer(token),
			body: { emoji_cdn_urls: '["  https://a.example.com/owo.json  ", "", "https://b.example.com/owo.json"]' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('emoji_cdn_urls')).toBe(
			'["https://a.example.com/owo.json","https://b.example.com/owo.json"]'
		);
	});

	it('空串 / 空白 / 空数组落库为 []', async () => {
		for (const value of ['', '   ', '[]', '["", "   "]']) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: bearer(token),
				body: { emoji_cdn_urls: value },
			});
			expect(res.status, value).toBe(200);
			expect(await rawSetting('emoji_cdn_urls'), value).toBe('[]');
		}
	});

	it('五条错误文案逐字一致，且整批不落库', async () => {
		const cases: Array<[string, string]> = [
			['not json', EMOJI_CDN_URLS_ERRORS.notArray],
			['{}', EMOJI_CDN_URLS_ERRORS.notArray],
			['"https://a.example.com/owo.json"', EMOJI_CDN_URLS_ERRORS.notArray],
			['[1]', EMOJI_CDN_URLS_ERRORS.notString],
			['["https://a.example.com/owo.json", null]', EMOJI_CDN_URLS_ERRORS.notString],
			[
				'["https://a.example.com/owo.json","https://b.example.com/owo.json","https://c.example.com/owo.json","https://d.example.com/owo.json","https://e.example.com/owo.json","https://f.example.com/owo.json"]',
				EMOJI_CDN_URLS_ERRORS.tooMany,
			],
			['["ftp://a.example.com/owo.json"]', EMOJI_CDN_URLS_ERRORS.badScheme],
			['["javascript:alert(1)"]', EMOJI_CDN_URLS_ERRORS.badScheme],
			['["owo.json"]', EMOJI_CDN_URLS_ERRORS.badScheme],
			['["//example.com/owo.json"]', EMOJI_CDN_URLS_ERRORS.badScheme],
			['["<img src=x>"]', EMOJI_CDN_URLS_ERRORS.badScheme],
			[`["https://cdn.example.com/${'a'.repeat(500)}"]`, EMOJI_CDN_URLS_ERRORS.tooLong],
		];

		for (const [value, message] of cases) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: bearer(token),
				body: { emoji_cdn_urls: value, site_name: '不应写入' },
			});
			expect(res.status, value.slice(0, 40)).toBe(400);
			expect(res.body.message, value.slice(0, 40)).toBe(message);
			expect(await rawSetting('emoji_cdn_urls'), value.slice(0, 40)).toBeNull();
			expect(await rawSetting('site_name'), value.slice(0, 40)).toBeNull();
		}
	});

	it('导入路径同一套校验：非法值 400 且不落库', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: { emoji_cdn_urls: '["ftp://a.example.com/owo.json"]' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe(EMOJI_CDN_URLS_ERRORS.badScheme);
		expect(await rawSetting('emoji_cdn_urls')).toBeNull();
	});

	it('导入路径写入归一化后的 JSON 数组', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: { emoji_cdn_urls: '[" https://a.example.com/owo.json "]' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('emoji_cdn_urls')).toBe('["https://a.example.com/owo.json"]');
	});
});

describe('GET /admin/settings?type=emoji', () => {
	it('返回 emoji_enabled + emoji_cdn_urls + 兼容用的 emoji_cdn_url', async () => {
		await seedSettings({
			emoji_cdn_urls: '["https://a.example.com/owo.json","https://b.example.com/owo.json"]',
			emoji_cdn_url: 'https://legacy.example.com/owo.json',
			emoji_enabled: 'false',
		});
		const res = await api('/admin/settings?type=emoji', { headers: bearer(token) });
		expect(Object.keys(res.body.data).sort()).toEqual([
			'email_enabled',
			'emoji_cdn_url',
			'emoji_cdn_urls',
			'emoji_enabled',
		]);
		expect(res.body.data.emoji_cdn_urls).toBe(
			'["https://a.example.com/owo.json","https://b.example.com/owo.json"]'
		);
		expect(res.body.data.emoji_cdn_url).toBe('https://legacy.example.com/owo.json');
		expect(res.body.data.emoji_enabled).toBe('false');
		expect(res.body.data.emoji_packs).toBeUndefined();
	});

	it('未配置时表情键不会凭空出现', async () => {
		const res = await api('/admin/settings?type=emoji', { headers: bearer(token) });
		expect(Object.keys(res.body.data)).toEqual(['email_enabled']);
		expect(res.body.data.emoji_cdn_urls).toBeUndefined();
		expect(res.body.data.emoji_cdn_url).toBeUndefined();
		expect(res.body.data.emoji_enabled).toBeUndefined();
	});
});

describe('GET /api/comments 下发表情配置', () => {
	it('未配置时 fail-open 为启用，地址数组回落默认源的单项数组', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: '198.18.9.1' });
		expect(res.body.data.emoji_enabled).toBe('true');
		expect(res.body.data.emoji_cdn_urls).toEqual([DEFAULT_EMOJI_CDN_URL]);
		// 旧前端字段 = 数组第一个地址
		expect(res.body.data.emoji_cdn_url).toBe(DEFAULT_EMOJI_CDN_URL);
	});

	it('多来源时按数组顺序下发；旧的单地址键被忽略', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		const urls = ['https://a.example.com/owo.json', 'http://b.example.com/owo.json?group=Emoji'];
		await seedSettings({
			emoji_cdn_urls: JSON.stringify(urls),
			emoji_cdn_url: 'https://legacy.example.com/owo.json',
			emoji_enabled: 'FALSE',
		});
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: '198.18.9.2' });
		expect(res.body.data.emoji_enabled).toBe('false');
		expect(res.body.data.emoji_cdn_urls).toEqual(urls);
		expect(res.body.data.emoji_cdn_url).toBe(urls[0]);
	});

	it('数组为空 / 脏值时回落到旧键，旧键也为空再回落默认源', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		const cases: Array<[string, string, string]> = [
			['[]', '  https://legacy.example.com/owo.json  ', 'https://legacy.example.com/owo.json'],
			['not json', 'https://legacy.example.com/owo.json', 'https://legacy.example.com/owo.json'],
			['{"a":1}', '', DEFAULT_EMOJI_CDN_URL],
			['', '   ', DEFAULT_EMOJI_CDN_URL],
		];
		for (const [index, [storedUrls, storedLegacy, expected]] of cases.entries()) {
			await seedSettings({ emoji_cdn_urls: storedUrls, emoji_cdn_url: storedLegacy, emoji_enabled: 'false' });
			const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: `198.18.9.${20 + index}` });
			expect(res.body.data.emoji_cdn_urls, storedUrls).toEqual([expected]);
			expect(res.body.data.emoji_cdn_url, storedUrls).toBe(expected);
			expect(res.body.data.emoji_enabled, storedUrls).toBe('false');
		}
	});

	it('读取宽容：非字符串项 / 空串丢弃、超过 5 个只取前 5 个', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		await seedSettings({
			emoji_cdn_urls:
				'["", 7, "https://a.example.com/owo.json", null, "  ", "https://b.example.com/owo.json", "https://c.example.com/owo.json", "https://d.example.com/owo.json", "https://e.example.com/owo.json", "https://f.example.com/owo.json"]',
		});
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji', { ip: '198.18.9.40' });
		expect(res.body.data.emoji_cdn_urls).toEqual([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
			'https://c.example.com/owo.json',
			'https://d.example.com/owo.json',
			'https://e.example.com/owo.json',
		]);
	});

	it('非嵌套分支同样下发 emoji_cdn_urls', async () => {
		await seedComment({ post_slug: '/posts/emoji' });
		await seedSettings({ emoji_cdn_urls: '["https://a.example.com/owo.json"]' });
		const res = await api('/api/comments?post_slug=%2Fposts%2Femoji&nested=false', { ip: '198.18.9.41' });
		expect(res.body.data.emoji_cdn_urls).toEqual(['https://a.example.com/owo.json']);
		expect(res.body.data.emoji_cdn_url).toBe('https://a.example.com/owo.json');
	});
});

describe('GET /api/emoji 已删除', () => {
	it('未命中路由返回 404', async () => {
		const res = await api('/api/emoji', { ip: '198.18.9.20' });
		expect(res.status).toBe(404);
	});
});

describe('设置导出 / 导入', () => {
	it('导出包含三个表情键，导入可原样恢复（并做归一化）', async () => {
		await seedSettings({
			emoji_cdn_urls: '["https://a.example.com/owo.json"]',
			emoji_cdn_url: 'https://cdn.example.com/owo.json',
			emoji_enabled: 'false',
		});

		const exported = await api('/admin/data/export/settings', { headers: bearer(token) });
		expect(exported.body.data.settings.emoji_cdn_urls).toBe('["https://a.example.com/owo.json"]');
		expect(exported.body.data.settings.emoji_cdn_url).toBe('https://cdn.example.com/owo.json');
		expect(exported.body.data.settings.emoji_enabled).toBe('false');
		expect(exported.body.data.settings.emoji_packs).toBeUndefined();

		const imported = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: bearer(token),
			body: {
				emoji_cdn_url: ' https://cdn.example.com/other.json ',
				emoji_cdn_urls: ' [ " https://b.example.com/owo.json " ] ',
				emoji_enabled: ' TRUE ',
			},
		});
		expect(imported.status).toBe(200);
		expect(await rawSetting('emoji_cdn_url')).toBe('https://cdn.example.com/other.json');
		expect(await rawSetting('emoji_cdn_urls')).toBe('["https://b.example.com/owo.json"]');
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
