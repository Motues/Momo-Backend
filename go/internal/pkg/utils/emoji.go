package utils

import (
	"fmt"
	"regexp"
	"strings"
)

/*
表情配置（OwO 格式的表情来源，见 doc/emoji.md）的校验与归一化。

与 Node / Worker 共享同一份口径（doc/emoji.md 第 1、3 节与 doc/vectors/emoji-v2.json）：
默认源、默认开关、长度上限、写入路径校验与读取路径归一化都必须逐条一致。

长度单位统一用 **Unicode 码点**（不是字节、也不是 UTF-16 码元），与 CountRunes 口径相同。
*/

const (
	// EmojiEnabledKey / EmojiCdnURLKey 两个设置键
	EmojiEnabledKey = "emoji_enabled"
	EmojiCdnURLKey  = "emoji_cdn_url"

	// DefaultEmojiCDN 未配置（或只填了空白）时回落的表情来源
	DefaultEmojiCDN = "https://open.motues.top/emoji/owo.json"
	// DefaultEmojiEnabled 开关的默认值：读取路径 fail-open 为启用
	DefaultEmojiEnabled = "true"

	// MaxEmojiCDNURLLength emoji_cdn_url 的码点上限
	MaxEmojiCDNURLLength = 500
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

// ValidateEmojiCdnURL 校验 emoji_cdn_url：trim 后为空视为「未配置」，合法；
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
ResolveEmojiConfig 读取路径的归一化（宽容，见 doc/emoji.md 第 3.2 节）：

	url     = trim(storedURL)，空则回落 DefaultEmojiCDN
	enabled = 仅当 trim+小写(storedEnabled) == "false" 时为 "false"，否则 "true"

即开关为空或无法识别一律 fail-open 为启用；关闭时地址照常下发（面板不会丢掉配置）。
*/
func ResolveEmojiConfig(storedURL, storedEnabled string) (url string, enabled string) {
	url = strings.TrimSpace(storedURL)
	if url == "" {
		url = DefaultEmojiCDN
	}

	enabled = DefaultEmojiEnabled
	if strings.ToLower(strings.TrimSpace(storedEnabled)) == "false" {
		enabled = "false"
	}
	return url, enabled
}
