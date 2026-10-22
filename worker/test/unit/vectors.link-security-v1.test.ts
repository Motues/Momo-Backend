import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/link-security-v1.json';
import {
	DEFAULT_LINK_DORMANT_DAYS,
	DAY_MS,
	LINK_DORMANT_DAYS_KEY,
	LINK_DORMANT_NOTICE_ENABLED_KEY,
	LINK_SECURITY_ENABLED_KEY,
	LINK_SECURITY_ERRORS,
	LINK_SYNC_ENABLED_KEY,
	MAX_LINK_DORMANT_DAYS,
	MIN_LINK_DORMANT_DAYS,
	isUrlDormant,
	isTrustActive,
	needDormantNotice,
	normalizeSwitch,
	parseDormantDays,
	shouldSendDormantNotice,
	validateDormantDays,
	validateLinkSecuritySettings,
	validateSwitch,
} from '../../src/utils/linkSecurity';
import { normalizeEmail } from '../../src/utils/adminEmails';

/**
 * 链接安全审查契约 v1 的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里没有文件系统，vitest 会把 JSON 打包进来。
 */

/** 固定「现在」，让休眠边界（刚好 N 天 vs N 天 + 1 毫秒）完全确定 */
const NOW = 1_800_000_000_000;

describe('vectors/link-security-v1 — 键名 / 默认值 / 上限 / 错误文案', () => {
	it('键名与 fixture 完全一致', () => {
		expect(LINK_SECURITY_ENABLED_KEY).toBe(fixture.keys.securityEnabled);
		expect(LINK_DORMANT_DAYS_KEY).toBe(fixture.keys.dormantDays);
		expect(LINK_SYNC_ENABLED_KEY).toBe(fixture.keys.syncEnabled);
		expect(LINK_DORMANT_NOTICE_ENABLED_KEY).toBe(fixture.keys.dormantNotice);
	});

	it('默认值与 fixture 完全一致（开关 fail-closed）', () => {
		expect(normalizeSwitch(fixture.defaults.securityEnabled)).toBe('false');
		expect(DEFAULT_LINK_DORMANT_DAYS).toBe(fixture.defaults.dormantDays);
		expect(parseDormantDays(null)).toBe(fixture.defaults.dormantDays);
		expect(normalizeSwitch(fixture.defaults.syncEnabled)).toBe('false');
		expect(normalizeSwitch(fixture.defaults.dormantNoticeEnabled)).toBe('false');
		// 未配置（null）归一化后是空串：读取侧 fail-closed 由 isUrlDormant / resolve 处理
		expect(normalizeSwitch(null)).toBe('');
	});

	it('上下限与 dayMs 与 fixture 完全一致', () => {
		expect(MIN_LINK_DORMANT_DAYS).toBe(fixture.limits.minDormantDays);
		expect(MAX_LINK_DORMANT_DAYS).toBe(fixture.limits.maxDormantDays);
		expect(DAY_MS).toBe(fixture.limits.dayMs);
	});

	it('四条错误文案逐字一致', () => {
		expect(LINK_SECURITY_ERRORS).toEqual(fixture.errors);
	});
});

describe('vectors/link-security-v1 — 开关写入校验', () => {
	for (const value of fixture.switches.valid) {
		it(`合法：${JSON.stringify(value)}`, () => {
			expect(validateSwitch(value, LINK_SECURITY_ENABLED_KEY)).toBeNull();
			expect(validateSwitch(value, LINK_SYNC_ENABLED_KEY)).toBeNull();
			expect(validateSwitch(value, LINK_DORMANT_NOTICE_ENABLED_KEY)).toBeNull();
			expect(['', 'true', 'false']).toContain(normalizeSwitch(value));
		});
	}

	for (const value of fixture.switches.invalid) {
		it(`非法：${JSON.stringify(value)}`, () => {
			expect(validateSwitch(value, LINK_SECURITY_ENABLED_KEY)).toBe(
				LINK_SECURITY_ERRORS.securityEnabled
			);
			expect(validateSwitch(value, LINK_SYNC_ENABLED_KEY)).toBe(LINK_SECURITY_ERRORS.syncEnabled);
			expect(validateSwitch(value, LINK_DORMANT_NOTICE_ENABLED_KEY)).toBe(
				LINK_SECURITY_ERRORS.dormantNoticeEnabled
			);
		});
	}
});

