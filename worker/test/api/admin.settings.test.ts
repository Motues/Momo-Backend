/**
 * GET / PUT /admin/settings + POST /admin/settings/test-email —— 设置白名单、敏感字段与邮件测试。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, rawSetting, rawSettings, seedSettings, testEnv } from '../helpers/db';
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
		await seedSettings({
			site_name: 'Momo',
			allow_origin: 'https://a.com',
			smtp_host: 'h',
			// API 地址与邮箱验证开关也属于基础分组（面板已合并到「站点信息 / 评论审核」）
			verify_base_url: 'https://api.example.com',
			email_verify_enabled: 'true',
			// 审核自动化四项规则都属于基础分组
			comment_spam_keywords: '["加微信"]',
			comment_spam_max_links: '5',
			comment_spam_min_length: '0',
			comment_spam_duplicate_window: '60',
		});
		const res = await api('/admin/settings?type=basic', { headers: authed() });
		expect(res.body.data.site_name).toBe('Momo');
		expect(res.body.data.verify_base_url).toBe('https://api.example.com');
		expect(res.body.data.email_verify_enabled).toBe('true');
		expect(res.body.data.comment_spam_keywords).toBe('["加微信"]');
		expect(res.body.data.comment_spam_max_links).toBe('5');
		expect(res.body.data.comment_spam_min_length).toBe('0');
		expect(res.body.data.comment_spam_duplicate_window).toBe('60');
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

	it('审核自动化规则：非法值整批拒绝', async () => {
		const cases: [string, string, string][] = [
			[
				'comment_spam_keywords',
				'{oops',
				'comment_spam_keywords must be a JSON array of at most 200 non-empty strings',
			],
			[
				'comment_spam_keywords',
				'["a",1]',
				'comment_spam_keywords must be a JSON array of at most 200 non-empty strings',
			],
			['comment_spam_max_links', '51', 'comment_spam_max_links must be an integer between 0 and 50'],
			['comment_spam_max_links', 'abc', 'comment_spam_max_links must be an integer between 0 and 50'],
			['comment_spam_min_length', '2001', 'comment_spam_min_length must be an integer between 0 and 2000'],
			[
				'comment_spam_duplicate_window',
				'10081',
				'comment_spam_duplicate_window must be an integer between 0 and 10080',
			],
		];

		for (const [key, value, message] of cases) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { site_name: '不应写入', [key]: value },
			});
			expect(res.status, `${key}=${value}`).toBe(400);
			expect(res.body.message, `${key}=${value}`).toBe(message);
			// 校验在写入之前完成：整批都不落地
			expect(await rawSetting(key), `${key}=${value}`).toBeNull();
			expect(await rawSetting('site_name'), `${key}=${value}`).toBeNull();
		}
	});

	it('审核自动化规则：合法值写入并可读回', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: {
				comment_spam_keywords: '["加微信","casino"]',
				comment_spam_max_links: '5',
				comment_spam_min_length: '0',
				comment_spam_duplicate_window: '60',
			},
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('comment_spam_keywords')).toBe('["加微信","casino"]');
		expect(await rawSetting('comment_spam_max_links')).toBe('5');
		expect(await rawSetting('comment_spam_min_length')).toBe('0');
		expect(await rawSetting('comment_spam_duplicate_window')).toBe('60');

		const basic = await api('/admin/settings?type=basic', { headers: authed() });
		expect(basic.body.data.comment_spam_max_links).toBe('5');
		expect(basic.body.data.comment_spam_keywords).toBe('["加微信","casino"]');
	});

	it('审核自动化的空串阈值允许写入（表示使用默认值）', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { comment_spam_max_links: '', comment_spam_min_length: '', comment_spam_duplicate_window: '' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('comment_spam_max_links')).toBe('');
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

	it('comment_verify_domain_enabled 在白名单内，且属于安全分组（默认未配置时不出现）', async () => {
		// 默认（未配置）时键不会凭空出现 —— 关闭语义由 getSetting 的 null 兜底
		const before = await api('/admin/settings?type=security', { headers: authed() });
		expect(before.body.data.comment_verify_domain_enabled).toBeUndefined();

		const put = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { comment_verify_domain_enabled: 'true' },
		});
		expect(put.status).toBe(200);
		expect(await rawSetting('comment_verify_domain_enabled')).toBe('true');

		const security = await api('/admin/settings?type=security', { headers: authed() });
		expect(security.body.data.comment_verify_domain_enabled).toBe('true');

		// 完整白名单同样下发
		const full = await api('/admin/settings', { headers: authed() });
		expect(full.body.data.comment_verify_domain_enabled).toBe('true');
	});

	it('多管理员邮箱：admin_emails 存归一化去重后的 JSON 数组', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { admin_emails: '["  A@X.com ", "b@y.com", "a@x.com"]' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('admin_emails')).toBe('["a@x.com","b@y.com"]');

		// 属于 basic 分组
		const basic = await api('/admin/settings?type=basic', { headers: authed() });
		expect(basic.body.data.admin_emails).toBe('["a@x.com","b@y.com"]');
	});

	it('多管理员邮箱：notify_email 必须在列表里（同一次请求用新列表判定）', async () => {
		const ok = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { admin_emails: '["a@x.com","b@y.com"]', notify_email: '  B@Y.COM  ' },
		});
		expect(ok.status).toBe(200);
		expect(await rawSetting('notify_email')).toBe('b@y.com');

		const bad = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { notify_email: 'c@z.com', site_name: '不应写入' },
		});
		expect(bad.status).toBe(400);
		expect(bad.body.message).toBe('notify_email 必须在管理员邮箱列表中');
		expect(await rawSetting('site_name')).toBeNull();
	});

	it('多管理员邮箱：非法 admin_emails 与 notify_email 的固定文案', async () => {
		const cases: Array<[Record<string, string>, string]> = [
			[{ admin_emails: 'not json' }, 'admin_emails 必须是 JSON 数组'],
			[{ admin_emails: '[1]' }, 'admin_emails 的每一项都必须是字符串'],
			[{ admin_emails: '["nope"]' }, 'admin_emails 包含非法邮箱地址'],
			[
				{
					admin_emails: JSON.stringify(
						Array.from({ length: 11 }, (_, index) => `admin${index + 1}@example.com`)
					),
				},
				'admin_emails 最多 10 个邮箱',
			],
			[{ admin_emails: '["a@x.com"]', notify_email: 'nope' }, 'notify_email 必须是合法的邮箱地址'],
		];
		for (const [body, message] of cases) {
			const res = await api('/admin/settings', { method: 'PUT', headers: authed(), body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body.message, JSON.stringify(body)).toBe(message);
			expect(await rawSetting('admin_emails')).toBeNull();
		}
	});

	it('多管理员邮箱：清空 notify_email 永远合法（读取时回落列表第一个）', async () => {
		await seedSettings({ admin_emails: '["a@x.com"]', notify_email: 'a@x.com' });
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { notify_email: '' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('notify_email')).toBe('');
	});

	it('链接安全：四个键属于新的 link 分组，且做写入校验', async () => {
		const put = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: {
				verify_base_url: 'https://api.example.com',
				link_security_enabled: ' TRUE ',
				link_dormant_days: ' 30 ',
				link_sync_enabled: 'False',
				link_dormant_notice_enabled: ' True ',
			},
		});
		expect(put.status).toBe(200);
		expect(await rawSetting('verify_base_url')).toBe('https://api.example.com');
		expect(await rawSetting('link_security_enabled')).toBe('true');
		expect(await rawSetting('link_dormant_days')).toBe('30');
		expect(await rawSetting('link_sync_enabled')).toBe('false');
		expect(await rawSetting('link_dormant_notice_enabled')).toBe('true');

		const link = await api('/admin/settings?type=link', { headers: authed() });
		expect(link.body.data.link_security_enabled).toBe('true');
		expect(link.body.data.link_dormant_days).toBe('30');
		expect(link.body.data.link_sync_enabled).toBe('false');
		expect(link.body.data.link_dormant_notice_enabled).toBe('true');
	});

	it('链接安全：非法值整批拒绝且文案固定', async () => {
		const cases: Array<[Record<string, string>, string]> = [
			[{ link_security_enabled: 'yes' }, 'link_security_enabled 只能是 true 或 false'],
			[{ link_sync_enabled: 'on' }, 'link_sync_enabled 只能是 true 或 false'],
			[{ link_dormant_notice_enabled: 'on' }, 'link_dormant_notice_enabled 只能是 true 或 false'],
			[{ link_dormant_days: '0' }, 'link_dormant_days 必须是 1-3650 之间的整数'],
			[{ link_dormant_days: '1.5' }, 'link_dormant_days 必须是 1-3650 之间的整数'],
			[{ link_dormant_days: '3651' }, 'link_dormant_days 必须是 1-3650 之间的整数'],
		];
		for (const [body, message] of cases) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { ...body, site_name: '不应写入' },
			});
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body.message, JSON.stringify(body)).toBe(message);
			expect(await rawSetting('site_name')).toBeNull();
		}
	});

	it('API 地址：归一化落库、非法值整批拒绝', async () => {
		const put = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { verify_base_url: '  https://api.example.com///  ' },
		});
		expect(put.status).toBe(200);
		expect(await rawSetting('verify_base_url')).toBe('https://api.example.com');

		for (const value of ['api.example.com', 'ftp://api.example.com', 'https://', 'https://a.com?x=1', 'https://u:p@a.com']) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { verify_base_url: value, site_name: '不应写入' },
			});
			expect(res.status, value).toBe(400);
			expect(res.body.message, value).toBe('verify_base_url 必须是 http(s) 开头的完整地址');
			expect(await rawSetting('site_name')).toBeNull();
		}
	});

	it('邮箱验证 / 链接同步 / 休眠提醒开启时必须填写 API 地址', async () => {
		const cases: Array<[Record<string, string>, string]> = [
			[{ email_verify_enabled: 'true' }, '邮箱验证开启时必须填写 API 地址'],
			[{ link_sync_enabled: 'true' }, '历史链接同步开启时必须填写 API 地址'],
			[{ link_dormant_notice_enabled: 'true' }, '休眠提醒邮件开启时必须填写 API 地址'],
			[{ email_verify_enabled: 'yes' }, 'email_verify_enabled 只能是 true 或 false'],
		];
		for (const [body, message] of cases) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { ...body, site_name: '不应写入' },
			});
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body.message, JSON.stringify(body)).toBe(message);
			expect(await rawSetting('site_name')).toBeNull();
		}
	});

	it('清空 API 地址会被仍开启的依赖功能拦住；关闭依赖后可清空', async () => {
		await seedSettings({ verify_base_url: 'https://api.example.com', link_sync_enabled: 'true' });
		const blocked = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { verify_base_url: '' },
		});
		expect(blocked.status).toBe(400);
		expect(blocked.body.message).toBe('历史链接同步开启时必须填写 API 地址');

		await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { link_sync_enabled: 'false' },
		});
		const cleared = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { verify_base_url: '' },
		});
		expect(cleared.status).toBe(200);
		expect(await rawSetting('verify_base_url')).toBe('');
	});

	it('同一请求里同时填地址并开启功能可以通过', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: {
				verify_base_url: 'https://api.example.com',
				email_verify_enabled: 'true',
				link_sync_enabled: 'true',
				link_dormant_notice_enabled: 'true',
			},
		});
		expect(res.status).toBe(200);
	});

	it('邮件日志保留天数：合法值归一化落库、非法值整批拒绝', async () => {
		const put = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { mail_log_retention_days: ' 045 ' },
		});
		expect(put.status).toBe(200);
		expect(await rawSetting('mail_log_retention_days')).toBe('45');

		const email = await api('/admin/settings?type=email', { headers: authed() });
		expect(email.body.data.mail_log_retention_days).toBe('45');

		for (const bad of ['', '-1', '1.5', '3651', 'abc', '30d']) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { mail_log_retention_days: bad, site_name: '不应写入' },
			});
			expect(res.status, bad).toBe(400);
			expect(res.body.message, bad).toBe('mail_log_retention_days 必须是 0-3650 之间的整数');
			expect(await rawSetting('site_name')).toBeNull();
		}
	});

	it('导入路径同样校验并归一化新增设置（admin_emails / notify_email / link / emoji_cdn_urls）', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: authed(),
			body: {
				admin_emails: '[" A@X.com ", "a@x.com"]',
				notify_email: 'A@X.com',
				verify_base_url: 'https://api.example.com',
				link_security_enabled: ' TRUE ',
				link_dormant_days: '45',
				link_sync_enabled: 'false',
				link_dormant_notice_enabled: 'True',
				emoji_cdn_urls: '["https://a.example.com/owo.json"]',
			},
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('admin_emails')).toBe('["a@x.com"]');
		expect(await rawSetting('notify_email')).toBe('a@x.com');
		expect(await rawSetting('verify_base_url')).toBe('https://api.example.com');
		expect(await rawSetting('link_security_enabled')).toBe('true');
		expect(await rawSetting('link_dormant_days')).toBe('45');
		expect(await rawSetting('link_sync_enabled')).toBe('false');
		expect(await rawSetting('link_dormant_notice_enabled')).toBe('true');
		expect(await rawSetting('emoji_cdn_urls')).toBe('["https://a.example.com/owo.json"]');
	});

	it('导入路径：非法 link_dormant_days 被拒绝且不落库', async () => {
		const res = await api('/admin/data/import/settings', {
			method: 'POST',
			headers: authed(),
			body: { link_dormant_days: 'abc', site_name: '不应写入' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('link_dormant_days 必须是 1-3650 之间的整数');
		expect(await rawSetting('site_name')).toBeNull();
	});

	it('导出包含新增的设置键（链接安全 / API 地址 / 邮箱验证 / 表情）', async () => {
		await seedSettings({
			admin_emails: '["a@x.com"]',
			notify_email: 'a@x.com',
			verify_base_url: 'https://api.example.com',
			email_verify_enabled: 'true',
			link_security_enabled: 'true',
			link_dormant_days: '30',
			link_sync_enabled: 'true',
			link_dormant_notice_enabled: 'true',
			emoji_cdn_urls: '["https://a.example.com/owo.json"]',
		});
		const exported = await api('/admin/data/export/settings', { headers: authed() });
		expect(exported.body.data.settings).toMatchObject({
			admin_emails: '["a@x.com"]',
			notify_email: 'a@x.com',
			verify_base_url: 'https://api.example.com',
			email_verify_enabled: 'true',
			link_security_enabled: 'true',
			link_dormant_days: '30',
			link_sync_enabled: 'true',
			link_dormant_notice_enabled: 'true',
			emoji_cdn_urls: '["https://a.example.com/owo.json"]',
		});
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

	it('收件人是解析后的 notify_email（不是列表第一个）', async () => {
		await seedSettings({
			...SMTP,
			admin_emails: '["a@x.com","b@y.com"]',
			notify_email: 'b@y.com',
			site_name: 'Momo Blog',
		});
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(res.status).toBe(200);
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('b@y.com');
	});

	it('notify_email 未配置时回落到管理员列表第一个', async () => {
		await seedSettings({ ...SMTP, admin_emails: '["a@x.com","b@y.com"]' });
		await testEnv.MOMO_DB.prepare("DELETE FROM Settings WHERE key = 'admin_email'").run();
		const res = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(res.status).toBe(200);
		expect(sentMails[0].to).toBe('a@x.com');
	});
});

describe('PUT /admin/settings —— 头像来源（doc/avatar.md）', () => {
	it('非法来源 / 非法模板整批拒绝', async () => {
		for (const [key, value] of [
			['avatar_source', 'github'],
			['avatar_enabled', 'yes'],
			['avatar_custom_url', 'javascript:alert(1)'],
			['avatar_custom_url', 'https://x/{foo}'],
			['avatar_custom_url', 'https://x/\n{hash}'],
		]) {
			const res = await api('/admin/settings', {
				method: 'PUT',
				headers: authed(),
				body: { site_name: '不应写入', [key]: value },
			});
			expect(res.status, `${key}=${value}`).toBe(400);
			expect(await rawSetting(key), `${key}=${value}`).toBeNull();
			expect(await rawSetting('site_name'), `${key}=${value}`).toBeNull();
		}
	});

	it('选择 custom 但未填地址返回 400', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { avatar_source: 'custom' },
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('选择自定义头像来源时必须填写头像地址');
		expect(await rawSetting('avatar_source')).toBeNull();
	});

	it('合法写入后归一化（开关小写、来源小写、模板 trim），type=avatar 可读回', async () => {
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: {
				avatar_enabled: ' FALSE ',
				avatar_source: '  CUSTOM  ',
				avatar_custom_url: '  https://cdn.example.com/{hash}.png  ',
			},
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('avatar_enabled')).toBe('false');
		expect(await rawSetting('avatar_source')).toBe('custom');
		expect(await rawSetting('avatar_custom_url')).toBe('https://cdn.example.com/{hash}.png');

		const read = await api('/admin/settings?type=avatar', { headers: authed() });
		expect(read.body.data.avatar_enabled).toBe('false');
		expect(read.body.data.avatar_source).toBe('custom');
		expect(read.body.data.avatar_custom_url).toBe('https://cdn.example.com/{hash}.png');
	});

	it('切回 default 时可同时清空模板', async () => {
		await seedSettings({
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
		const res = await api('/admin/settings', {
			method: 'PUT',
			headers: authed(),
			body: { avatar_source: 'default', avatar_custom_url: '' },
		});
		expect(res.status).toBe(200);
		expect(await rawSetting('avatar_source')).toBe('default');
		expect(await rawSetting('avatar_custom_url')).toBe('');
	});
});
