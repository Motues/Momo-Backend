package utils

import (
	"errors"
	"strings"
	"testing"
)

/*
邮件发送日志（MailLog）：写入点在最底层的发送函数 SendRaw。

覆盖六种邮件类型各记一行、失败时记 failed 且错误照旧抛给调用方、
SMTP 未配置的「跳过」不记录，以及 30 天保留策略（每次写日志顺手清理超窗口的行）。
*/

// mailLogTestRow 邮件日志的一行（error 用指针，才能断言成功行是 NULL）
type mailLogTestRow struct {
	ID        int64   `db:"id"`
	Type      string  `db:"type"`
	Recipient string  `db:"recipient"`
	Subject   string  `db:"subject"`
	Status    string  `db:"status"`
	Error     *string `db:"error"`
	CreatedAt string  `db:"created_at"`
}

// clearMailLogTable 清空邮件日志表（用例隔离）
func clearMailLogTable(t *testing.T) {
	t.Helper()
	if _, err := testSettingsDB.Exec("DELETE FROM MailLog"); err != nil {
		t.Fatalf("清空 MailLog 失败: %v", err)
	}
}

// mailLogRowsInTest 读取全部邮件日志（按 id 升序）
func mailLogRowsInTest(t *testing.T) []mailLogTestRow {
	t.Helper()
	var rows []mailLogTestRow
	if err := testSettingsDB.Select(&rows,
		`SELECT id, type, recipient, subject, status, error, created_at FROM MailLog ORDER BY id ASC`); err != nil {
		t.Fatalf("读取 MailLog 失败: %v", err)
	}
	return rows
}

// installFakeSendHook 注入假发送器（err 非 nil 时每次发送都失败），用例结束还原
func installFakeSendHook(t *testing.T, err error) {
	t.Helper()
	SetSendMailHookForTest(func(mailType, to, subject, body string) error { return err })
	t.Cleanup(func() { SetSendMailHookForTest(nil) })
}

// configureSendableService 让邮件服务「可用」并配好管理员收件人
func configureSendableService(t *testing.T) {
	t.Helper()
	setSetting(t, "smtp_host", "smtp.example.com")
	setSetting(t, "email_user", "noreply@example.com")
	setSetting(t, "email_password", "secret")
	setSetting(t, "site_name", "Momo Blog")
	setSetting(t, "admin_email", "admin@example.com")
}

// TestSendRawLogsAllSixMailTypes 六种类型各发一封 → 六行日志，类型与状态都正确
func TestSendRawLogsAllSixMailTypes(t *testing.T) {
	resetSettings(t)
	clearMailLogTable(t)
	configureSendableService(t)
	installFakeSendHook(t, nil)

	svc := GetService()
	if !svc.IsAvailable() {
		t.Fatalf("前置条件：SMTP 配置完整时服务应可用")
	}

	if err := svc.SendVerificationEmail("a@b.com", "甲", "标题", "/p", "https://x/verify"); err != nil {
		t.Fatalf("发送验证邮件失败: %v", err)
	}
	if err := svc.SendLinkSyncConfirmationEmail("a@b.com", "甲", "https://old", "https://new", "标题", "https://x", "https://x/confirm"); err != nil {
		t.Fatalf("发送链接同步邮件失败: %v", err)
	}
	if err := svc.SendDormantNoticeEmail("a@b.com", "甲", "https://a.example.com", "https://x/notice", 30); err != nil {
		t.Fatalf("发送休眠提醒失败: %v", err)
	}
	if err := svc.SendCommentNotification("标题", "https://x", "甲", "内容", "<p>内容</p>"); err != nil {
		t.Fatalf("发送评论通知失败: %v", err)
	}
	if err := svc.SendCommentReplyNotification("a@b.com", "甲", "标题", "原评论", "乙", "回复", "https://x", "<p>原</p>", "<p>回</p>"); err != nil {
		t.Fatalf("发送回复通知失败: %v", err)
	}
	if err := svc.SendRaw(MailTypeTest, "admin@example.com", "SMTP 配置验证", "<p>test</p>"); err != nil {
		t.Fatalf("发送测试邮件失败: %v", err)
	}

	rows := mailLogRowsInTest(t)
	if len(rows) != 6 {
		t.Fatalf("六种类型应各记一行（共 6 行），实际 %d 行: %+v", len(rows), rows)
	}

	wantByIndex := []string{
		MailTypeVerify, MailTypeLinkSync, MailTypeDormantNotice,
		MailTypeCommentNotify, MailTypeReplyNotify, MailTypeTest,
	}
	for i, want := range wantByIndex {
		if rows[i].Type != want {
			t.Errorf("第 %d 行的类型期望 %q，实际 %q", i, want, rows[i].Type)
		}
		if rows[i].Status != MailStatusSent {
			t.Errorf("第 %d 行的状态期望 sent，实际 %q", i, rows[i].Status)
		}
		if rows[i].Error != nil {
			t.Errorf("成功行的 error 应为 NULL，实际 %v", *rows[i].Error)
		}
		if rows[i].Recipient == "" || rows[i].Subject == "" {
			t.Errorf("第 %d 行缺少收件人或主题: %+v", i, rows[i])
		}
		if !hasTrustTimeLayout(rows[i].CreatedAt) {
			t.Errorf("created_at 应是 %s 格式，实际 %q", TrustTimeLayout, rows[i].CreatedAt)
		}
	}

	// 主题是模板插值后的最终字符串
	if rows[2].Subject != "您在 Momo Blog 的个人网站链接已进入休眠" {
		t.Errorf("休眠提醒主题不正确: %q", rows[2].Subject)
	}
	if rows[3].Recipient != "admin@example.com" {
		t.Errorf("评论通知的收件人应为解析后的 notify_email，实际 %q", rows[3].Recipient)
	}
}

