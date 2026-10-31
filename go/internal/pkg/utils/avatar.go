package utils

import (
	"crypto/md5"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

/*
评论区头像来源（契约 v1，见 doc/avatar.md 与 doc/vectors/avatar-v1.json）。

头像由服务端按邮箱推导后随评论列表下发，不落库、不代理、不向第三方发起请求。
两个设置键：
  - avatar_source：default / gravatar / cravatar / qq / custom
  - avatar_custom_url：仅 source=custom 时使用的 URL 模板

读取路径 **fail-open**：未知来源、空/非法模板、qq 来源下的非 QQ 邮箱，
一律回落到内置默认源（历史地址），保证评论区永远有头像可用。

本文件与 Node `nodejs/src/utils/avatar.ts`、Worker `worker/src/utils/avatar.ts`
逐字一致；任何一端改动都必须同步另外两端与向量文件。
*/

const (
	AvatarEnabledKey       = "avatar_enabled"
	AvatarSourceKey        = "avatar_source"
	AvatarCustomURLKey     = "avatar_custom_url"
	DefaultAvatarSource    = "default"
	DefaultAvatarCustomURL = ""
	DefaultAvatarEnabled   = "true"
	// AvatarURLMaxLength 自定义模板长度上限（按码点计）
	AvatarURLMaxLength = 500
)

// DefaultAvatarURL 关闭头像后统一下发的默认头像：内联 SVG（灰色人像），零外部请求。
// 三端与 doc/vectors/avatar-v1.json 的 defaultAvatarUrl 逐字一致。
const DefaultAvatarURL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIzMiIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjQiIHI9IjExIiBmaWxsPSIjOWNhM2FmIi8+PHBhdGggZD0iTTEzIDU3YzAtMTAuNSA4LjUtMTkgMTktMTlzMTkgOC41IDE5IDE5IiBmaWxsPSIjOWNhM2FmIi8+PC9zdmc+"

// AvatarSources 合法的头像来源取值（顺序即面板展示顺序）
var AvatarSources = []string{"default", "gravatar", "cravatar", "qq", "custom"}

// AvatarTemplates 四个预设模板（custom 由管理员提供）
var AvatarTemplates = map[string]string{
	"default":  "https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam",
	"gravatar": "https://gravatar.com/avatar/{hash}?s=200&d=identicon",
	"cravatar": "https://cravatar.cn/avatar/{hash}?s=200&d=identicon",
	"qq":       "https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100",
}

// AvatarPlaceholders 自定义模板允许的占位符
var AvatarPlaceholders = []string{"{hash}", "{email}", "{author}", "{qq}"}

// 三端逐字一致的错误文案（文档/向量里钉死）
const (
	AvatarErrNotString      = "avatar_custom_url 必须是字符串"
	AvatarErrBadSource      = "avatar_source 只能是 default / gravatar / cravatar / qq / custom"
	AvatarErrBadScheme      = "avatar_custom_url 只允许 http/https 地址"
	AvatarErrTooLong        = "avatar_custom_url 不能超过 500 个字符"
	AvatarErrControlChar    = "avatar_custom_url 不能包含控制字符"
	AvatarErrBadPlaceholder = "avatar_custom_url 包含不支持的占位符"
	AvatarErrEmptyCustom    = "选择自定义头像来源时必须填写头像地址"
	AvatarErrBadEnabled     = "avatar_enabled 只能是 true 或 false"
)

// AvatarConfig 解析后的头像配置：来源 + 实际使用的模板
type AvatarConfig struct {
	Source   string
	Template string
}

// AvatarSettingsInput 写入请求里的头像相关字段；nil 表示本次请求没提交该键
type AvatarSettingsInput struct {
	Enabled   *string
	Source    *string
	CustomURL *string
}

var avatarPlaceholderRe = regexp.MustCompile(`\{[^{}]*\}`)

// IsAvatarSource 判断取值是否在合法来源表内（调用方应先归一化）
func IsAvatarSource(value string) bool {
	for _, source := range AvatarSources {
		if source == value {
			return true
		}
	}
	return false
}

// NormalizeAvatarSource 读取归一化：trim + 小写；未知值/空串一律回落 default
func NormalizeAvatarSource(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if IsAvatarSource(value) {
		return value
	}
	return DefaultAvatarSource
}

// ValidateAvatarSource 写入校验：空串合法（归一化为 default）
func ValidateAvatarSource(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" || IsAvatarSource(value) {
		return ""
	}
	return AvatarErrBadSource
}

// NormalizeAvatarEnabled 开关归一化（写入用）：trim + 小写；空串表示「未配置」
func NormalizeAvatarEnabled(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// ValidateAvatarEnabled 开关写入校验：只接受 "" / "true" / "false"
func ValidateAvatarEnabled(raw string) string {
	switch NormalizeAvatarEnabled(raw) {
	case "", "true", "false":
		return ""
	default:
		return AvatarErrBadEnabled
	}
}

// IsAvatarEnabled 读取：只有明确 "false" 才算关闭，其余（含空/脏值）fail-open 为开启
func IsAvatarEnabled(raw string) bool {
	return NormalizeAvatarEnabled(raw) != "false"
}

// NormalizeAvatarCustomURL 落库前 trim
func NormalizeAvatarCustomURL(raw string) string {
	return strings.TrimSpace(raw)
}

// ValidateAvatarCustomURL 自定义模板校验：空串合法（未配置）。
// 校验顺序固定：trim → 控制字符 → 协议 → 长度 → 占位符。
func ValidateAvatarCustomURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return AvatarErrControlChar
		}
	}
	lower := strings.ToLower(value)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return AvatarErrBadScheme
	}
	if utf8.RuneCountInString(value) > AvatarURLMaxLength {
		return AvatarErrTooLong
	}
	for _, token := range avatarPlaceholderRe.FindAllString(value, -1) {
		allowed := false
		for _, placeholder := range AvatarPlaceholders {
			if token == placeholder {
				allowed = true
				break
			}
		}
		if !allowed {
			return AvatarErrBadPlaceholder + "：" + token
		}
	}
	return ""
}

