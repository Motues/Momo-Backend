/**
 * 后台「表情设置」的纯逻辑（契约 v3）：常量、开关归一化、地址列表校验、OwO 形状校验与在线校验。
 *
 * 唯一事实来源是 `doc/emoji.md`：本站不再存储任何表情内容，评论区只有一个
 * 「启用开关 + 一组 OwO 格式地址（owo.json 同构，最多 5 个）」，由访客浏览器直接拉取
 * 并按数组顺序拼接合并。这里的规则与后端三端（Node / Go / Worker）一致，
 * 口径由 `doc/vectors/emoji-v3.json` 钉死。
 *
 * 在线校验只是给管理员的**护栏**，不是安全边界：地址由管理员自己填写，
 * 服务端刻意不抓取第三方地址（避免 SSRF 与保存延迟）。
 */

/** 默认表情来源（OwO 格式，见 doc/emoji.md 第 2 节） */
export const DEFAULT_EMOJI_CDN_URL = 'https://open.motues.top/emoji/owo.json';

/** 地址长度上限（Unicode 码点，与后端一致） */
export const EMOJI_MAX_CDN_URL_LENGTH = 500;

/** 地址个数上限（契约 v3） */
export const EMOJI_MAX_CDN_URLS = 5;

/** 面板侧「来源过多」的提示文案（与后端 `emoji_cdn_urls 最多 5 个地址` 是两层口径） */
export const EMOJI_TOO_MANY_SOURCES = `最多只能配置 ${EMOJI_MAX_CDN_URLS} 个表情来源`;

/** 面板侧文案：地址不合法（列表编辑器的通用提示） */
export const EMOJI_SOURCE_INVALID = '请输入合法的 http/https 地址';

/** 面板侧文案：地址重复（trim 后精确匹配） */
export const EMOJI_SOURCE_DUPLICATE = '该地址已在列表中';

/** owo.json 里 `type` 的合法取值；缺省按 image 处理 */
export const EMOJI_TYPES = ['emoji', 'emoticon', 'image'];

/** 在线校验的超时时间：8 秒（每条地址独立计时） */
const EMOJI_CHECK_TIMEOUT_MS = 8000;

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;

/** 码点长度（`😂` 算 1 个，不是 2 个 UTF-16 码元） */
export function codePointLength(value) {
	return [...String(value ?? '')].length;
}

/**
 * 归一化 `emoji_enabled`：trim + 转小写。
 * 只认 `true` / `false`，其余（含空串与无法识别的值）返回空串 —— 由调用方决定 fail-open。
 */
export function normalizeEmojiEnabled(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return normalized === 'true' || normalized === 'false' ? normalized : '';
}

/**
 * 校验单个 `emoji_cdn_url`。返回错误文案，空串表示通过。
 *
 * - trim 后为空 → 通过（等价于「未配置」，读取时回落默认源；关闭表情请用 emoji_enabled）
 * - 否则必须是 `^https?://[^"<>]+$`（大小写不敏感）且不超过 500 码点
 */
export function validateCdnUrl(raw) {
	const url = String(raw ?? '').trim();
	if (url === '') return '';
	if (codePointLength(url) > EMOJI_MAX_CDN_URL_LENGTH) {
		return `地址不能超过 ${EMOJI_MAX_CDN_URL_LENGTH} 个字符`;
	}
	if (!CDN_URL_RE.test(url)) return '只允许 http/https 地址';
	return '';
}

/**
 * 读取路径（宽容）解析 `emoji_cdn_urls`：容错规则同 `doc/emoji.md` 第 3.2 节。
 *
 * 非字符串项丢弃、字符串项 trim 后为空的丢弃、结果按顺序截断到前 5 个；
 * 空值 / 非法 JSON / 不是数组一律返回 `[]`。
 */
export function parseEmojiCdnUrls(raw) {
	const text = String(raw ?? '').trim();
	if (text === '') return [];

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const list = [];
	for (const item of parsed) {
		if (typeof item !== 'string') continue;
		const url = item.trim();
		if (url === '') continue;
		list.push(url);
		if (list.length >= EMOJI_MAX_CDN_URLS) break;
	}
	return list;
}

/**
 * 读取路径的回落链（`doc/emoji.md` 第 3.2 节）：
 * `emoji_cdn_urls` 为空 → 旧的单地址 `emoji_cdn_url` → 默认源。
 */
export function resolveEmojiCdnUrls(rawUrls, legacyUrl) {
	const urls = parseEmojiCdnUrls(rawUrls);
	if (urls.length > 0) return urls;

	const legacy = String(legacyUrl ?? '').trim();
	return [legacy === '' ? DEFAULT_EMOJI_CDN_URL : legacy];
}