// TestSendRawLogsFailureAndPropagatesError 发送失败 → failed + 错误信息，且调用方仍看到原来的错误
func TestSendRawLogsFailureAndPropagatesError(t *testing.T) {
	resetSettings(t)
	clearMailLogTable(t)
	configureSendableService(t)
	installFakeSendHook(t, errors.New("smtp boom"))

	svc := GetService()

	// 底层出口：错误照旧抛给调用方
	err := svc.SendRaw(MailTypeTest, "a@b.com", "主题", "<p>x</p>")
	if err == nil || !strings.Contains(err.Error(), "smtp boom") {
		t.Fatalf("SendRaw 应把底层错误原样抛出，实际 %v", err)
	}

	// 上层发送函数同样照旧看到错误（日志绝不改变发送语义）
	err = svc.SendVerificationEmail("a@b.com", "甲", "标题", "/p", "https://x/verify")
	if err == nil || !strings.Contains(err.Error(), "smtp boom") {
		t.Fatalf("SendVerificationEmail 应把底层错误原样抛出，实际 %v", err)
	}

	rows := mailLogRowsInTest(t)
	if len(rows) != 2 {
		t.Fatalf("两次失败应记两行，实际 %d 行", len(rows))
	}
	for i, row := range rows {
		if row.Status != MailStatusFailed {
			t.Errorf("第 %d 行的状态期望 failed，实际 %q", i, row.Status)
		}
		if row.Error == nil || !strings.Contains(*row.Error, "smtp boom") {
			t.Errorf("第 %d 行应记录失败原因，实际 %v", i, row.Error)
		}
	}

	// 超长错误信息必须被截断（避免撑爆表）
	installFakeSendHook(t, errors.New(strings.Repeat("x", 2000)))
	clearMailLogTable(t)
	if err := svc.SendRaw(MailTypeTest, "a@b.com", "主题", "<p>x</p>"); err == nil {
		t.Fatalf("应返回错误")
	}
	rows = mailLogRowsInTest(t)
	if len(rows) != 1 {
		t.Fatalf("应记一行，实际 %d 行", len(rows))
	}
	if rows[0].Error == nil || len(*rows[0].Error) > 500 {
		t.Errorf("失败原因应被截断到 500 字符以内，实际 %d 字符", len(*rows[0].Error))
	}
}

