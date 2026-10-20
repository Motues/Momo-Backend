package http

import (
	"net/http"
	"testing"

	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：管理端邮件发送日志列表（GET /admin/mails，任务规范第 9 节）。

覆盖分页与排序、status / type / search 筛选、无法识别的取值按 all、缺 token 401、
retentionDays 字段，以及「只返回 30 天窗口内的行」。
*/

type mailLogItem struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	Recipient string `json:"recipient"`
	Subject   string `json:"subject"`
	Status    string `json:"status"`
	Error     string `json:"error"`
	CreatedAt string `json:"createdAt"`
}

type mailListPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		List          []mailLogItem `json:"list"`
		Total         int64         `json:"total"`
		Page          int           `json:"page"`
		PageSize      int           `json:"pageSize"`
		RetentionDays int           `json:"retentionDays"`
	} `json:"data"`
}

// seedMailLog 直接写入一条邮件日志（errMsg 为空串时落 NULL，与实际写入一致）
func seedMailLog(t *testing.T, mailType, recipient, subject, status, errMsg, createdAt string) {
	t.Helper()
	var errValue interface{}
	if status == utils.MailStatusFailed {
		errValue = errMsg
	}
	if _, err := testDB.Exec(`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, mailType, recipient, subject, status, errValue, createdAt); err != nil {
		t.Fatalf("写入邮件日志失败: %v", err)
	}
}

// fetchMails 拉取邮件列表
func fetchMails(t *testing.T, token, query string) mailListPayload {
	t.Helper()
	target := "/admin/mails"
	if query != "" {
		target += "?" + query
	}
	w := callWithToken(t, "GET", target, "", token)
	requireStatus(t, w, http.StatusOK)

	var payload mailListPayload
	decodeInto(t, w, &payload)
	return payload
}

// mailLogRecipients 返回列表里的收件人顺序（用于断言排序）
func mailLogRecipients(payload mailListPayload) []string {
	out := make([]string, 0, len(payload.Data.List))
	for _, item := range payload.Data.List {
		out = append(out, item.Recipient)
	}
	return out
}

// TestListMailsRequiresToken 缺 token / 非法 token 一律 401（与其它 /admin/* 一致）
func TestListMailsRequiresToken(t *testing.T) {
	resetState(t)

	w := callJSON(t, "GET", "/admin/mails", "")
	requireStatus(t, w, http.StatusUnauthorized)
	if got := decodeJSON(t, w)["message"]; got != "Invalid token" {
		t.Errorf("401 文案期望 Invalid token，实际 %v", got)
	}

	w = call(t, "GET", "/admin/mails", "", map[string]string{"Authorization": "Bearer nope"}, "")
	requireStatus(t, w, http.StatusUnauthorized)
}

// TestListMailsEmpty 空库：list 是空数组（不是 null），并带回 retentionDays
func TestListMailsEmpty(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/mails", "", token)
	requireStatus(t, w, http.StatusOK)

	body := w.Body.String()
	if !containsAll(body, []string{`"list":[]`, `"total":0`, `"retentionDays":30`}) {
		t.Errorf("空列表响应不正确：%s", body)
	}

	var payload mailListPayload
	decodeInto(t, w, &payload)
	if payload.Message != "Mails fetched successfully" {
		t.Errorf("message 期望 Mails fetched successfully，实际 %q", payload.Message)
	}
	if payload.Data.Page != 1 || payload.Data.PageSize != 20 {
		t.Errorf("默认分页期望 page=1 pageSize=20，实际 %d/%d", payload.Data.Page, payload.Data.PageSize)
	}
	if payload.Data.RetentionDays != utils.MailLogRetentionDays {
		t.Errorf("retentionDays 期望 %d，实际 %d", utils.MailLogRetentionDays, payload.Data.RetentionDays)
	}
}

// TestListMailsCustomRetention 保留天数可由设置项 mail_log_retention_days 自定义：
// 窗口外的行不再返回；设置为 0 时永久保留（不设时间下限）。
func TestListMailsCustomRetention(t *testing.T) {
	resetState(t)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	token := adminToken(t)

	seedMailLog(t, utils.MailTypeTest, "old@x.com", "旧的", utils.MailStatusSent, "",
		utils.FormatTrustTime(now-10*utils.DayMillis))
	seedMailLog(t, utils.MailTypeTest, "new@x.com", "新的", utils.MailStatusSent, "",
		utils.FormatTrustTime(now-1*utils.DayMillis))

	t.Run("默认 30 天：两条都在窗口内", func(t *testing.T) {
		payload := fetchMails(t, token, "")
		if payload.Data.Total != 2 {
			t.Errorf("默认保留期窗口内应有 2 条，实际 %d", payload.Data.Total)
		}
		if payload.Data.RetentionDays != utils.MailLogRetentionDays {
			t.Errorf("retentionDays 期望默认 %d，实际 %d", utils.MailLogRetentionDays, payload.Data.RetentionDays)
		}
	})

	t.Run("设置为 7 天：10 天前的行被隐藏，retentionDays 为 7", func(t *testing.T) {
		setSetting(t, utils.MailLogRetentionKey, "7")
		payload := fetchMails(t, token, "")
		if payload.Data.RetentionDays != 7 {
			t.Errorf("retentionDays 期望 7，实际 %d", payload.Data.RetentionDays)
		}
		if payload.Data.Total != 1 {
			t.Errorf("7 天窗口内应只有 1 条，实际 %d", payload.Data.Total)
		}
		if got := mailLogRecipients(payload); len(got) != 1 || got[0] != "new@x.com" {
			t.Errorf("应只返回窗口内的 new@x.com，实际 %v", got)
		}
	})

	t.Run("设置为 0：永久保留，retentionDays 为 0 且全部返回", func(t *testing.T) {
		setSetting(t, utils.MailLogRetentionKey, "0")
		payload := fetchMails(t, token, "")
		if payload.Data.RetentionDays != 0 {
			t.Errorf("retentionDays 期望 0，实际 %d", payload.Data.RetentionDays)
		}
		if payload.Data.Total != 2 {
			t.Errorf("永久保留时应返回全部 2 条，实际 %d", payload.Data.Total)
		}
	})
}

// TestUpdateSettingsMailLogRetention PUT /admin/settings 对保留天数的写入校验与归一化
func TestUpdateSettingsMailLogRetention(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, bad := range []string{"", "-1", "1.5", "3651", "abc", "30d"} {
		body := `{"mail_log_retention_days":"` + bad + `"}`
		w := callWithToken(t, "PUT", "/admin/settings", body, token)
		requireStatus(t, w, http.StatusBadRequest)
		if got := decodeJSON(t, w)["message"]; got != "mail_log_retention_days 必须是 0-3650 之间的整数" {
			t.Errorf("取值 %q 的错误文案不正确: %v", bad, got)
		}
		if got := utils.GetSetting(utils.MailLogRetentionKey); got != "" {
			t.Errorf("校验失败时不应落库，实际 %q", got)
		}
	}

	w := callWithToken(t, "PUT", "/admin/settings", `{"mail_log_retention_days":" 045 "}`, token)
	requireStatus(t, w, http.StatusOK)
	if got := utils.GetSetting(utils.MailLogRetentionKey); got != "45" {
		t.Errorf("应存规范化后的 45，实际 %q", got)
	}
}

// TestListMailsSortingAndPagination 按 created_at DESC, id DESC 排序并支持分页
func TestListMailsSortingAndPagination(t *testing.T) {
	resetState(t)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	token := adminToken(t)

	// 三条同一时刻（并列时 id 倒序）+ 一条更早
	seedMailLog(t, utils.MailTypeVerify, "a@x.com", "验证", utils.MailStatusSent, "", utils.FormatTrustTime(now))
	seedMailLog(t, utils.MailTypeLinkSync, "b@x.com", "同步", utils.MailStatusSent, "", utils.FormatTrustTime(now))
	seedMailLog(t, utils.MailTypeTest, "c@x.com", "测试", utils.MailStatusSent, "", utils.FormatTrustTime(now))
	seedMailLog(t, utils.MailTypeReplyNotify, "d@x.com", "回复", utils.MailStatusSent, "", utils.FormatTrustTime(now-3600_000))

	payload := fetchMails(t, token, "")
	if payload.Data.Total != 4 {
		t.Fatalf("total 期望 4，实际 %d", payload.Data.Total)
	}
	got := mailLogRecipients(payload)
	want := []string{"c@x.com", "b@x.com", "a@x.com", "d@x.com"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排序期望 %v，实际 %v", want, got)
		}
	}

	// 分页：pageSize=2，第二页是更早的两条
	payload = fetchMails(t, token, "page=2&pageSize=2")
	if payload.Data.Total != 4 {
		t.Errorf("分页时 total 应仍为 4，实际 %d", payload.Data.Total)
	}
	if payload.Data.Page != 2 || payload.Data.PageSize != 2 {
		t.Errorf("分页元信息不正确：%d/%d", payload.Data.Page, payload.Data.PageSize)
	}
	got = mailLogRecipients(payload)
	if len(got) != 2 || got[0] != "a@x.com" || got[1] != "d@x.com" {
		t.Errorf("第二页应为 a@x.com / d@x.com，实际 %v", got)
	}

	// pageSize 上限 100、非法值回落 20
	if p := fetchMails(t, token, "pageSize=1000"); p.Data.PageSize != 100 {
		t.Errorf("pageSize 上限应为 100，实际 %d", p.Data.PageSize)
	}
	if p := fetchMails(t, token, "pageSize=abc"); p.Data.PageSize != 20 {
		t.Errorf("pageSize 非法应回落 20，实际 %d", p.Data.PageSize)
	}
	if p := fetchMails(t, token, "pageSize=0"); p.Data.PageSize != 20 {
		t.Errorf("pageSize=0 应回落 20，实际 %d", p.Data.PageSize)
	}

	// page 非法 → 400
	w := callWithToken(t, "GET", "/admin/mails?page=0", "", token)
	requireStatus(t, w, http.StatusBadRequest)
	requireBodyCode(t, w, http.StatusBadRequest)
	w = callWithToken(t, "GET", "/admin/mails?page=abc", "", token)
	requireStatus(t, w, http.StatusBadRequest)
}

// TestListMailsFilters status / type / search 三个筛选与非法取值
func TestListMailsFilters(t *testing.T) {
	resetState(t)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	token := adminToken(t)

	// 六种邮件类型各一行（同时覆盖「每种类型都能筛出来」）
	seedMailLog(t, utils.MailTypeVerify, "alice@x.com", "请验证您的邮箱", utils.MailStatusSent, "", utils.FormatTrustTime(now-1000))
	seedMailLog(t, utils.MailTypeLinkSync, "carol@x.com", "确认更新您的历史评论链接", utils.MailStatusSent, "", utils.FormatTrustTime(now-2000))
	seedMailLog(t, utils.MailTypeDormantNotice, "bob@x.com", "您的个人网站链接已进入休眠", utils.MailStatusSent, "", utils.FormatTrustTime(now-3000))
	seedMailLog(t, utils.MailTypeCommentNotify, "admin@x.com", "您在 Momo Blog 上有新的评论", utils.MailStatusSent, "", utils.FormatTrustTime(now-4000))
	seedMailLog(t, utils.MailTypeReplyNotify, "dave@x.com", "您在 Momo Blog 上的评论有了新回复", utils.MailStatusSent, "", utils.FormatTrustTime(now-5000))
	seedMailLog(t, utils.MailTypeTest, "alice@x.com", "SMTP 配置验证", utils.MailStatusFailed, "smtp down", utils.FormatTrustTime(now-6000))

	t.Run("status", func(t *testing.T) {
		if got := fetchMails(t, token, "status=sent").Data.Total; got != 5 {
			t.Errorf("status=sent 期望 5 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "status=failed").Data.Total; got != 1 {
			t.Errorf("status=failed 期望 1 条，实际 %d", got)
		}
		for _, value := range []string{"all", "garbage", ""} {
			if got := fetchMails(t, token, "status="+value).Data.Total; got != 6 {
				t.Errorf("status=%q 应不筛选（6 条），实际 %d", value, got)
			}
		}
		// 大小写归一化（与 verified / linkStatus 的宽容口径一致）
		if got := fetchMails(t, token, "status=SENT").Data.Total; got != 5 {
			t.Errorf("status=SENT 应归一化为 sent（5 条），实际 %d", got)
		}
	})

	t.Run("type", func(t *testing.T) {
		for _, mailType := range []string{
			utils.MailTypeVerify, utils.MailTypeLinkSync, utils.MailTypeDormantNotice,
			utils.MailTypeCommentNotify, utils.MailTypeReplyNotify, utils.MailTypeTest,
		} {
			payload := fetchMails(t, token, "type="+mailType)
			if payload.Data.Total != 1 {
				t.Errorf("type=%s 期望 1 条，实际 %d", mailType, payload.Data.Total)
			}
			if len(payload.Data.List) == 1 && payload.Data.List[0].Type != mailType {
				t.Errorf("type=%s 筛选结果类型不正确：%+v", mailType, payload.Data.List[0])
			}
		}
		for _, value := range []string{"all", "garbage", ""} {
			if got := fetchMails(t, token, "type="+value).Data.Total; got != 6 {
				t.Errorf("type=%q 应不筛选（6 条），实际 %d", value, got)
			}
		}
	})

	t.Run("search 对 recipient / subject 做不区分大小写的模糊匹配", func(t *testing.T) {
		if got := fetchMails(t, token, "search=alice").Data.Total; got != 2 {
			t.Errorf("search=alice 期望 2 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "search=ALICE").Data.Total; got != 2 {
			t.Errorf("search 应不区分大小写，实际 %d", got)
		}
		if got := fetchMails(t, token, "search=%E9%AA%8C%E8%AF%81").Data.Total; got != 2 {
			t.Errorf("search 命中主题（验证）期望 2 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "search=%20%20bob%20%20").Data.Total; got != 1 {
			t.Errorf("search 应先 trim 再匹配，期望 1 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "search=").Data.Total; got != 6 {
			t.Errorf("search 为空表示不筛选，期望 6 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "search=zzz").Data.Total; got != 0 {
			t.Errorf("无匹配应为 0 条，实际 %d", got)
		}
	})

	t.Run("组合筛选", func(t *testing.T) {
		payload := fetchMails(t, token, "status=failed&search=alice")
		if payload.Data.Total != 1 {
			t.Fatalf("组合筛选期望 1 条，实际 %d", payload.Data.Total)
		}
		item := payload.Data.List[0]
		if item.Type != utils.MailTypeTest || item.Status != utils.MailStatusFailed {
			t.Errorf("组合筛选结果不正确：%+v", item)
		}
		if item.Error != "smtp down" {
			t.Errorf("失败原因应回传，实际 %q", item.Error)
		}
		if item.CreatedAt != utils.FormatTrustTime(now-6000) {
			t.Errorf("createdAt 应原样下发，实际 %q", item.CreatedAt)
		}

		// status + type 组合
		if got := fetchMails(t, token, "status=sent&type=verify").Data.Total; got != 1 {
			t.Errorf("status=sent&type=verify 期望 1 条，实际 %d", got)
		}
		if got := fetchMails(t, token, "status=failed&type=verify").Data.Total; got != 0 {
			t.Errorf("status=failed&type=verify 期望 0 条，实际 %d", got)
		}
	})
}

// TestListMailsRetentionWindow 只返回 30 天窗口内的行
func TestListMailsRetentionWindow(t *testing.T) {
	resetState(t)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	token := adminToken(t)

	seedMailLog(t, utils.MailTypeTest, "fresh@x.com", "新的", utils.MailStatusSent, "", utils.FormatTrustTime(now-1000))
	// 恰好 30 天（>= cutoff）→ 仍在窗口内
	seedMailLog(t, utils.MailTypeTest, "edge@x.com", "边界", utils.MailStatusSent, "",
		utils.FormatTrustTime(now-30*utils.DayMillis))
	// 31 天 → 不在窗口内
	seedMailLog(t, utils.MailTypeTest, "old@x.com", "旧的", utils.MailStatusSent, "",
		utils.FormatTrustTime(now-31*utils.DayMillis))

	payload := fetchMails(t, token, "")
	if payload.Data.Total != 2 {
		t.Fatalf("30 天窗口内应有 2 条，实际 %d：%v", payload.Data.Total, mailLogRecipients(payload))
	}
	for _, item := range payload.Data.List {
		if item.Recipient == "old@x.com" {
			t.Errorf("31 天前的行不应返回")
		}
	}

	// 不存在的空 error 也要下发给空串（形状稳定）
	if got := payload.Data.List[0].Error; got != "" {
		t.Errorf("成功行的 error 应为空串，实际 %q", got)
	}
}

// TestListMailsReflectsRealSend 真的发一封信后，列表里能看到它
// （写入点在最底层的 SendRaw —— 面板只应看到「真正尝试过的发送」）
func TestListMailsReflectsRealSend(t *testing.T) {
	resetState(t)
	// 刻意不固定 handler 的 nowMillis：邮件日志的时钟在 utils 包（真实时间），
	// 固定 handler 的时间会让「保留 30 天」的清理把刚写入的行当成过期行删掉。
	installFakeMailer(t, nil)
	enableSmtpForTest(t)
	setSetting(t, "admin_email", "admin@x.com")
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/settings/test-email", "", token)
	requireStatus(t, w, http.StatusOK)

	payload := fetchMails(t, token, "")
	if payload.Data.Total != 1 {
		t.Fatalf("发送一封后应有 1 行日志，实际 %d", payload.Data.Total)
	}
	item := payload.Data.List[0]
	if item.Type != utils.MailTypeTest || item.Status != utils.MailStatusSent {
		t.Errorf("日志内容不正确：%+v", item)
	}
	if item.Recipient != "admin@x.com" {
		t.Errorf("收件人期望 admin@x.com，实际 %q", item.Recipient)
	}
	if item.Subject != "SMTP 配置验证" {
		t.Errorf("主题期望 SMTP 配置验证，实际 %q", item.Subject)
	}

	// SMTP 未配置导致的「跳过」不记录
	truncateAll()
	token = adminToken(t)
	w = callWithToken(t, "POST", "/admin/settings/test-email", "", token)
	requireStatus(t, w, http.StatusBadRequest)
	if got := fetchMails(t, token, "").Data.Total; got != 0 {
		t.Errorf("SMTP 未配置的「跳过」不应记录，实际 %d 行", got)
	}
}