describe('vectors/link-security-v1 — 天数写入校验', () => {
	for (const value of fixture.days.valid) {
		it(`合法：${JSON.stringify(value)}`, () => {
			expect(validateDormantDays(value)).toBeNull();
		});
	}

	for (const value of fixture.days.invalid) {
		it(`非法：${JSON.stringify(value)}`, () => {
			expect(validateDormantDays(value)).toBe(LINK_SECURITY_ERRORS.dormantDays);
		});
	}
});

describe('vectors/link-security-v1 — 天数读取归一化', () => {
	for (const testCase of fixture.days.resolve) {
		it(`${JSON.stringify(testCase.stored)} → ${testCase.expect}`, () => {
			expect(parseDormantDays(testCase.stored)).toBe(testCase.expect);
		});
	}
});

describe('vectors/link-security-v1 — 休眠判定', () => {
	for (const testCase of fixture.dormant) {
		it(testCase.name, () => {
			const result = isUrlDormant({
				enabled: testCase.enabled,
				hasUrl: testCase.hasUrl,
				dormantDays: testCase.days,
				lastCommentAt: testCase.ageMs === null ? null : NOW - testCase.ageMs,
				now: NOW,
			});
			expect(result).toBe(testCase.expect);
		});
	}

	it('边界：刚好 N 天不算休眠，N 天 + 1 毫秒算', () => {
		const base = {
			enabled: 'true',
			hasUrl: true,
			dormantDays: 30,
			now: NOW,
		};
		expect(isUrlDormant({ ...base, lastCommentAt: NOW - 30 * DAY_MS })).toBe(false);
		expect(isUrlDormant({ ...base, lastCommentAt: NOW - (30 * DAY_MS + 1) })).toBe(true);
	});

	it('最后评论时间缺失（null / 无法解析）→ fail-open 不标记', () => {
		const base = { enabled: 'true', hasUrl: true, dormantDays: 30, now: NOW };
		expect(isUrlDormant({ ...base, lastCommentAt: null })).toBe(false);
		expect(isUrlDormant({ ...base, lastCommentAt: undefined })).toBe(false);
		expect(isUrlDormant({ ...base, lastCommentAt: 'garbage' })).toBe(false);
	});

	it('功能关闭或开关是脏值时一律不标记', () => {
		const base = { hasUrl: true, dormantDays: 30, lastCommentAt: NOW - 100 * DAY_MS, now: NOW };
		for (const enabled of ['false', 'yes', '', '   ', 'TRUE1', null, undefined]) {
			expect(isUrlDormant({ ...base, enabled }), String(enabled)).toBe(false);
		}
		expect(isUrlDormant({ ...base, enabled: ' TRUE ' })).toBe(true);
	});
});

describe('vectors/link-security-v1 — 人工确认是否有效（trust.active）', () => {
	for (const testCase of fixture.trust.active) {
		it(testCase.name, () => {
			expect(isTrustActive(testCase.expiresAt, testCase.nowMs)).toBe(testCase.expect);
		});
	}

	it('边界：expires_at 恰好等于 now 视为过期（严格大于）', () => {
		expect(isTrustActive(new Date(NOW).toISOString(), NOW)).toBe(false);
		expect(isTrustActive(new Date(NOW + 1).toISOString(), NOW)).toBe(true);
		// 写入格式之外的一律 fail-closed（带时区偏移 / 缺毫秒 / 只有日期 / 数字串）
		expect(isTrustActive('2026-11-17T08:00:00.000+08:00', NOW)).toBe(false);
		expect(isTrustActive('2026-11-17T00:00:00Z', NOW)).toBe(false);
	});
});

describe('vectors/link-security-v1 — 人工确认豁免休眠（trust.dormantOverride）', () => {
	for (const testCase of fixture.trust.dormantOverride) {
		it(testCase.name, () => {
			expect(
				isUrlDormant({
					enabled: testCase.enabled,
					hasUrl: testCase.hasUrl,
					dormantDays: testCase.days,
					lastCommentAt: NOW - testCase.ageMs,
					trusted: testCase.trusted,
					now: NOW,
				})
			).toBe(testCase.expect);
		});
	}

	it('功能关闭时人工确认与否都一样（开关判断在前）', () => {
		const base = { enabled: 'false', hasUrl: true, dormantDays: 30, lastCommentAt: NOW - 100 * DAY_MS, now: NOW };
		expect(isUrlDormant({ ...base, trusted: true })).toBe(false);
		expect(isUrlDormant({ ...base, trusted: false })).toBe(false);
	});
});

