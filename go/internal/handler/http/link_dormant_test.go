package http

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：休眠链接提醒（DormantNotice，任务规范第 4、6、8 节）。

覆盖：惰性检测（读一次公开评论列表 → 发一封提醒 + 落记录 + 写邮件日志）、同一休眠周期不重复发、
新的休眠周期再发、记录过期后再发、功能关闭 / SMTP 未配置不落记录，
以及提醒页三个端点（notice / confirm / update）的全部文案与副作用。
*/

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// sentMail 一次假发送的记录
type sentMail struct {
	MailType string
	To       string
	Subject  string
	Body     string
}

// fakeMailer 假的邮件投递器：记录每次发送，并可让发送失败
type fakeMailer struct {
	mu   sync.Mutex
	sent []sentMail
	err  error
}

func (f *fakeMailer) hook() func(string, string, string, string) error {
	return func(mailType, to, subject, body string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.err != nil {
			return f.err
		}
		f.sent = append(f.sent, sentMail{MailType: mailType, To: to, Subject: subject, Body: body})
		return nil
	}
}

// list 返回已发送的邮件快照
func (f *fakeMailer) list() []sentMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMail(nil), f.sent...)
}

// count 返回已发送的邮件数
func (f *fakeMailer) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

// installFakeMailer 注入假投递器（err 非 nil 时每次发送都失败），用例结束自动还原
func installFakeMailer(t *testing.T, err error) *fakeMailer {
	t.Helper()
	fake := &fakeMailer{err: err}
	utils.SetSendMailHookForTest(fake.hook())
	t.Cleanup(func() { utils.SetSendMailHookForTest(nil) })
	return fake
}

// syncDormantTasks 让休眠提醒的「异步」任务同步执行，断言才有确定性
func syncDormantTasks(t *testing.T) {
	t.Helper()
	original := runDormantTask
	runDormantTask = func(fn func()) { fn() }
	t.Cleanup(func() { runDormantTask = original })
}

// callForm 以 application/x-www-form-urlencoded 提交表单（浏览器原生表单的行为）
func callForm(t *testing.T, target string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", target, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = nextRemoteAddr()

	w := httptest.NewRecorder()
	testRouter.ServeHTTP(w, req)
	return w
}

// dormantNoticeRow 读取唯一的休眠提醒记录
func dormantNoticeRow(t *testing.T) *model.DormantNotice {
	t.Helper()
	var row model.DormantNotice
	if err := testDB.Get(&row, "SELECT * FROM DormantNotice ORDER BY id DESC LIMIT 1"); err != nil {
		t.Fatalf("读取 DormantNotice 失败: %v", err)
	}
	return &row
}

// dormantNoticeCount 统计休眠提醒记录数
func dormantNoticeCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM DormantNotice"); err != nil {
		t.Fatalf("统计 DormantNotice 失败: %v", err)
	}
	return n
}

// seedDormantNotice 直接写入一条提醒记录（构造端点用例的前置状态）
func seedDormantNotice(t *testing.T, email, targetURL, token, expiresAt string, lastCommentAt int64) {
	t.Helper()
	if _, err := testDB.Exec(`INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at, notify_count)
		VALUES (?, ?, ?, ?, ?, ?, 1)`,
		email, targetURL, lastCommentAt, token, expiresAt, expiresAt); err != nil {
		t.Fatalf("写入 DormantNotice 失败: %v", err)
	}
}

// mailLogRows 读取全部邮件日志（按 id 升序）
func mailLogRows(t *testing.T) []model.MailLog {
	t.Helper()
	var rows []model.MailLog
	if err := testDB.Select(&rows, `SELECT id, type, recipient, subject, status, COALESCE(error, '') AS error, created_at
		FROM MailLog ORDER BY id ASC`); err != nil {
		t.Fatalf("读取 MailLog 失败: %v", err)
	}
	return rows
}

// mailLogCountOf 统计某一类型的邮件日志行数
func mailLogCountOf(t *testing.T, mailType string) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM MailLog WHERE type = ?", mailType); err != nil {
		t.Fatalf("统计 MailLog 失败: %v", err)
	}
	return n
}

