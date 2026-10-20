package utils

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

/*
服务端短代码水合（邮件专用，见 doc/mail.md 第 4 节）。

评论区的表情由访客浏览器拉取 owo.json 后水合；邮件没有浏览器，所以发信路径自己拉一次：
按解析后的 emoji_cdn_urls 顺序拉取并合并，短代码推导与前端**完全一致**
（doc/emoji.md 第 5 节），再把 :name: 换成内联小图。

任何失败都降级为纯文本（短代码原样保留），邮件照常发出；emoji_enabled = "false" 时完全不水合。
*/

const (
	emailEmojiFetchTimeout = 3 * time.Second
	emailEmojiMaxBodyBytes = 1 << 20 // 1 MiB
	emailEmojiCacheTTL     = 10 * time.Minute
)

var (
	emailEmojiHTTPClient = &http.Client{Timeout: emailEmojiFetchTimeout}

	emailEmojiCacheMu sync.Mutex
	emailEmojiCache   = map[string]emailEmojiCacheEntry{}
)

type emailEmojiCacheEntry struct {
	mapping map[string]string
	expires time.Time
}

// owoTab 一个顶层标签（键就是标签名，键的顺序就是标签栏的顺序）
type owoTab struct {
	Name    string
	Type    string
	Enabled bool
	Items   []owoItem
}

// owoItem 一个表情项。icon / text 按 JS 的 String(value) 语义宽容处理：
// 字符串原样、数字/布尔按字面量当文本、null 与对象/数组当空串 ——
// 一个畸形槽位不该让整份 owo.json 被丢掉（与 Node / Worker 的行为一致）。
type owoItem struct {
	Icon jsonScalar
	Text jsonScalar
}

// jsonScalar 是「按 JS String(value) 语义取值」的字符串标量
type jsonScalar string

func (s *jsonScalar) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		*s = ""
		return nil
	}
	switch text[0] {
	case '"':
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		*s = jsonScalar(value)
		return nil
	case '{', '[':
		// JS 的 String({}) 是 "[object Object]"，这里按「空」处理：
		// 该槽位既不会产出图片地址，也不会参与归一化（都是被丢弃的路径）
		*s = ""
		return nil
	default:
		// 数字 / true / false：按 JSON 字面量当作文本（等价于 JS String(value)）
		*s = jsonScalar(text)
		return nil
	}
}

func (s jsonScalar) String() string { return string(s) }

// 短代码：只匹配小写形式
var reEmojiShortcode = regexp.MustCompile(`:[a-z0-9][a-z0-9-]{0,31}:`)

// 名称推导：结果必须匹配这个形状才直接使用，否则退回 FNV-1a 哈希
var reEmojiShortcodeName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// 把 text 里不属于 [a-z0-9] 的连续字符压成一个 -
var reEmojiNameSeparator = regexp.MustCompile(`[^a-z0-9]+`)

// <img src="…"> 的严格形态（与前端 owo.ts 的 IMG_TAG_RE 逐字一致）
var reEmojiImgSrc = regexp.MustCompile(`^<img\s+src="([^"<>]+)"\s*/?>$`)

// 远程图片地址：只放行小写 https:// 且不含引号/尖括号
var reEmojiRemoteImage = regexp.MustCompile(`^https://[^"<>]+$`)

// 内联 data:image 图片（与前端 owo.ts 的 DATA_ICON_RE 逐字一致）
var reEmojiDataImage = regexp.MustCompile(`^data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$`)

// EmojiMaxRemoteURLLength 远程图片地址的码点上限（与前端 EMOJI_MAX_REMOTE_URL 一致）
const EmojiMaxRemoteURLLength = 2048

// 文本节点内不替换短代码的容器
var emailEmojiSkipElements = map[string]bool{
	"code":     true,
	"pre":      true,
	"script":   true,
	"style":    true,
	"textarea": true,
}

// ---------------------------------------------------------------------------
// 短代码推导（与前端同一函数，doc/emoji.md 第 5 节）
// ---------------------------------------------------------------------------

// EmojiShortcodeFromText 把 image 项的 text 归一化为短代码名；不合法时返回空串。
//
// 规则（与前端 `normalizeShortcode` 逐字一致）：小写化 → 非 [a-z0-9] 的字符替换为 - →
// 压缩连续 - → 去掉首尾 - → 截断到 32 个码点；结果匹配 ^[a-z0-9][a-z0-9-]{0,31}$ 时直接使用。
func EmojiShortcodeFromText(text string) string {
	normalized := strings.ToLower(text)
	normalized = reEmojiNameSeparator.ReplaceAllString(normalized, "-")
	normalized = strings.Trim(normalized, "-")
	normalized = TruncateRunes(normalized, 32)
	if reEmojiShortcodeName.MatchString(normalized) {
		return normalized
	}
	return ""
}

