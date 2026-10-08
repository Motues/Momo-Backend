import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAllowedApiUrl, normalizeApiUrl, API_URL_REQUIREMENT } from '../src/utils/apiUrl.js';

/** happy-dom 默认源；apiUrl 的白名单判断依赖 window.location.origin */
const DEFAULT_ORIGIN = 'http://localhost:3000';

const setOrigin = (origin) => window.happyDOM.setURL(`${origin}/`);

beforeEach(() => setOrigin(DEFAULT_ORIGIN));
afterEach(() => setOrigin(DEFAULT_ORIGIN));

describe('isAllowedApiUrl - 非字符串与空值一律拒绝', () => {
	it.each([
		['undefined', undefined],
		['null', null],
		['数字 0', 0],
		['数字 123', 123],
		['布尔 false', false],
		['布尔 true', true],
		['普通对象', {}],
		['数组', []],
	])('%s 被拒绝', (_label, value) => {
		expect(isAllowedApiUrl(value)).toBe(false);
	});

	it('函数被拒绝', () => {
		expect(isAllowedApiUrl(() => {})).toBe(false);
	});

	it('空字符串被拒绝', () => {
		expect(isAllowedApiUrl('')).toBe(false);
	});

	it('纯空格字符串被拒绝', () => {
		expect(isAllowedApiUrl('   ')).toBe(false);
	});

	it('制表符与换行组成的字符串被拒绝', () => {
		expect(isAllowedApiUrl('\t\n ')).toBe(false);
	});
});

describe('isAllowedApiUrl - 同源相对路径', () => {
	it.each(['/api', '/api/v1', '/', '/api?x=1', '/api#hash'])('允许相对路径 %s', (value) => {
		expect(isAllowedApiUrl(value)).toBe(true);
	});

	it('去掉首尾空白后仍按相对路径处理', () => {
		expect(isAllowedApiUrl('  /api  ')).toBe(true);
	});

	it('协议相对地址 //evil.com 被拒绝（否则会被浏览器当作跨域）', () => {
		expect(isAllowedApiUrl('//evil.com')).toBe(false);
	});

	it('协议相对地址 //evil.com/api 被拒绝', () => {
		expect(isAllowedApiUrl('//evil.com/api')).toBe(false);
	});

	it('三斜杠 ///evil.com 被拒绝', () => {
		expect(isAllowedApiUrl('///evil.com')).toBe(false);
	});

	it('不带前导斜杠的相对路径 ./api 被拒绝', () => {
		expect(isAllowedApiUrl('./api')).toBe(false);
	});

	it('裸域名 evil.com 被拒绝（缺少 scheme）', () => {
		expect(isAllowedApiUrl('evil.com')).toBe(false);
	});

	it('裸主机名加端口 localhost:3000 被拒绝（缺少 scheme）', () => {
		expect(isAllowedApiUrl('localhost:3000')).toBe(false);
	});
});

describe('isAllowedApiUrl - https 地址', () => {
	it.each([
		'https://any.example.com',
		'https://example.com:8443/api',
		'https://sub.domain.example.com/path?query=1',
		'HTTPS://A.EXAMPLE.COM',
	])('允许 https 地址 %s', (value) => {
		expect(isAllowedApiUrl(value)).toBe(true);
	});

	it('允许带 userinfo 的 https 地址（设计上 https 一律放行）', () => {
		expect(isAllowedApiUrl('https://localhost:3000@evil.com/')).toBe(true);
	});

	it('https://localhost.evil.com 允许（https 一律放行）', () => {
		expect(isAllowedApiUrl('https://localhost.evil.com')).toBe(true);
	});
});

describe('isAllowedApiUrl - 本机 http 调试地址', () => {
	it.each([
		'http://localhost:3000',
		'http://localhost',
		'http://LOCALHOST:8080',
		'http://127.0.0.1:3000',
		'http://127.0.0.1',
		'http://[::1]:3000',
	])('允许本机地址 %s', (value) => {
		expect(isAllowedApiUrl(value)).toBe(true);
	});
});

