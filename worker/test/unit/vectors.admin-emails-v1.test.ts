import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/admin-emails-v1.json';
import {
	ADMIN_EMAIL_ERRORS,
	MAX_ADMIN_EMAILS,
	MAX_ADMIN_EMAIL_LENGTH,
	isAdminMember,
	isEmailAddress,
	normalizeEmail,
	parseAdminEmails,
	resolveAdminConfig,
	validateAdminEmails,
	validateAdminSettingsBody,
	validateNotifyEmail,
} from '../../src/utils/adminEmails';

/**
 * 多管理员邮箱契约 v1 的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里没有文件系统，vitest 会把 JSON 打包进来。
 */

describe('vectors/admin-emails-v1 — 常量与错误文案', () => {
	it('上限与 fixture 完全一致', () => {
		expect(MAX_ADMIN_EMAILS).toBe(fixture.limits.maxAdminEmails);
		expect(MAX_ADMIN_EMAIL_LENGTH).toBe(fixture.limits.maxEmailLen);
	});

	it('六条错误文案逐字一致', () => {
		expect(ADMIN_EMAIL_ERRORS).toEqual(fixture.errors);
	});
});

describe('vectors/admin-emails-v1 — 邮箱校验', () => {
	for (const value of fixture.email.valid) {
		it(`合法：${JSON.stringify(value)}`, () => {
			expect(isEmailAddress(value)).toBe(true);
			expect(normalizeEmail(value)).toBe(String(value).trim().toLowerCase());
		});
	}

	for (const value of fixture.email.invalid) {
		it(`非法：${String(value).slice(0, 60)}`, () => {
			expect(isEmailAddress(value)).toBe(false);
		});
	}
});

describe('vectors/admin-emails-v1 — 读取解析 parse', () => {
	for (const testCase of fixture.parse) {
		it(testCase.name, () => {
			expect(parseAdminEmails(testCase.stored)).toEqual(testCase.expect);
		});
	}

	it('null / undefined 容错为空', () => {
		expect(parseAdminEmails(null)).toEqual([]);
		expect(parseAdminEmails(undefined)).toEqual([]);
	});
});

describe('vectors/admin-emails-v1 — 读取归一化 resolve', () => {
	for (const testCase of fixture.resolve) {
		it(testCase.name, () => {
			const resolved = resolveAdminConfig(
				testCase.storedAdmins,
				testCase.legacyAdmin,
				testCase.storedNotify
			);
			expect(resolved.admins).toEqual(testCase.expectAdmins);
			expect(resolved.notify).toBe(testCase.expectNotify);
		});
	}

	it('成员判定：trim + 小写后命中即视为博主', () => {
		expect(isAdminMember(['a@x.com'], '  A@X.com  ')).toBe(true);
		expect(isAdminMember(['a@x.com'], 'b@x.com')).toBe(false);
		expect(isAdminMember([], 'a@x.com')).toBe(false);
		expect(isAdminMember(['a@x.com'], '')).toBe(false);
	});
});

describe('vectors/admin-emails-v1 — admin_emails 写入校验', () => {
	it('空串 / 空白视为未配置（存 []）', () => {
		expect(validateAdminEmails('')).toEqual({ error: null, emails: [] });
		expect(validateAdminEmails('   ')).toEqual({ error: null, emails: [] });
		expect(validateAdminEmails('[]')).toEqual({ error: null, emails: [] });
	});

	it('null / undefined 视为未提供', () => {
		expect(validateAdminEmails(null)).toEqual({ error: null, emails: [] });
		expect(validateAdminEmails(undefined)).toEqual({ error: null, emails: [] });
	});

	it('写入口径：归一化（trim + 小写）+ 去重保序', () => {
		const result = validateAdminEmails('["  A@X.com ", "b@y.com", "a@x.com"]');
		expect(result.error).toBeNull();
		expect(result.emails).toEqual(['a@x.com', 'b@y.com']);
	});

	it('不是合法 JSON / 不是数组 → notArray', () => {
		for (const value of ['not json', '{}', '"a@b.com"', '123', '{oops']) {
			expect(validateAdminEmails(value).error, value).toBe(ADMIN_EMAIL_ERRORS.notArray);
		}
	});

	it('数组里有非字符串项 → notString', () => {
		for (const value of ['[1]', '["a@b.com", null]', '["a@b.com", {"x":1}]']) {
			expect(validateAdminEmails(value).error, value).toBe(ADMIN_EMAIL_ERRORS.notString);
		}
	});

	it('归一化去空后超过 10 个 → tooMany（11 个合法邮箱）', () => {
		const emails = Array.from({ length: 11 }, (_, index) => `admin${index + 1}@example.com`);
		expect(validateAdminEmails(JSON.stringify(emails)).error).toBe(ADMIN_EMAIL_ERRORS.tooMany);
	});

	it('有非法邮箱 → badEmail', () => {
		expect(validateAdminEmails('["a@b.com","nope"]').error).toBe(ADMIN_EMAIL_ERRORS.badEmail);
		expect(validateAdminEmails('["<a@b.com>"]').error).toBe(ADMIN_EMAIL_ERRORS.badEmail);
	});
});

