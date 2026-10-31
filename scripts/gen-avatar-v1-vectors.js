#!/usr/bin/env node
/**
 * 生成 `doc/vectors/avatar-v1.json` —— 评论区头像来源契约（v1）的跨语言固定向量。
 *
 * 契约见 `doc/avatar.md`：两个设置键（`avatar_source` / `avatar_custom_url`）、
 * 四个预设模板、四个占位符、八条写入错误文案，以及读取时的 fail-open 回落。
 *
 * 运行：`node scripts/gen-avatar-v1-vectors.js`（纯 Node，零依赖）。
 * 生成口径在脚本里**独立复算**，不调用任何实现内部函数，因此它同时是一次独立复核。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SOURCE = 'default';
const DEFAULT_CUSTOM_URL = '';
const DEFAULT_ENABLED = 'true';
const MAX_URL_LENGTH = 500;

/**
 * 关闭头像后统一下发的默认头像（内联 SVG，灰色人像）。
 * 三端常量与 fixture 的 defaultAvatarUrl 必须逐字一致。
 */
const DEFAULT_AVATAR_URL =
	'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIzMiIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjQiIHI9IjExIiBmaWxsPSIjOWNhM2FmIi8+PHBhdGggZD0iTTEzIDU3YzAtMTAuNSA4LjUtMTkgMTktMTlzMTkgOC41IDE5IDE5IiBmaWxsPSIjOWNhM2FmIi8+PC9zdmc+';

const SOURCES = ['default', 'gravatar', 'cravatar', 'qq', 'custom'];
const TEMPLATES = {
	default: 'https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam',
	gravatar: 'https://gravatar.com/avatar/{hash}?s=200&d=identicon',
	cravatar: 'https://cravatar.cn/avatar/{hash}?s=200&d=identicon',
	qq: 'https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100',
};
const PLACEHOLDERS = ['{hash}', '{email}', '{author}', '{qq}'];

const ERRORS = {
	notString: 'avatar_custom_url 必须是字符串',
	badSource: 'avatar_source 只能是 default / gravatar / cravatar / qq / custom',
	badScheme: 'avatar_custom_url 只允许 http/https 地址',
	tooLong: `avatar_custom_url 不能超过 ${MAX_URL_LENGTH} 个字符`,
	controlChar: 'avatar_custom_url 不能包含控制字符',
	badPlaceholder: 'avatar_custom_url 包含不支持的占位符：{foo}',
	emptyCustom: '选择自定义头像来源时必须填写头像地址',
	badEnabled: 'avatar_enabled 只能是 true 或 false',
};

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const codePointLength = (value) => [...String(value)].length;
const isQqEmail = (email) => /^\d+@qq\.com$/.test(normalizeEmail(email));

/** RFC 3986 非保留字符之外全部 percent-encode（与三端实现逐字一致） */
const percentEncode = (value) =>
	Array.from(Buffer.from(String(value ?? ''), 'utf8'))
		.map((byte) => {
			const char = String.fromCharCode(byte);
			if (/[A-Za-z0-9\-_.~]/.test(char)) return char;
			return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		})
		.join('');

const normalizeSource = (value) => {
	const raw = String(value ?? '').trim().toLowerCase();
	return SOURCES.includes(raw) ? raw : DEFAULT_SOURCE;
};

