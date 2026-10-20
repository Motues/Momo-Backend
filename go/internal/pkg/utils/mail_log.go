package utils

import (
	"log"
	"strconv"
	"strings"
	"time"
)

/*
邮件发送日志（MailLog）。

写入点只有一处：最底层的发送函数 EmailService.SendRaw —— 各上层发送函数把自己的
类型传进来，因此「一次实际尝试过的发送 = 一行」。SMTP 未配置 / 邮件通知关闭导致的
「跳过」不会走到这里（调用方在拿到配置之前就 return 了），面板只看真正尝试过的发送。

口径（见任务规范第 2、3、9 节）：
  - 邮件类型：verify / link_sync / dormant_notice / comment_notify / reply_notify / test；
  - 状态：sent / failed；
  - 保留天数由设置项 mail_log_retention_days 决定（默认 30 天，0 = 永久保留）：
    每次写日志顺手清理超窗口的行，列表接口也只回窗口内的行；
  - 写日志本身失败一律无声吞掉（只写服务端日志），绝不影响发信结果。
*/

const (
	// MailTypeVerify 邮箱验证邮件
	MailTypeVerify = "verify"
	// MailTypeLinkSync 历史链接同步确认邮件
	MailTypeLinkSync = "link_sync"
	// MailTypeDormantNotice 休眠链接提醒邮件
	MailTypeDormantNotice = "dormant_notice"
	// MailTypeCommentNotify 新评论通知（发给管理员）
	MailTypeCommentNotify = "comment_notify"
	// MailTypeReplyNotify 回复通知（发给被回复的评论者）
	MailTypeReplyNotify = "reply_notify"
	// MailTypeTest 后台「测试邮件」
	MailTypeTest = "test"

	// MailStatusSent 发送成功
	MailStatusSent = "sent"
	// MailStatusFailed 发送失败
	MailStatusFailed = "failed"

	// MailLogRetentionKey 邮件日志保留天数的设置键（面板「邮件通知设置 → 邮件记录」写入）
	MailLogRetentionKey = "mail_log_retention_days"
	// MailLogRetentionDays 默认保留天数（未配置 / 脏值时的回退值）
	MailLogRetentionDays = 30
	// MaxMailLogRetentionDays 保留天数上限（与认证记录的保留天数同一口径）
	MaxMailLogRetentionDays = 3650

	// mailLogMaxErrorLen 失败原因的最大长度（截断到合理长度，避免超长错误串撑爆表）
	mailLogMaxErrorLen = 500
)

// mailLogRetentionMessage 非法保留天数的错误文案（三端逐字一致）
const mailLogRetentionMessage = "mail_log_retention_days 必须是 0-3650 之间的整数"

// ResolveMailLogRetentionDays 读取路径的保留天数归一化（宽容）：
//
//   - 未配置 / 非整数（""、"abc"、"1.5"）→ 默认 30 天；
//   - 0 或负数 → **永久保留**（不清理、列表不做时间下限）；
//   - 大于上限 → 夹取到 3650。
func ResolveMailLogRetentionDays(stored string) int {
	text := strings.TrimSpace(stored)
	if text == "" {
		return MailLogRetentionDays
	}
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = strings.TrimPrefix(text, "-")
	}
	days, ok := parseDecimalDays(text)
	if !ok {
		return MailLogRetentionDays
	}
	if negative || days <= 0 {
		return 0
	}
	if days > MaxMailLogRetentionDays {
		return MaxMailLogRetentionDays
	}
	return days
}

// ValidateMailLogRetentionDays 写入路径校验：0–3650 的十进制整数。
// 通过时返回**规范化后的十进制字符串**（写入路径存的就是它）。
func ValidateMailLogRetentionDays(raw string) (string, string) {
	days, ok := parseDecimalDays(strings.TrimSpace(raw))
	if !ok || days > MaxMailLogRetentionDays {
		return "", mailLogRetentionMessage
	}
	return strconv.Itoa(days), ""
}

// MailLogRetentionDaysFromSettings 读取当前生效的保留天数（0 = 永久保留）。
func MailLogRetentionDaysFromSettings() int {
	return ResolveMailLogRetentionDays(GetSetting(MailLogRetentionKey))
}

// MailLogTypeAllowed 判断邮件类型是否是已定义的枚举（管理端列表筛选用）。
func MailLogTypeAllowed(mailType string) bool {
	switch mailType {
	case MailTypeVerify, MailTypeLinkSync, MailTypeDormantNotice,
		MailTypeCommentNotify, MailTypeReplyNotify, MailTypeTest:
		return true
	default:
		return false
	}
}

// MailLogCutoff 返回保留窗口的起点（「现在 - N 天」，ISO 8601 UTC，与 created_at 同一格式）。
// 第二个返回值为 false 表示永久保留（不清理、列表不加时间下限）。
func MailLogCutoff(nowMs int64) (string, bool) {
	days := MailLogRetentionDaysFromSettings()
	if days <= 0 {
		return "", false
	}
	return FormatTrustTime(nowMs - int64(days)*DayMillis), true
}

// nowMillisForMailLog 返回当前时间的毫秒值。抽成包级变量是为了让保留策略的用例
// 能精确固定「现在」（生产路径就是 time.Now().UnixMilli()）。
var nowMillisForMailLog = func() int64 { return time.Now().UnixMilli() }

// SetNowMillisForMailLogForTest 仅供测试固定邮件日志的「现在」；传 nil 恢复真实时间。
func SetNowMillisForMailLogForTest(fn func() int64) {
	if fn == nil {
		nowMillisForMailLog = func() int64 { return time.Now().UnixMilli() }
		return
	}
	nowMillisForMailLog = fn
}

// RecordMailLog 记一行邮件发送日志，并顺手清理超过保留期的行。
//
// 这是**尽力而为**的写入：任何失败（表缺失、数据库忙）都只写服务端日志，
// 绝不返回错误、更不影响发信结果。
func RecordMailLog(mailType, recipient, subject, status, errMsg string) {
	if settingsDB == nil {
		return
	}

	nowMs := nowMillisForMailLog()
	createdAt := FormatTrustTime(nowMs)

	var errorValue interface{}
	if status == MailStatusFailed {
		errorValue = truncateMailError(errMsg)
	}

	if _, err := settingsDB.Exec(
		`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		mailType, recipient, subject, status, errorValue, createdAt,
	); err != nil {
		log.Printf("[WARN] 写入邮件日志失败（不影响发信）: %v", err)
		return
	}

	// 保留策略：走 idx_ml_created；保留天数为 0（永久保留）时不清
	if cutoff, ok := MailLogCutoff(nowMs); ok {
		if _, err := settingsDB.Exec(
			`DELETE FROM MailLog WHERE created_at < ?`, cutoff,
		); err != nil {
			log.Printf("[WARN] 清理过期邮件日志失败（不影响发信）: %v", err)
		}
	}
}

// truncateMailError 截断错误信息（成功时为 NULL，由调用方保证不传空串之外的脏值）。
func truncateMailError(errMsg string) string {
	errMsg = strings.TrimSpace(errMsg)
	if len(errMsg) <= mailLogMaxErrorLen {
		return errMsg
	}
	// 按字节截断：错误串基本是 ASCII（Go 的 error 文案），不会切出半个 UTF-8 字符的概率极低；
	// 即便如此也只是日志可读性问题，不影响任何业务语义。
	return errMsg[:mailLogMaxErrorLen]
}
