package utils

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

/*
表情配置（OwO 格式的表情来源，见 doc/emoji.md）的校验与归一化。

与 Node / Worker 共享同一份口径（doc/emoji.md 第 1、3 节与 doc/vectors/emoji-v3.json）：
默认源、默认开关、长度上限、写入路径校验与读取路径归一化都必须逐条一致。

契约 v3：emoji_cdn_urls（JSON 数组，最多 5 个地址，按顺序拼接合并）为现行键；
旧键 emoji_cdn_url 仅在数组解析为空时作为回落。

长度单位统一用 **Unicode 码点**（不是字节、也不是 UTF-16 码元），与 CountRunes 口径相同。
*/

const (
	// EmojiEnabledKey / EmojiCdnURLsKey / EmojiCdnURLKey 三个设置键
	EmojiEnabledKey = "emoji_enabled"
	EmojiCdnURLsKey = "emoji_cdn_urls"
	EmojiCdnURLKey  = "emoji_cdn_url"

	// DefaultEmojiCDN 未配置（或只填了空白）时回落的表情来源
	DefaultEmojiCDN = "https://open.motues.top/emoji/owo.json"
	// DefaultEmojiEnabled 开关的默认值：读取路径 fail-open 为启用
	DefaultEmojiEnabled = "true"

	// MaxEmojiCDNURLLength 单个地址的码点上限
	MaxEmojiCDNURLLength = 500
	// MaxEmojiCDNURLs 地址数组的长度上限
	MaxEmojiCDNURLs = 5
)

// 只允许 http/https，且不能含 " < >（避免被拼进 HTML 属性时逃逸）；大小写不敏感
var reEmojiCDNURL = regexp.MustCompile(`(?i)^https?://[^"<>]+$`)

// NormalizeEmojiEnabled 归一化 emoji_enabled 的写入值：去掉两侧空白并转小写。
// 写入路径必须存归一化后的值，避免 " FALSE " 这类脏值在读取路径反复出现。
func NormalizeEmojiEnabled(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// ValidateEmojiEnabled 校验 emoji_enabled：归一化后只能是 "" / "true" / "false"。
// 空串表示「未配置」，读取时 fail-open 为启用。通过校验返回空串，否则返回错误信息。
func ValidateEmojiEnabled(raw string) string {
	switch NormalizeEmojiEnabled(raw) {
	case "", "true", "false":
		return ""
	default:
		return "emoji_enabled 只能是 true 或 false"
	}
}

// ValidateEmojiCdnURL 校验 emoji_cdn_url（旧键）：trim 后为空视为「未配置」，合法；
// 否则必须是 http/https 地址且不超过 MaxEmojiCDNURLLength 个码点。
func ValidateEmojiCdnURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if CountRunes(value) > MaxEmojiCDNURLLength {
		return fmt.Sprintf("emoji_cdn_url 不能超过 %d 个字符", MaxEmojiCDNURLLength)
	}
	if !reEmojiCDNURL.MatchString(value) {
		return "emoji_cdn_url 只允许 http/https 地址"
	}
	return ""
}

/*
ParseEmojiCdnURLs 读取路径的容错解析（doc/emoji.md 第 3.2 节）：

 1. null / 空串 / 只有空白 → 空列表；
 2. 不是合法 JSON、或 JSON 不是数组 → 空列表；
 3. 数组里非字符串项直接丢弃、字符串项 trim 后为空的丢弃；
 4. 结果截断到前 5 个（顺序保持）。

返回值恒为非 nil 切片，方便调用方直接比较长度为 0。
*/
func ParseEmojiCdnURLs(stored string) []string {
	result := []string{}
	value := strings.TrimSpace(stored)
	if value == "" {
		return result
	}

	var items []interface{}
	if err := json.Unmarshal([]byte(value), &items); err != nil {
		return result
	}

	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		url := strings.TrimSpace(text)
		if url == "" {
			continue
		}
		result = append(result, url)
		if len(result) == MaxEmojiCDNURLs {
			break
		}
	}
	return result
}

/*
ValidateEmojiCdnURLs 写入路径校验（严格，doc/emoji.md 第 3.1 节）：

  - trim 后为空视为「未配置」（存 "[]"）；
  - 否则必须是 JSON 数组，每一项都是字符串；
  - 去掉两侧空格并丢弃空串后最多 5 个，每个都必须是 ^https?://[^"<>]+$ 且 ≤ 500 码点。

通过校验时返回**归一化后的 JSON 数组字符串**（写入路径存的就是它），否则返回错误信息。
*/
func ValidateEmojiCdnURLs(raw string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "[]", ""
	}

	var items []interface{}
	if err := json.Unmarshal([]byte(value), &items); err != nil {
		return "", "emoji_cdn_urls 必须是 JSON 数组"
	}

	urls := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return "", "emoji_cdn_urls 的每一项都必须是字符串"
		}
		url := strings.TrimSpace(text)
		if url == "" {
			continue
		}
		urls = append(urls, url)
	}

	if len(urls) > MaxEmojiCDNURLs {
		return "", "emoji_cdn_urls 最多 5 个地址"
	}
	// 单条地址的判定顺序与 Node / Worker 一致：先长度、后协议
	// （旧键 emoji_cdn_url 也是这个顺序；同时超限与坏协议时三端必须给出同一条文案）
	for _, url := range urls {
		if CountRunes(url) > MaxEmojiCDNURLLength {
			return "", "emoji_cdn_urls 不能超过 500 个字符"
		}
		if !reEmojiCDNURL.MatchString(url) {
			return "", "emoji_cdn_urls 只允许 http/https 地址"
		}
	}

	return mustJSONArray(urls), ""
}

/*
ResolveEmojiConfig 读取路径的完整归一化（宽容，doc/emoji.md 第 3.2 节）：

	urls    = ParseEmojiCdnURLs(storedURLs)          # 最多前 5 个
	if urls 为空:
	    legacy = trim(storedURL)                     # 旧键回落
	    urls = legacy == "" ? [DefaultEmojiCDN] : [legacy]
	enabled = (trim+小写(storedEnabled) == "false") ? "false" : "true"

返回的 urls 恒非空；enabled 为空或无法识别一律 fail-open 为启用；关闭时地址照常下发。

下发旧字段时取 urls[0] 作为 emoji_cdn_url。
*/
func ResolveEmojiConfig(storedURLs, storedURL, storedEnabled string) (urls []string, enabled string) {
	urls = ParseEmojiCdnURLs(storedURLs)
	if len(urls) == 0 {
		legacy := strings.TrimSpace(storedURL)
		if legacy == "" {
			urls = []string{DefaultEmojiCDN}
		} else {
			urls = []string{legacy}
		}
	}

	enabled = DefaultEmojiEnabled
	if strings.ToLower(strings.TrimSpace(storedEnabled)) == "false" {
		enabled = "false"
	}
	return urls, enabled
}
