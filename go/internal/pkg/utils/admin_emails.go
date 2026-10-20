package utils

import (
	"encoding/json"
	"regexp"
	"strings"
)

/*
多管理员邮箱与通知收件人（见 doc/admin_emails.md）的校验、归一化与解析。

与 Node / Worker 共享同一份口径（doc/vectors/admin-emails-v1.json 钉死）：

  - admin_emails 是权威列表（JSON 数组字符串），admin_email 仅在列表解析为空时回落；
  - 列表与通知邮箱一律 `trim` + 转小写后比对（成员判定 = 归一化后相等）；
  - notify_email 命中不了列表时读取路径回落到列表第一个，写入路径则直接 400。

归一化与读取解析刻意宽容（历史脏值不能让整个面板不可用），写入路径则严格：
非法取值 400 且不落库。
*/

const (
	// AdminEmailsKey / AdminEmailKey / NotifyEmailKey 三个设置键
	AdminEmailsKey = "admin_emails"
	AdminEmailKey  = "admin_email"
	NotifyEmailKey = "notify_email"

	// MaxAdminEmails 管理员邮箱列表的长度上限
	MaxAdminEmails = 10
	// MaxAdminEmailLength 单个邮箱的字符数上限（与三端一致）
	MaxAdminEmailLength = 254
)

// 邮箱判定正则（doc/admin_emails.md 第 2 节）：刻意不做 RFC 5322 全量解析，
// 只挡明显非法形态（无 @、无 TLD、含空格、尖括号包裹、a@@b.com、a@b..com）。
var reAdminEmail = regexp.MustCompile(`^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$`)