describe('isAllowedApiUrl - 跨源 http 与危险 scheme', () => {
	it('跨源明文 http 主机被拒绝（token 会被外发）', () => {
		expect(isAllowedApiUrl('http://evil.com')).toBe(false);
	});

	it('跨源明文 http 内网地址被拒绝', () => {
		expect(isAllowedApiUrl('http://192.168.1.5:8080')).toBe(false);
	});

	it('localhost.evil.com 被拒绝（不能只做前缀匹配）', () => {
		expect(isAllowedApiUrl('http://localhost.evil.com')).toBe(false);
	});

	it('127.0.0.1.evil.com 被拒绝', () => {
		expect(isAllowedApiUrl('http://127.0.0.1.evil.com')).toBe(false);
	});

	it('http://localhost:3000@evil.com 被拒绝（userinfo 伪造本机主机）', () => {
		expect(isAllowedApiUrl('http://localhost:3000@evil.com/')).toBe(false);
	});

	it('http://127.0.0.1@evil.com 被拒绝', () => {
		expect(isAllowedApiUrl('http://127.0.0.1@evil.com')).toBe(false);
	});

	it.each([
		['javascript:', 'javascript:alert(1)'],
		['javascript scheme + 双斜杠', 'javascript://alert(1)'],
		['data:', 'data:text/html,<script>alert(1)</script>'],
		['data scheme + 双斜杠', 'data://text/html'],
		['file:', 'file:///etc/passwd'],
		['ftp:', 'ftp://files.example.com'],
		['ws:', 'ws://evil.com'],
		['wss:', 'wss://evil.com'],
		['vbscript:', 'vbscript:msgbox(1)'],
	])('%s 被拒绝', (_label, value) => {
		expect(isAllowedApiUrl(value)).toBe(false);
	});

	it('单斜杠的 http:/evil.com 被拒绝', () => {
		expect(isAllowedApiUrl('http:/evil.com')).toBe(false);
	});

	it('只有 scheme 没有主机的 http:// 被拒绝（URL 解析失败）', () => {
		expect(isAllowedApiUrl('http://')).toBe(false);
	});

	it('只有 scheme 没有主机的 https:// 被拒绝', () => {
		expect(isAllowedApiUrl('https://')).toBe(false);
	});

	it('主机非法的 http://:3000 被拒绝', () => {
		expect(isAllowedApiUrl('http://:3000')).toBe(false);
	});
});

describe('isAllowedApiUrl - 依赖 window.location.origin', () => {
	it('同源明文 http 被接受（面板自身源为 http）', () => {
		expect(window.location.origin).toBe('http://localhost:3000');
		expect(isAllowedApiUrl('http://localhost:3000')).toBe(true);
	});

	it('换一个非本机的同源源后，该源被接受', () => {
		setOrigin('http://panel.example.com');
		expect(isAllowedApiUrl('http://panel.example.com')).toBe(true);
		expect(isAllowedApiUrl('http://panel.example.com/api')).toBe(true);
	});

	it('换源后其他 http 主机仍被拒绝', () => {
		setOrigin('http://panel.example.com');
		expect(isAllowedApiUrl('http://other.example.com')).toBe(false);
		expect(isAllowedApiUrl('http://panel.example.com:8080')).toBe(false);
	});

	it('http 面板下的 https 同主机依然允许', () => {
		setOrigin('http://panel.example.com');
		expect(isAllowedApiUrl('https://panel.example.com')).toBe(true);
	});

	it('https 面板下的 http 同主机被拒绝（协议不同即跨源）', () => {
		setOrigin('https://panel.example.com');
		expect(isAllowedApiUrl('http://panel.example.com')).toBe(false);
		expect(isAllowedApiUrl('https://panel.example.com')).toBe(true);
	});

	it('https 面板下本机明文 http 仍允许（本地调试）', () => {
		setOrigin('https://panel.example.com');
		expect(isAllowedApiUrl('http://localhost:3000')).toBe(true);
	});

	it('源变化只影响明文 http 的判定，不影响相对路径', () => {
		setOrigin('https://another.example.com');
		expect(isAllowedApiUrl('/api')).toBe(true);
	});
});

