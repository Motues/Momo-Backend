import { Bindings } from '../bindings';
import { getSetting } from './settings';
import {
	EMOJI_CDN_URLS_KEY,
	EMOJI_CDN_URL_KEY,
	EMOJI_ENABLED_KEY,
	resolveEmojiSettings,
} from './emoji';

/**
 * 通知邮件的服务端短代码水合（邮件专用，见 `doc/mail.md` 第 4 节）。
 *
 * 评论区的表情由**访客浏览器**拉取 owo.json 后水合；邮件没有浏览器，所以发信路径
 * 自己按解析后的 `emoji_cdn_urls` 拉一次（单次 3 秒超时、响应体上限 1 MiB、
 * 10 分钟模块级缓存），合并后按**与前端完全一致**的规则推导短代码
 * （`doc/emoji.md` 第 5 节），再把正文文本节点里的 `:name:` 换成内联小图。
 *
 * 失败一律降级为纯文本：短代码原样保留，邮件照常发出。`emoji_enabled = "false"` 时不水合。
 */

/** 单次拉取超时 */
export const EMOJI_FETCH_TIMEOUT_MS = 3000;
/** 响应体上限（超出即放弃该来源） */
export const EMOJI_MAX_RESPONSE_BYTES = 1024 * 1024;
/** 模块级缓存 TTL（按地址列表做键） */
export const EMOJI_HYDRATION_CACHE_TTL_MS = 10 * 60 * 1000;

/** 注入的图片标签（与前端水合器同款样式） */
export const EMOJI_IMG_STYLE =
	'max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;';

const SHORTCODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATA_ICON_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const REMOTE_ICON_RE = /^https:\/\/[^"<>]+$/;
const IMG_TAG_RE = /^<img\s+src="([^"<>]+)"\s*\/?>$/;
/** 与前端 `EMOJI_MAX_REMOTE_URL` 一致 */
const MAX_REMOTE_URL_LENGTH = 2048;

const TEXT_PACK_TYPES = new Set(['emoji', 'emoticon']);
/** 这些标签内部不替换（与前端水合器一致） */
const SKIP_TAGS = new Set(['code', 'pre', 'script', 'style', 'textarea']);
/** 自闭合 / 空元素，不进入标签栈 */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export interface OwoItem {
	icon: string;
	text: string;
}

export interface OwoPack {
	type?: string;
	container: OwoItem[];
}

export type OwoPacks = Record<string, OwoPack>;