// EmojiHashShortcode 计算 src 的 FNV-1a 32 位哈希，拼成 e-<8 位十六进制>。
//
// 必须与前端 `fnv1aHex` 逐位一致：JS 的 `charCodeAt` 迭代的是 **UTF-16 码元**，
// 每次异或的是 16 位的值（不是逐字节），因此这里也用 utf16.Encode 复刻。
// 刻意不用 SHA-1：水合发生在渲染路径上，需要同步哈希，且非安全上下文里没有 WebCrypto。
func EmojiHashShortcode(src string) string {
	hash := uint32(0x811c9dc5)
	for _, unit := range utf16.Encode([]rune(src)) {
		hash ^= uint32(unit)
		hash *= 0x01000193
	}
	return fmt.Sprintf("e-%08x", hash)
}

// EmojiShortcodeFor 按前端规则推导一个 image 项的短代码。
func EmojiShortcodeFor(text, src string) string {
	if name := EmojiShortcodeFromText(text); name != "" {
		return name
	}
	return EmojiHashShortcode(src)
}

// IsSafeEmojiImageURL 图片地址白名单：https://… 或 data:image/{png,jpeg,gif,webp};base64,…。
//
// 与前端 `safeImageUrl` 同一口径：小写 `https://` 且不含引号/尖括号、码点不超过
// EmojiMaxRemoteURLLength；data:image 要求基段是合法 base64 字符。
func IsSafeEmojiImageURL(raw string) bool {
	return normalizeSafeEmojiImageURL(raw) != ""
}

// normalizeSafeEmojiImageURL 返回归一化后的图片地址：
// data:image 会被重写成稳定的 `data:<mime>;base64,<payload>`（与前端一致），其余原样返回。
func normalizeSafeEmojiImageURL(raw string) string {
	if match := reEmojiDataImage.FindStringSubmatch(raw); match != nil {
		return fmt.Sprintf("data:%s;base64,%s", match[1], match[2])
	}
	if reEmojiRemoteImage.MatchString(raw) && CountRunes(raw) <= EmojiMaxRemoteURLLength {
		return raw
	}
	return ""
}

// ---------------------------------------------------------------------------
// 拉取、合并与缓存
// ---------------------------------------------------------------------------

// parseOwoPack 按顺序解析一个 owo.json：用 Decoder 的 Token 流保住顶层键的顺序
// （跨包重名的后缀依赖标签顺序，顺序丢了就会让后来的包抢走名字）。
//
// 宽容度与 Node / Worker 的 mergeOwoPacks 对齐：顶层不是对象才算「这个来源不可用」；
// 单个标签值不是对象 → 只跳过这个标签；container 不是数组 → 视为空；
// container 里不是对象的项 → 丢弃。一个畸形槽位不该让整份 owo.json 失效。
func parseOwoPack(data []byte) ([]owoTab, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("owo.json 顶层必须是对象")
	}

	var tabs []owoTab
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, fmt.Errorf("owo.json 的标签名必须是字符串")
		}

		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			// 标签值不是对象：跳过这个标签（其余标签照常保留）
			continue
		}

		var typ string
		if rawType, ok := fields["type"]; ok {
			_ = json.Unmarshal(rawType, &typ)
		}
		// `enabled` 是前端扩展字段（doc/emoji.md 未定义）：只有显式 false 才关闭该标签，
		// 与前端 / Node 的 `pack.enabled !== false` 一致
		enabled := true
		if rawEnabled, ok := fields["enabled"]; ok {
			var flag bool
			if err := json.Unmarshal(rawEnabled, &flag); err == nil {
				enabled = flag
			}
		}

		var items []owoItem
		if rawContainer, ok := fields["container"]; ok {
			var entries []json.RawMessage
			if err := json.Unmarshal(rawContainer, &entries); err == nil {
				for _, entry := range entries {
					var itemFields map[string]json.RawMessage
					if err := json.Unmarshal(entry, &itemFields); err != nil {
						continue
					}
					var item owoItem
					if rawIcon, ok := itemFields["icon"]; ok {
						_ = json.Unmarshal(rawIcon, &item.Icon)
					}
					if rawText, ok := itemFields["text"]; ok {
						_ = json.Unmarshal(rawText, &item.Text)
					}
					items = append(items, item)
				}
			}
		}

		tabs = append(tabs, owoTab{Name: name, Type: typ, Enabled: enabled, Items: items})
	}
	return tabs, nil
}

// fetchOwoPack 拉取单个来源（3 秒超时、1 MiB 响应体上限）。
func fetchOwoPack(url string) ([]owoTab, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := emailEmojiHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, emailEmojiMaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > emailEmojiMaxBodyBytes {
		return nil, fmt.Errorf("响应体超过 1 MiB")
	}
	return parseOwoPack(body)
}

