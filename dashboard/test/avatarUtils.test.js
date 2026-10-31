import { describe, it, expect } from 'vitest';
import {
	AVATAR_ERRORS,
	AVATAR_PLACEHOLDERS,
	AVATAR_SOURCES,
	AVATAR_TEMPLATES,
	AVATAR_URL_MAX_LENGTH,
	DEFAULT_AVATAR_ENABLED,
	DEFAULT_AVATAR_URL,
	avatarPreview,
	isAvatarEnabled,
	normalizeAvatarCustomUrl,
	normalizeAvatarEnabled,
	normalizeAvatarSource,
	validateAvatarCustomUrl,
	validateAvatarEnabled,
	validateAvatarSettings,
	validateAvatarSource,
} from '../src/utils/avatar.js';

describe('dashboard avatar utils — 常量', () => {
	it('来源取值与预设模板与后端契约一致', () => {
		expect(DEFAULT_AVATAR_ENABLED).toBe('true');
		expect(DEFAULT_AVATAR_URL.startsWith('data:image/svg+xml;base64,')).toBe(true);
		expect(AVATAR_SOURCES).toEqual(['default', 'gravatar', 'cravatar', 'qq', 'custom']);
		expect(AVATAR_TEMPLATES.default).toBe(
			'https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam'
		);
		expect(AVATAR_PLACEHOLDERS).toEqual(['{hash}', '{email}', '{author}', '{qq}']);
		expect(AVATAR_URL_MAX_LENGTH).toBe(500);
	});
});

describe('dashboard avatar utils — 开关', () => {
	it('只有明确 false 才关闭（fail-open）', () => {
		expect(normalizeAvatarEnabled('  FALSE ')).toBe('false');
		expect(isAvatarEnabled(undefined)).toBe(true);
		expect(isAvatarEnabled('')).toBe(true);
		expect(isAvatarEnabled('false')).toBe(false);
		expect(isAvatarEnabled('garbage')).toBe(true);
	});

	it('非法开关值返回统一错误', () => {
		expect(validateAvatarEnabled('yes')).toBe(AVATAR_ERRORS.badEnabled);
		expect(validateAvatarEnabled(' FALSE ')).toBe('');
	});
});

describe('dashboard avatar utils — 来源归一化与校验', () => {
	it('trim + 小写，未知值回落 default', () => {
		expect(normalizeAvatarSource('  GRAVATAR ')).toBe('gravatar');
		expect(normalizeAvatarSource('github')).toBe('default');
		expect(normalizeAvatarSource(null)).toBe('default');
	});

	it('未知来源返回统一错误', () => {
		expect(validateAvatarSource('github')).toBe(AVATAR_ERRORS.badSource);
		expect(validateAvatarSource('')).toBe('');
	});
});

describe('dashboard avatar utils — 模板校验', () => {
	it('空串合法，trim 后返回', () => {
		expect(validateAvatarCustomUrl('')).toBe('');
		expect(normalizeAvatarCustomUrl('  https://x/{hash}  ')).toBe('https://x/{hash}');
	});

	it('只允许 http/https', () => {
		expect(validateAvatarCustomUrl('javascript:alert(1)')).toBe(AVATAR_ERRORS.badScheme);
		expect(validateAvatarCustomUrl('ftp://x/{hash}')).toBe(AVATAR_ERRORS.badScheme);
	});

	it('拒绝控制字符、未知占位符与超长地址', () => {
		expect(validateAvatarCustomUrl('https://x/\n{hash}')).toBe(AVATAR_ERRORS.controlChar);
		expect(validateAvatarCustomUrl('https://x/{foo}')).toBe(
			`${AVATAR_ERRORS.badPlaceholder}：{foo}`
		);
		expect(validateAvatarCustomUrl('https://x/' + 'a'.repeat(500))).toBe(AVATAR_ERRORS.tooLong);
	});

	it('custom 必须有模板', () => {
		expect(validateAvatarSettings({ source: 'custom', customUrl: '' })).toBe(
			AVATAR_ERRORS.emptyCustom
		);
		expect(
			validateAvatarSettings({ source: 'custom', customUrl: 'https://x/{hash}' })
		).toBe('');
	});
});

describe('dashboard avatar utils — 预览', () => {
	it('用示例值替换四个占位符', () => {
		expect(avatarPreview('https://x/{hash}/{email}/{author}/{qq}')).toBe(
			'https://x/5d60d4e28066df254d5452f92c910092/test%40example.com/%E5%BC%A0%E4%B8%89/12345'
		);
	});

	it('空模板返回空串', () => {
		expect(avatarPreview('')).toBe('');
		expect(avatarPreview(null)).toBe('');
	});
});