describe('vectors/admin-emails-v1 — notify_email 写入校验', () => {
	it('空串 = 清空，永远合法', () => {
		expect(validateNotifyEmail('', ['a@x.com'])).toEqual({ error: null, value: '' });
		expect(validateNotifyEmail('   ', [])).toEqual({ error: null, value: '' });
		expect(validateNotifyEmail(null, [])).toEqual({ error: null, value: '' });
	});

	it('非空但不是合法邮箱 → badNotify', () => {
		expect(validateNotifyEmail('nope', ['a@x.com']).error).toBe(ADMIN_EMAIL_ERRORS.badNotify);
		expect(validateNotifyEmail('<a@b.com>', ['a@b.com']).error).toBe(ADMIN_EMAIL_ERRORS.badNotify);
	});

	it('归一化后不在列表里 → notifyNotInList（含列表为空）', () => {
		expect(validateNotifyEmail('c@z.com', ['a@x.com']).error).toBe(
			ADMIN_EMAIL_ERRORS.notifyNotInList
		);
		expect(validateNotifyEmail('a@x.com', []).error).toBe(ADMIN_EMAIL_ERRORS.notifyNotInList);
	});

	it('命中时存归一化后的值（trim + 小写）', () => {
		expect(validateNotifyEmail('  B@Y.COM  ', ['a@x.com', 'b@y.com'])).toEqual({
			error: null,
			value: 'b@y.com',
		});
	});
});

describe('vectors/admin-emails-v1 — 设置写入路径的联合校验', () => {
	it('同时提交 admin_emails 时用新列表判定 notify_email', () => {
		const ok = validateAdminSettingsBody(
			{ admin_emails: '["new@x.com"]', notify_email: 'new@x.com' },
			['old@x.com']
		);
		expect(ok.error).toBeNull();
		expect(ok.adminEmailsJson).toBe('["new@x.com"]');
		expect(ok.notifyEmail).toBe('new@x.com');

		const bad = validateAdminSettingsBody(
			{ admin_emails: '["new@x.com"]', notify_email: 'old@x.com' },
			['old@x.com']
		);
		expect(bad.error).toBe(ADMIN_EMAIL_ERRORS.notifyNotInList);
	});

	it('未提交 admin_emails 时用当前库里的列表判定', () => {
		expect(validateAdminSettingsBody({ notify_email: 'old@x.com' }, ['old@x.com']).error).toBeNull();
		expect(validateAdminSettingsBody({ notify_email: 'other@x.com' }, ['old@x.com']).error).toBe(
			ADMIN_EMAIL_ERRORS.notifyNotInList
		);
	});

	it('列表被清空时提交 notify_email 一律拒绝', () => {
		const result = validateAdminSettingsBody(
			{ admin_emails: '[]', notify_email: 'a@x.com' },
			['a@x.com']
		);
		expect(result.error).toBe(ADMIN_EMAIL_ERRORS.notifyNotInList);
	});

	it('admin_emails 非法时直接返回该错误（整批拒绝）', () => {
		const result = validateAdminSettingsBody({ admin_emails: 'not json', notify_email: 'a@x.com' }, []);
		expect(result.error).toBe(ADMIN_EMAIL_ERRORS.notArray);
	});
});
