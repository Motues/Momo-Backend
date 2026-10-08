/**
 * src/utils/security.ts —— 净化、URL 白名单、IP/CIDR 黑名单与状态白名单。
 *
 * 这些逻辑与 nodejs/src/utils/security.ts、go/internal/pkg/utils 保持三端一致，
 * 因此断言的是「三端共同口径」，不是 Worker 私有行为。
 */
import { describe, it, expect } from 'vitest';
import {
	COMMENT_STATUSES,
	MAX_AUTHOR,
	MAX_CONTENT,
	MAX_CONTENT_HTML,
	MAX_EMAIL,
	MAX_POST_SLUG,
	MAX_URL,
	checkContent,
	ipMatchesBlacklist,
	isValidCommentStatus,
	isValidIpBlacklistJson,
	isValidIpOrCidr,
	parseIpBlacklist,
	sanitizeUrl,
} from '../../src/utils/security';

describe('checkContent —— 脚本与样式块', () => {
	it('整块 script 连内容一起移除', () => {
		expect(checkContent('<script>alert(1)</script>')).toBe('');
		expect(checkContent('<script src=x></script>hello')).toBe('hello');
		expect(checkContent('a<script>1</script>b<script>2</script>c')).toBe('abc');
	});

	it('大小写不敏感', () => {
		expect(checkContent('<SCRIPT>alert(1)</SCRIPT>')).toBe('');
		expect(checkContent('<ScRiPt>x</ScRiPt>')).toBe('');
	});

	it('style 块连内容一起移除', () => {
		expect(checkContent('<style>body{}</style>text')).toBe('text');
	});

	it('未闭合的 <script> 不会被移除（与 Node/Go 一致的已知边界）', () => {
		// 正则要求闭合标签；该行为与 nodejs/src/utils/security.ts 完全相同，
		// 且 content_html 侧由 parseMarkdown 转义，故不视为本端独有的漏洞。
		expect(checkContent('<script>alert(1)')).toBe('<script>alert(1)');
	});
});

describe('checkContent —— 事件属性与危险协议', () => {
	it('移除 on* 事件属性（双引号 / 单引号 / 无引号 / 带空格）', () => {
		expect(checkContent('<img src=x onerror=alert(1)>')).toBe('<img src=x>');
		expect(checkContent('<p onclick="evil()">hi</p>')).toBe('<p>hi</p>');
		expect(checkContent("<p onclick='evil()'>hi</p>")).toBe('<p>hi</p>');
		expect(checkContent('<p onmouseover = "x">hi</p>')).toBe('<p>hi</p>');
	});

	it('移除带引号的 javascript: / vbscript: 链接属性', () => {
		expect(checkContent('href="javascript:alert(1)"')).toBe('');
		expect(checkContent("src='vbscript:msgbox(1)'")).toBe('');
	});

	it('移除无引号的 javascript: 链接属性', () => {
		expect(checkContent('<a href=javascript:alert(1)>x</a>')).toBe('<a >x</a>');
	});

	it('移除独立的 javascript: 协议文本', () => {
		expect(checkContent('javascript:alert(1)')).toBe('alert(1)');
		expect(checkContent('JavaScript:alert(1)')).toBe('alert(1)');
	});

	it('移除危险嵌入标签但保留普通标签', () => {
		expect(checkContent('<iframe src=x></iframe>')).toBe('');
		expect(checkContent('<embed src=x>')).toBe('');
		expect(checkContent('<object data=x></object>')).toBe('');
		expect(checkContent('<form action=x></form>')).toBe('');
		expect(checkContent('<input value=x>')).toBe('');
		expect(checkContent('<b>bold</b>')).toBe('<b>bold</b>');
	});
});

describe('checkContent —— 常规输入', () => {
	it('纯文本原样返回', () => {
		expect(checkContent('hello world')).toBe('hello world');
		expect(checkContent('中文评论 🎉')).toBe('中文评论 🎉');
	});

	it('空串与 falsy 输入原样返回', () => {
		expect(checkContent('')).toBe('');
		// 实现是 `if (!content) return content`，falsy 值原样透出
		expect(checkContent(undefined as unknown as string)).toBeUndefined();
	});
});