/** 把多行文本拆成地址列表：按行拆分、trim、丢弃空行（顺序保持） */
export function parseCdnUrlText(text) {
	return String(text ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

/** 地址列表 → 多行文本（与 `parseCdnUrlText` 互逆） */
export function formatCdnUrlText(list) {
	return (Array.isArray(list) ? list : []).join('\n');
}

/**
 * 校验地址列表：超过 5 个 → `最多只能配置 5 个表情来源`；
 * 否则逐条走 `validateCdnUrl`，第一条不合格的返回 `第 k 条：<原因>`（单条时直接返回原因）。
 * 返回空串表示通过。
 */
export function validateCdnUrls(list) {
	const urls = Array.isArray(list) ? list : parseCdnUrlText(list);
	if (urls.length > EMOJI_MAX_CDN_URLS) return EMOJI_TOO_MANY_SOURCES;

	for (let index = 0; index < urls.length; index += 1) {
		const error = validateCdnUrl(urls[index]);
		if (error) return urls.length > 1 ? `第 ${index + 1} 条：${error}` : error;
	}
	return '';
}

/**
 * 往来源列表里加一个地址（「表情来源」列表编辑器用）。返回 `{ list, error }`：
 * - 输入 trim 后为空 → 原样返回、无错误（调用方自行决定是否清空输入框）；
 * - 不合法（`validateCdnUrl` 不通过）→ 协议错误统一成 `EMOJI_SOURCE_INVALID`，
 *   其余（如超长）沿用 `validateCdnUrl` 的具体文案；
 * - 重复（trim 后精确匹配）→ `EMOJI_SOURCE_DUPLICATE`；
 * - 已达 5 个 → `EMOJI_TOO_MANY_SOURCES`。
 *
 * 成功时返回**新数组**（不做原地修改，便于 Vue 响应式与测试断言）。
 * 与 `addAdminEmail`（`utils/emails.js`）保持同一套写法。
 */
export function addEmojiCdnUrl(list, raw) {
	const current = Array.isArray(list) ? list : [];
	const url = String(raw ?? '').trim();
	if (url === '') return { list: current, error: '' };

	const invalid = validateCdnUrl(url);
	if (invalid) {
		return { list: current, error: invalid === '只允许 http/https 地址' ? EMOJI_SOURCE_INVALID : invalid };
	}
	if (current.some((item) => String(item ?? '').trim() === url)) {
		return { list: current, error: EMOJI_SOURCE_DUPLICATE };
	}
	if (current.length >= EMOJI_MAX_CDN_URLS) return { list: current, error: EMOJI_TOO_MANY_SOURCES };
	return { list: [...current, url], error: '' };
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验单个表情项，返回错误文案或空串 */
function validateOwoItem(item, tabName, index) {
	const at = `标签「${tabName}」第 ${index + 1} 项`;
	if (!isPlainObject(item)) return `${at}不是对象`;
	if (typeof item.icon !== 'string' || item.icon.trim() === '') return `${at}缺少 icon`;
	return '';
}

/** 校验单个标签，返回错误文案或空串 */
function validateOwoTab(tab, tabName) {
	if (!isPlainObject(tab)) return `标签「${tabName}」不是对象`;
	if (!Array.isArray(tab.container)) return `标签「${tabName}」的 container 不是数组`;
	if (tab.type !== undefined && !EMOJI_TYPES.includes(tab.type)) {
		return `标签「${tabName}」的 type 不支持`;
	}
	for (let index = 0; index < tab.container.length; index += 1) {
		const error = validateOwoItem(tab.container[index], tabName, index);
		if (error) return error;
	}
	return '';
}

/**
 * 校验**已 JSON.parse 的值**是不是 owo.json（doc/emoji.md 第 4 节）。
 *
 * 返回 `{ ok: true, tabs, items }` 或 `{ ok: false, reason }`：
 * - `tabs`  = 合格标签数（至少 1 个才算通过）
 * - `items` = 合格标签里的表情项总数
 *
 * 不合格的标签被整体忽略（不计入 tabs/items）；一个都不合格时给出第一条具体原因。
 */
export function validateOwoSource(payload) {
	if (!isPlainObject(payload)) {
		return { ok: false, reason: '不是 owo.json：顶层必须是「标签名 → 包」的对象' };
	}

	const entries = Object.entries(payload);
	if (entries.length === 0) return { ok: false, reason: '没有可用的标签' };

	let tabs = 0;
	let items = 0;
	let firstReason = '';

	for (const [tabName, tab] of entries) {
		const error = validateOwoTab(tab, tabName);
		if (error) {
			if (!firstReason) firstReason = error;
			continue;
		}
		tabs += 1;
		items += tab.container.length;
	}

	if (tabs === 0) return { ok: false, reason: firstReason || '没有可用的标签' };
	return { ok: true, tabs, items };
}

function errorMessage(error) {
	if (error instanceof Error && error.message) return error.message;
	return String(error ?? '未知错误');
}

/**
 * 在线校验**单条**地址（浏览器直接 fetch，不经过本站）。
 *
 * 三种结果：
 * - `{ status: 'ok', tabs, items }`      —— 拿到了合法的 owo.json
 * - `{ status: 'invalid', reason }`      —— 拉取成功但不是 owo 形状 / 不是合法 JSON
 * - `{ status: 'unreachable', reason }`  —— fetch 抛错、超时或非 2xx（网络 / 跨域被拦）
 */
async function checkSingleOwoSource(url, fetchImpl) {
	const target = String(url ?? '').trim();
	if (target === '') return { status: 'unreachable', reason: '地址为空，无法在线校验' };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EMOJI_CHECK_TIMEOUT_MS);

	let response;
	try {
		response = await fetchImpl(target, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			signal: controller.signal,
		});
	} catch (error) {
		return { status: 'unreachable', reason: `无法访问该地址：${errorMessage(error)}` };
	} finally {
		clearTimeout(timer);
	}

	if (!response || response.ok !== true) {
		const status = Number(response?.status);
		return {
			status: 'unreachable',
			reason: status ? `地址返回 HTTP ${status}` : '无法访问该地址',
		};
	}

	let text;
	try {
		text = await response.text();
	} catch (error) {
		return { status: 'unreachable', reason: `读取响应失败：${errorMessage(error)}` };
	}

	let payload;
	try {
		payload = JSON.parse(String(text ?? ''));
	} catch {
		return { status: 'invalid', reason: '返回的内容不是合法 JSON' };
	}

	const result = validateOwoSource(payload);
	if (!result.ok) return { status: 'invalid', reason: result.reason };
	return { status: 'ok', tabs: result.tabs, items: result.items };
}

/**
 * 在线校验**一组**地址（契约 v3，`doc/emoji.md` 第 4 节）：每条地址独立判定后聚合。
 *
 * 四种结果：
 * - `{ status: 'ok', sources, tabs, items }`  —— 全部通过（tabs/items 是各来源之和）
 * - `{ status: 'invalid', index, reason }`    —— 第 `index` 条（1 起）明确不是 owo.json，**阻止保存**
 * - `{ status: 'unreachable', index, reason }`—— 第 `index` 条拉取失败（网络 / 跨域），仅提示，仍可保存
 * - 空列表 → `{ status: 'unreachable', index: 0, reason }`
 *
 * 多条里既有 invalid 又有 unreachable 时，**invalid 优先**（它是唯一会阻止保存的结果）。
 * 故意不在 err 路径里弹 toast：提示由页面决定。
 *
 * 为兼容旧调用点，也接受单个 URL 字符串（等价于单元素数组）。
 */
export async function checkOwoSource(urls, fetchImpl = globalThis.fetch) {
	const list = (Array.isArray(urls) ? urls : [urls])
		.map((url) => String(url ?? '').trim())
		.filter((url) => url !== '');
	if (list.length === 0) {
		return { status: 'unreachable', index: 0, reason: '地址为空，无法在线校验' };
	}

	// 并发拉取（顺序由 results 保证），避免 N 个来源串行超时叠加
	const results = await Promise.all(list.map((url) => checkSingleOwoSource(url, fetchImpl)));

	let sources = 0;
	let tabs = 0;
	let items = 0;
	let invalid = null;
	let unreachable = null;

	results.forEach((result, position) => {
		const index = position + 1;
		if (result.status === 'ok') {
			sources += 1;
			tabs += result.tabs;
			items += result.items;
		} else if (result.status === 'invalid') {
			if (!invalid) invalid = { index, reason: result.reason };
		} else if (!unreachable) {
			unreachable = { index, reason: result.reason };
		}
	});

	if (invalid) return { status: 'invalid', index: invalid.index, reason: invalid.reason };
	if (unreachable) return { status: 'unreachable', index: unreachable.index, reason: unreachable.reason };
	return { status: 'ok', sources, tabs, items };
}