// TestSendRawSkipsLogWhenServiceUnavailable SMTP 未配置 / 邮件通知关闭都属于「跳过」，不记录
func TestSendRawSkipsLogWhenServiceUnavailable(t *testing.T) {
	resetSettings(t)
	clearMailLogTable(t)
	installFakeSendHook(t, nil)

	svc := GetService()
	if svc.IsAvailable() {
		t.Fatalf("前置条件：SMTP 未配置时服务应不可用")
	}
	if err := svc.SendRaw(MailTypeTest, "a@b.com", "主题", "<p>x</p>"); err == nil {
		t.Fatalf("服务不可用时应返回错误")
	}
	if rows := mailLogRowsInTest(t); len(rows) != 0 {
		t.Errorf("SMTP 未配置的「跳过」不应记录，实际 %d 行", len(rows))
	}

	// email_enabled = "false"：同样一封都不发、也不记录
	configureSendableService(t)
	setSetting(t, "email_enabled", "false")
	if svc := GetService(); !svc.IsAvailable() {
		t.Fatalf("前置条件：SMTP 配置完整时服务应可用")
	}
	if err := svc.SendRaw(MailTypeTest, "a@b.com", "主题", "<p>x</p>"); err == nil {
		t.Fatalf("邮件通知关闭时应返回错误（调用方据此跳过）")
	}
	if rows := mailLogRowsInTest(t); len(rows) != 0 {
		t.Errorf("邮件通知关闭的「跳过」不应记录，实际 %d 行", len(rows))
	}
}

// TestMailLogRetention 每次写日志顺手清理超过保留期的行（默认 30 天，可通过设置自定义）
func TestMailLogRetention(t *testing.T) {
	resetSettings(t)
	clearMailLogTable(t)
	configureSendableService(t)
	installFakeSendHook(t, nil)

	now := int64(1_800_000_000_000)
	SetNowMillisForMailLogForTest(func() int64 { return now })
	t.Cleanup(func() { SetNowMillisForMailLogForTest(nil) })

	// 手工插入一条 31 天前的行（正好在窗口外）与一条 29 天前的行（窗口内）
	if _, err := testSettingsDB.Exec(`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
		VALUES (?, 'old@b.com', '旧的', 'sent', NULL, ?)`, MailTypeTest, FormatTrustTime(now-31*DayMillis)); err != nil {
		t.Fatalf("写入历史行失败: %v", err)
	}
	boundary := FormatTrustTime(now - 29*DayMillis)
	if _, err := testSettingsDB.Exec(`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
		VALUES (?, 'keep@b.com', '保留的', 'sent', NULL, ?)`, MailTypeTest, boundary); err != nil {
		t.Fatalf("写入窗口内的行失败: %v", err)
	}

	svc := GetService()
	if err := svc.SendRaw(MailTypeTest, "new@b.com", "新的", "<p>x</p>"); err != nil {
		t.Fatalf("发送失败: %v", err)
	}

	rows := mailLogRowsInTest(t)
	if len(rows) != 2 {
		t.Fatalf("清理后应剩 2 行（窗口内 + 新写的），实际 %d 行: %+v", len(rows), rows)
	}
	for _, row := range rows {
		if row.Recipient == "old@b.com" {
			t.Errorf("31 天前的行应被清理")
		}
	}

	// 默认保留天数与响应里的 retentionDays 同源
	if MailLogRetentionDays != 30 {
		t.Errorf("默认保留天数应为 30，实际 %d", MailLogRetentionDays)
	}
	if got := MailLogRetentionDaysFromSettings(); got != MailLogRetentionDays {
		t.Errorf("未配置时生效值应为默认 %d，实际 %d", MailLogRetentionDays, got)
	}
}

