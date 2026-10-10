package utils

import (
	"encoding/json"
	"log"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 评论审核自动化（垃圾规则）。
//
// 与 comment_auto_approve 合并为一个开关，语义与 Node / Worker 逐字一致：
//   - comment_auto_approve = "false" → 所有评论 pending（历史行为）；
//   - 否则：命中任一垃圾规则 → pending，未命中 → approved；
//   - 管理员密钥已验证的博主评论永远 approved，不参与规则判定。
//
// 四条规则：
//  1. 敏感关键词：JSON 数组，不区分大小写，命中「正文 / 昵称 / 网址」任一即垃圾；
//  2. 链接数：正文中的 http(s)://… 与裸 www.  + 个人网址字段（计 1），超过阈值即垃圾；
//  3. 正文长度：按 Unicode 码点计算，低于阈值即垃圾；
//  4. 重复内容：同一 IP 在时间窗内提交过完全相同的正文即垃圾。
//
// 阈值 0 一律表示「不启用该规则」，且四项默认值全部为 0：升级后行为与旧版本完全一致，
// 不会凭空拦下任何评论。后台页面会给出建议值（链接 3 / 正文 5 字符 / 重复 10 分钟）供按需填写。
const (
	// SpamMaxKeywords 关键词条数上限
	SpamMaxKeywords = 200
	// SpamMaxKeywordLength 单条关键词长度上限（Unicode 码点）
	SpamMaxKeywordLength = 100
	// SpamMaxLinks 链接数阈值上限
	SpamMaxLinks = 50
	// SpamMaxMinLength 正文长度阈值上限
	SpamMaxMinLength = 2000
	// SpamMaxDuplicateWindowMinutes 重复检测时间窗上限（分钟，7 天）
	SpamMaxDuplicateWindowMinutes = 10080

	// 未配置时的默认阈值：全部为 0（不启用），与后台页面的默认值保持一致
	SpamDefaultMaxLinks        = 0
	SpamDefaultMinLength       = 0
	SpamDefaultDuplicateWindow = 0
)

// 匹配带协议的链接（连同后面的非空白字符一起吃掉，避免与裸 www. 重复计数）
var spamSchemeLinkRe = regexp.MustCompile(`(?i)https?://\S*`)

// 匹配裸域名形式的链接
var spamBareWwwRe = regexp.MustCompile(`(?i)www\.`)

// ParseSpamKeywords 解析敏感关键词配置。
//
// 配置损坏或类型不对时返回空切片（等于该规则不生效）并留下告警 ——
// 与 IP/邮箱黑名单一致：一条坏配置不能让全站评论都被判为垃圾。
// 关键词统一转小写，匹配时不区分大小写。
func ParseSpamKeywords(raw string) []string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}

	// 用 []any 而不是 []string 接收：数组里混入一个非字符串（手工改库才可能出现的
	// 坏数据）不应让整份关键词配置失效 —— Node / Worker 的同类解析同样是逐项过滤。
	var parsed []any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		log.Printf("[WARN] comment_spam_keywords 不是合法 JSON，关键词规则已被跳过，请在后台修复该配置: %v", err)
		return nil
	}

	keywords := make([]string, 0, len(parsed))
	for _, entry := range parsed {
		value, ok := entry.(string)
		if !ok {
			continue
		}
		if kw := strings.ToLower(strings.TrimSpace(value)); kw != "" {
			keywords = append(keywords, kw)
		}
	}
	return keywords
}

// ParseSpamNumber 解析数值型配置：非法值退回默认值，超上限按上限夹取。
// 与 Node 的 parseSpamNumber 语义一致（只接受非负整数字符串）。
func ParseSpamNumber(raw string, fallback, max int) int {
	text := strings.TrimSpace(raw)
	if text == "" {
		return fallback
	}
	value := 0
	for _, r := range text {
		if r < '0' || r > '9' {
			return fallback
		}
		value = value*10 + int(r-'0')
		if value > max {
			return max
		}
	}
	if value > max {
		return max
	}
	return value
}

// CountLinks 统计正文中的链接数量（只数正文，个人网址字段由调用方另计 1）。
func CountLinks(text string) int {
	if text == "" {
		return 0
	}
	schemeLinks := len(spamSchemeLinkRe.FindAllString(text, -1))
	rest := spamSchemeLinkRe.ReplaceAllString(text, " ")
	bareLinks := len(spamBareWwwRe.FindAllString(rest, -1))
	return schemeLinks + bareLinks
}