// enableDormantNoticeForTest 打开休眠提醒邮件的前提（doc/link_security.md 第 2.7 节）：
// 提醒开关本身 + API 地址（不再依赖邮箱验证）。
func enableDormantNoticeForTest(t *testing.T) {
	t.Helper()
	setSetting(t, utils.LinkDormantNoticeEnabledKey, "true")
	setSetting(t, "verify_base_url", "https://blog.example.com")
}

// ---------------------------------------------------------------------------
// 惰性检测
// ---------------------------------------------------------------------------

// TestDormantNoticeSweep 读一次公开评论列表触发提醒，并验证四个状态机分支
func TestDormantNoticeSweep(t *testing.T) {
	now := int64(1800000000000)
	day := int64(86400000)

	t.Run("首次读取：发一封提醒 + 落一条记录 + 写一条 dormant_notice 日志", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)
		setSetting(t, "site_name", "Momo Blog")

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		comments := linkComments(t)
		if got := comments["甲"]; got == nil || !got.UrlDormant {
			t.Fatalf("前置条件：该评论应处于休眠，实际 %+v", got)
		}

		sent := fake.list()
		if len(sent) != 1 {
			t.Fatalf("应恰好发出一封提醒，实际 %d 封: %+v", len(sent), sent)
		}
		if sent[0].MailType != utils.MailTypeDormantNotice {
			t.Errorf("邮件类型期望 dormant_notice，实际 %q", sent[0].MailType)
		}
		if sent[0].To != "a@x.com" {
			t.Errorf("收件人期望 a@x.com，实际 %q", sent[0].To)
		}
		if sent[0].Subject != "您在 Momo Blog 的个人网站链接已进入休眠" {
			t.Errorf("主题不正确: %q", sent[0].Subject)
		}
		for _, fragment := range []string{
			"https://a.example.com",           // 完整显示该链接
			"查看并确认",                           // 按钮
			"/api/link-dormant/notice?token=", // 提醒页地址
			"我仍在使用",                           // 两个选项
			"此链接 30 天内有效",
			"忽略本邮件即可",
		} {
			if !strings.Contains(sent[0].Body, fragment) {
				t.Errorf("提醒邮件正文缺少 %q", fragment)
			}
		}

		row := dormantNoticeRow(t)
		if row.Email != "a@x.com" || row.URL != "https://a.example.com" {
			t.Errorf("记录内容不正确: %+v", row)
		}
		if row.LastCommentAt != now-90*day {
			t.Errorf("last_comment_at 期望 %d，实际 %d", now-90*day, row.LastCommentAt)
		}
		if row.NotifyCount != 1 {
			t.Errorf("notify_count 期望 1，实际 %d", row.NotifyCount)
		}
		if len(row.Token) != 64 {
			t.Errorf("令牌应为 32 字节十六进制（64 字符），实际 %d 字符", len(row.Token))
		}
		// 有效期 = 发信时刻 + N 天
		if want := utils.FormatTrustTime(now + 30*day); row.ExpiresAt != want {
			t.Errorf("expires_at 期望 %q，实际 %q", want, row.ExpiresAt)
		}

		logs := mailLogRows(t)
		if len(logs) != 1 {
			t.Fatalf("邮件日志应恰好一行，实际 %d 行: %+v", len(logs), logs)
		}
		if logs[0].Type != utils.MailTypeDormantNotice || logs[0].Status != utils.MailStatusSent {
			t.Errorf("邮件日志内容不正确: %+v", logs[0])
		}
		if logs[0].Recipient != "a@x.com" || logs[0].Error != "" {
			t.Errorf("邮件日志收件人/错误不正确: %+v", logs[0])
		}
	})

	t.Run("再读一次：同一休眠周期不再发", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		linkComments(t)
		if got := fake.count(); got != 1 {
			t.Fatalf("首次读取应发一封，实际 %d 封", got)
		}
		linkComments(t)
		linkComments(t)
		if got := fake.count(); got != 1 {
			t.Errorf("同一休眠周期内不应重复发信，实际共 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 1 {
			t.Errorf("提醒记录应仍为 1 行，实际 %d 行", got)
		}
	})

	t.Run("他后来又评论过（最后评论时间变了）：新的休眠周期，再发一封", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)
		linkComments(t)

		// 他后来又评论过：最后评论时间从 T-90d 变成 T-60d（仍超过 N 天，仍休眠）
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-60*day)
		linkComments(t)

		if got := fake.count(); got != 2 {
			t.Fatalf("新的休眠周期应再发一封，实际共 %d 封", got)
		}
		row := dormantNoticeRow(t)
		if row.NotifyCount != 2 {
			t.Errorf("notify_count 期望 2，实际 %d", row.NotifyCount)
		}
		if row.LastCommentAt != now-60*day {
			t.Errorf("last_comment_at 应刷新为 %d，实际 %d", now-60*day, row.LastCommentAt)
		}
		if got := mailLogCountOf(t, utils.MailTypeDormantNotice); got != 2 {
			t.Errorf("邮件日志应有 2 行 dormant_notice，实际 %d 行", got)
		}
	})

	t.Run("记录过期后再发一封", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)
		linkComments(t)

		// 把记录改成已过期（令牌与有效期都会刷新）
		oldToken := dormantNoticeRow(t).Token
		if _, err := testDB.Exec(`UPDATE DormantNotice SET expires_at = ?`,
			utils.FormatTrustTime(now-1000)); err != nil {
			t.Fatalf("改写 expires_at 失败: %v", err)
		}

		linkComments(t)
		if got := fake.count(); got != 2 {
			t.Fatalf("记录过期后应再发一封，实际共 %d 封", got)
		}
		row := dormantNoticeRow(t)
		if row.Token == oldToken {
			t.Errorf("过期后再发应换新令牌")
		}
		if row.NotifyCount != 2 {
			t.Errorf("notify_count 期望 2，实际 %d", row.NotifyCount)
		}
		if want := utils.FormatTrustTime(now + 30*day); row.ExpiresAt != want {
			t.Errorf("expires_at 应刷新为 %q，实际 %q", want, row.ExpiresAt)
		}
	})

	t.Run("单次请求最多 3 封：其余留给后续请求，且不重复", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)

		// 5 条休眠链接（老站首次开启的典型形态）
		for i := 0; i < 5; i++ {
			seedLinkComment(t, fmt.Sprintf("用户%d", i), fmt.Sprintf("u%d@x.com", i),
				fmt.Sprintf("https://u%d.example.com", i), "approved", now-90*day)
		}

		linkComments(t)
		if got := fake.count(); got != MaxDormantNoticesPerRequest {
			t.Fatalf("单次请求最多发 %d 封，实际 %d 封", MaxDormantNoticesPerRequest, got)
		}
		if got := dormantNoticeCount(t); got != MaxDormantNoticesPerRequest {
			t.Fatalf("应有 %d 条提醒记录，实际 %d 行", MaxDormantNoticesPerRequest, got)
		}

		// 第二次请求把剩下的 2 封发完；总数恰好 5，没有重复
		linkComments(t)
		if got := fake.count(); got != 5 {
			t.Errorf("两次请求共应发 5 封，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 5 {
			t.Errorf("应有 5 条提醒记录，实际 %d 行", got)
		}
		seen := make(map[string]bool)
		for _, sent := range fake.list() {
			if seen[sent.To] {
				t.Errorf("同一收件人不应重复提醒: %s", sent.To)
			}
			seen[sent.To] = true
		}

		// 再读一次：5 条都提醒过了，不再发信
		linkComments(t)
		if got := fake.count(); got != 5 {
			t.Errorf("全部提醒过后不应再发信，实际共 %d 封", got)
		}
	})

	t.Run("功能关闭：不发信、不落记录", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "false")
		enableDormantNoticeForTest(t)
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		if got := linkComments(t)["甲"]; got == nil || got.UrlDormant {
			t.Errorf("功能关闭时不应标记休眠")
		}
		if got := fake.count(); got != 0 {
			t.Errorf("功能关闭时不应发信，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("功能关闭时不应落记录，实际 %d 行", got)
		}
	})

	// 休眠提醒开关（后台「链接安全」页的按钮）：关闭时链接照常休眠，但不发信、不落记录
	t.Run("提醒开关关闭：链接照常休眠但不发信、不落记录", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		// 刻意只打开总开关与 API 地址，提醒开关保持默认关闭
		setSetting(t, "link_dormant_notice_enabled", "false")
		setSetting(t, "verify_base_url", "https://blog.example.com")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		if got := linkComments(t)["甲"]; got == nil || !got.UrlDormant {
			t.Errorf("提醒开关关闭不应影响 urlDormant，实际 %+v", got)
		}
		if got := fake.count(); got != 0 {
			t.Errorf("提醒开关关闭时不应发信，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("提醒开关关闭时不应落记录，实际 %d 行", got)
		}
	})

	// API 地址是硬前提：未填写时即使提醒开关打开也不会发信（面板同款警告）
	t.Run("API 地址为空：提醒开关打开也不发信、不落记录", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		setSetting(t, "link_dormant_notice_enabled", "true")
		setSetting(t, "verify_base_url", "")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		linkComments(t)
		if got := fake.count(); got != 0 {
			t.Errorf("API 地址为空时不应发信，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("API 地址为空时不应落记录，实际 %d 行", got)
		}
	})

	t.Run("SMTP 未配置：不发信、不落记录，且不影响评论列表响应", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		// 刻意不配置 SMTP

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		comments := linkComments(t)
		if got := comments["甲"]; got == nil || !got.UrlDormant {
			t.Errorf("SMTP 未配置不应影响 urlDormant，实际 %+v", got)
		}
		if got := fake.count(); got != 0 {
			t.Errorf("SMTP 未配置时不应发信，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("SMTP 未配置时不应落记录，实际 %d 行", got)
		}
	})

	t.Run("邮件通知关闭：不发信、不落记录", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		fake := installFakeMailer(t, nil)
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)
		setSetting(t, "email_enabled", "false")

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		linkComments(t)
		if got := fake.count(); got != 0 {
			t.Errorf("邮件通知关闭时不应发信，实际 %d 封", got)
		}
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("邮件通知关闭时不应落记录，实际 %d 行", got)
		}
	})

	t.Run("发送失败：不落记录（下次读取会重试），日志记 failed", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		syncDormantTasks(t)
		installFakeMailer(t, fmt.Errorf("smtp down"))
		setSetting(t, "link_security_enabled", "true")
		enableDormantNoticeForTest(t)
		setSetting(t, "link_dormant_days", "30")
		enableSmtpForTest(t)

		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)

		linkComments(t)
		if got := dormantNoticeCount(t); got != 0 {
			t.Errorf("发送失败时不应落记录，实际 %d 行", got)
		}
		logs := mailLogRows(t)
		if len(logs) != 1 || logs[0].Status != utils.MailStatusFailed {
			t.Fatalf("应有一条 failed 日志，实际 %+v", logs)
		}
		if !strings.Contains(logs[0].Error, "smtp down") {
			t.Errorf("失败日志应带上错误信息，实际 %q", logs[0].Error)
		}
	})
}

