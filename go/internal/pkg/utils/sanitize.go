package utils

import (
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
)

var (
	reScriptStyle  = regexp.MustCompile(`(?i)<(?:script|style)[\s\S]*?</(?:script|style)>`)
	reEventHandler = regexp.MustCompile(`(?i)\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`)
	reDangerousTags = regexp.MustCompile(`(?i)</?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>`)
	reUrlScheme     = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*$`)
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
func CheckContent(content string) string {
	content = reScriptStyle.ReplaceAllString(content, "")
	content = reEventHandler.ReplaceAllString(content, "")
	content = reDangerousTags.ReplaceAllString(content, "")
	return content
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
