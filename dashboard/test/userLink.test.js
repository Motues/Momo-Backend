import { describe, it, expect } from 'vitest';
import { LINK_UNKNOWN_TITLE, linkStatus, trustTitle } from '../src/utils/userLink.js';

describe('userLink - linkStatus', () => {
	it('url 字段缺失（老后端）判定为 unknown，与「没有链接」区分', () => {
		expect(linkStatus({})).toBe('unknown');
		expect(linkStatus({ url: null })).toBe('unknown');
		expect(linkStatus(null)).toBe('unknown');
	});

	it('url 为空串判定为 none', () => {
		expect(linkStatus({ url: '' })).toBe('none');
	});

	it('有 url 时区分 trusted / dormant / normal', () => {
		expect(linkStatus({ url: 'https://a.example.com', urlTrustedUntil: '2030-01-01T00:00:00Z' })).toBe('trusted');
		expect(linkStatus({ url: 'https://a.example.com', urlDormant: true })).toBe('dormant');
		expect(linkStatus({ url: 'https://a.example.com' })).toBe('normal');
	});

	it('trusted 优先于 dormant（后端确认后会把 urlDormant 置 false，这里也保持同一优先级）', () => {
		expect(
			linkStatus({ url: 'https://a.example.com', urlDormant: true, urlTrustedUntil: '2030-01-01T00:00:00Z' })
		).toBe('trusted');
	});
});

describe('userLink - 文案', () => {
	it('unknown 的说明文案提醒升级后端', () => {
		expect(LINK_UNKNOWN_TITLE).toContain('升级');
	});

	it('已确认文案区分「人工确认」与「本人确认」', () => {
		expect(trustTitle({ urlTrustedUntil: '2030-01-01T00:00:00Z' })).toContain('已人工确认安全');
		expect(
			trustTitle({ urlTrustedUntil: '2030-01-01T00:00:00Z', urlTrustedSource: 'self' })
		).toContain('本人已确认仍在使用');
	});
});