// ---------------------------------------------------------------------------
// 提醒页与两个自助动作
// ---------------------------------------------------------------------------

// TestDormantNoticePage 有效的 token 返回中文 HTML 页面（含当前链接、两个表单与页脚）
func TestDormantNoticePage(t *testing.T) {
	resetState(t)
	now := int64(1800000000000)
	withFixedNow(t, now)
	setSetting(t, "link_dormant_days", "30")
	seedDormantNotice(t, "a@x.com", "https://a.example.com", "tok-notice",
		utils.FormatTrustTime(now+30*86400000), now-90*86400000)

	w := callJSON(t, "GET", "/api/link-dormant/notice?token=tok-notice", "")
	requireStatus(t, w, http.StatusOK)
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type 期望 text/html，实际 %q", ct)
	}

	body := w.Body.String()
	for _, fragment := range []string{
		"链接已休眠",
		"https://a.example.com",
		`action="/api/link-dormant/confirm?token=tok-notice"`,
		"我仍在使用",
		`action="/api/link-dormant/update?token=tok-notice"`,
		`name="url"`,
		`placeholder="https://example.com"`,
		"提交新链接",
		"确认后 30 天内不会再标记为休眠",
	} {
		if !strings.Contains(body, fragment) {
			t.Errorf("提醒页缺少 %q", fragment)
		}
	}
}

