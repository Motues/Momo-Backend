/**
 * 后台「表情设置」的纯逻辑（契约 v2）：常量、开关归一化、地址校验、OwO 形状校验与在线校验。
 *
 * 唯一事实来源是 `doc/emoji.md`：本站不再存储任何表情内容，评论区只有一个
 * 「启用开关 + 一个 OwO 格式地址（owo.json 同构）」，由访客浏览器直接拉取。
 * 这里的规则与后端三端（Node / Go / Worker）一致，口径由 `doc/vectors/emoji-v2.json` 钉死。
 *
 * 在线校验只是给管理员的**护栏**，不是安全边界：地址由管理员自己填写，
 * 服务端刻意不抓取第三方地址（避免 SSRF 与保存延迟）。
 */

/** 默认表情来源（OwO 格式，见 doc/emoji.md 第 2 节） */
export const DEFAULT_EMOJI_CDN_URL = 'https://open.motues.top/emoji/owo.json';

/** 地址长度上限（Unicode 码点，与后端一致） */
export const EMOJI_MAX_CDN_URL_LENGTH = 500;

/** owo.json 里 `type` 的合法取值；缺省按 image 处理 */
export const EMOJI_TYPES = ['emoji', 'emoticon', 'image'];

/** 在线校验的超时时间：8 秒 */
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
 * 校验 `emoji_cdn_url`。返回错误文案，空串表示通过。
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
 * 在线校验地址（浏览器直接 fetch，不经过本站）。
 *
 * 三种结果：
 * - `{ status: 'ok', tabs, items }`      —— 拿到了合法的 owo.json
 * - `{ status: 'invalid', reason }`      —— 拉取成功但不是 owo 形状 / 不是合法 JSON
 * - `{ status: 'unreachable', reason }`  —— fetch 抛错、超时或非 2xx（网络 / 跨域被拦）
 *
 * 刻意不在这里弹 toast：提示由页面决定。
 */
export async function checkOwoSource(url, fetchImpl = globalThis.fetch) {
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