/** FNV-1a 32 位哈希（十六进制，8 位）。与前端 `fnv1aHex` 逐位一致。 */
export function fnv1aHex(text: string): string {
	let hash = 0x811c9dc5;
	const value = String(text ?? '');
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** 文案 → 合法短代码；无法归一化时返回空串（与前端 `normalizeShortcode` 一致） */
export function normalizeShortcode(label: unknown): string {
	const normalized = String(label ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	return SHORTCODE_NAME_RE.test(normalized) ? normalized : '';
}

/**
 * 从 `image` 项的 icon 里取出安全的图片地址（与前端 `safeImageUrl` 同口径）：
 * 只有 `<img src="…">` 形式、且地址是 `https://…` 或
 * `data:image/{png,jpeg,gif,webp};base64,…` 才返回，其余一律丢弃。
 */
export function safeEmojiImageUrl(icon: unknown): string {
	const matched = IMG_TAG_RE.exec(String(icon ?? ''));
	if (!matched) return '';
	const url = matched[1];

	const dataIcon = DATA_ICON_RE.exec(url);
	if (dataIcon) return `data:${dataIcon[1]};base64,${dataIcon[2]}`;

	if (REMOTE_ICON_RE.test(url) && [...url].length <= MAX_REMOTE_URL_LENGTH) return url;

	return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按数组顺序合并多个 owo 来源（`doc/emoji.md` 第 3.3 节）：
 *  - 顶层标签按「首次出现」的顺序排列；
 *  - 不同来源出现同名标签时，后面的来源把 `container` **追加**进先出现的那个标签。
 * 结构不正确的来源/标签/项直接丢弃（脏数据绝不进入渲染路径）。
 */
export function mergeOwoSources(sources: unknown[]): OwoPacks {
	const merged: OwoPacks = {};

	for (const source of sources) {
		if (!isPlainObject(source)) continue;
		for (const [label, pack] of Object.entries(source)) {
			if (!isPlainObject(pack)) continue;
			const container: OwoItem[] = [];
			if (Array.isArray(pack.container)) {
				for (const item of pack.container) {
					if (!isPlainObject(item)) continue;
					if (typeof item.icon !== 'string' || item.icon === '') continue;
					container.push({
						icon: item.icon,
						text: typeof item.text === 'string' ? item.text : '',
					});
				}
			}

			const existing = merged[label];
			if (existing) {
				existing.container.push(...container);
				continue;
			}
			merged[label] = {
				type: typeof pack.type === 'string' ? pack.type : 'image',
				container,
			};
		}
	}

	return merged;
}

/**
 * 构建「短代码 → 图片地址」映射，推导规则与前端 `buildEmojiSet` 完全一致：
 *  - 只处理 `image` 项（`type` 为 `emoji`/`emoticon` 的标签是文本，跳过）；
 *  - `text` 归一化合法就用它，否则 `e-<FNV-1a 32 位 8 位十六进制>`；
 *  - 同标签内重名、或与更靠前的标签重名时追加 `-2` / `-3`……。
 */
export function buildEmojiImageMap(packs: OwoPacks): Map<string, string> {
	const images = new Map<string, string>();

	for (const pack of Object.values(packs ?? {})) {
		if (TEXT_PACK_TYPES.has(String(pack?.type ?? 'image'))) continue;
		for (const item of pack?.container ?? []) {
			const url = safeEmojiImageUrl(item.icon);
			if (!url) continue;

			let name = normalizeShortcode(item.text) || `e-${fnv1aHex(url)}`;
			if (images.has(name)) {
				let suffix = 2;
				while (images.has(`${name}-${suffix}`)) suffix += 1;
				name = `${name}-${suffix}`;
			}
			images.set(name, url);
		}
	}

	return images;
}

/* ------------------------------- HTML 水合 ------------------------------- */

interface HtmlToken {
	type: 'tag' | 'text';
	value: string;
}

/** 把 HTML 切成「标签 / 文本」两类 token（标签内的属性值不会被当成文本） */
function tokenizeHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	let index = 0;

	while (index < html.length) {
		const lt = html.indexOf('<', index);
		if (lt < 0) {
			tokens.push({ type: 'text', value: html.slice(index) });
			break;
		}
		if (lt > index) tokens.push({ type: 'text', value: html.slice(index, lt) });

		let end: number;
		if (html.startsWith('<!--', lt)) {
			const close = html.indexOf('-->', lt + 4);
			end = close < 0 ? html.length : close + 3;
		} else {
			let cursor = lt + 1;
			let quote = '';
			while (cursor < html.length) {
				const char = html[cursor];
				if (quote) {
					if (char === quote) quote = '';
				} else if (char === '"' || char === "'") {
					quote = char;
				} else if (char === '>') {
					cursor += 1;
					break;
				}
				cursor += 1;
			}
			end = cursor;
		}

		tokens.push({ type: 'tag', value: html.slice(lt, end) });
		index = end;
	}

	return tokens;
}

function tagName(tag: string): string {
	const matched = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
	return matched ? matched[1].toLowerCase() : '';
}

function imgTag(url: string, name: string): string {
	return `<img src="${url}" alt=":${name}:" title=":${name}:" style="${EMOJI_IMG_STYLE}">`;
}

/**
 * 只在文本节点上把 `:name:` 换成 `<img>`（映射里没有的名字原样保留）。
 * 边界规则与前端一致：名称前一个字符不能是字母/数字、后一个字符不能是数字。
 */
function replaceShortcodesInText(text: string, images: Map<string, string>): string {
	if (text.indexOf(':') < 0) return text;

	let output = '';
	let last = 0;
	let index = 0;

	while (index < text.length) {
		const start = text.indexOf(':', index);
		if (start < 0) break;
		const end = text.indexOf(':', start + 1);
		if (end < 0) break;

		const name = text.slice(start + 1, end);
		const url = images.get(name);
		const before = start > 0 ? text[start - 1] : '';
		const after = end + 1 < text.length ? text[end + 1] : '';

		if (url && SHORTCODE_NAME_RE.test(name) && !/[0-9a-z]/i.test(before) && !/[0-9]/.test(after)) {
			output += text.slice(last, start) + imgTag(url, name);
			last = end + 1;
			index = end + 1;
		} else {
			index = start + 1;
		}
	}

	return output === '' ? text : output + text.slice(last);
}

/**
 * 短代码水合：只在**文本节点**上替换；`<code>` / `<pre>` / `<script>` / `<style>` /
 * `<textarea>` 内部不替换。映射为空时原样返回。
 */
export function hydrateShortcodesInHtml(html: string, images: Map<string, string>): string {
	if (!html || images.size === 0) return html;

	const output: string[] = [];
	const stack: string[] = [];
	const blocked = () => stack.some((name) => SKIP_TAGS.has(name));

	for (const token of tokenizeHtml(html)) {
		if (token.type === 'tag') {
			const name = tagName(token.value);
			if (name) {
				if (token.value.startsWith('</')) {
					const at = stack.lastIndexOf(name);
					if (at >= 0) stack.length = at;
				} else if (!token.value.endsWith('/>') && !VOID_TAGS.has(name)) {
					stack.push(name);
				}
			}
			output.push(token.value);
			continue;
		}
		output.push(blocked() ? token.value : replaceShortcodesInText(token.value, images));
	}

	return output.join('');
}

/* ------------------------------ 拉取与缓存 ------------------------------- */

type FetchLike = (input: string, init?: any) => Promise<Response>;

/** 读取响应体并施加 1 MiB 上限（超出返回 null） */
async function readCappedBody(response: Response): Promise<string | null> {
	const declared = Number(response.headers?.get?.('content-length') ?? '');
	if (Number.isFinite(declared) && declared > EMOJI_MAX_RESPONSE_BYTES) return null;

	const body = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
	if (body && typeof (body as any).getReader === 'function') {
		const reader = (body as any).getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > EMOJI_MAX_RESPONSE_BYTES) {
					try {
						await reader.cancel();
					} catch {
						/* ignore */
					}
					return null;
				}
				chunks.push(value);
			}
		} finally {
			try {
				reader.releaseLock?.();
			} catch {
				/* ignore */
			}
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(merged);
	}

	const text = await response.text();
	return new TextEncoder().encode(text).byteLength > EMOJI_MAX_RESPONSE_BYTES ? null : text;
}

