import { describe, it, expect } from 'vitest';
import {
	BASE_URL_ERROR,
	BASE_URL_TOO_LONG,
	MAX_BASE_URL_LENGTH,
	normalizeBaseUrl,
	validateBaseUrl,
} from '../src/utils/baseUrl.js';

describe('baseUrl 纯逻辑', () => {
	it('normalizeBaseUrl：去首尾空格与末尾斜杠，空串保持空串', () => {
		expect(normalizeBaseUrl('')).toBe('');
		expect(normalizeBaseUrl('   ')).toBe('');
		expect(normalizeBaseUrl(null)).toBe('');
		expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
		expect(normalizeBaseUrl('  https://api.example.com///  ')).toBe('https://api.example.com');
		expect(normalizeBaseUrl('https://api.example.com/base/')).toBe('https://api.example.com/base');
	});

	it('validateBaseUrl：空串合法（表示未配置）', () => {
		expect(validateBaseUrl('')).toBe('');
		expect(validateBaseUrl('   ')).toBe('');
	});

	it('validateBaseUrl：接受 http / https 绝对地址', () => {
		expect(validateBaseUrl('https://api.example.com')).toBe('');
		expect(validateBaseUrl('http://localhost:17171')).toBe('');
		expect(validateBaseUrl('https://api.example.com/base')).toBe('');
		expect(validateBaseUrl('https://api.example.com///')).toBe('');
	});

	it('validateBaseUrl：拒绝相对地址、非 http(s) 协议与畸形地址', () => {
		[
			'api.example.com',
			'ftp://api.example.com',
			'https://',
			'https://a.com?x=1',
			'https://a.com#frag',
			'https://u:p@a.com',
			'///',
			'http://',
		].forEach((value) => {
			expect(validateBaseUrl(value), value).toBe(BASE_URL_ERROR);
		});
	});

	it('validateBaseUrl：超过上限时给出长度错误', () => {
		const longUrl = `https://api.example.com/${'a'.repeat(MAX_BASE_URL_LENGTH)}`;
		expect(validateBaseUrl(longUrl)).toBe(BASE_URL_TOO_LONG);
	});
});