// TestDormantNoticeConfirm confirm 成功后的副作用与「一次性」语义
func TestDormantNoticeConfirm(t *testing.T) {
	resetState(t)
	now := int64(1800000000000)
	day := int64(86400000)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")
	seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)
	seedDormantNotice(t, "a@x.com", "https://a.example.com", "tok-confirm",
		utils.FormatTrustTime(now+30*day), now-90*day)

	w := callForm(t, "/api/link-dormant/confirm?token=tok-confirm", url.Values{})
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"操作成功", "确认成功！该链接已恢复正常，30 天内不会再标记为休眠。"}) {
		t.Errorf("confirm 结果页不正确：%s", firstLines(w.Body.String(), 8))
	}

	// TrustedLink：source = self、有效期 = 现在 + N 天
	var row model.TrustedLink
	if err := testDB.Get(&row, "SELECT * FROM TrustedLink WHERE email = ? AND url = ?", "a@x.com", "https://a.example.com"); err != nil {
		t.Fatalf("应写入一条 TrustedLink: %v", err)
	}
	if row.Source != model.TrustedLinkSourceSelf {
		t.Errorf("source 期望 self，实际 %q", row.Source)
	}
	if want := utils.FormatTrustTime(now + 30*day); row.ExpiresAt != want {
		t.Errorf("expires_at 期望 %q，实际 %q", want, row.ExpiresAt)
	}

	// 提醒记录被删掉
	if got := dormantNoticeCount(t); got != 0 {
		t.Errorf("confirm 后提醒记录应被删除，实际 %d 行", got)
	}

	// 此后该链接不休眠
	if got := linkComments(t)["甲"]; got == nil || got.UrlDormant {
		t.Errorf("confirm 后该链接不应再休眠，实际 %+v", got)
	}

	// 一次性：同一个 token 再访问落到「该提醒已失效或已处理」
	w = callForm(t, "/api/link-dormant/confirm?token=tok-confirm", url.Values{})
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"操作失败", "该提醒已失效或已处理。"}) {
		t.Errorf("重复 confirm 应返回失效文案：%s", firstLines(w.Body.String(), 8))
	}
}