// uniqueShortcode 同包/跨包重名时追加 -2 / -3……
func uniqueShortcode(base string, used map[string]bool) string {
	if !used[base] {
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !used[candidate] {
			return candidate
		}
	}
}

// BuildEmailEmojiMap 按顺序拉取并合并多个 owo.json，返回短代码 → 图片地址的映射。
//
// 合并口径与前端 / Node / Worker 一致：标签按「首次出现」的顺序排列，同名标签把后来的
// container **追加**进先出现的那个标签（保留先出现那一个的 type），然后再统一推导短代码。
// 先合并再推导很重要：跨包重名时「标签栏靠前的包先占名」，逐包推导会给出不同的后缀分配。
//
// 结果按地址列表缓存 10 分钟；某个来源失败只丢这一个来源；全部失败返回空映射
// （调用方据此把短代码原样留成文字）。返回值恒为非 nil。
func BuildEmailEmojiMap(urls []string) map[string]string {
	cacheKey := strings.Join(urls, "\n")

	emailEmojiCacheMu.Lock()
	if entry, ok := emailEmojiCache[cacheKey]; ok && time.Now().Before(entry.expires) {
		mapping := entry.mapping
		emailEmojiCacheMu.Unlock()
		return mapping
	}
	emailEmojiCacheMu.Unlock()

	merged, order := mergeOwoTabs(urls)

	mapping := map[string]string{}
	used := map[string]bool{}
	for _, name := range order {
		tab := merged[name]
		// 只有 image（或缺省/未知按 image）的项才可水合；emoji/emoticon 是文本。
		// 与前端 / Node 一致地做**大小写敏感**的精确比较（脏值按 image 处理）
		if !tab.Enabled {
			continue
		}
		if tab.Type == "emoji" || tab.Type == "emoticon" {
			continue
		}
		for _, item := range tab.Items {
			src := normalizeSafeEmojiImageURL(emojiImageSrc(item.Icon.String()))
			if src == "" {
				continue
			}
			shortcode := uniqueShortcode(EmojiShortcodeFor(item.Text.String(), src), used)
			used[shortcode] = true
			mapping[shortcode] = src
		}
	}

	emailEmojiCacheMu.Lock()
	emailEmojiCache[cacheKey] = emailEmojiCacheEntry{mapping: mapping, expires: time.Now().Add(emailEmojiCacheTTL)}
	emailEmojiCacheMu.Unlock()

	return mapping
}

// mergeOwoTabs 按顺序拉取并合并多份 owo.json，返回「标签名 → 合并后的标签」与标签顺序。
//
// 某个来源失败（网络 / 非 2xx / 超过 1 MiB / 形状不对）只丢这一个来源。
func mergeOwoTabs(urls []string) (map[string]*owoTab, []string) {
	merged := map[string]*owoTab{}
	order := make([]string, 0, len(urls))

	for _, url := range urls {
		tabs, err := fetchOwoPack(url)
		if err != nil {
			log.Printf("[WARN] 邮件表情来源拉取失败，已跳过该来源: %s (%v)", url, err)
			continue
		}
		for _, tab := range tabs {
			if existing, ok := merged[tab.Name]; ok {
				existing.Items = append(existing.Items, tab.Items...)
				continue
			}
			copied := tab
			merged[tab.Name] = &copied
			order = append(order, tab.Name)
		}
	}
	return merged, order
}

// emojiImageSrc 从严格的 <img src="…"> 里取出 src
func emojiImageSrc(icon string) string {
	match := reEmojiImgSrc.FindStringSubmatch(icon)
	if match == nil {
		return ""
	}
	return match[1]
}

// ---------------------------------------------------------------------------
// 水合
// ---------------------------------------------------------------------------

// HydrateEmailEmoji 在已经净化过的 content_html 上做一次短代码水合。
//
// emoji_enabled = "false" 时完全不水合；地址解析 / 拉取失败时映射为空，
// 短代码原样保留为文字（邮件照常发出）。
func HydrateEmailEmoji(contentHTML string) string {
	if contentHTML == "" {
		return contentHTML
	}
	urls, enabled := ResolveEmojiConfig(
		GetSetting(EmojiCdnURLsKey), GetSetting(EmojiCdnURLKey), GetSetting(EmojiEnabledKey))
	if enabled == "false" {
		return contentHTML
	}
	return hydrateShortcodes(contentHTML, BuildEmailEmojiMap(urls))
}