describe('normalizeApiUrl - 归一化与白名单', () => {
	it.each([
		['undefined', undefined],
		['null', null],
		['数字', 42],
		['对象', {}],
		['数组', []],
		['布尔', true],
	])('%s 返回 null', (_label, value) => {
		expect(normalizeApiUrl(value)).toBeNull();
	});

	it('空字符串返回 null', () => {
		expect(normalizeApiUrl('')).toBeNull();
	});

	it('纯空白返回 null', () => {
		expect(normalizeApiUrl('   ')).toBeNull();
	});

	it('去掉结尾斜杠', () => {
		expect(normalizeApiUrl('https://api.example.com/')).toBe('https://api.example.com');
	});

	it('去掉多个结尾斜杠', () => {
		expect(normalizeApiUrl('https://api.example.com///')).toBe('https://api.example.com');
	});

	it('同时去掉首尾空白与结尾斜杠', () => {
		expect(normalizeApiUrl('  https://api.example.com/  ')).toBe('https://api.example.com');
	});

	it('相对路径去掉结尾斜杠', () => {
		expect(normalizeApiUrl('/api/')).toBe('/api');
	});

	it('没有结尾斜杠时原样返回', () => {
		expect(normalizeApiUrl('https://api.example.com')).toBe('https://api.example.com');
	});

	it('保留路径中的斜杠，只裁剪结尾', () => {
		expect(normalizeApiUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
	});

	it('本机 http 地址归一化后仍可用', () => {
		expect(normalizeApiUrl('http://localhost:3000/')).toBe('http://localhost:3000');
		expect(normalizeApiUrl('http://127.0.0.1:3000//')).toBe('http://127.0.0.1:3000');
		expect(normalizeApiUrl('http://[::1]:3000/')).toBe('http://[::1]:3000');
	});

	it('归一化后仍执行白名单：跨源 http 返回 null', () => {
		expect(normalizeApiUrl('http://evil.com/')).toBeNull();
	});

	it('归一化后仍执行白名单：协议相对地址返回 null', () => {
		expect(normalizeApiUrl('//evil.com/')).toBeNull();
	});

	it('归一化后仍执行白名单：裸域名返回 null', () => {
		expect(normalizeApiUrl('evil.com/')).toBeNull();
	});

	it('归一化后仍执行白名单：javascript: 返回 null', () => {
		expect(normalizeApiUrl('javascript:alert(1)')).toBeNull();
	});

	it('归一化后仍执行白名单：file: 返回 null', () => {
		expect(normalizeApiUrl('file:///etc/passwd/')).toBeNull();
	});

	it('未知 scheme 不会因为斜杠裁剪而放行', () => {
		expect(normalizeApiUrl('gopher://evil.com/')).toBeNull();
	});

	it('已记录的边界：单独的 "/" 会被裁剪成空串并返回 null', () => {
		// isAllowedApiUrl('/') 为 true，但 normalizeApiUrl('/') 为 null，
		// 因此登录页会以「API 地址无效」拒绝填写 "/"（疑似不一致，见测试报告）。
		expect(isAllowedApiUrl('/')).toBe(true);
		expect(normalizeApiUrl('/')).toBeNull();
	});
});

describe('API_URL_REQUIREMENT 提示文案', () => {
	it('是非空字符串', () => {
		expect(typeof API_URL_REQUIREMENT).toBe('string');
		expect(API_URL_REQUIREMENT.length).toBeGreaterThan(0);
	});

	it('说明支持 https', () => {
		expect(API_URL_REQUIREMENT).toContain('https');
	});

	it('说明支持同源与本机地址', () => {
		expect(API_URL_REQUIREMENT).toContain('同源');
		expect(API_URL_REQUIREMENT).toContain('localhost');
		expect(API_URL_REQUIREMENT).toContain('127.0.0.1');
	});
});