describe('sanitizeUrl —— 协议白名单', () => {
	it('允许 http / https / mailto（大小写不敏感，保留原样）', () => {
		expect(sanitizeUrl('https://a.com/path')).toBe('https://a.com/path');
		expect(sanitizeUrl('http://a.com')).toBe('http://a.com');
		expect(sanitizeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
		expect(sanitizeUrl('HTTPS://A.com/p')).toBe('HTTPS://A.com/p');
	});

	it('允许相对路径与协议相对地址', () => {
		expect(sanitizeUrl('/rel/path')).toBe('/rel/path');
		expect(sanitizeUrl('rel/path')).toBe('rel/path');
		expect(sanitizeUrl('//proto.example.com/x')).toBe('//proto.example.com/x');
	});

	it('拒绝 javascript / vbscript / data 等其它 scheme', () => {
		expect(sanitizeUrl('javascript:alert(1)')).toBe('');
		expect(sanitizeUrl('JavaScript:alert(1)')).toBe('');
		expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
		expect(sanitizeUrl('data:text/html,x')).toBe('');
		expect(sanitizeUrl('tel:123')).toBe('');
		expect(sanitizeUrl('file:///etc/passwd')).toBe('');
	});

	it('剥离控制字符后再判定 scheme，防止 java\\nscript 绕过', () => {
		expect(sanitizeUrl('java\nscript:alert(1)')).toBe('');
		expect(sanitizeUrl('java\tscript:alert(1)')).toBe('');
		expect(sanitizeUrl('\u0000javascript:alert(1)')).toBe('');
	});

	it('空值与纯空白 / 纯控制字符返回空串', () => {
		expect(sanitizeUrl('')).toBe('');
		expect(sanitizeUrl('   ')).toBe('');
		expect(sanitizeUrl('\u0000')).toBe('');
		expect(sanitizeUrl('  https://a.com  ')).toBe('https://a.com');
	});

	it('非字符串输入返回空串', () => {
		expect(sanitizeUrl(undefined)).toBe('');
		expect(sanitizeUrl(null)).toBe('');
		expect(sanitizeUrl(123)).toBe('');
		expect(sanitizeUrl({ href: 'https://a.com' })).toBe('');
	});
});

describe('isValidIpOrCidr', () => {
	it('接受合法 IPv4', () => {
		expect(isValidIpOrCidr('127.0.0.1')).toBe(true);
		expect(isValidIpOrCidr('0.0.0.0')).toBe(true);
		expect(isValidIpOrCidr('255.255.255.255')).toBe(true);
		expect(isValidIpOrCidr(' 10.1.2.3 ')).toBe(true);
	});

	it('拒绝非法 IPv4', () => {
		expect(isValidIpOrCidr('256.0.0.1')).toBe(false);
		expect(isValidIpOrCidr('1.2.3')).toBe(false);
		expect(isValidIpOrCidr('1.2.3.4.5')).toBe(false);
		expect(isValidIpOrCidr('1.2.3.abc')).toBe(false);
	});

	it('接受合法 IPv6（含内嵌 IPv4 与区域 ID）', () => {
		expect(isValidIpOrCidr('::1')).toBe(true);
		expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
		expect(isValidIpOrCidr('::ffff:127.0.0.1')).toBe(true);
		expect(isValidIpOrCidr('fe80::1%eth0')).toBe(true);
	});

	it('拒绝非法 IPv6', () => {
		expect(isValidIpOrCidr('::1::2')).toBe(false);
		expect(isValidIpOrCidr('2001:db8:::1')).toBe(false);
		expect(isValidIpOrCidr('gggg::1')).toBe(false);
		expect(isValidIpOrCidr('1:2:3:4:5:6:7')).toBe(false);
	});

	it('CIDR 前缀范围校验', () => {
		expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true);
		expect(isValidIpOrCidr('10.0.0.0/0')).toBe(true);
		expect(isValidIpOrCidr('10.0.0.0/32')).toBe(true);
		expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false);
		expect(isValidIpOrCidr('::/0')).toBe(true);
		expect(isValidIpOrCidr('::/128')).toBe(true);
		expect(isValidIpOrCidr('::/129')).toBe(false);
		expect(isValidIpOrCidr('10.0.0.0/-1')).toBe(false);
		expect(isValidIpOrCidr('10.0.0.0/abc')).toBe(false);
		expect(isValidIpOrCidr('10.0.0.0/')).toBe(false);
		expect(isValidIpOrCidr('/24')).toBe(false);
		expect(isValidIpOrCidr('10.0.0.0/8/8')).toBe(false);
	});

	it('拒绝空值与非字符串', () => {
		expect(isValidIpOrCidr('')).toBe(false);
		expect(isValidIpOrCidr('   ')).toBe(false);
		expect(isValidIpOrCidr(null)).toBe(false);
		expect(isValidIpOrCidr(123)).toBe(false);
		expect(isValidIpOrCidr(['1.2.3.4'])).toBe(false);
	});
});

describe('isValidIpBlacklistJson / parseIpBlacklist', () => {
	it('空串视为合法（表示未配置）', () => {
		expect(isValidIpBlacklistJson('')).toBe(true);
	});

	it('合法数组通过，非法条目被拒绝', () => {
		expect(isValidIpBlacklistJson('[]')).toBe(true);
		expect(isValidIpBlacklistJson('["1.2.3.4","10.0.0.0/8"]')).toBe(true);
		expect(isValidIpBlacklistJson('["bad-ip"]')).toBe(false);
		expect(isValidIpBlacklistJson('[123]')).toBe(false);
	});

	it('非数组 / 非法 JSON 被拒绝', () => {
		expect(isValidIpBlacklistJson('{"a":1}')).toBe(false);
		expect(isValidIpBlacklistJson('"1.2.3.4"')).toBe(false);
		expect(isValidIpBlacklistJson('not json')).toBe(false);
	});

	it('parseIpBlacklist 解析成功时过滤掉非字符串元素', () => {
		expect(parseIpBlacklist('["1.2.3.4",5,null,"::1"]')).toEqual(['1.2.3.4', '::1']);
		expect(parseIpBlacklist('[]')).toEqual([]);
	});

	it('parseIpBlacklist 解析失败时返回 null（供调用方 fail-open + 告警）', () => {
		expect(parseIpBlacklist('not json')).toBeNull();
		expect(parseIpBlacklist('{"a":1}')).toBeNull();
	});
});