// EvaluateSpamRules 纯函数规则判定：返回命中原因（用于日志），未命中返回空串。
//
// 与 DB 无关，便于三端做完全一致的单元测试与向量对齐。
func EvaluateSpamRules(content, author, url string, keywords []string, maxLinks, minLength int) string {
	// 1. 敏感关键词（正文 / 昵称 / 网址）
	if len(keywords) > 0 {
		haystack := strings.ToLower(content + "\n" + author + "\n" + url)
		for _, keyword := range keywords {
			if strings.Contains(haystack, keyword) {
				return "keyword:" + keyword
			}
		}
	}

	// 2. 链接数（正文链接 + 个人网址字段）
	if maxLinks > 0 {
		links := CountLinks(content)
		if url != "" {
			links++
		}
		if links > maxLinks {
			return "too_many_links:" + strconv.Itoa(links)
		}
	}

	// 3. 正文长度（Unicode 码点）
	if minLength > 0 {
		length := utf8.RuneCountInString(strings.TrimSpace(content))
		if length < minLength {
			return "too_short:" + strconv.Itoa(length)
		}
	}

	return ""
}

// GetCommentSpamSettings 读取四项垃圾规则配置。
func GetCommentSpamSettings() (keywords []string, maxLinks, minLength, duplicateWindow int) {
	keywords = ParseSpamKeywords(GetSetting("comment_spam_keywords"))
	maxLinks = ParseSpamNumber(GetSetting("comment_spam_max_links"), SpamDefaultMaxLinks, SpamMaxLinks)
	minLength = ParseSpamNumber(GetSetting("comment_spam_min_length"), SpamDefaultMinLength, SpamMaxMinLength)
	duplicateWindow = ParseSpamNumber(GetSetting("comment_spam_duplicate_window"), SpamDefaultDuplicateWindow, SpamMaxDuplicateWindowMinutes)
	return
}

// IsValidSpamKeywordsJSON 校验敏感关键词 JSON：必须是非空字符串数组，条数与单条长度都受限。
func IsValidSpamKeywordsJSON(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return true
	}
	var parsed []string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return false
	}
	if len(parsed) > SpamMaxKeywords {
		return false
	}
	for _, entry := range parsed {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > SpamMaxKeywordLength {
			return false
		}
	}
	return true
}

// IsSpamSettingKey 判断某个键是否属于垃圾规则设置。
func IsSpamSettingKey(key string) bool {
	switch key {
	case "comment_spam_keywords", "comment_spam_max_links", "comment_spam_min_length", "comment_spam_duplicate_window":
		return true
	default:
		return false
	}
}

// ValidateSpamSetting 校验一条垃圾规则设置。
//
// 通过返回空串，否则返回错误信息（与 Node / Worker 文案一致）。
// 空串表示「未设置」→ 使用默认值，允许。
func ValidateSpamSetting(key, raw string) string {
	value := strings.TrimSpace(raw)

	switch key {
	case "comment_spam_keywords":
		if IsValidSpamKeywordsJSON(value) {
			return ""
		}
		return "comment_spam_keywords must be a JSON array of at most 200 non-empty strings"
	case "comment_spam_max_links":
		if value == "" || isSpamIntInRange(value, 0, SpamMaxLinks) {
			return ""
		}
		return "comment_spam_max_links must be an integer between 0 and 50"
	case "comment_spam_min_length":
		if value == "" || isSpamIntInRange(value, 0, SpamMaxMinLength) {
			return ""
		}
		return "comment_spam_min_length must be an integer between 0 and 2000"
	case "comment_spam_duplicate_window":
		if value == "" || isSpamIntInRange(value, 0, SpamMaxDuplicateWindowMinutes) {
			return ""
		}
		return "comment_spam_duplicate_window must be an integer between 0 and 10080"
	default:
		return ""
	}
}

func isSpamIntInRange(value string, min, max int) bool {
	if value == "" {
		return false
	}
	n := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
		n = n*10 + int(r-'0')
		if n > max {
			return false
		}
	}
	return n >= min
}
