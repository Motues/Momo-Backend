import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/settings-export-v1.json';
import {
	SETTINGS_EXPORT_DEFAULTS,
	SETTINGS_EXPORT_SENSITIVE_KEYS,
	buildExportedSettings,
} from '../../src/utils/settingsExport';

/**
 * 系统设置导出的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 导出是「完整快照」：50 个可写设置键全都要出现，缺的键按生效默认值补全。
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里，vitest 会把 JSON 打包进来。
 */

const DEFAULT_EMOJI_URLS = JSON.stringify(['https://open.motues.top/emoji/owo.json']);

describe('vectors/settings-export-v1 — 默认值表', () => {
	it('默认值表与 fixture 逐键一致（不多不少）', () => {
		expect(SETTINGS_EXPORT_DEFAULTS).toEqual(fixture.defaults);
		expect(Object.keys(SETTINGS_EXPORT_DEFAULTS).length).toBe(50);
	});

	it('敏感键与 fixture 一致', () => {
		expect([...SETTINGS_EXPORT_SENSITIVE_KEYS]).toEqual(fixture.sensitiveBlanked);
	});
});

describe('vectors/settings-export-v1 — 完整快照合成', () => {
	it('空库导出全部 50 个键，值等于默认值表（表情也能看到）', () => {
		const { settings, sensitiveOmitted } = buildExportedSettings({});
		expect(Object.keys(settings).length).toBe(50);
		expect(settings).toEqual(fixture.defaults);
		expect(settings.emoji_enabled).toBe('true');
		expect(settings.avatar_enabled).toBe('true');
		expect(settings.avatar_source).toBe('default');
		expect(settings.emoji_cdn_urls).toBe(DEFAULT_EMOJI_URLS);
		expect(sensitiveOmitted).toEqual([]);
	});

	it('库里的值覆盖默认值，缺的键仍然补齐', () => {
		const { settings } = buildExportedSettings({
			site_name: '我的博客',
			emoji_enabled: 'false',
			emoji_cdn_urls: '["https://cdn.example.com/owo.json"]',
		});
		expect(settings.site_name).toBe('我的博客');
		expect(settings.emoji_enabled).toBe('false');
		expect(settings.emoji_cdn_urls).toBe('["https://cdn.example.com/owo.json"]');
		expect(settings.smtp_port).toBe('465');
		expect(Object.keys(settings).length).toBe(50);
	});

	it('表情：缺 emoji_cdn_urls 时导出旧单地址键解析后的列表（不能被默认源覆盖）', () => {
		const { settings } = buildExportedSettings({
			emoji_cdn_url: 'https://cdn.example.com/legacy.json',
		});
		expect(settings.emoji_cdn_urls).toBe('["https://cdn.example.com/legacy.json"]');
	});

	it('敏感键始终出现且为空串，只有存过非空值才登记 sensitiveOmitted', () => {
		const blank = buildExportedSettings({ email_password: '', admin_comment_key: '' });
		expect(blank.settings.email_password).toBe('');
		expect(blank.settings.admin_comment_key).toBe('');
		expect(blank.sensitiveOmitted).toEqual([]);

		const omitted = buildExportedSettings({
			email_password: 'smtp-secret',
			admin_comment_key: 'blogger-key',
		});
		expect(omitted.settings.email_password).toBe('');
		expect(omitted.settings.admin_comment_key).toBe('');
		expect(omitted.sensitiveOmitted).toEqual(['email_password', 'admin_comment_key']);
	});

	it('白名单外的键不会被带进快照', () => {
		const { settings } = buildExportedSettings({
			admin_password: '$2b$10$deadbeef',
			password_changed: 'true',
			comment_verify_secret: 'internal-secret',
			secret_key: 'leak-me',
		});
		for (const key of ['admin_password', 'password_changed', 'comment_verify_secret', 'secret_key']) {
			expect(settings[key], key).toBeUndefined();
		}
	});
});