const customUrlError = (value) => {
	if (value === null || value === undefined) return '';
	if (typeof value !== 'string') return ERRORS.notString;
	const trimmed = value.trim();
	if (trimmed === '') return '';
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return ERRORS.controlChar;
	if (!/^https?:\/\//i.test(trimmed)) return ERRORS.badScheme;
	if (codePointLength(trimmed) > MAX_URL_LENGTH) return ERRORS.tooLong;
	const unknown = trimmed.match(/\{[^{}]*\}/g)?.find((token) => !PLACEHOLDERS.includes(token));
	if (unknown) return ERRORS.badPlaceholder.replace('{foo}', unknown);
	return '';
};

const resolve = (source, customUrl) => {
	const normalized = normalizeSource(source);
	if (normalized === 'custom') {
		const trimmed = typeof customUrl === 'string' ? customUrl.trim() : '';
		if (trimmed !== '' && customUrlError(trimmed) === '') {
			return { source: 'custom', template: trimmed };
		}
		return { source: DEFAULT_SOURCE, template: TEMPLATES.default };
	}
	return { source: normalized, template: TEMPLATES[normalized] };
};

const build = (source, customUrl, email, author) => {
	const config = resolve(source, customUrl);
	let template = config.template;
	const normalizedEmail = normalizeEmail(email);
	if (template.includes('{qq}') && !isQqEmail(normalizedEmail)) {
		template = TEMPLATES.default;
	}
	const qq = normalizedEmail.match(/^(\d+)@qq\.com$/)?.[1] ?? '';
	return template.replace(/\{(hash|email|author|qq)\}/g, (_match, name) => {
		switch (name) {
			case 'hash':
				return md5(normalizedEmail);
			case 'email':
				return percentEncode(normalizedEmail);
			case 'author':
				return percentEncode(String(author ?? '').trim());
			default:
				return qq;
		}
	});
};

const normalizeEnabled = (value) => String(value ?? '').trim().toLowerCase();
const effectiveEnabled = (value) => normalizeEnabled(value) !== 'false';

const longUrl = (len) => 'https://' + 'a'.repeat(len - 'https://'.length);
if (longUrl(MAX_URL_LENGTH + 1).length !== MAX_URL_LENGTH + 1) {
	throw new Error('longUrl 长度计算错误');
}

const CUSTOM = 'https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}&qq={qq}';

const fixture = {
	version: 1,
	note:
		'评论区头像来源契约 v1。三个设置键：avatar_enabled（默认开启）、avatar_source（default/gravatar/cravatar/qq/custom）与 avatar_custom_url。' +
		'预设模板、四个占位符（{hash}/{email}/{author}/{qq}）、八条写入错误文案、读取 fail-open 回落' +
		'（未知来源/空或非法模板/qq 来源下非 QQ 邮箱 → 内置默认源）、以及关闭头像时统一下发的 defaultAvatarUrl。' +
		'三端必须逐条一致。由 scripts/gen-avatar-v1-vectors.js 生成，请勿手改。',
	defaults: {
		enabled: DEFAULT_ENABLED,
		source: DEFAULT_SOURCE,
		customUrl: DEFAULT_CUSTOM_URL,
	},
	defaultAvatarUrl: DEFAULT_AVATAR_URL,
	enabled: {
		normalize: [
			{ value: null, expect: '' },
			{ value: '', expect: '' },
			{ value: '  TRUE  ', expect: 'true' },
			{ value: ' FALSE ', expect: 'false' },
			{ value: 'garbage', expect: 'garbage' },
		],
		effective: [
			{ value: null, expect: true },
			{ value: '', expect: true },
			{ value: 'true', expect: true },
			{ value: 'false', expect: false },
			{ value: '  FALSE  ', expect: false },
			{ value: 'garbage', expect: true },
		],
		invalid: [
			{ value: 'yes', error: ERRORS.badEnabled },
			{ value: '1', error: ERRORS.badEnabled },
		],
	},
	limits: {
		maxUrlLen: MAX_URL_LENGTH,
	},
	sources: SOURCES,
	templates: TEMPLATES,
	placeholders: PLACEHOLDERS,
	errors: ERRORS,
	validateSource: {
		valid: [
			{ value: null, expect: 'default' },
			{ value: '', expect: 'default' },
			{ value: '   ', expect: 'default' },
			{ value: '  GRAVATAR  ', expect: 'gravatar' },
			{ value: 'Custom', expect: 'custom' },
			{ value: ' qq ', expect: 'qq' },
		],
		invalid: [
			{ value: 'github', error: ERRORS.badSource },
			{ value: 'gravatar2', error: ERRORS.badSource },
			{ value: '默认', error: ERRORS.badSource },
		],
	},
	validateCustomUrl: {
		valid: [
			{ value: null, expect: '' },
			{ value: '', expect: '' },
			{ value: '   ', expect: '' },
			{ value: '  https://cdn.example.com/{hash}  ', expect: 'https://cdn.example.com/{hash}' },
			{ value: 'http://x/{email}?a=1&b=2', expect: 'http://x/{email}?a=1&b=2' },
			{ value: 'https://x/static.png', expect: 'https://x/static.png' },
		],
		invalid: [
			{ value: 'javascript:alert(1)', error: ERRORS.badScheme },
			{ value: 'data:text/html,{hash}', error: ERRORS.badScheme },
			{ value: 'ftp://x/{hash}', error: ERRORS.badScheme },
			{ value: 'https://x/{foo}', error: ERRORS.badPlaceholder },
			{ value: 'https://x/\n{hash}', error: ERRORS.controlChar },
			{ value: longUrl(MAX_URL_LENGTH + 1), error: ERRORS.tooLong },
		],
	},
	resolve: [
		{ name: '未配置 → 内置默认源', source: null, customUrl: null, expect: resolve(null, null) },
		{ name: '空串 → 内置默认源', source: '', customUrl: '', expect: resolve('', '') },
		{ name: '大小写/空格归一化', source: '  GRAVATAR  ', customUrl: '', expect: resolve('GRAVATAR', '') },
		{ name: '非 custom 时忽略自定义地址', source: 'cravatar', customUrl: 'https://x/{hash}', expect: resolve('cravatar', '') },
		{ name: 'qq 预设', source: 'qq', customUrl: '', expect: resolve('qq', '') },
		{ name: '合法自定义模板', source: 'custom', customUrl: '  https://cdn.example.com/{hash}  ', expect: resolve('custom', 'https://cdn.example.com/{hash}') },
		{ name: 'custom 但地址为空 → 默认', source: 'custom', customUrl: '', expect: resolve('custom', '') },
		{ name: 'custom 但地址非法 → 默认', source: 'custom', customUrl: 'javascript:alert(1)', expect: resolve('custom', 'javascript:alert(1)') },
		{ name: '未知来源 → 默认', source: 'github', customUrl: 'https://x/{hash}', expect: resolve('github', '') },
		{ name: 'custom 地址含非 ASCII 原样保留', source: 'custom', customUrl: 'https://x/头像/{hash}', expect: resolve('custom', 'https://x/头像/{hash}') },
	],
	build: [
		{
			name: '默认源：邮箱归一化（去空格 + 小写）',
			source: null,
			customUrl: null,
			email: 'test@example.com',
			author: '张三',
			expect: build(null, null, 'test@example.com', '张三'),
		},
		{
			name: '默认源：大小写与空格不影响哈希',
			source: 'default',
			customUrl: '',
			email: '  Test@Example.COM  ',
			author: '任意',
			expect: build('default', '', '  Test@Example.COM  ', '任意'),
		},
		{
			name: '默认源：空邮箱',
			source: 'default',
			customUrl: '',
			email: '',
			author: '匿名',
			expect: build('default', '', '', '匿名'),
		},
		{
			name: 'Gravatar',
			source: 'gravatar',
			customUrl: '',
			email: 'a@b.c',
			author: 'x',
			expect: build('gravatar', '', 'a@b.c', 'x'),
		},
		{
			name: 'Cravatar',
			source: 'cravatar',
			customUrl: '',
			email: 'a@b.c',
			author: 'x',
			expect: build('cravatar', '', 'a@b.c', 'x'),
		},
		{
			name: 'QQ 头像',
			source: 'qq',
			customUrl: '',
			email: '12345@qq.com',
			author: 'QQ 用户',
			expect: build('qq', '', '12345@qq.com', 'QQ 用户'),
		},
		{
			name: 'QQ 头像：邮箱大小写归一化',
			source: 'qq',
			customUrl: '',
			email: '12345@QQ.com',
			author: 'QQ 用户',
			expect: build('qq', '', '12345@QQ.com', 'QQ 用户'),
		},
		{
			name: 'QQ 来源下非 QQ 邮箱回落默认源',
			source: 'qq',
			customUrl: '',
			email: 'a@b.c',
			author: 'x',
			expect: build('qq', '', 'a@b.c', 'x'),
		},
		{
			name: '自定义模板：四个占位符（含中文与空格）',
			source: 'custom',
			customUrl: CUSTOM,
			email: '12345@qq.com',
			author: '张 三',
			expect: build('custom', CUSTOM, '12345@qq.com', '张 三'),
		},
		{
			name: '自定义模板：非 QQ 邮箱不含 {qq}',
			source: 'custom',
			customUrl: 'https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}',
			email: '张三@example.com',
			author: '张 三',
			expect: build(
				'custom',
				'https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}',
				'张三@example.com',
				'张 三'
			),
		},
		{
			name: '自定义模板：QQ 邮箱填 {qq}',
			source: 'custom',
			customUrl: CUSTOM,
			email: '12345@qq.com',
			author: 'Alice',
			expect: build('custom', CUSTOM, '12345@qq.com', 'Alice'),
		},
		{
			name: '自定义模板：percent-encode 特殊字符',
			source: 'custom',
			customUrl: 'https://cdn.example.com/a?email={email}&name={author}',
			email: 'a+b@example.com',
			author: 'A&B',
			expect: build('custom', 'https://cdn.example.com/a?email={email}&name={author}', 'a+b@example.com', 'A&B'),
		},
		{
			name: '模板含 {qq} 但非 QQ 邮箱 → 默认源',
			source: 'custom',
			customUrl: 'https://cdn.example.com/qq/{qq}',
			email: 'a@b.c',
			author: 'x',
			expect: build('custom', 'https://cdn.example.com/qq/{qq}', 'a@b.c', 'x'),
		},
		{
			name: '不含占位符的固定头像',
			source: 'custom',
			customUrl: 'https://cdn.example.com/static.png',
			email: 'a@b.c',
			author: 'x',
			expect: build('custom', 'https://cdn.example.com/static.png', 'a@b.c', 'x'),
		},
		{
			name: '非法自定义模板 → 默认源',
			source: 'custom',
			customUrl: 'javascript:alert(1)',
			email: 'a@b.c',
			author: 'x',
			expect: build('custom', 'javascript:alert(1)', 'a@b.c', 'x'),
		},
		{
			name: '未知来源 → 默认源',
			source: 'github',
			customUrl: 'https://x/{hash}',
			email: 'a@b.c',
			author: 'x',
			expect: build('github', 'https://x/{hash}', 'a@b.c', 'x'),
		},
		{
			name: '关闭头像：忽略来源，统一返回内置默认头像',
			enabled: false,
			source: 'custom',
			customUrl: CUSTOM,
			email: '12345@qq.com',
			author: '张三',
			expect: DEFAULT_AVATAR_URL,
		},
		{
			name: '关闭头像：未知来源同样返回内置默认头像',
			enabled: false,
			source: 'github',
			customUrl: '',
			email: 'a@b.c',
			author: 'x',
			expect: DEFAULT_AVATAR_URL,
		},
	],
};

const output = path.join(__dirname, '..', 'doc', 'vectors', 'avatar-v1.json');
fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log(`wrote ${output}`);
