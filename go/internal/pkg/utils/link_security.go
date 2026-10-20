package utils

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

/*
链接安全审查（休眠链接 + 历史链接批量更新）的设置归一化与休眠判定。

口径见 doc/link_security.md，由 doc/vectors/link-security-v1.json 钉死。

与表情开关的 fail-open **刻意相反**：开关一律 fail-closed（只有归一化后等于 "true" 才算开启），
绝不会因为一个脏值把全站链接拦起来；休眠天数脏值回退 30，超上限夹取 3650。
*/

const (
	// LinkSecurityEnabledKey / LinkDormantDaysKey / LinkSyncEnabledKey / LinkDormantNoticeEnabledKey 四个设置键
	LinkSecurityEnabledKey      = "link_security_enabled"
	LinkDormantDaysKey          = "link_dormant_days"
	LinkSyncEnabledKey          = "link_sync_enabled"
	LinkDormantNoticeEnabledKey = "link_dormant_notice_enabled"

	// DefaultLinkDormantDays 休眠天数默认值（脏值回退值）
	DefaultLinkDormantDays = 30
	// MinLinkDormantDays / MaxLinkDormantDays 休眠天数的取值区间
	MinLinkDormantDays = 1
	MaxLinkDormantDays = 3650

	// DayMillis 一天的毫秒数（pub_date 统一是毫秒整数）
	DayMillis = int64(86400000)

	// TrustTimeLayout 人工确认到期/确认时间的**唯一**合法格式，
	// 与 JS 的 new Date(ms).toISOString() 逐字一致（UTC + 恰好 3 位毫秒 + 字面 Z）。
	TrustTimeLayout = "2006-01-02T15:04:05.000Z"
)

// NormalizeLinkSwitch 归一化链接安全开关的**写入值**：trim + 转小写。
//
// 空串保持空串（与 Node / Worker 逐字一致：写入时存的就是归一化后的值本身）。
// 读取路径的 fail-closed 判定在 ResolveLinkSecurityEnabled，不在这里兜底。
func NormalizeLinkSwitch(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// ResolveLinkSecurityEnabled 读取路径的开关判定（fail-closed）：
// 只有归一化后等于 "true" 才算开启，空值 / 脏值 / 大小写变体一律按关闭处理。
func ResolveLinkSecurityEnabled(stored string) bool {
	return strings.ToLower(strings.TrimSpace(stored)) == "true"
}

// ShouldSendDormantNotice 休眠提醒邮件的**发信前提**（doc/link_security.md 第 2.7 节）：
//
//	发信 = link_security_enabled && link_dormant_notice_enabled && email_verify_enabled
//
// 三个值一律 fail-closed（归一化后等于 "true" 才算开启）：功能没开、提醒开关没开、
// 或站点没开邮箱验证时，一封提醒都不发 —— 面板上的警告与这里完全同口径。
// SMTP 可用性与 email_enabled 由发信函数再检查一次（不合并进本函数，便于单元测试）。
func ShouldSendDormantNotice(securityEnabled, noticeEnabled, emailVerifyEnabled string) bool {
	return ResolveLinkSecurityEnabled(securityEnabled) &&
		ResolveLinkSecurityEnabled(noticeEnabled) &&
		ResolveLinkSecurityEnabled(emailVerifyEnabled)
}

// ValidateLinkSwitch 写入路径校验：归一化后只能是 "" / "true" / "false"。
//
// value 为 nil 表示「未提供」（通过校验）；其余非字符串取值一律视为非法
// （与 JS 侧 `String(value)` 得到非法值等价）。
// 通过校验返回空串，否则返回错误信息。
func ValidateLinkSwitch(key string, value interface{}) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "", "true", "false":
			return ""
		}
	}
	return key + " 只能是 true 或 false"
}

// ValidateLinkDormantDays 写入路径校验：只能是 1–3650 的十进制整数。
//
// 通过时返回**规范化后的十进制字符串**（写入路径存的就是它）。注意 null / 空串都属于非法
// 取值（与 fixture 的 days.invalid 一致）。
func ValidateLinkDormantDays(value interface{}) (string, string) {
	const message = "link_dormant_days 必须是 1-3650 之间的整数"

	var text string
	switch v := value.(type) {
	case nil:
		return "", message
	case string:
		text = strings.TrimSpace(v)
	case json.Number:
		text = v.String()
	case float64:
		text = strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		text = strconv.Itoa(v)
	case int64:
		text = strconv.FormatInt(v, 10)
	default:
		return "", message
	}

	days, ok := parseDecimalDays(text)
	if !ok || days < MinLinkDormantDays || days > MaxLinkDormantDays {
		return "", message
	}
	return strconv.Itoa(days), ""
}

// ResolveLinkDormantDays 读取路径的休眠天数归一化（宽容）：
// 整数且落在 1..3650 内取该值；大于上限夹取 3650；其余（空、脏值、0、负数、小数）回退 30。
func ResolveLinkDormantDays(stored string) int {
	days, ok := parseDecimalDays(strings.TrimSpace(stored))
	if !ok {
		return DefaultLinkDormantDays
	}
	if days > MaxLinkDormantDays {
		return MaxLinkDormantDays
	}
	if days < MinLinkDormantDays {
		return DefaultLinkDormantDays
	}
	return days
}