// TestDormantNoticeUpdate update 的四种结果与副作用
func TestDormantNoticeUpdate(t *testing.T) {
	resetState(t)
	now := int64(1800000000000)
	day := int64(86400000)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")

	oldOne := seedLinkComment(t, "甲", "a@x.com", "https://old.example.com", "approved", now-90*day)
	pendingOne := seedLinkComment(t, "甲", "a@x.com", "https://old.example.com", "pending", now-89*day)
	rejectedOne := seedLinkComment(t, "甲", "a@x.com", "https://rejected.example.com", "rejected", now-88*day)
	otherEmail := seedLinkComment(t, "乙", "b@x.com", "https://b.example.com", "approved", now-90*day)

	seedDormantNotice(t, "a@x.com", "https://old.example.com", "tok-update",
		utils.FormatTrustTime(now+30*day), now-90*day)

	// 1. 非法网址：不改任何评论
	for _, bad := range []string{"", "javascript:alert(1)", "mailto:a@b.com", "//evil.example.com", "not a url"} {
		w := callForm(t, "/api/link-dormant/update?token=tok-update", url.Values{"url": {bad}})
		requireStatus(t, w, http.StatusOK)
		if !containsAll(w.Body.String(), []string{
			"操作失败", "新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。"}) {
			t.Errorf("非法网址 %q 应返回失败文案：%s", bad, firstLines(w.Body.String(), 8))
		}
		if got := commentByID(t, oldOne.ID); got.URL == nil || *got.URL != "https://old.example.com" {
			t.Fatalf("非法网址不应改动任何评论，实际 %v", got.URL)
		}
		if got := dormantNoticeCount(t); got != 1 {
			t.Fatalf("非法网址不应删除提醒记录，实际 %d 行", got)
		}
	}

	// 2. 合法新链接：批量改写（pending 也算历史评论，rejected 不算）
	w := callForm(t, "/api/link-dormant/update?token=tok-update", url.Values{"url": {"https://new.example.com"}})
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"操作成功", "链接更新成功！共 2 条历史评论的网址已更新。"}) {
		t.Errorf("update 结果页不正确：%s", firstLines(w.Body.String(), 8))
	}
	for _, id := range []int64{oldOne.ID, pendingOne.ID} {
		if got := commentByID(t, id); got.URL == nil || *got.URL != "https://new.example.com" {
			t.Errorf("评论 %d 的网址应被更新，实际 %v", id, got.URL)
		}
	}
	if got := commentByID(t, rejectedOne.ID); got.URL == nil || *got.URL != "https://rejected.example.com" {
		t.Errorf("rejected 评论不应被更新，实际 %v", got.URL)
	}
	if got := commentByID(t, otherEmail.ID); got.URL == nil || *got.URL != "https://b.example.com" {
		t.Errorf("其他邮箱的评论不应被更新，实际 %v", got.URL)
	}

	// 新链接写入 TrustedLink（source = self）并删除提醒记录
	var row model.TrustedLink
	if err := testDB.Get(&row, "SELECT * FROM TrustedLink WHERE email = ? AND url = ?", "a@x.com", "https://new.example.com"); err != nil {
		t.Fatalf("应写入新链接的 TrustedLink: %v", err)
	}
	if row.Source != model.TrustedLinkSourceSelf {
		t.Errorf("source 期望 self，实际 %q", row.Source)
	}
	if got := dormantNoticeCount(t); got != 0 {
		t.Errorf("update 后提醒记录应被删除，实际 %d 行", got)
	}
	// 新链接在 N 天内不休眠
	if got := linkComments(t)["甲"]; got == nil || got.UrlDormant {
		t.Errorf("新链接在 N 天内不应休眠，实际 %+v", got)
	}
}