// hydrateShortcodes 只在**文本节点**上替换短代码；<code>/<pre>/<script>/<style>/<textarea>
// 内部与注释、标签属性一律不动（doc/mail.md 第 4 节）。
func hydrateShortcodes(contentHTML string, mapping map[string]string) string {
	if len(mapping) == 0 || !strings.Contains(contentHTML, ":") {
		return contentHTML
	}

	var out strings.Builder
	out.Grow(len(contentHTML))

	var skip []string
	i := 0
	for i < len(contentHTML) {
		if contentHTML[i] == '<' {
			// 注释：整段原样透传，内部不做替换
			if strings.HasPrefix(contentHTML[i:], "<!--") {
				end := strings.Index(contentHTML[i+4:], "-->")
				if end < 0 {
					out.WriteString(contentHTML[i:])
					return out.String()
				}
				end += i + 7
				out.WriteString(contentHTML[i:end])
				i = end
				continue
			}
			end := emojiTagEnd(contentHTML, i)
			if end < 0 {
				out.WriteString(contentHTML[i:])
				return out.String()
			}
			tag := contentHTML[i : end+1]
			out.WriteString(tag)
			skip = updateEmojiSkipStack(skip, tag)
			i = end + 1
			continue
		}

		next := strings.IndexByte(contentHTML[i:], '<')
		if next < 0 {
			out.WriteString(emojiTextSegment(contentHTML[i:], skip, mapping))
			break
		}
		next += i
		out.WriteString(emojiTextSegment(contentHTML[i:next], skip, mapping))
		i = next
	}

	return out.String()
}

// emojiTextSegment 处理一段文本；处于跳过大标签内时原样返回
func emojiTextSegment(segment string, skip []string, mapping map[string]string) string {
	if len(skip) > 0 {
		return segment
	}
	return hydrateTextNode(segment, mapping)
}

// emojiTagEnd 返回标签结束的 '>' 下标（跳过引号内的内容）；找不到返回 -1
func emojiTagEnd(s string, start int) int {
	var quote byte
	for i := start + 1; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			quote = c
		case '>':
			return i
		}
	}
	return -1
}

// emojiTagName 提取标签名与是否闭合标签
func emojiTagName(tag string) (name string, closing bool) {
	i := 1
	if i < len(tag) && tag[i] == '/' {
		closing = true
		i++
	}
	start := i
	for i < len(tag) && isASCIIAlnum(tag[i]) {
		i++
	}
	return strings.ToLower(tag[start:i]), closing
}

// updateEmojiSkipStack 维护「当前处于哪些跳过大标签内」的栈
func updateEmojiSkipStack(stack []string, tag string) []string {
	name, closing := emojiTagName(tag)
	if !emailEmojiSkipElements[name] {
		return stack
	}
	if closing {
		for i := len(stack) - 1; i >= 0; i-- {
			if stack[i] == name {
				return stack[:i]
			}
		}
		return stack
	}
	// 自闭合（<code/>）不入栈
	if strings.HasSuffix(strings.TrimSpace(tag), "/>") {
		return stack
	}
	return append(stack, name)
}

// hydrateTextNode 替换一个文本节点里的短代码。
//
// 边界规则与前端一致：名称前一个字符不能是字母/数字、后一个字符不能是数字
// （因此 12:30:45 不受影响，而 :doge:紧跟英文 仍会被替换）。
func hydrateTextNode(text string, mapping map[string]string) string {
	if text == "" || !strings.Contains(text, ":") {
		return text
	}
	matches := reEmojiShortcode.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}

	var out strings.Builder
	out.Grow(len(text))
	last := 0
	for _, match := range matches {
		start, end := match[0], match[1]
		if start < last {
			continue
		}
		name := text[start+1 : end-1]
		src, ok := mapping[name]
		if !ok || !emojiBoundaryOK(text, start, end) {
			continue
		}
		out.WriteString(text[last:start])
		out.WriteString(emailEmojiImageTag(name, src))
		last = end
	}
	out.WriteString(text[last:])
	return out.String()
}

// emojiBoundaryOK 名称前一个字符不是字母/数字、后一个字符不是数字
func emojiBoundaryOK(text string, start, end int) bool {
	if start > 0 {
		prev, _ := utf8.DecodeLastRuneInString(text[:start])
		if isASCIIAlnumRune(prev) {
			return false
		}
	}
	if end < len(text) {
		next, _ := utf8.DecodeRuneInString(text[end:])
		if next >= '0' && next <= '9' {
			return false
		}
	}
	return true
}

// emailEmojiImageTag 注入的内联小图（口径由 doc/mail.md 第 4 节钉死）
func emailEmojiImageTag(name, src string) string {
	return fmt.Sprintf(
		`<img src="%s" alt=":%s:" title=":%s:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;">`,
		HtmlEscape(src), name, name)
}

func isASCIIAlnum(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isASCIIAlnumRune(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

// resetEmailEmojiCache 清空进程内缓存（仅测试使用）
func resetEmailEmojiCache() {
	emailEmojiCacheMu.Lock()
	emailEmojiCache = map[string]emailEmojiCacheEntry{}
	emailEmojiCacheMu.Unlock()
}
