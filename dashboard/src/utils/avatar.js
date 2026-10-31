/**
 * 评论区头像来源（契约 v1）的面板侧常量与校验。
 *
 * 与后端 `doc/avatar.md` / `doc/vectors/avatar-v1.json` 保持同一口径：
 * 来源取值、预设模板、占位符与八条错误文案都要逐字一致。
 * 这里只做「保存前」的即时提示；最终判定仍以后端为准。
 */

export const AVATAR_ENABLED_KEY = 'avatar_enabled';
export const AVATAR_SOURCE_KEY = 'avatar_source';
export const AVATAR_CUSTOM_URL_KEY = 'avatar_custom_url';

export const DEFAULT_AVATAR_ENABLED = 'true';
export const DEFAULT_AVATAR_SOURCE = 'default';
export const DEFAULT_AVATAR_CUSTOM_URL = '';

/** 关闭头像后统一下发的默认头像（与后端 / 向量逐字一致） */
export const DEFAULT_AVATAR_URL =
	'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIzMiIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjQiIHI9IjExIiBmaWxsPSIjOWNhM2FmIi8+PHBhdGggZD0iTTEzIDU3YzAtMTAuNSA4LjUtMTkgMTktMTlzMTkgOC41IDE5IDE5IiBmaWxsPSIjOWNhM2FmIi8+PC9zdmc+';

export const AVATAR_URL_MAX_LENGTH = 500;

export const AVATAR_SOURCES = ['default', 'gravatar', 'cravatar', 'qq', 'custom'];

/** 预设模板（custom 由管理员提供） */
export const AVATAR_TEMPLATES = {
	default: 'https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam',
	gravatar: 'https://gravatar.com/avatar/{hash}?s=200&d=identicon',
	cravatar: 'https://cravatar.cn/avatar/{hash}?s=200&d=identicon',
	qq: 'https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100',
};

export const AVATAR_PLACEHOLDERS = ['{hash}', '{email}', '{author}', '{qq}'];

export const AVATAR_ERRORS = {
	notString: 'avatar_custom_url 必须是字符串',
	badSource: 'avatar_source 只能是 default / gravatar / cravatar / qq / custom',
	badScheme: 'avatar_custom_url 只允许 http/https 地址',
	tooLong: `avatar_custom_url 不能超过 ${AVATAR_URL_MAX_LENGTH} 个字符`,
	controlChar: 'avatar_custom_url 不能包含控制字符',
	badPlaceholder: 'avatar_custom_url 包含不支持的占位符',
	emptyCustom: '选择自定义头像来源时必须填写头像地址',
	badEnabled: 'avatar_enabled 只能是 true 或 false',
};

/** 来源展示信息（面板卡片文案） */
export const AVATAR_SOURCE_OPTIONS = [
	{
		value: 'default',
		label: '内置默认源',
		hint: '与历史行为一致：open.motues.top 的 Cravatar + beam 变体',
	},
	{
		value: 'gravatar',
		label: 'Gravatar',
		hint: 'gravatar.com 官方头像服务',
	},
	{
		value: 'cravatar',
		label: 'Cravatar',
		hint: 'cravatar.cn（国内可访问的 Gravatar 镜像）',
	},
	{
		value: 'qq',
		label: 'QQ 邮箱头像',
		hint: '仅对「数字@qq.com」生效，其它邮箱自动回落内置默认源',
	},
	{
		value: 'custom',
		label: '自定义地址模板',
		hint: '自己填写 URL 模板，支持 {hash} / {email} / {author} / {qq}',
	},
];

export function normalizeAvatarSource(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return AVATAR_SOURCES.includes(normalized) ? normalized : DEFAULT_AVATAR_SOURCE;
}

/** 开关归一化（写入用）：trim + 小写；空串表示「未配置」 */
export function normalizeAvatarEnabled(value) {
	return String(value ?? '').trim().toLowerCase();
}

/** 读取：只有明确 "false" 才算关闭，其余 fail-open 为开启 */
export function isAvatarEnabled(value) {
	return normalizeAvatarEnabled(value) !== 'false';
}

export function validateAvatarEnabled(value) {
	const normalized = normalizeAvatarEnabled(value);
	if (normalized === '' || normalized === 'true' || normalized === 'false') return '';
	return AVATAR_ERRORS.badEnabled;
}

export function validateAvatarSource(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (normalized === '' || AVATAR_SOURCES.includes(normalized)) return '';
	return AVATAR_ERRORS.badSource;
}

export function normalizeAvatarCustomUrl(value) {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * 模板校验：空串合法（未配置）。校验顺序与后端一致：
 * trim → 控制字符 → 协议 → 长度 → 占位符。
 */
export function validateAvatarCustomUrl(value) {
	if (value === null || value === undefined) return '';
	if (typeof value !== 'string') return AVATAR_ERRORS.notString;
	const trimmed = value.trim();
	if (trimmed === '') return '';
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return AVATAR_ERRORS.controlChar;
	if (!/^https?:\/\//i.test(trimmed)) return AVATAR_ERRORS.badScheme;
	if ([...trimmed].length > AVATAR_URL_MAX_LENGTH) return AVATAR_ERRORS.tooLong;
	for (const token of trimmed.match(/\{[^{}]*\}/g) ?? []) {
		if (!AVATAR_PLACEHOLDERS.includes(token)) {
			return `${AVATAR_ERRORS.badPlaceholder}：${token}`;
		}
	}
	return '';
}

/** 跨键约束：来源为 custom 时必须有模板 */
export function validateAvatarSettings({ enabled, source, customUrl }) {
	if (enabled !== undefined) {
		const enabledError = validateAvatarEnabled(enabled);
		if (enabledError) return enabledError;
	}
	const sourceError = validateAvatarSource(source);
	if (sourceError) return sourceError;
	const customError = validateAvatarCustomUrl(customUrl);
	if (customError) return customError;
	if (normalizeAvatarSource(source) === 'custom' && normalizeAvatarCustomUrl(customUrl) === '') {
		return AVATAR_ERRORS.emptyCustom;
	}
	return '';
}

/**
 * 用示例值替换占位符，便于在面板里直观看到最终形态。
 * （真实哈希由后端计算，这里只展示结构。）
 */
export function avatarPreview(template, { hash = '5d60d4e28066df254d5452f92c910092', qq = '12345' } = {}) {
	if (typeof template !== 'string' || template.trim() === '') return '';
	return template
		.trim()
		.replace(/\{hash\}/g, hash)
		.replace(/\{email\}/g, 'test%40example.com')
		.replace(/\{author\}/g, '%E5%BC%A0%E4%B8%89')
		.replace(/\{qq\}/g, qq);
}