// TestMailLogRetentionCustom 自定义保留天数（面板「邮件通知设置 → 邮件记录」）
func TestMailLogRetentionCustom(t *testing.T) {
	t.Run("设置为 7 天：只清理 7 天以前的行", func(t *testing.T) {
		resetSettings(t)
		clearMailLogTable(t)
		configureSendableService(t)
		installFakeSendHook(t, nil)
		setSetting(t, MailLogRetentionKey, "7")

		now := int64(1_800_000_000_000)
		SetNowMillisForMailLogForTest(func() int64 { return now })
		t.Cleanup(func() { SetNowMillisForMailLogForTest(nil) })

		for _, item := range []struct {
			recipient string
			agoDays   int64
		}{
			{"old@b.com", 8},
			{"keep@b.com", 6},
		} {
			if _, err := testSettingsDB.Exec(
				`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
				 VALUES (?, ?, 'x', 'sent', NULL, ?)`,
				MailTypeTest, item.recipient, FormatTrustTime(now-item.agoDays*DayMillis),
			); err != nil {
				t.Fatalf("写入历史行失败: %v", err)
			}
		}

		if err := GetService().SendRaw(MailTypeTest, "new@b.com", "新的", "<p>x</p>"); err != nil {
			t.Fatalf("发送失败: %v", err)
		}

		recipients := map[string]bool{}
		for _, row := range mailLogRowsInTest(t) {
			recipients[row.Recipient] = true
		}
		if recipients["old@b.com"] {
			t.Errorf("8 天前的行应被清理（保留 7 天）")
		}
		if !recipients["keep@b.com"] || !recipients["new@b.com"] {
			t.Errorf("窗口内与新写入的行都应保留，实际 %v", recipients)
		}
		if got := MailLogRetentionDaysFromSettings(); got != 7 {
			t.Errorf("生效值应为 7，实际 %d", got)
		}
	})

	t.Run("设置为 0：永久保留，不清理任何行", func(t *testing.T) {
		resetSettings(t)
		clearMailLogTable(t)
		configureSendableService(t)
		installFakeSendHook(t, nil)
		setSetting(t, MailLogRetentionKey, "0")

		now := int64(1_800_000_000_000)
		SetNowMillisForMailLogForTest(func() int64 { return now })
		t.Cleanup(func() { SetNowMillisForMailLogForTest(nil) })

		if _, err := testSettingsDB.Exec(
			`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
			 VALUES (?, 'ancient@b.com', 'x', 'sent', NULL, ?)`,
			MailTypeTest, FormatTrustTime(now-3000*DayMillis),
		); err != nil {
			t.Fatalf("写入历史行失败: %v", err)
		}

		if err := GetService().SendRaw(MailTypeTest, "new@b.com", "新的", "<p>x</p>"); err != nil {
			t.Fatalf("发送失败: %v", err)
		}

		if rows := mailLogRowsInTest(t); len(rows) != 2 {
			t.Fatalf("永久保留时不应清理，期望 2 行，实际 %d 行", len(rows))
		}
		if _, ok := MailLogCutoff(now); ok {
			t.Errorf("保留天数为 0 时不应返回时间下限")
		}
	})

	t.Run("归一化与写入校验", func(t *testing.T) {
		if got := ResolveMailLogRetentionDays(""); got != MailLogRetentionDays {
			t.Errorf("空值应回退 %d，实际 %d", MailLogRetentionDays, got)
		}
		if got := ResolveMailLogRetentionDays("abc"); got != MailLogRetentionDays {
			t.Errorf("脏值应回退 %d，实际 %d", MailLogRetentionDays, got)
		}
		if got := ResolveMailLogRetentionDays("-5"); got != 0 {
			t.Errorf("负数应视为永久保留 0，实际 %d", got)
		}
		if got := ResolveMailLogRetentionDays("0"); got != 0 {
			t.Errorf("0 应视为永久保留，实际 %d", got)
		}
		if got := ResolveMailLogRetentionDays("99999"); got != MaxMailLogRetentionDays {
			t.Errorf("超上限应夹取到 %d，实际 %d", MaxMailLogRetentionDays, got)
		}

		if value, msg := ValidateMailLogRetentionDays(" 030 "); msg != "" || value != "30" {
			t.Errorf("030 应归一化为 \"30\"，实际 (%q, %q)", value, msg)
		}
		for _, bad := range []string{"", "   ", "-1", "1.5", "3651", "abc", "30d"} {
			if _, msg := ValidateMailLogRetentionDays(bad); msg == "" {
				t.Errorf("取值 %q 不应通过写入校验", bad)
			}
		}
	})
}

// TestMailLogTypeAllowed 邮件类型枚举（管理端筛选用）
func TestMailLogTypeAllowed(t *testing.T) {
	for _, mailType := range []string{
		MailTypeVerify, MailTypeLinkSync, MailTypeDormantNotice,
		MailTypeCommentNotify, MailTypeReplyNotify, MailTypeTest,
	} {
		if !MailLogTypeAllowed(mailType) {
			t.Errorf("%q 应是合法类型", mailType)
		}
	}
	for _, mailType := range []string{"", "all", "unknown", "VERIFY", "verify "} {
		if MailLogTypeAllowed(mailType) {
			t.Errorf("%q 不应是合法类型", mailType)
		}
	}
}