describe('vectors/link-security-v1 — 休眠提醒是否需要发送（notice.needNotify）', () => {
	for (const testCase of fixture.notice.needNotify) {
		it(testCase.name, () => {
			expect(
				needDormantNotice({
					dormant: testCase.dormant,
					hasRecord: testCase.hasRecord,
					recordExpired: testCase.recordExpired,
					recordLastCommentAt: testCase.recordLastCommentAt,
					currentLastCommentAt: testCase.currentLastCommentAt,
				})
			).toBe(testCase.expect);
		});
	}

	it('没有记录时只按休眠与否判断', () => {
		const base = {
			hasRecord: false,
			recordExpired: false,
			recordLastCommentAt: null,
			currentLastCommentAt: 1000,
		};
		expect(needDormantNotice({ ...base, dormant: false })).toBe(false);
		expect(needDormantNotice({ ...base, dormant: true })).toBe(true);
	});

	it('记录里的最后评论时间缺失时视为与当前不同（宁多提醒一次）', () => {
		expect(
			needDormantNotice({
				dormant: true,
				hasRecord: true,
				recordExpired: false,
				recordLastCommentAt: null,
				currentLastCommentAt: 2000,
			})
		).toBe(true);
	});

	it('记录过期时不看时间，一律再提醒（并刷新令牌与有效期）', () => {
		for (const current of [1000, 2000]) {
			expect(
				needDormantNotice({
					dormant: true,
					hasRecord: true,
					recordExpired: true,
					recordLastCommentAt: 1000,
					currentLastCommentAt: current,
				})
			).toBe(true);
		}
	});
});

describe('vectors/link-security-v1 — 休眠提醒发信前提（notice.sendGate）', () => {
	for (const testCase of fixture.notice.sendGate) {
		it(testCase.name, () => {
			expect(
				shouldSendDormantNotice({
					securityEnabled: testCase.securityEnabled,
					noticeEnabled: testCase.noticeEnabled,
					apiBaseUrl: testCase.apiBaseUrl,
				})
			).toBe(testCase.expect);
		});
	}

	it('总开关 / 提醒开关 / API 地址 必须同时具备（穷举 2×2×2 种组合）', () => {
		for (const securityEnabled of ['true', 'false']) {
			for (const noticeEnabled of ['true', 'false']) {
				for (const apiBaseUrl of ['https://api.example.com', '']) {
					expect(
						shouldSendDormantNotice({ securityEnabled, noticeEnabled, apiBaseUrl }),
						`${securityEnabled}/${noticeEnabled}/${apiBaseUrl}`
					).toBe(
						securityEnabled === 'true' && noticeEnabled === 'true' && apiBaseUrl !== ''
					);
				}
			}
		}
	});
});

describe('vectors/link-security-v1 — 身份邮箱归一化', () => {	for (const testCase of fixture.emailNormalize) {
		it(`${JSON.stringify(testCase.input)} → ${testCase.expect}`, () => {
			expect(normalizeEmail(testCase.input)).toBe(testCase.expect);
		});
	}
});

describe('vectors/link-security-v1 — 设置写入的联合校验', () => {
	it('三个键一起提交且合法时返回 null', () => {
		expect(
			validateLinkSecuritySettings({
				link_security_enabled: ' TRUE ',
				link_dormant_days: '30',
				link_sync_enabled: ' false ',
				link_dormant_notice_enabled: 'true',
			})
		).toBeNull();
	});

	it('任一键非法时返回该键的固定文案', () => {
		expect(validateLinkSecuritySettings({ link_security_enabled: 'yes' })).toBe(
			LINK_SECURITY_ERRORS.securityEnabled
		);
		expect(validateLinkSecuritySettings({ link_sync_enabled: 'on' })).toBe(
			LINK_SECURITY_ERRORS.syncEnabled
		);
		expect(validateLinkSecuritySettings({ link_dormant_notice_enabled: 'on' })).toBe(
			LINK_SECURITY_ERRORS.dormantNoticeEnabled
		);
		expect(validateLinkSecuritySettings({ link_dormant_days: '0' })).toBe(
			LINK_SECURITY_ERRORS.dormantDays
		);
		expect(validateLinkSecuritySettings({ link_dormant_days: '3651' })).toBe(
			LINK_SECURITY_ERRORS.dormantDays
		);
	});
});
