/**
 * 版本号解析/比较、最新版本查询与本地缓存。
 *
 * 这里刻意不依赖 Vue：纯函数 + fetch + storage，便于直接单测。
 * 查询策略（与使用方约定一致）：
 *   1. 优先 GitHub Releases（最权威，覆盖后端 + 面板 + 组件）
 *   2. 失败回退 jsDelivr 上的 npm 包版本（国内可达性更好）
 *   3. 两者都失败则抛错，由调用方决定是否沿用旧缓存
 */

/** 构建期由 vite define 注入；在未注入的环境（如直接跑源码）回退为 dev 版本 */
export const APP_VERSION = (() => {
	try {
		return __APP_VERSION__;
	} catch {
		return '0.0.0-dev';
	}
})();

export const GITHUB_LATEST_RELEASE_URL =
	'https://api.github.com/repos/Motues/Momo-Backend/releases/latest';
export const FALLBACK_LATEST_VERSION_URL =
	'https://data.jsdelivr.com/v1/packages/npm/@motues/momo-comment/resolved?specifier=latest';
export const RELEASE_PAGE_URL = 'https://github.com/Motues/Momo-Backend/releases';
export const RELEASE_TAG_PAGE_URL = `${RELEASE_PAGE_URL}/tag/`;

/** 检查结果缓存：6 小时内不重复请求 */
export const CACHE_KEY = 'momo_update_check';
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次请求超时：网络不通时不能让面板一直转圈 */
export const REQUEST_TIMEOUT_MS = 6000;

/**
 * 解析版本号。接受 `1.6.1`、`v1.6.1`、`1.6`、`1.6.1-beta.2`。
 * 无法解析时返回 null（调用方据此判定「不是有效版本」而不是当成 0.0.0）。
 */
export function parseVersion(raw) {
	if (typeof raw !== 'string') return null;
	const matched = raw
		.trim()
		.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
	if (!matched) return null;
	return {
		major: Number(matched[1]),
		minor: Number(matched[2] ?? 0),
		patch: Number(matched[3] ?? 0),
		pre: matched[4] ?? '',
	};
}

/** 归一化为 `x.y.z`（可带预发布后缀）；无法解析返回空串 */
export function normalizeVersion(raw) {
	const parsed = parseVersion(raw);
	if (!parsed) return '';
	const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
	return parsed.pre ? `${base}-${parsed.pre}` : base;
}

/** 拼出对应版本的 Release 页面；版本号不可用时退回 Releases 列表 */
export function releaseTagUrl(version) {
	const normalized = normalizeVersion(version);
	return normalized ? `${RELEASE_TAG_PAGE_URL}v${normalized}` : RELEASE_PAGE_URL;
}

/**
 * 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 无法解析的一方按 0.0.0 处理（保证不抛错，也不因脏数据误报有新版本）。
 * 预发布版本小于同号正式版（1.6.1-beta < 1.6.1）。
 */
export function compareVersions(a, b) {
	const left = parseVersion(a) ?? { major: 0, minor: 0, patch: 0, pre: '' };
	const right = parseVersion(b) ?? { major: 0, minor: 0, patch: 0, pre: '' };

	for (const key of ['major', 'minor', 'patch']) {
		if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
	}
	if (left.pre === right.pre) return 0;
	if (!left.pre) return 1;
	if (!right.pre) return -1;
	return left.pre > right.pre ? 1 : -1;
}

/** latest 是否比 current 新；latest 非法时一律返回 false（不误报） */
export function isNewerVersion(latest, current) {
	if (!parseVersion(latest)) return false;
	return compareVersions(latest, current) > 0;
}

/** 读取本地缓存；内容损坏或结构不对时返回 null，不抛错 */
export function readCache(storage) {
	try {
		const raw = storage?.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		if (typeof parsed.latest !== 'string' || !Number.isFinite(parsed.checkedAt)) return null;
		return {
			latest: parsed.latest,
			url: typeof parsed.url === 'string' ? parsed.url : '',
			source: typeof parsed.source === 'string' ? parsed.source : '',
			checkedAt: parsed.checkedAt,
		};
	} catch {
		return null;
	}
}

/** 写入本地缓存；存储被禁用（隐私模式）时静默失败，不能影响渲染 */
export function writeCache(entry, storage) {
	try {
		storage?.setItem(CACHE_KEY, JSON.stringify(entry));
		return true;
	} catch {
		return false;
	}
}

/** 缓存是否仍在有效期内（未过期且时间戳不是未来时间） */
export function isCacheFresh(entry, now = Date.now()) {
	if (!entry || !Number.isFinite(entry.checkedAt)) return false;
	const age = now - entry.checkedAt;
	return age >= 0 && age < CACHE_TTL_MS;
}

/** 带超时的 JSON 请求 */
async function requestJson(url, fetchImpl, timeoutMs) {
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
	try {
		const res = await fetchImpl(url, {
			signal: controller ? controller.signal : undefined,
			headers: { Accept: 'application/json' },
		});
		if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '未知'}`);
		return await res.json();
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const VERSION_SOURCES = [
	{
		name: 'github',
		url: GITHUB_LATEST_RELEASE_URL,
		pick: (data) => ({ version: data?.tag_name, url: data?.html_url }),
	},
	{
		name: 'jsdelivr',
		url: FALLBACK_LATEST_VERSION_URL,
		// jsDelivr 只给版本号；按仓库的 tag 约定拼出对应 Release 页面
		pick: (data) => ({ version: data?.version, url: releaseTagUrl(data?.version) }),
	},
];

/**
 * 查询最新版本：依次尝试各来源，返回第一个成功解析的结果。
 * 全部失败时抛出最后一个错误，由调用方决定是否沿用缓存。
 */
export async function fetchLatestVersion(options = {}) {
	const { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = options;
	if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');

	let lastError = null;
	for (const source of VERSION_SOURCES) {
		try {
			const data = await requestJson(source.url, fetchImpl, timeoutMs);
			const picked = source.pick(data);
			const version = normalizeVersion(picked?.version);
			if (!version) throw new Error('响应中缺少版本号');
			return { version, url: picked.url || RELEASE_PAGE_URL, source: source.name };
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error('检查更新失败');
}