// ValidateAvatarSettings 写入校验（含跨键约束）：source=custom 时生效模板不能为空。
// storedSource / storedCustom 用于补全本次请求没提交的另一个键。
func ValidateAvatarSettings(input AvatarSettingsInput, storedSource, storedCustom string) string {
	if input.Enabled != nil {
		if msg := ValidateAvatarEnabled(*input.Enabled); msg != "" {
			return msg
		}
	}
	if input.Source != nil {
		if msg := ValidateAvatarSource(*input.Source); msg != "" {
			return msg
		}
	}
	if input.CustomURL != nil {
		if msg := ValidateAvatarCustomURL(*input.CustomURL); msg != "" {
			return msg
		}
	}
	if input.Source == nil && input.CustomURL == nil {
		return ""
	}

	effectiveSource := NormalizeAvatarSource(storedSource)
	if input.Source != nil {
		effectiveSource = NormalizeAvatarSource(*input.Source)
	}
	effectiveCustom := NormalizeAvatarCustomURL(storedCustom)
	if input.CustomURL != nil {
		effectiveCustom = NormalizeAvatarCustomURL(*input.CustomURL)
	}
	if effectiveSource == "custom" && effectiveCustom == "" {
		return AvatarErrEmptyCustom
	}
	return ""
}

// ResolveAvatarConfig 读取解析：始终返回一个可用的配置（非法输入回落内置默认源）
func ResolveAvatarConfig(sourceRaw, customRaw string) AvatarConfig {
	source := NormalizeAvatarSource(sourceRaw)
	if source == "custom" {
		custom := NormalizeAvatarCustomURL(customRaw)
		if custom != "" && ValidateAvatarCustomURL(custom) == "" {
			return AvatarConfig{Source: "custom", Template: custom}
		}
		return AvatarConfig{Source: DefaultAvatarSource, Template: AvatarTemplates[DefaultAvatarSource]}
	}
	return AvatarConfig{Source: source, Template: AvatarTemplates[source]}
}

func normalizeAvatarEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// AvatarPercentEncode RFC 3986：只保留非保留字符，其余 UTF-8 字节编码为 %XX（大写）
func AvatarPercentEncode(value string) string {
	const hexUpper = "0123456789ABCDEF"
	var builder strings.Builder
	for _, b := range []byte(value) {
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
			b == '-' || b == '_' || b == '.' || b == '~' {
			builder.WriteByte(b)
		} else {
			builder.WriteByte('%')
			builder.WriteByte(hexUpper[b>>4])
			builder.WriteByte(hexUpper[b&0x0f])
		}
	}
	return builder.String()
}

func avatarMD5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

var qqEmailRe = regexp.MustCompile(`^(\d+)@qq\.com$`)

func avatarQQNumber(normalizedEmail string) string {
	match := qqEmailRe.FindStringSubmatch(normalizedEmail)
	if match == nil {
		return ""
	}
	return match[1]
}

// BuildAvatarURL 按解析后的配置生成头像地址；模板含 {qq} 但邮箱不是 QQ 时回落默认源
func BuildAvatarURL(config AvatarConfig, email, author string) string {
	normalizedEmail := normalizeAvatarEmail(email)
	qq := avatarQQNumber(normalizedEmail)
	template := config.Template
	if strings.Contains(template, "{qq}") && qq == "" {
		template = AvatarTemplates[DefaultAvatarSource]
	}
	replacements := map[string]string{
		"{hash}":   avatarMD5Hex(normalizedEmail),
		"{email}":  AvatarPercentEncode(normalizedEmail),
		"{author}": AvatarPercentEncode(strings.TrimSpace(author)),
		"{qq}":     qq,
	}
	var builder strings.Builder
	for {
		start := strings.Index(template, "{")
		if start < 0 {
			builder.WriteString(template)
			break
		}
		end := strings.Index(template[start:], "}")
		if end < 0 {
			builder.WriteString(template)
			break
		}
		end += start
		token := template[start : end+1]
		builder.WriteString(template[:start])
		if replacement, ok := replacements[token]; ok {
			builder.WriteString(replacement)
		} else {
			builder.WriteString(token)
		}
		template = template[end+1:]
	}
	return builder.String()
}

// ResolveAvatarURL 公开评论列表最终下发的头像：关闭开关时一律返回内置默认头像，
// 否则按来源配置生成。开关只影响下发结果，不修改/清空已保存的来源配置。
func ResolveAvatarURL(enabled bool, config AvatarConfig, email, author string) string {
	if !enabled {
		return DefaultAvatarURL
	}
	return BuildAvatarURL(config, email, author)
}

// GetCravatar 生成内置默认源的头像地址（保持历史导出，供旧调用方/测试使用）
func GetCravatar(email string) string {
	return BuildAvatarURL(ResolveAvatarConfig("", ""), email, "")
}
