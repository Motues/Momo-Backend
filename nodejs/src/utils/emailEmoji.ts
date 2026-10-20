/**
 * 通知邮件里的表情水合（服务端）。
 *
 * 评论区的表情由**访客浏览器**拉 owo.json 后水合；邮件没有浏览器，所以发信路径自己拉一次，
 * 把 `:name:` 短代码替换成 `<img>`。口径的唯一事实来源是 `doc/mail.md` 第 4 节：
 *  - 按 `emoji_cdn_urls` 顺序拉取（单次 3 秒超时、响应体 ≤1 MiB、内存缓存 10 分钟）；
 *  - 短代码推导与前端**完全一致**（`text` 归一化优先，否则 `e-<FNV-1a 8hex>`，重名追加 `-2`/`-3`）；
 *  - 只在文本节点替换，`<code>` / `<pre>` / `<script>` / `<style>` / `<textarea>` 内部不替换；
 *  - 图片地址只接受 `https://…` 与 `data:image/{png,jpeg,gif,webp};base64,…`；
 *  - 任何失败都降级为「短代码保持文字」，邮件照常发出。
 */

export const EMOJI_EMAIL_TIMEOUT_MS = 3000;
export const EMOJI_EMAIL_MAX_BYTES = 1024 * 1024;
export const EMOJI_EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;
export const EMOJI_MAX_TEXT_LENGTH = 64;
export const EMOJI_MAX_REMOTE_URL = 2048;

const SHORTCODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATA_ICON_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const REMOTE_ICON_RE = /^https:\/\/[^"<>]+$/;
const IMG_TAG_RE = /^<img\s+src="([^"<>]+)"\s*\/?>$/;

/** 这些标签内部的文本不参与替换（与前端 render.ts 的 SKIP_TAGS 一致） */
const SKIP_TAGS = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);

interface OwoItem {
  icon?: unknown;
  text?: unknown;
}

export function codePointLength(value: unknown): number {
  return [...String(value ?? "")].length;
}

/** FNV-1a 32 位哈希（十六进制，8 位）：与前端 owo.ts 的 fnv1aHex 同口径 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 文案 → 合法短代码；无法归一化时返回空串（与前端同口径） */
export function normalizeShortcode(label: unknown): string {
  const normalized = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return SHORTCODE_NAME_RE.test(normalized) ? normalized : "";
}

