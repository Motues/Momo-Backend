/**
 * GET / PUT /admin/settings + POST /admin/settings/test-email —— 设置白名单、敏感字段与邮件测试。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, rawSetting, rawSettings, seedSettings } from '../helpers/db';
import { resetSentMails, sentMails, failNextSendMail } from '../stubs/nodemailer';

let token: string;

beforeEach(async () => {
	await createSchema();
	resetSentMails();
	token = await adminToken();
});

const authed = () => bearer(token);

describe('GET /admin/settings', () => {
	it('未配置任何设置时只返回注入的默认值与 worker 提示', async () => {
		const res = await api('/admin/settings', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.code).toBe(200);
		expect(res.body.message).toBe('Settings fetched');
		// trust_proxy 在白名单里，因此完整列表总带 trust_proxy_override
		expect(res.body.data).toEqual({ email_enabled: 'true', trust_proxy_override: 'worker' });
	});

	it('只返回白名单内的键（数据库中的其它键被过滤）', async () => {
		await seedSettings({ site_name: 'Momo', internal_secret: 'should-not-leak' });
		const res = await api('/admin/settings', { headers: authed() });
		expect(res.body.data.site_name).toBe('Momo');
		expect(res.body.data.internal_secret).toBeUndefined();
	});

	it('敏感字段读取时一律置空；不在白名单内的密码字段根本不出现', async () => {
		await seedSettings({
			admin_password: '$2hashed',
			email_password: 'smtp-secret',
			admin_comment_key: 'comment-key',
			comment_verify_secret: 'a'.repeat(64),
		});
		const res = await api('/admin/settings', { headers: authed() });
		expect(res.body.data.email_password).toBe('');
		expect(res.body.data.admin_comment_key).toBe('');
		// admin_password / comment_verify_secret 不在 ALLOWED_SETTINGS 中，整个键都不下发
		expect(res.body.data.admin_password).toBeUndefined();
		expect(res.body.data.comment_verify_secret).toBeUndefined();
	});

	it('email_enabled 未配置时注入默认 "true"', async () => {
		await seedSettings({ site_name: 'Momo' });
		expect((await api('/admin/settings', { headers: authed() })).body.data.email_enabled).toBe('true');
	});

	it('已配置的 email_enabled 原样下发', async () => {
		await seedSettings({ email_enabled: 'false' });
		expect((await api('/admin/settings', { headers: authed() })).body.data.email_enabled).toBe('false');
	});

	it('type=basic 只返回已配置的基础分组键', async () => {
		await seedSettings({ site_name: 'Momo', allow_origin: 'https://a.com', smtp_host: 'h' });
		const res = await api('/admin/settings?type=basic', { headers: authed() });
		expect(res.body.data.site_name).toBe('Momo');
		// 分组外的键不下发；分组内未配置的键也不会凭空出现
		expect(res.body.data.allow_origin).toBeUndefined();
		expect(res.body.data.smtp_host).toBeUndefined();
		expect(res.body.data.blogger_badge_enabled).toBeUndefined();
		expect(res.body.data.email_enabled).toBe('true');
	});

	it('type=email 只返回邮件分组', async () => {
		await seedSettings({ site_name: 'Momo', smtp_host: 'h', email_user: 'u' });
		const res = await api('/admin/settings?type=email', { headers: authed() });
		expect(res.body.data.smtp_host).toBe('h');
		expect(res.body.data.email_user).toBe('u');
		expect(res.body.data.site_name).toBeUndefined();
		expect(res.body.data.trust_proxy_override).toBeUndefined();
	});

	it('type=security 下发 trust_proxy_override = worker', async () => {
		const res = await api('/admin/settings?type=security', { headers: authed() });
		expect(res.body.data.trust_proxy_override).toBe('worker');
	});

	it('完整列表同样下发 trust_proxy_override', async () => {
		const res = await api('/admin/settings', { headers: authed() });
		expect(res.body.data.trust_proxy_override).toBe('worker');
	});

	it('type=account 只返回账号分组', async () => {
		await seedSettings({ admin_name: 'root', site_name: 'Momo' });
		const res = await api('/admin/settings?type=account', { headers: authed() });
		expect(res.body.data.admin_name).toBe('root');
		expect(res.body.data.site_name).toBeUndefined();
		expect(res.body.data.trust_proxy_override).toBeUndefined();
		// email_enabled 的默认注入不区分分组，因此这里也会出现
		expect(res.body.data.email_enabled).toBe('true');
	});

	it('未知 type 回落到完整白名单', async () => {
		await seedSettings({ site_name: 'Momo' });
		const res = await api('/admin/settings?type=nope', { headers: authed() });
		expect(res.body.data.site_name).toBe('Momo');
		expect(res.body.data.trust_proxy_override).toBe('worker');
	});

	it('已知边界：email_enabled 的默认注入不按 type 分组过滤', async () => {
		// 记录既有实现细节（file: worker/src/api/admin/settings.ts:57）：
		// 无论请求哪个分组，只要该分组里没有 email_enabled，就会被注入 'true'。
		// 于是 type=security 看到的 email_enabled 与数据库真实值可能不一致。
		await seedSettings({ email_enabled: 'false' });
		const security = await api('/admin/settings?type=security', { headers: authed() });
		expect(security.body.data.email_enabled).toBe('true');
		// 完整列表能看到真实值
		expect((await api('/admin/settings', { headers: authed() })).body.data.email_enabled).toBe('false');
	});
});

describe('PUT /admin/settings', () => {
	it('白名单外的键返回 400 并指出键名', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { not_allowed: 'x' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Setting "not_allowed" is not allowed');
		expect(await rawSetting('not_allowed')).toBeNull();
	});

	it('白名单内的键写入成功并持久化', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { site_name: 'Momo Blog', comment_auto_approve: 'false' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('site_name')).toBe('Momo Blog');
		expect(await rawSetting('comment_auto_approve')).toBe('false');
	});

	it('部分键非法时整批不写入（先校验后落库）', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { site_name: 'Momo', nope: '1' },
		});
		expect(res.status).toBe(400);
		expect(await rawSetting('site_name')).toBeNull();
	});

	it('smtpChanged 标记：包含 SMTP 字段时为 true', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { smtp_host: 'smtp.example.com' },
		});
		expect(res.body.smtpChanged).toBe(true);
	});

	it('smtpChanged 标记：普通字段为 false', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { site_name: 'Momo' },
		});
		expect(res.body.smtpChanged).toBe(false);
	});

	it('email_password 为空串时不覆盖已有密码', async () => {
		await seedSettings({ email_password: 'existing-secret' });
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { email_password: '', site_name: 'Momo' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('email_password')).toBe('existing-secret');
		expect(await rawSetting('site_name')).toBe('Momo');
	});

	it('email_password 为空串且原本不存在时也不会创建该键', async () => {
		await api('/admin/settings', { method: 'PUT', headers: authed(), body: { email_password: '' } });
		expect(await rawSetting('email_password')).toBeNull();
	});

	it('ip_blacklist 必须是合法 IP/CIDR 数组', async () => {
		const bad = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { ip_blacklist: '["not-an-ip"]' },
		});
		expect(bad.status).toBe(400);
		expect(bad.body.message).toContain('ip_blacklist must be a JSON array');
		expect(await rawSetting('ip_blacklist')).toBeNull();

		const notJson = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { ip_blacklist: 'not-json' },
		});
		expect(notJson.status).toBe(400);

		const ok = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { ip_blacklist: '["10.0.0.0/8"]' },
		});
		expect(ok.status).toBe(200);
		expect(await rawSetting('ip_blacklist')).toBe('["10.0.0.0/8"]');
	});

	it('ip_blacklist 为空串视为清空配置，允许通过', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { ip_blacklist: '' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('ip_blacklist')).toBe('');
	});

	it('email_blacklist 不做格式校验（保持与 Node/Go 一致）', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { email_blacklist: 'not-json' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('email_blacklist')).toBe('not-json');
	});

	it('null / undefined 值被跳过', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { site_name: null, admin_email: 'a@b.c' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('site_name')).toBeNull();
		expect(await rawSetting('admin_email')).toBe('a@b.c');
	});

	it('数字与布尔值被强制转为字符串', async () => {
		await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { smtp_port: 465, comment_auto_approve: false },
		});
		expect(await rawSetting('smtp_port')).toBe('465');
		expect(await rawSetting('comment_auto_approve')).toBe('false');
	});

	it('JSON null 请求体返回 400', async () => {
		const res = await api('/admin/settings', { method: 'PUT', headers: authed(), body: 'null' });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Invalid request body');
	});

	it('字符串请求体返回 400', async () => {
		const res = await api('/admin/settings', { method: 'PUT', headers: authed(), body: '"hello"' });
		expect(res.status).toBe(400);
	});

	it('数组请求体按下标当作键名而被拒绝', async () => {
		const res = await api('/admin/settings', { method: 'PUT', headers: authed(), body: [1, 2] });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Setting "0" is not allowed');
	});

	it('非法 JSON 请求体没有 catch，返回 500（既有行为）', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: { ...authed(), 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(res.status).toBe(500);
	});

	it('PUT 后 GET 能读回同一份数据（往返一致）', async () => {
		await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { site_name: 'Momo', allow_origin: 'https://a.com', email_enabled: 'false' },
		});
		const security = await api('/admin/settings?type=security', { headers: authed() });
		expect(security.body.data.allow_origin).toBe('https://a.com');

		const full = await api('/admin/settings', { headers: authed() });
		expect(full.body.data.email_enabled).toBe('false');
		expect(full.body.data.site_name).toBe('Momo');
		expect((await rawSettings()).site_name).toBe('Momo');
	});
});

describe('POST /admin/settings/test-email', () => {
	const SMTP = {
		smtp_host: 'smtp.example.com',
		smtp_port: '465',
		email_user: 'noreply@example.com',
		email_password: 'secret',
	};

	it('未配置 admin_email 时返回 400', async () => {
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(res.status).toBe(400);
		expect(res.body.message).toContain('Admin email is not configured');
	});

	it('配置了 admin_email 但 SMTP 缺失时返回 400', async () => {
		await seedSettings({ admin_email: 'admin@example.com' });
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('邮件发送失败，请检查 SMTP 配置');
	});

	it('SMTP 只配了一半（缺密码）同样返回 400', async () => {
		await seedSettings({
			admin_email: 'admin@example.com',
			smtp_host: 'smtp.example.com',
			email_user: 'noreply@example.com',
		});
		expect((await api('/admin/settings/test-email', { method: 'POST', headers: authed() })).status).toBe(400);
	});

	it('email_enabled = "false" 时返回 400', async () => {
		await seedSettings({ ...SMTP, admin_email: 'admin@example.com', email_enabled: 'false' });
		expect((await api('/admin/settings/test-email', { method: 'POST', headers: authed() })).status).toBe(400);
	});

	it('SMTP 配置齐全时返回 200 并真的构造出邮件', async () => {
		await seedSettings({ ...SMTP, admin_email: 'admin@example.com', site_name: 'Momo Blog' });
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });

		expect(res.status).toBe(200);
		expect(res.body.message).toBe('A test email has been sent');
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('admin@example.com');
		expect(sentMails[0].subject).toBe('SMTP 配置验证');
		expect(sentMails[0].from).toBe('Momo Blog 评论通知 <noreply@example.com>');
		expect(sentMails[0].html).toContain('Momo Blog');
	});

	it('未配置 site_name 时发件人使用默认站点名', async () => {
		await seedSettings({ ...SMTP, admin_email: 'admin@example.com' });
		await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(sentMails[0].from).toBe('Momo Blog 评论通知 <noreply@example.com>');
	});

	it('SMTP 发送失败时返回 400 而不是 500', async () => {
		await seedSettings({ ...SMTP, admin_email: 'admin@example.com' });
		failNextSendMail();
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('邮件发送失败，请检查 SMTP 配置');
	});
});