// TestDormantNoticeUpdateSameURL 新链接与现有链接相同时返回「未做修改」
func TestDormantNoticeUpdateSameURL(t *testing.T) {
	resetState(t)
	now := int64(1800000000000)
	day := int64(86400000)
	withFixedNow(t, now)
	setSetting(t, "link_dormant_days", "30")
	seedLinkComment(t, "甲", "a@x.com", "https://same.example.com", "approved", now-90*day)
	seedDormantNotice(t, "a@x.com", "https://same.example.com", "tok-same",
		utils.FormatTrustTime(now+30*day), now-90*day)

	w := callForm(t, "/api/link-dormant/update?token=tok-same", url.Values{"url": {"https://same.example.com"}})
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"操作成功", "新链接与现有链接相同，未做修改。"}) {
		t.Errorf("相同链接应返回「未做修改」：%s", firstLines(w.Body.String(), 8))
	}
	// 仍然会写入 TrustedLink 并删除提醒记录（否则新链接会立刻又被判休眠）
	if got := dormantNoticeCount(t); got != 0 {
		t.Errorf("处理成功后提醒记录应被删除，实际 %d 行", got)
	}
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM TrustedLink WHERE email = 'a@x.com'"); err != nil {
		t.Fatalf("统计 TrustedLink 失败: %v", err)
	}
	if n != 1 {
		t.Errorf("应写入一条 TrustedLink，实际 %d 行", n)
	}
}

