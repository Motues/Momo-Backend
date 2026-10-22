package utils

import (
	"net/url"
	"strings"
)

// API 地址（verify_base_url）与邮箱验证开关（email_verify_enabled）的写入口径。
//
// 与 Node / Worker 三端逐条一致（唯一事实来源：doc/api.md）：
//   - 空串允许（表示未配置）；
//   - 非空必须是 http(s):// 开头的绝对地址，不能带 query / hash / 用户名密码；
//   - 写入时去首尾空格与末尾 /。
//
// 依赖关系：
//   - email_verify_enabled = "true" 需要 API 地址非空；
//   - link_sync_enabled = "true" 需要 API 地址非空；
//   - link_dormant_notice_enabled = "true" 需要 API 地址非空。
// 后两者不再依赖 email_verify_enabled（见 doc/link_security.md）。
const (
	VerifyBaseURLKey       = "verify_base_url"
	EmailVerifyEnabledKey  = "email_verify_enabled"
	MaxVerifyBaseURLLength = 500
)

// 三端逐字一致的错误文案
const (
	VerifyBaseURLError             = "verify_base_url 必须是 http(s) 开头的完整地址"
	VerifyBaseURLTooLongError      = "verify_base_url 不能超过 500 个字符"
	EmailVerifyEnabledError        = "email_verify_enabled 只能是 true 或 false"
	EmailVerifyNeedsBaseURLError   = "邮箱验证开启时必须填写 API 地址"
	LinkSyncNeedsBaseURLError      = "历史链接同步开启时必须填写 API 地址"
	DormantNoticeNeedsBaseURLError = "休眠提醒邮件开启时必须填写 API 地址"
)

// NormalizeVerifyBaseURL 写入前的归一化：去首尾空格、去末尾 /；空串保持空串。
func NormalizeVerifyBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	return strings.TrimRight(trimmed, "/")
}

// ValidateVerifyBaseURL 写入校验：空串允许；否则必须是合法的 http(s) 绝对地址。
// 通过校验返回空串，否则返回错误信息。
func ValidateVerifyBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) > MaxVerifyBaseURLLength {
		return VerifyBaseURLTooLongError
	}
	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return VerifyBaseURLError
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return VerifyBaseURLError
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return VerifyBaseURLError
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return VerifyBaseURLError
	}
	return ""
}

// NormalizeEmailVerifyEnabled 开关归一化：只保留 true / false，其余（含空串）按空串处理。
func NormalizeEmailVerifyEnabled(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true":
		return "true"
	case "false":
		return "false"
	default:
		return ""
	}
}

// ValidateEmailVerifyEnabled 开关写入校验：只接受 "" / "true" / "false"（忽略大小写与两侧空格）。
func ValidateEmailVerifyEnabled(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "true", "false":
		return ""
	default:
		return EmailVerifyEnabledError
	}
}

// ValidateApiURLDependents 交叉校验：请求体优先、否则回落到库中现值，判断
// 「开启某个依赖 API 地址的功能时，API 地址是否为空」。
func ValidateApiURLDependents(body map[string]string) string {
	effective := func(key string) string {
		if value, ok := body[key]; ok {
			return value
		}
		return GetSetting(key)
	}

	if NormalizeVerifyBaseURL(effective(VerifyBaseURLKey)) != "" {
		return ""
	}
	if NormalizeEmailVerifyEnabled(effective(EmailVerifyEnabledKey)) == "true" {
		return EmailVerifyNeedsBaseURLError
	}
	if ResolveLinkSecurityEnabled(effective(LinkSyncEnabledKey)) {
		return LinkSyncNeedsBaseURLError
	}
	if ResolveLinkSecurityEnabled(effective(LinkDormantNoticeEnabledKey)) {
		return DormantNoticeNeedsBaseURLError
	}
	return ""
}

// HasApiURLDependencyKey 请求体是否涉及 API 地址依赖链（用于避免无意义的交叉校验）。
func HasApiURLDependencyKey(body map[string]string) bool {
	for _, key := range []string{
		VerifyBaseURLKey,
		EmailVerifyEnabledKey,
		LinkSyncEnabledKey,
		LinkDormantNoticeEnabledKey,
	} {
		if _, ok := body[key]; ok {
			return true
		}
	}
	return false
}
