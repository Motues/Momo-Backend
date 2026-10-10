package utils

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/microcosm-cc/bluemonday"
)

var (
	reScriptStyle  = regexp.MustCompile(`(?i)<(?:script|style)[\s\S]*?</(?:script|style)>`)
	reEventHandler = regexp.MustCompile(`(?i)\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`)
	// 与 Node/Worker 的 checkContent 逐条对齐：javascript:/vbscript: 的三种引号形式，
	// 以及独立的 javascript:/vbscript: 文本。少任何一条都会让同一段输入在三端得到不同结果。
	reJsSchemeDoubleQuoted = regexp.MustCompile(`(?i)(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"`)
	reJsSchemeSingleQuoted = regexp.MustCompile(`(?i)(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'`)
	reJsSchemeUnquoted     = regexp.MustCompile(`(?i)(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+`)
	reJsSchemeStandalone   = regexp.MustCompile(`(?i)(?:javascript|vbscript):\s*`)
	reDangerousTags        = regexp.MustCompile(`(?i)</?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>`)
	reUrlScheme            = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*$`)
)

// bluemonday 策略实例（用于 Markdown 输出后的 HTML 净化）
var htmlPolicy = bluemonday.UGCPolicy()

func init() {
	// 允许 Markdown 常用的标签和属性
	htmlPolicy.AllowAttrs("href", "target", "rel").OnElements("a")
	htmlPolicy.AllowAttrs("src", "alt", "title").OnElements("img")
	htmlPolicy.AllowAttrs("class").OnElements("code", "pre", "span", "div")
}

// CheckContent sanitizes raw user input for plain-text fields (author, url, etc.)
// Removes XSS attack vectors before markdown processing
//
// 规则与顺序必须与 Node/Worker 的 checkContent 逐条一致：
// 任何一条缺失或顺序不同，都会让同一段输入在三端得到不同结果 —— 而文章标识
// （post_slug）现在会被签进挑战载荷，口径不一致就等于「合法访客被假拒绝」。
func CheckContent(content string) string {
	content = reScriptStyle.ReplaceAllString(content, "")
	content = reEventHandler.ReplaceAllString(content, "")
	content = reJsSchemeDoubleQuoted.ReplaceAllString(content, "")
	content = reJsSchemeSingleQuoted.ReplaceAllString(content, "")
	content = reJsSchemeUnquoted.ReplaceAllString(content, "")
	content = reJsSchemeStandalone.ReplaceAllString(content, "")
	content = reDangerousTags.ReplaceAllString(content, "")
	return content
}

// CountRunes 统计 Unicode 码点数（不是字节数）。
// 与 JS 侧的 countCodePoints 语义一致：成对的代理项在 UTF-16 里算一个码点，
// 在 Go 里一个 rune 也是一个码点。
func CountRunes(value string) int {
	return utf8.RuneCountInString(value)
}

// TruncateRunes 按 Unicode 码点截断（与 JS 侧的 truncateCodePoints 语义一致）。
//
// 不能按字节截：多字节字符被从中间切断会产出非法 UTF-8，与 Node/Worker 的结果不一致。
// 也不能让 JS 侧按 UTF-16 码元截：那可能切出孤立代理项，传到 Go 会变成 U+FFFD。
// 因此三端统一按**码点**截断，这是唯一能让三端逐字节一致的切法。
func TruncateRunes(value string, max int) string {
	if max <= 0 {
		return ""
	}
	count := 0
	for i := range value {
		if count == max {
			return value[:i]
		}
		count++
	}
	return value
}

// SanitizeUrl 协议白名单校验（比黑名单正则可靠）。
//
// 允许：相对路径、http:、https:、mailto:；其余 scheme（javascript:/vbscript:/data: 等）返回空串。
// 浏览器解析 URL 前会剥离 \t \n \r 等控制字符，因此必须先剥离再判定 scheme，
// 否则 `java\nscript:alert(1)` 会绕过白名单。
func SanitizeUrl(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}

	// 用于 scheme 判定的归一化副本：去掉全部 ASCII 控制字符与空白
	var b strings.Builder
	for _, r := range value {
		if r <= 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	probe := b.String()
	if probe == "" {
		return ""
	}

	if idx := strings.Index(probe, ":"); idx > 0 {
		candidate := probe[:idx]
		if reUrlScheme.MatchString(candidate) {
			switch strings.ToLower(candidate) {
			case "http", "https", "mailto":
				return value
			default:
				return ""
			}
		}
	}

	// 无 scheme：相对路径 / 协议相对地址
	return value
}

// SanitizeHtml 使用 bluemonday 净化已渲染的 HTML 内容（Markdown 输出后使用）
func SanitizeHtml(html string) string {
	return htmlPolicy.Sanitize(html)
}

// HTML escape for email template injection defense
func HtmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}
