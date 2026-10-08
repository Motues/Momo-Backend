/**
 * src/utils/cors.ts —— 跨域白名单。
 *
 * 默认姿态是「未配置即拒绝跨域」：index.ts 从 Settings 读 allow_origin，
 * 未配置时传入空串，此时任何 Origin 都不应拿到 Access-Control-Allow-Origin。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { customCors } from '../../src/utils/cors';

function buildApp(allowOrigin: string | undefined) {
	const app = new Hono();
	app.use('*', customCors(allowOrigin));
	app.get('/x', (c) => c.text('ok'));
	app.post('/x', (c) => c.text('ok'));
	app.put('/x', (c) => c.text('ok'));
	app.delete('/x', (c) => c.text('ok'));
	return app;
}

const ACAO = 'access-control-allow-origin';
const ACAM = 'access-control-allow-methods';
const ACAH = 'access-control-allow-headers';
const ACAC = 'access-control-allow-credentials';
const EXPO = 'access-control-expose-headers';
const MAXAGE = 'access-control-max-age';

describe('customCors —— 空白名单（默认拒绝跨域）', () => {
	const app = buildApp('');

	it('无 Origin 的普通请求：响应正常但没有跨域头', async () => {
		const res = await app.request('/x');
		expect(res.status).toBe(200);
		expect(res.headers.get(ACAO)).toBeNull();
		// 仍然声明 Vary: Origin，避免下游缓存串味
		expect(res.headers.get('vary')).toContain('Origin');
		expect(res.headers.get(EXPO)).toBe('Content-Length');
	});

	it('带不匹配 Origin 的请求：不下发 Allow-Origin', async () => {
		const res = await app.request('/x', { headers: { Origin: 'http://evil.com' } });
		expect(res.status).toBe(200);
		expect(res.headers.get(ACAO)).toBeNull();
	});

	it('未配置时 * 也不生效（空串不等于通配）', async () => {
		const res = await app.request('/x', { headers: { Origin: '*' } });
		expect(res.headers.get(ACAO)).toBeNull();
	});

	it('undefined 与空串等价', async () => {
		const res = await buildApp(undefined).request('/x', { headers: { Origin: 'http://a.com' } });
		expect(res.headers.get(ACAO)).toBeNull();
	});

	it('预检请求返回 204 但不放行任何来源', async () => {
		const res = await app.request('/x', {
			method: 'OPTIONS',
			headers: { Origin: 'http://evil.com', 'access-control-request-method': 'POST' },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get(ACAO)).toBeNull();
		expect(res.headers.get(ACAM)).toBe('GET,POST,PUT,DELETE,OPTIONS');
	});
});

describe('customCors —— 精确白名单', () => {
	const app = buildApp('http://good.com');

	it('匹配来源原样回显', async () => {
		const res = await app.request('/x', { headers: { Origin: 'http://good.com' } });
		expect(res.status).toBe(200);
		expect(res.headers.get(ACAO)).toBe('http://good.com');
	});

	it('不匹配来源不下发 Allow-Origin', async () => {
		const res = await app.request('/x', { headers: { Origin: 'http://good.com.evil.com' } });
		expect(res.headers.get(ACAO)).toBeNull();
	});

	it('大小写 / 末尾斜杠属于不同来源（精确匹配）', async () => {
		expect((await app.request('/x', { headers: { Origin: 'HTTP://GOOD.COM' } })).headers.get(ACAO)).toBeNull();
		expect((await app.request('/x', { headers: { Origin: 'http://good.com/' } })).headers.get(ACAO)).toBeNull();
	});

	it('预检请求下发方法与头部、max-age', async () => {
		const res = await app.request('/x', {
			method: 'OPTIONS',
			headers: { Origin: 'http://good.com', 'access-control-request-method': 'POST' },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get(ACAO)).toBe('http://good.com');
		expect(res.headers.get(ACAM)).toBe('GET,POST,PUT,DELETE,OPTIONS');
		expect(res.headers.get(ACAH)).toBe('Content-Type,Authorization');
		expect(res.headers.get(MAXAGE)).toBe('600');
	});
});

describe('customCors —— 多来源与通配', () => {
	it('逗号分隔列表会 trim 并逐个匹配', async () => {
		const app = buildApp(' http://a.com , http://b.com ,, http://c.com ');
		expect((await app.request('/x', { headers: { Origin: 'http://a.com' } })).headers.get(ACAO)).toBe('http://a.com');
		expect((await app.request('/x', { headers: { Origin: 'http://b.com' } })).headers.get(ACAO)).toBe('http://b.com');
		expect((await app.request('/x', { headers: { Origin: 'http://c.com' } })).headers.get(ACAO)).toBe('http://c.com');
		expect((await app.request('/x', { headers: { Origin: 'http://d.com' } })).headers.get(ACAO)).toBeNull();
	});

	it('显式配置 * 时按通配返回 *', async () => {
		const app = buildApp('*');
		const res = await app.request('/x', { headers: { Origin: 'http://any.com' } });
		expect(res.headers.get(ACAO)).toBe('*');
	});

	it('* 与具体来源混排时仍然通配', async () => {
		const app = buildApp('http://a.com,*');
		expect((await app.request('/x', { headers: { Origin: 'http://zzz.com' } })).headers.get(ACAO)).toBe('*');
	});

	it('不下发 Allow-Credentials（Bearer 令牌方案下同时给 * 与 credentials 本就无效）', async () => {
		const app = buildApp('*');
		const res = await app.request('/x', { headers: { Origin: 'http://any.com' } });
		expect(res.headers.get(ACAC)).toBeNull();
	});

	it('仅空白字符串等价于空白名单', async () => {
		const app = buildApp('  ,  ');
		expect((await app.request('/x', { headers: { Origin: 'http://a.com' } })).headers.get(ACAO)).toBeNull();
	});

	it('所有 HTTP 方法都在 allowMethods 白名单内', async () => {
		const app = buildApp('http://good.com');
		for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
			expect((await app.request('/x', { method })).status).toBe(200);
		}
	});
});