// NormalizeEmail 邮箱归一化：去掉两侧空白并转小写。
func NormalizeEmail(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// IsValidEmail 判断归一化/原始邮箱串是否合法（先 trim 再校验，长度按字符数计）。
func IsValidEmail(raw string) bool {
	value := strings.TrimSpace(raw)
	if value == "" || CountRunes(value) > MaxAdminEmailLength {
		return false
	}
	return reAdminEmail.MatchString(value)
}

// ParseAdminEmails 读取路径的宽容解析（doc/admin_emails.md 第 4 节）：
//
//  1. 空串 / 只有空白 → 空列表；
//  2. 不是合法 JSON、或 JSON 不是数组 → 空列表；
//  3. 非字符串项、非法邮箱、空串一律丢弃；
//  4. 归一化后去重保序，截断到前 10 个。
//
// 返回值恒为非 nil 切片，方便调用方直接比较长度为 0。
func ParseAdminEmails(stored string) []string {
	result := []string{}
	value := strings.TrimSpace(stored)
	if value == "" {
		return result
	}

	var items []interface{}
	if err := json.Unmarshal([]byte(value), &items); err != nil {
		return result
	}

	seen := make(map[string]bool, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		email := NormalizeEmail(text)
		if email == "" || !IsValidEmail(email) || seen[email] {
			continue
		}
		seen[email] = true
		result = append(result, email)
		if len(result) == MaxAdminEmails {
			break
		}
	}
	return result
}

// ResolveAdminEmails 读取路径的管理员列表：优先 admin_emails，解析为空时回落旧键
// admin_email 的单元素列表（旧键非法则视为「没有管理员」）。
func ResolveAdminEmails(storedEmails, storedLegacyAdmin string) []string {
	if admins := ParseAdminEmails(storedEmails); len(admins) > 0 {
		return admins
	}
	legacy := NormalizeEmail(storedLegacyAdmin)
	if IsValidEmail(legacy) {
		return []string{legacy}
	}
	return []string{}
}

// ResolveNotifyEmail 读取路径的通知收件人：归一化后必须命中管理员列表，
// 否则回落到列表第一个；列表为空则返回空串（不发通知）。
func ResolveNotifyEmail(storedNotify string, admins []string) string {
	normalized := NormalizeEmail(storedNotify)
	if normalized != "" && IsAdminEmail(normalized, admins) {
		return normalized
	}
	if len(admins) > 0 {
		return admins[0]
	}
	return ""
}

// IsAdminEmail 成员判定：归一化后与列表中的某一项完全相等即为博主。
func IsAdminEmail(email string, admins []string) bool {
	normalized := NormalizeEmail(email)
	if normalized == "" {
		return false
	}
	for _, admin := range admins {
		if admin == normalized {
			return true
		}
	}
	return false
}

// AdminEmailHashes 返回管理员列表里每个邮箱的 sha256 十六进制哈希（保序）。
func AdminEmailHashes(admins []string) []string {
	hashes := make([]string, 0, len(admins))
	for _, admin := range admins {
		hashes = append(hashes, EmailHash(admin))
	}
	return hashes
}

// EmailHash 返回邮箱（应为归一化后的值）的 sha256 十六进制哈希。
//
// 公开接口的 admin_email_hash / admin_email_hashes 都用它：口径与旧版一致
// （sha256(lower(trim(email)))），只在博主密钥功能开启时才下发。
func EmailHash(email string) string {
	return sha256Hex(email)
}

// ResolveAdminEmailsFromSettings 从库里解析管理员列表（含旧键回落）。
func ResolveAdminEmailsFromSettings() []string {
	return ResolveAdminEmails(GetSetting(AdminEmailsKey), GetSetting(AdminEmailKey))
}

// ResolveNotifyEmailFromSettings 从库里解析通知收件人（含回落列表第一个）。
func ResolveNotifyEmailFromSettings() string {
	return ResolveNotifyEmail(GetSetting(NotifyEmailKey), ResolveAdminEmailsFromSettings())
}

// ValidateAdminEmails 写入路径校验（严格）。通过时返回**归一化去重后**的 JSON 数组
// 字符串（写入路径存的就是它），否则返回错误信息。
func ValidateAdminEmails(raw string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "[]", ""
	}

	var items []interface{}
	if err := json.Unmarshal([]byte(value), &items); err != nil {
		return "", "admin_emails 必须是 JSON 数组"
	}

	// 判定顺序与 Node / Worker 逐条一致：
	// 非字符串项 → 归一化去空去重 → 超过 10 个 → 非法邮箱
	// （先查数量再查合法性：同一个值同时踩两条时三端必须给出同一条文案）
	normalized := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return "", "admin_emails 的每一项都必须是字符串"
		}
		email := NormalizeEmail(text)
		if email == "" || seen[email] {
			continue
		}
		seen[email] = true
		normalized = append(normalized, email)
	}

	if len(normalized) > MaxAdminEmails {
		return "", "admin_emails 最多 10 个邮箱"
	}
	for _, email := range normalized {
		if !IsValidEmail(email) {
			return "", "admin_emails 包含非法邮箱地址"
		}
	}

	return mustJSONArray(normalized), ""
}

// ValidateNotifyEmail 写入路径校验（严格）：
//
//   - trim 后为空 = 清空（读取时回落列表第一个），合法；
//   - 否则必须是合法邮箱，且归一化后必须命中管理员列表。
//
// admins 是判定用的列表：同一次请求里若同时提交了 admin_emails，调用方必须传**新列表**。
func ValidateNotifyEmail(raw string, admins []string) (string, string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ""
	}
	email := NormalizeEmail(value)
	if !IsValidEmail(email) {
		return "", "notify_email 必须是合法的邮箱地址"
	}
	if !IsAdminEmail(email, admins) {
		return "", "notify_email 必须在管理员邮箱列表中"
	}
	return email, ""
}

// mustJSONArray 把字符串数组序列化为紧凑 JSON（失败时回落空数组）。
func mustJSONArray(items []string) string {
	if items == nil {
		items = []string{}
	}
	data, err := json.Marshal(items)
	if err != nil {
		return "[]"
	}
	return string(data)
}