/** 拉取单个 owo.json；失败 / 超时 / 超限 / 非 JSON 一律返回 null（只丢这一个来源） */
async function fetchOwoSource(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		try {
			controller.abort();
		} catch {
			/* ignore */
		}
	}, EMOJI_FETCH_TIMEOUT_MS);

	try {
		const response = await fetchImpl(url, {
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});
		if (!response || !response.ok) return null;
		const body = await readCappedBody(response);
		if (body === null) return null;
		return JSON.parse(body);
	} catch (error) {
		console.warn('[emailEmoji] 表情来源拉取失败，已降级为纯文本:', url, error);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

interface CacheEntry {
	expiresAt: number;
	images: Map<string, string>;
}

/** 模块级缓存：键是**整个地址列表**的规范化 JSON（与前端缓存键同思路） */
const imageMapCache = new Map<string, CacheEntry>();

/** 测试用：清掉模块级缓存 */
export function resetEmailEmojiCache(): void {
	imageMapCache.clear();
}

async function loadImageMap(urls: string[], fetchImpl: FetchLike): Promise<Map<string, string>> {
	const key = JSON.stringify(urls);
	const now = Date.now();
	const cached = imageMapCache.get(key);
	if (cached && cached.expiresAt > now) return cached.images;

	// 并发拉取、按地址顺序合并（顺序决定同名标签/同名短代码的归属）
	const sources = await Promise.all(urls.map((url) => fetchOwoSource(url, fetchImpl)));
	const succeeded = sources.filter((source) => source !== null);
	const images = buildEmojiImageMap(mergeOwoSources(succeeded));

	// 全部来源失败时不写缓存：短代码降级为文字，但下一个请求仍有机会拉到表情
	if (succeeded.length > 0) {
		imageMapCache.set(key, { expiresAt: now + EMOJI_HYDRATION_CACHE_TTL_MS, images });
	}
	return images;
}

/**
 * 按当前设置水合一段（已净化的）评论 HTML。
 *
 * 任何失败（设置读取、拉取、解析）都只是让短代码保持文字，绝不抛错 —— 邮件必须照常发出。
 * `emoji_enabled = "false"` 时不水合（与评论区一致）。
 */
export async function hydrateEmojiHtml(
	env: Bindings,
	html: string,
	options: { fetchImpl?: FetchLike } = {}
): Promise<string> {
	if (!html) return html;

	try {
		const [storedUrls, storedUrl, storedEnabled] = await Promise.all([
			getSetting(env, EMOJI_CDN_URLS_KEY),
			getSetting(env, EMOJI_CDN_URL_KEY),
			getSetting(env, EMOJI_ENABLED_KEY),
		]);
		const config = resolveEmojiSettings(storedUrls, storedUrl, storedEnabled);
		if (config.enabled === 'false') return html;

		const fetchImpl: FetchLike =
			options.fetchImpl ?? ((input, init) => (globalThis.fetch as FetchLike)(input, init));
		const images = await loadImageMap(config.urls, fetchImpl);
		return hydrateShortcodesInHtml(html, images);
	} catch (error) {
		console.warn('[emailEmoji] 表情水合失败，已降级为纯文本:', error);
		return html;
	}
}