// TestDormantNoticeEndpointFailures 缺 token / 未知 token / 过期 / 处理异常
func TestDormantNoticeEndpointFailures(t *testing.T) {
	resetState(t)
	now := int64(1800000000000)
	withFixedNow(t, now)
	setSetting(t, "link_dormant_days", "30")

	t.Run("缺 token（notice / confirm / update 三个端点同一文案）", func(t *testing.T) {
		for _, target := range []string{
			"/api/link-dormant/notice",
			"/api/link-dormant/notice?token=",
		} {
			w := callJSON(t, "GET", target, "")
			requireStatus(t, w, http.StatusOK)
			if !containsAll(w.Body.String(), []string{"操作失败", "缺少提醒参数。"}) {
				t.Errorf("%s 应返回缺少参数文案：%s", target, firstLines(w.Body.String(), 8))
			}
		}
		w := callForm(t, "/api/link-dormant/confirm", url.Values{})
		if !containsAll(w.Body.String(), []string{"缺少提醒参数。"}) {
			t.Errorf("confirm 缺 token 文案不正确：%s", firstLines(w.Body.String(), 8))
		}
		w = callForm(t, "/api/link-dormant/update", url.Values{"url": {"https://x.example.com"}})
		if !containsAll(w.Body.String(), []string{"缺少提醒参数。"}) {
			t.Errorf("update 缺 token 文案不正确：%s", firstLines(w.Body.String(), 8))
		}
	})

	t.Run("未知 token：该提醒已失效或已处理", func(t *testing.T) {
		for _, target := range []string{
			"/api/link-dormant/notice?token=nope",
		} {
			w := callJSON(t, "GET", target, "")
			if !containsAll(w.Body.String(), []string{"操作失败", "该提醒已失效或已处理。"}) {
				t.Errorf("%s 文案不正确：%s", target, firstLines(w.Body.String(), 8))
			}
		}
		w := callForm(t, "/api/link-dormant/confirm?token=nope", url.Values{})
		if !containsAll(w.Body.String(), []string{"该提醒已失效或已处理。"}) {
			t.Errorf("confirm 未知 token 文案不正确：%s", firstLines(w.Body.String(), 8))
		}
		w = callForm(t, "/api/link-dormant/update?token=nope", url.Values{"url": {"https://x.example.com"}})
		if !containsAll(w.Body.String(), []string{"该提醒已失效或已处理。"}) {
			t.Errorf("update 未知 token 文案不正确：%s", firstLines(w.Body.String(), 8))
		}
	})

	t.Run("过期 token：该提醒已过期…", func(t *testing.T) {
		seedDormantNotice(t, "a@x.com", "https://a.example.com", "tok-expired",
			utils.FormatTrustTime(now-1000), now-90*86400000)

		w := callJSON(t, "GET", "/api/link-dormant/notice?token=tok-expired", "")
		if !containsAll(w.Body.String(), []string{"操作失败", "该提醒已过期，请在评论区留言或等待新的提醒邮件。"}) {
			t.Errorf("notice 过期文案不正确：%s", firstLines(w.Body.String(), 8))
		}
		w = callForm(t, "/api/link-dormant/confirm?token=tok-expired", url.Values{})
		if !containsAll(w.Body.String(), []string{"该提醒已过期，请在评论区留言或等待新的提醒邮件。"}) {
			t.Errorf("confirm 过期文案不正确：%s", firstLines(w.Body.String(), 8))
		}
		w = callForm(t, "/api/link-dormant/update?token=tok-expired", url.Values{"url": {"https://x.example.com"}})
		if !containsAll(w.Body.String(), []string{"该提醒已过期，请在评论区留言或等待新的提醒邮件。"}) {
			t.Errorf("update 过期文案不正确：%s", firstLines(w.Body.String(), 8))
		}
		// 过期记录不应被删除，也不应写入 TrustedLink
		if got := dormantNoticeCount(t); got != 1 {
			t.Errorf("过期记录不应被删除，实际 %d 行", got)
		}
		var n int
		if err := testDB.Get(&n, "SELECT COUNT(*) FROM TrustedLink"); err != nil {
			t.Fatalf("统计 TrustedLink 失败: %v", err)
		}
		if n != 0 {
			t.Errorf("过期 token 不应写入 TrustedLink，实际 %d 行", n)
		}
	})
}