/** 从 `image` 项的 icon 里取出安全的图片地址（只放行 https 与 data:image 白名单） */
export function safeImageUrl(icon: unknown): string {
  const matched = IMG_TAG_RE.exec(String(icon ?? ""));
  if (!matched) return "";
  const url = matched[1];

  const dataIcon = DATA_ICON_RE.exec(url);
  if (dataIcon) return `data:${dataIcon[1]};base64,${dataIcon[2]}`;
  if (REMOTE_ICON_RE.test(url) && codePointLength(url) <= EMOJI_MAX_REMOTE_URL) return url;
  return "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一份（或多份已合并的）owo 对象转成「短代码 → 图片地址」映射。
 * 规则与前端 `buildEmojiSet` 一致：只有 `image`（缺省/未知按 image）项参与，
 * 同标签重名或与更靠前的标签重名时追加 `-2`/`-3`……
 */
export function buildShortcodeMap(packs: unknown): Map<string, string> {
  const images = new Map<string, string>();
  if (!isPlainObject(packs)) return images;

  for (const pack of Object.values(packs)) {
    if (!isPlainObject(pack)) continue;
    if (pack.enabled === false) continue;
    const isTextPack = pack.type === "emoji" || pack.type === "emoticon";
    if (isTextPack) continue;
    const container = Array.isArray(pack.container) ? (pack.container as OwoItem[]) : [];

    const used = new Set<string>();
    for (const raw of container) {
      if (!isPlainObject(raw)) continue;
      const url = safeImageUrl(raw.icon);
      if (!url) continue;

      let name = normalizeShortcode(raw.text) || `e-${fnv1aHex(url)}`;
      if (used.has(name) || images.has(name)) {
        let suffix = 2;
        while (used.has(`${name}-${suffix}`) || images.has(`${name}-${suffix}`)) suffix += 1;
        name = `${name}-${suffix}`;
      }
      used.add(name);
      images.set(name, url);
    }
  }
  return images;
}

/** 把多份 owo 对象按顺序合并（同名标签把后面的 container 追加进先出现的那个） */
export function mergeOwoPacks(target: Record<string, any>, incoming: unknown): Record<string, any> {
  if (!isPlainObject(incoming)) return target;
  for (const [label, pack] of Object.entries(incoming)) {
    if (!isPlainObject(pack)) continue;
    const container = Array.isArray(pack.container) ? pack.container.filter(isPlainObject) : [];
    const existing = target[label];
    if (existing && Array.isArray(existing.container)) {
      existing.container = existing.container.concat(container);
    } else {
      target[label] = {
        type: typeof pack.type === "string" ? pack.type : "image",
        enabled: pack.enabled !== false,
        container: [...container],
      };
    }
  }
  return target;
}

/** 扫描文本里的短代码（边界规则与前端 findShortcodes 一致） */
export function findShortcodes(
  text: string,
  limit = Number.POSITIVE_INFINITY
): Array<{ start: number; end: number; name: string }> {
  const matches: Array<{ start: number; end: number; name: string }> = [];
  const value = String(text ?? "");
  let index = 0;

  while (index < value.length && matches.length < limit) {
    const start = value.indexOf(":", index);
    if (start < 0) break;
    const end = value.indexOf(":", start + 1);
    if (end < 0) break;

    const name = value.slice(start + 1, end);
    const before = start > 0 ? value[start - 1] : "";
    const after = end + 1 < value.length ? value[end + 1] : "";
    if (SHORTCODE_NAME_RE.test(name) && !/[0-9a-z]/i.test(before) && !/[0-9]/.test(after)) {
      matches.push({ start, end: end + 1, name });
      index = end + 1;
    } else {
      index = start + 1;
    }
  }
  return matches;
}

/** 邮件里的表情图：内联尺寸 + alt/title 为短代码本身 */
function emojiImgTag(url: string, name: string): string {
  return `<img src="${url}" alt=":${name}:" title=":${name}:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;">`;
}

/** 替换一段纯文本里的短代码（调用方保证它不在 skip 标签内部） */
function hydrateText(text: string, images: Map<string, string>): string {
  const matches = findShortcodes(text).filter((match) => images.has(match.name));
  if (matches.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) out += text.slice(cursor, match.start);
    out += emojiImgTag(images.get(match.name) as string, match.name);
    cursor = match.end;
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/**
 * 把一段 HTML 里的短代码替换成 `<img>`：按标签切分，只处理标签之间的文本，
 * 并跟踪 `code/pre/script/style/textarea` 的嵌套深度跳过其内部。
 * 这是一个**保守的字符串遍历**：不改写任何既有标签，只插入受白名单约束的 img。
 */
export function hydrateEmailEmoji(html: string, images?: Map<string, string> | null): string {
  const source = String(html ?? "");
  if (!images || images.size === 0 || source === "") return source;

  let out = "";
  let cursor = 0;
  let skipDepth = 0;

  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor);
    if (lt < 0) {
      out += skipDepth > 0 ? source.slice(cursor) : hydrateText(source.slice(cursor), images);
      break;
    }
    if (lt > cursor) {
      const text = source.slice(cursor, lt);
      out += skipDepth > 0 ? text : hydrateText(text, images);
    }

    const gt = source.indexOf(">", lt);
    if (gt < 0) {
      // 没有闭合的 `<`：剩下的按普通文本处理，避免吞掉内容
      out += source.slice(lt);
      break;
    }
    const tag = source.slice(lt, gt + 1);
    out += tag;

    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    if (nameMatch && SKIP_TAGS.has(nameMatch[1].toUpperCase())) {
      if (/^<\//.test(tag)) {
        if (skipDepth > 0) skipDepth -= 1;
      } else if (!/\/>$/.test(tag)) {
        skipDepth += 1;
      }
    }
    cursor = gt + 1;
  }
  return out;
}

let cache: { key: string; savedAt: number; images: Map<string, string> } | null = null;

/** 测试用：清掉模块级缓存 */
export function resetEmailEmojiCache(): void {
  cache = null;
}

async function fetchOnePacks(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMOJI_EMAIL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;

    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > EMOJI_EMAIL_MAX_BYTES) return null;

    const text = await res.text();
    if (text.length > EMOJI_EMAIL_MAX_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取并缓存「短代码 → 图片地址」映射。
 * 永不抛错：全部来源都拿不到时返回空 Map（短代码在邮件里保持文字）。
 */
export async function loadEmailEmojiMap(
  urls: string[],
  options: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<Map<string, string>> {
  const list = (Array.isArray(urls) ? urls : []).filter((url) => typeof url === "string" && url.trim() !== "");
  if (list.length === 0) return new Map();

  const key = JSON.stringify(list);
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (cache && cache.key === key && now - cache.savedAt < EMOJI_EMAIL_CACHE_TTL_MS) {
    return cache.images;
  }
  if (typeof fetchImpl !== "function") return new Map();

  const merged: Record<string, any> = {};
  const results = await Promise.all(list.map((url) => fetchOnePacks(url, fetchImpl)));
  for (const packs of results) {
    if (packs) mergeOwoPacks(merged, packs);
  }

  const images = buildShortcodeMap(merged);
  cache = { key, savedAt: now, images };
  return images;
}

/**
 * 把一条评论渲染成邮件正文 HTML：优先用已净化的 `content_html`，缺失时回落纯文本转义。
 * 短代码水合失败（映射为空）时原样返回，绝不抛错。
 */
export function renderEmailContent(
  contentHtml: string | null | undefined,
  contentText: string | null | undefined,
  images?: Map<string, string> | null
): string {
  const html = String(contentHtml ?? "").trim();
  const base = html !== ""
    ? html
    : String(contentText ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r?\n/g, "<br>");
  try {
    return hydrateEmailEmoji(base, images);
  } catch {
    return base;
  }
}