// parseDecimalDays 解析「十进制、无符号、无小数、无单位」的整数（与 Node / Worker 的
// /^\d+$/ 逐字一致：`+5` / `-5` / `1e3` / `1.5` / `30d` 一律不认）。
//
// 全是数字但超出 int 范围时返回「大于上限」的哨兵值：JS 侧 Number(...) 会得到 1e20，
// 同样落在超上限分支（写入校验报错、读取归一化夹取到 3650）。
func parseDecimalDays(text string) (int, bool) {
	if text == "" {
		return 0, false
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return 0, false
		}
	}
	days, err := strconv.Atoi(text)
	if err != nil {
		return MaxLinkDormantDays + 1, true
	}
	return days, true
}

// IsUrlDormant 休眠判定（doc/link_security.md 第 2.1 节）：
//
//	休眠 = 功能开启 && trusted !== true && 有个人网址 && 该网址归属邮箱的最后一条评论距今 **严格大于** N 天
//
// ageMs 是「现在 - 最后一条评论时间」；known 为 false 表示查不到最后评论时间
// （数据缺失/历史脏值）—— 此时不标记（fail-open：宁可照常跳转，也不冤枉活人）。
//
// trusted 表示管理员对该 (归一化邮箱, 网址) 做过**仍然有效**的人工确认（见 IsTrustActive）：
// 为 true 时直接不标记；人工确认已过期时必须由调用方传 false（本函数不自己看时间）。
func IsUrlDormant(enabled, hasURL bool, days int, ageMs int64, known, trusted bool) bool {
	if !enabled || !hasURL || !known {
		return false
	}
	if trusted {
		return false
	}
	return ageMs > int64(days)*DayMillis
}

// NeedDormantNotice 休眠链接提醒的纯函数判定（任务规范第 6 节）：
//
//	需要发提醒 = 该链接当前**休眠**
//	          && ( 没有任何提醒记录
//	               || 记录已过期(expires_at <= now)
//	               || 记录里的 last_comment_at ≠ 当前该邮箱的最后评论时间 )
//
// 含义：同一个「休眠周期」（最后评论时间没变）只提醒一次；他后来又评论过（时间变了）
// = 新的休眠周期，要再提醒一次；记录过期后也要再提醒（并顺带刷新令牌与有效期）。
//
// 参数都是调用方算好的：dormant 是既有 IsUrlDormant 的结果；recordExpired 是
// `!IsTrustActive(record.expires_at, now)`（格式不符同样算过期 → 再提醒一次）；
// hasRecord 为 false 时 recordLastCommentAt 无意义（可为 nil）。
func NeedDormantNotice(dormant, hasRecord, recordExpired bool, recordLastCommentAt *int64, currentLastCommentAt int64) bool {
	if !dormant {
		return false
	}
	if !hasRecord || recordExpired {
		return true
	}
	// 记录里的最后评论时间缺失（理论上 NOT NULL，兜住脏数据）：当作「时间变了」再提醒一次
	if recordLastCommentAt == nil {
		return true
	}
	return *recordLastCommentAt != currentLastCommentAt
}

// IsTrustActive 人工确认是否**当前有效**（doc/link_security.md 第 4 节）：
//
//	有效 = expires_at 逐字符合 YYYY-MM-DDTHH:mm:ss.sssZ && expires_at **严格大于** now
//
// 解析必须**严格**：JS 的 Date.parse 能吃下 `2026-11-17`，Go 的 time.Parse(RFC3339) 会拒绝，
// 只按「能解析就算」两端就会给出不同答案 —— 所以先做格式形状校验（恰好 3 位毫秒、只有 Z、
// 不接受时区偏移 / 纯日期 / 数字串），再交给 time.Parse 校验字段范围。
// 无法解析或格式不符一律 false（fail-closed：不豁免休眠，管理员重新确认即可）。
func IsTrustActive(expiresAt string, nowMs int64) bool {
	if !hasTrustTimeLayout(expiresAt) {
		return false
	}
	expires, err := time.Parse(TrustTimeLayout, expiresAt)
	if err != nil {
		return false
	}
	return expires.UnixMilli() > nowMs
}

// FormatTrustTime 把毫秒时间戳格式化为人工确认的**写入格式**（与 new Date(ms).toISOString() 一致）。
func FormatTrustTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(TrustTimeLayout)
}

// TrustedLinkKey 人工确认的匹配键：**归一化邮箱** + `\x00` + **逐字（trim 后）网址**。
//
// 读写两端都用它拼键：写入端存的是 sanitizeUrl 的输出（已 trim），读取端把评论/用户的网址
// trim 后比对，保证「换链接不继承」——确认的是旧网址时新网址匹配不上。
func TrustedLinkKey(email, url string) string {
	return NormalizeEmail(email) + "\x00" + strings.TrimSpace(url)
}

// hasTrustTimeLayout 判断字符串是否逐字符合 `YYYY-MM-DDTHH:mm:ss.sssZ`（形状校验，不校验字段范围）。
func hasTrustTimeLayout(value string) bool {
	const layoutLen = len("2006-01-02T15:04:05.000Z")
	if len(value) != layoutLen {
		return false
	}
	for i := 0; i < layoutLen; i++ {
		ch := value[i]
		switch i {
		case 4, 7:
			if ch != '-' {
				return false
			}
		case 10:
			if ch != 'T' {
				return false
			}
		case 13, 16:
			if ch != ':' {
				return false
			}
		case 19:
			if ch != '.' {
				return false
			}
		case 23:
			if ch != 'Z' {
				return false
			}
		default:
			if ch < '0' || ch > '9' {
				return false
			}
		}
	}
	return true
}