describe('ipMatchesBlacklist', () => {
	it('精确匹配 IPv4 与 IPv6', () => {
		expect(ipMatchesBlacklist('1.2.3.4', ['1.2.3.4'])).toBe(true);
		expect(ipMatchesBlacklist('1.2.3.4', ['1.2.3.5'])).toBe(false);
		expect(ipMatchesBlacklist('::1', ['::1'])).toBe(true);
	});

	it('IPv4-mapped IPv6 与 IPv4 视为同一地址', () => {
		expect(ipMatchesBlacklist('::ffff:1.2.3.4', ['1.2.3.4'])).toBe(true);
		expect(ipMatchesBlacklist('1.2.3.4', ['::ffff:1.2.3.4'])).toBe(true);
	});

	it('CIDR 命中与未命中', () => {
		expect(ipMatchesBlacklist('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
		expect(ipMatchesBlacklist('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
		expect(ipMatchesBlacklist('10.1.2.3', ['10.1.2.3/32'])).toBe(true);
		expect(ipMatchesBlacklist('10.1.2.4', ['10.1.2.3/32'])).toBe(false);
		expect(ipMatchesBlacklist('10.1.2.3', ['0.0.0.0/0'])).toBe(true);
		expect(ipMatchesBlacklist('2001:db8::5', ['2001:db8::/32'])).toBe(true);
		expect(ipMatchesBlacklist('2001:db9::5', ['2001:db8::/32'])).toBe(false);
	});

	it('非字节对齐前缀（如 /12）按位比较', () => {
		// 172.16.0.0/12 → 172.16.0.0 - 172.31.255.255
		expect(ipMatchesBlacklist('172.16.5.5', ['172.16.0.0/12'])).toBe(true);
		expect(ipMatchesBlacklist('172.31.255.255', ['172.16.0.0/12'])).toBe(true);
		expect(ipMatchesBlacklist('172.32.0.1', ['172.16.0.0/12'])).toBe(false);
		expect(ipMatchesBlacklist('172.15.0.1', ['172.16.0.0/12'])).toBe(false);
	});

	it('不跨族匹配', () => {
		expect(ipMatchesBlacklist('1.2.3.4', ['::/0'])).toBe(false);
		expect(ipMatchesBlacklist('::1', ['0.0.0.0/0'])).toBe(false);
		expect(ipMatchesBlacklist('1.2.3.4', ['::1'])).toBe(false);
	});

	it('空条目与非法 CIDR 不匹配', () => {
		expect(ipMatchesBlacklist('1.2.3.4', ['', '   '])).toBe(false);
		expect(ipMatchesBlacklist('1.2.3.4', ['10.0.0.0/abc'])).toBe(false);
		expect(ipMatchesBlacklist('1.2.3.4', ['bad-ip'])).toBe(false);
	});

	it('完全无法解析的条目退化为字符串相等比较', () => {
		// 记录既有实现细节：非法条目不会抛错，而是走 value === target 兜底
		expect(ipMatchesBlacklist('not-an-ip', ['not-an-ip'])).toBe(true);
		expect(ipMatchesBlacklist(' not-an-ip ', ['not-an-ip'])).toBe(true);
	});

	it('空黑名单数组永不匹配', () => {
		expect(ipMatchesBlacklist('1.2.3.4', [])).toBe(false);
	});
});

describe('isValidCommentStatus 与字段上限常量', () => {
	it('status 白名单', () => {
		expect(COMMENT_STATUSES).toEqual(['pending', 'approved', 'rejected', 'deleted']);
		for (const status of COMMENT_STATUSES) expect(isValidCommentStatus(status)).toBe(true);
	});

	it('拒绝白名单外的值', () => {
		expect(isValidCommentStatus('APPROVED')).toBe(false);
		expect(isValidCommentStatus('unknown')).toBe(false);
		expect(isValidCommentStatus('')).toBe(false);
		expect(isValidCommentStatus(null)).toBe(false);
		expect(isValidCommentStatus(123)).toBe(false);
		expect(isValidCommentStatus('deleted ')).toBe(false);
	});

	it('长度上限与前端组件约束对齐', () => {
		expect({
			MAX_CONTENT,
			MAX_CONTENT_HTML,
			MAX_AUTHOR,
			MAX_EMAIL,
			MAX_URL,
			MAX_POST_SLUG,
		}).toEqual({
			MAX_CONTENT: 2000,
			MAX_CONTENT_HTML: 50000,
			MAX_AUTHOR: 100,
			MAX_EMAIL: 254,
			MAX_URL: 500,
			MAX_POST_SLUG: 200,
		});
	});
});
