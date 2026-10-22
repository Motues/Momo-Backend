package http

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：链接安全审查（doc/link_security.md）。

覆盖四个设置键的写入校验与归一化、公开评论列表的 urlDormant（含「刚好 N 天 vs N 天 + 1 毫秒」
边界）、历史链接同步的触发条件、去重、一次性确认端点与五种结果页文案。
跨语言固定向量在 utils 包的 link_security_vectors_test.go。
*/

const linkTestSlug = "/posts/link"

// seedLinkComment 写入一条评论，PubDate 与 URL 由调用方给定
func seedLinkComment(t *testing.T, author, email, url, status string, pubDate int64) *model.Comment {
	t.Helper()
	comment := &model.Comment{
		PostSlug:    linkTestSlug,
		Author:      author,
		Email:       email,
		ContentText: "t",
		ContentHTML: "<p>t</p>",
		Status:      status,
		PubDate:     pubDate,
	}
	if url != "" {
		comment.URL = &url
	}
	return seedComment(t, comment)
}

// linkComments 读取公开接口返回的评论（按 author 索引）
func linkComments(t *testing.T) map[string]*commentResp {
	t.Helper()
	w := callJSON(t, "GET", "/api/comments?post_slug="+queryEscape(linkTestSlug)+"&nested=false", "")
	requireStatus(t, w, http.StatusOK)

	var payload commentsPayload
	decodeInto(t, w, &payload)

	result := make(map[string]*commentResp, len(payload.Data.Comments))
	for _, c := range payload.Data.Comments {
		result[c.Author] = c
	}
	return result
}

// withFixedNow 固定 GetComments 里的「现在」，让休眠边界可以精确构造
func withFixedNow(t *testing.T, now int64) {
	t.Helper()
	original := nowMillis
	nowMillis = func() int64 { return now }
	t.Cleanup(func() { nowMillis = original })
}

// ---------------------------------------------------------------------------
// 写入校验（PUT 与导入同一套）
// ---------------------------------------------------------------------------

func TestUpdateSettingsLinkSecurityValidation(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body string
		want string
	}{
		{"开关非法（数字字符串）", `{"link_security_enabled":"1"}`, "link_security_enabled 只能是 true 或 false"},
		{"开关非法（yes）", `{"link_security_enabled":"yes"}`, "link_security_enabled 只能是 true 或 false"},
		{"同步开关非法", `{"link_sync_enabled":"on"}`, "link_sync_enabled 只能是 true 或 false"},
		{"提醒开关非法", `{"link_dormant_notice_enabled":"on"}`, "link_dormant_notice_enabled 只能是 true 或 false"},
		{"天数为空串", `{"link_dormant_days":""}`, "link_dormant_days 必须是 1-3650 之间的整数"},
		{"天数为 0", `{"link_dormant_days":"0"}`, "link_dormant_days 必须是 1-3650 之间的整数"},
		{"天数为负", `{"link_dormant_days":"-5"}`, "link_dormant_days 必须是 1-3650 之间的整数"},
		{"天数为小数", `{"link_dormant_days":"1.5"}`, "link_dormant_days 必须是 1-3650 之间的整数"},
		{"天数带单位", `{"link_dormant_days":"30d"}`, "link_dormant_days 必须是 1-3650 之间的整数"},
		{"天数超上限", `{"link_dormant_days":"3651"}`, "link_dormant_days 必须是 1-3650 之间的整数"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			w := callWithToken(t, "PUT", "/admin/settings", testCase.body, token)
			requireStatus(t, w, http.StatusBadRequest)
			requireBodyCode(t, w, http.StatusBadRequest)

			m := decodeJSON(t, w)
			if got, _ := m["message"].(string); got != testCase.want {
				t.Errorf("错误信息期望 %q，实际 %q", testCase.want, got)
			}
			if got := utils.GetSetting("link_security_enabled"); got != "" {
				t.Errorf("校验失败时不应落库，实际 %q", got)
			}
		})
	}
}

func TestUpdateSettingsLinkSecurityNormalization(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"verify_base_url":"https://blog.example.com","link_security_enabled":" TRUE ","link_sync_enabled":"False","link_dormant_notice_enabled":" True ","link_dormant_days":" 30 "}`
	requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)

	if got := utils.GetSetting("link_security_enabled"); got != "true" {
		t.Errorf("开关键应存归一化后的 true，实际 %q", got)
	}
	if got := utils.GetSetting("link_sync_enabled"); got != "false" {
		t.Errorf("开关键应存归一化后的 false，实际 %q", got)
	}
	if got := utils.GetSetting("link_dormant_notice_enabled"); got != "true" {
		t.Errorf("提醒开关键应存归一化后的 true，实际 %q", got)
	}
	if got := utils.GetSetting("link_dormant_days"); got != "30" {
		t.Errorf("天数应存规范化后的十进制整数，实际 %q", got)
	}

	// 空串写入保持空串（读取路径 fail-closed；与 Node / Worker 的落库值一致）
	requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"link_security_enabled":"   "}`, token), http.StatusOK)
	if got := utils.GetSetting("link_security_enabled"); got != "" {
		t.Errorf("空白开关写入后应存空串，实际 %q", got)
	} else if utils.ResolveLinkSecurityEnabled(got) {
		t.Errorf("空串必须 fail-closed 判为关闭")
	}
}

func TestImportSettingsLinkSecurity(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	t.Run("导入同样校验并归一化", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		body := `{"link_security_enabled":"TRUE","link_dormant_days":" 7 "}`
		requireStatus(t, callWithToken(t, "POST", "/admin/data/import/settings", body, token), http.StatusOK)

		if got := utils.GetSetting("link_security_enabled"); got != "true" {
			t.Errorf("导入后应存 true，实际 %q", got)
		}
		if got := utils.GetSetting("link_dormant_days"); got != "7" {
			t.Errorf("导入后应存 7，实际 %q", got)
		}
	})

	t.Run("导入非法值被拒绝且不落库", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		w := callWithToken(t, "POST", "/admin/data/import/settings",
			`{"site_name":"不应写入","link_dormant_days":"abc"}`, token)
		requireStatus(t, w, http.StatusBadRequest)

		m := decodeJSON(t, w)
		if got, _ := m["message"].(string); got != "link_dormant_days 必须是 1-3650 之间的整数" {
			t.Errorf("导入校验错误信息不正确: %q", got)
		}
		if got := utils.GetSetting("site_name"); got != "" {
			t.Errorf("导入校验失败时不应写入任何设置，site_name 实际 %q", got)
		}
	})
}

func TestGetSettingsLinkGroup(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "7")
	setSetting(t, "link_sync_enabled", "false")
	setSetting(t, "link_dormant_notice_enabled", "true")
	setSetting(t, "site_name", "我的站")

	var payload settingsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/settings?type=link", "", token), &payload)

	for key, want := range map[string]string{
		"link_security_enabled":       "true",
		"link_dormant_days":           "7",
		"link_sync_enabled":           "false",
		"link_dormant_notice_enabled": "true",
	} {
		if got := payload.Data[key]; got != want {
			t.Errorf("link 分组 %s 期望 %q，实际 %q", key, want, got)
		}
	}
	if _, exists := payload.Data["site_name"]; exists {
		t.Errorf("type=link 不应带回其它分组字段：%v", keysOf(payload.Data))
	}
}

func TestSettingsExportImportLinkSecurity(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "7")
	setSetting(t, "link_sync_enabled", "false")
	setSetting(t, "link_dormant_notice_enabled", "true")

	var payload struct {
		Data struct {
			Settings map[string]string `json:"settings"`
		} `json:"data"`
	}
	decodeInto(t, callWithToken(t, "GET", "/admin/data/export/settings", "", token), &payload)

	for key, want := range map[string]string{
		"link_security_enabled":       "true",
		"link_dormant_days":           "7",
		"link_sync_enabled":           "false",
		"link_dormant_notice_enabled": "true",
	} {
		if got := payload.Data.Settings[key]; got != want {
			t.Errorf("导出缺少或错误 %s：%q", key, got)
		}
	}
}

// ---------------------------------------------------------------------------
// 休眠链接：GET /api/comments 的 urlDormant
// ---------------------------------------------------------------------------

// TestUrlDormantBoundaries 刚好 N 天不算休眠，N 天 + 1 毫秒就算（严格大于）
func TestUrlDormantBoundaries(t *testing.T) {
	resetState(t)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")

	const days = 30
	const dayMs = 86400000
	fixedNow := int64(1800000000000)

	// A：最后一条评论刚好在 N 天前 → 不标记
	seedLinkComment(t, "A", "a@x.com", "https://a.example.com", "approved", fixedNow-days*dayMs)
	// B：N 天 + 1 毫秒前 → 标记
	seedLinkComment(t, "B", "b@x.com", "https://b.example.com", "approved", fixedNow-days*dayMs-1)
	// C：没有个人网址 → 不标记
	seedLinkComment(t, "C", "c@x.com", "", "approved", fixedNow-days*dayMs-1000)

	withFixedNow(t, fixedNow)
	comments := linkComments(t)

	for _, testCase := range []struct {
		author string
		want   bool
	}{
		{"A", false},
		{"B", true},
		{"C", false},
	} {
		got, ok := comments[testCase.author]
		if !ok {
			t.Fatalf("未找到评论 %s", testCase.author)
		}
		if got.UrlDormant != testCase.want {
			t.Errorf("%s 的 urlDormant 期望 %v，实际 %v", testCase.author, testCase.want, got.UrlDormant)
		}
	}
}

// TestUrlDormantRules 各条判定口径：跨文章统计、状态过滤、再次评论自动解除、功能关闭
func TestUrlDormantRules(t *testing.T) {
	const dayMs = 86400000
	fixedNow := int64(1800000000000)

	t.Run("再次评论自动解除（跨文章统计）", func(t *testing.T) {
		resetState(t)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")

		// 本文里的老评论（带网址），作者 100 天前评论过；随后他换了一篇文章继续评论
		seedLinkComment(t, "老评论", "a@x.com", "https://a.example.com", "approved", fixedNow-100*dayMs)
		seedComment(t, &model.Comment{
			PostSlug: "/recent", Author: "新评论", Email: "a@x.com",
			ContentText: "new", ContentHTML: "<p>new</p>", Status: "approved",
			PubDate: fixedNow - 1000,
		})

		withFixedNow(t, fixedNow)
		comments := linkComments(t)
		if got := comments["老评论"]; got == nil || got.UrlDormant {
			t.Errorf("同一邮箱刚在别的文章评论过，本文老评论的链接应解除休眠，实际 %+v", got)
		}
	})

	t.Run("pending 也算「来过」，rejected/deleted 不算", func(t *testing.T) {
		resetState(t)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")

		// P：最后一条是 pending（近期）→ 不算休眠
		seedLinkComment(t, "P", "p@x.com", "https://p.example.com", "approved", fixedNow-500*dayMs)
		seedComment(t, &model.Comment{
			PostSlug: "/other", Author: "P2", Email: "p@x.com",
			ContentText: "pending", ContentHTML: "<p>pending</p>", Status: "pending",
			PubDate: fixedNow - 1000,
		})
		// R：最后一条是 rejected（近期）→ 仍然休眠（rejected 不算「来过」）
		seedLinkComment(t, "R", "r@x.com", "https://r.example.com", "approved", fixedNow-500*dayMs)
		seedComment(t, &model.Comment{
			PostSlug: "/other", Author: "R2", Email: "r@x.com",
			ContentText: "rejected", ContentHTML: "<p>rejected</p>", Status: "rejected",
			PubDate: fixedNow - 1000,
		})

		withFixedNow(t, fixedNow)
		comments := linkComments(t)

		if got := comments["P"]; got == nil || got.UrlDormant {
			t.Errorf("pending 评论也算「来过」，不应休眠，实际 %+v", got)
		}
		if got := comments["R"]; got == nil || !got.UrlDormant {
			t.Errorf("被拒评论不算「来过」，应保持休眠，实际 %+v", got)
		}
	})

	t.Run("功能关闭时一律 false", func(t *testing.T) {
		resetState(t)
		setSetting(t, "link_security_enabled", "false")
		setSetting(t, "link_dormant_days", "1")
		seedLinkComment(t, "A", "a@x.com", "https://a.example.com", "approved", fixedNow-100*dayMs)

		withFixedNow(t, fixedNow)
		comments := linkComments(t)
		if got := comments["A"]; got == nil || got.UrlDormant {
			t.Errorf("功能关闭时 urlDormant 必须恒为 false，实际 %+v", got)
		}
	})

	t.Run("开关是脏值时 fail-closed", func(t *testing.T) {
		resetState(t)
		setSetting(t, "link_security_enabled", "yes")
		setSetting(t, "link_dormant_days", "1")
		seedLinkComment(t, "A", "a@x.com", "https://a.example.com", "approved", fixedNow-100*dayMs)

		withFixedNow(t, fixedNow)
		comments := linkComments(t)
		if got := comments["A"]; got == nil || got.UrlDormant {
			t.Errorf("脏开关必须 fail-closed，实际 %+v", got)
		}
	})

	t.Run("天数脏值回退 30 天", func(t *testing.T) {
		resetState(t)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "abc")

		seedLinkComment(t, "A", "a@x.com", "https://a.example.com", "approved", fixedNow-29*dayMs)
		seedLinkComment(t, "B", "b@x.com", "https://b.example.com", "approved", fixedNow-31*dayMs)

		withFixedNow(t, fixedNow)
		comments := linkComments(t)
		if got := comments["A"]; got == nil || got.UrlDormant {
			t.Errorf("29 天前评论在回退 30 天下不应休眠，实际 %+v", got)
		}
		if got := comments["B"]; got == nil || !got.UrlDormant {
			t.Errorf("31 天前评论在回退 30 天下应休眠，实际 %+v", got)
		}
	})

	t.Run("字段始终存在（形状稳定）", func(t *testing.T) {
		resetState(t)
		seedLinkComment(t, "A", "a@x.com", "https://a.example.com", "approved", fixedNow)

		w := callJSON(t, "GET", "/api/comments?post_slug="+queryEscape(linkTestSlug), "")
		requireStatus(t, w, http.StatusOK)

		m := decodeJSON(t, w)
		data, _ := m["data"].(map[string]interface{})
		comments, _ := data["comments"].([]interface{})
		if len(comments) == 0 {
			t.Fatalf("期望至少一条评论: %s", w.Body.String())
		}
		first, _ := comments[0].(map[string]interface{})
		if _, ok := first["urlDormant"].(bool); !ok {
			t.Errorf("每条评论都必须带 urlDormant 布尔字段，实际 %v", first)
		}
	})
}

// ---------------------------------------------------------------------------
// 历史链接同步：触发 + 确认端点
// ---------------------------------------------------------------------------

// verifyEmailForTest 直接写入一条「已验证」的邮箱记录
func verifyEmailForTest(t *testing.T, email string) {
	t.Helper()
	_, err := testDB.Exec(`INSERT INTO EmailVerification (email, token, expires_at, verified, created_at)
		VALUES (?, ?, ?, 1, ?)`, email, fmt.Sprintf("token-%d", time.Now().UnixNano()),
		time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"),
		time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	if err != nil {
		t.Fatalf("写入邮箱验证记录失败: %v", err)
	}
}

// enableSmtpForTest 让邮件服务「可用」（不真正发信；发信在 goroutine 里异步失败）
func enableSmtpForTest(t *testing.T) {
	t.Helper()
	// 端口 1 必然连接被拒：异步发信会立刻失败，不会拖慢用例
	setSetting(t, "smtp_host", "127.0.0.1")
	setSetting(t, "smtp_port", "1")
	setSetting(t, "email_user", "noreply@example.com")
	setSetting(t, "email_password", "secret")
}

// linkSyncRow 读取唯一的 LinkSyncRequest 行
func linkSyncRow(t *testing.T) *model.LinkSyncRequest {
	t.Helper()
	var row model.LinkSyncRequest
	if err := testDB.Get(&row, "SELECT * FROM LinkSyncRequest ORDER BY id DESC LIMIT 1"); err != nil {
		t.Fatalf("读取 LinkSyncRequest 失败: %v", err)
	}
	return &row
}

func linkSyncRowCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM LinkSyncRequest"); err != nil {
		t.Fatalf("统计 LinkSyncRequest 失败: %v", err)
	}
	return n
}

// TestLinkSyncTriggerAndConfirm 端到端：提交带新网址的评论 → 落一条待确认记录 → 确认后批量更新
func TestLinkSyncTriggerAndConfirm(t *testing.T) {
	resetState(t)
	setSetting(t, "link_sync_enabled", "true")
	setSetting(t, "verify_base_url", "https://blog.example.com")
	enableSmtpForTest(t)

	oldURL := "https://old.example.com"
	history := seedLinkComment(t, "老评论", "user@example.com", oldURL, "approved", 1700000000000)
	seedLinkComment(t, "老评论2", "user@example.com", "https://old2.example.com", "approved", 1700000001000)
	// 没有个人网址的历史评论（url IS NULL）不参与更新：SQL 里 NULL != ? 不为真
	noURL := seedLinkComment(t, "无网址", "user@example.com", "", "approved", 1700000001500)
	// 被删除的评论不参与「历史评论」判定，也不会被更新
	seedLinkComment(t, "已删除", "user@example.com", "https://deleted.example.com", "deleted", 1700000002000)

	verifyEmailForTest(t, "User@Example.com")

	body := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"User@Example.com",` +
		`"content":"新网址","url":"https://new.example.com","post_title":"文章标题","post_url":"https://blog.example.com/p/1"}`
	requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)

	row := linkSyncRow(t)
	if row.Email != "user@example.com" {
		t.Errorf("记录里的邮箱应为归一化后的值，实际 %q", row.Email)
	}
	if row.NewURL != "https://new.example.com" {
		t.Errorf("记录里的新网址不正确，实际 %q", row.NewURL)
	}
	if row.Confirmed != 0 {
		t.Errorf("新记录应为未确认，实际 %d", row.Confirmed)
	}
	if len(row.Token) != 64 {
		t.Errorf("令牌应为 32 字节随机数的十六进制（64 个字符），实际 %d 个字符", len(row.Token))
	}
	expiresAt, err := time.Parse("2006-01-02T15:04:05.000Z", row.ExpiresAt)
	if err != nil {
		t.Fatalf("expires_at 不是 ISO 8601 UTC: %v", err)
	}
	if delta := time.Until(expiresAt); delta < 23*time.Hour || delta > 25*time.Hour {
		t.Errorf("有效期应约为 24 小时，实际 %v", delta)
	}

	// 确认前历史评论没有被改动
	if got := commentByID(t, history.ID); got.URL == nil || *got.URL != oldURL {
		t.Errorf("确认前不应修改历史评论，实际 %v", got.URL)
	}

	// 确认
	w := callJSON(t, "GET", "/api/link-sync/confirm?token="+queryEscape(row.Token)+"&email="+queryEscape("USER@example.com "), "")
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"<!DOCTYPE html>", "同步成功", "链接同步完成！共 2 条历史评论的网址已更新"}) {
		t.Errorf("确认结果页不正确：%s", firstLines(w.Body.String(), 6))
	}

	if got := commentByID(t, history.ID); got.URL == nil || *got.URL != "https://new.example.com" {
		t.Errorf("历史评论的网址应被更新，实际 %v", got.URL)
	}
	if got := commentByID(t, noURL.ID); got.URL != nil {
		t.Errorf("没有网址的历史评论不应被写入，实际 %v", *got.URL)
	}
	if got := linkSyncRow(t); got.Confirmed != 1 {
		t.Errorf("确认后应标记 confirmed = 1，实际 %d", got.Confirmed)
	}

	// 幂等 + 一次性：再次确认返回「已完成」，且不产生额外写入
	w = callJSON(t, "GET", "/api/link-sync/confirm?token="+queryEscape(row.Token)+"&email=user@example.com", "")
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"同步成功", "该链接同步已完成"}) {
		t.Errorf("重复确认应返回「已完成」：%s", firstLines(w.Body.String(), 6))
	}
}

// TestLinkSyncTriggerConditions 不满足开启条件时什么都不做
func TestLinkSyncTriggerConditions(t *testing.T) {
	newCommentBody := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"user@example.com",` +
		`"content":"新网址","url":"https://new.example.com"}`

	base := func(t *testing.T, marks ...func()) {
		t.Helper()
		resetState(t)
		enableSmtpForTest(t)
		seedLinkComment(t, "老评论", "user@example.com", "https://old.example.com", "approved", 1700000000000)
		verifyEmailForTest(t, "user@example.com")
		for _, mark := range marks {
			mark()
		}
	}

	t.Run("同步开关关闭", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "false")
			setSetting(t, "verify_base_url", "https://blog.example.com")
		})
		requireStatus(t, callJSON(t, "POST", "/api/comments", newCommentBody), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("开关关闭时不应写记录，实际 %d 条", n)
		}
	})

	t.Run("API 地址为空", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "true")
			setSetting(t, "verify_base_url", "")
		})
		requireStatus(t, callJSON(t, "POST", "/api/comments", newCommentBody), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("API 地址为空时不应写记录，实际 %d 条", n)
		}
	})

	t.Run("邮箱验证关闭但 API 地址已填：仍然触发", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "true")
			setSetting(t, "verify_base_url", "https://blog.example.com")
			setSetting(t, "email_verify_enabled", "false")
		})
		requireStatus(t, callJSON(t, "POST", "/api/comments", newCommentBody), http.StatusOK)
		if n := linkSyncRowCount(t); n != 1 {
			t.Errorf("只要 API 地址已填就应触发，实际 %d 条", n)
		}
	})

	t.Run("SMTP 不可用", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "true")
			setSetting(t, "verify_base_url", "https://blog.example.com")
			setSetting(t, "smtp_host", "")
		})
		requireStatus(t, callJSON(t, "POST", "/api/comments", newCommentBody), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("SMTP 不可用时不应写记录，实际 %d 条", n)
		}
	})

	t.Run("该邮箱未通过邮箱验证", func(t *testing.T) {
		resetState(t)
		enableSmtpForTest(t)
		setSetting(t, "link_sync_enabled", "true")
		setSetting(t, "verify_base_url", "https://blog.example.com")
		seedLinkComment(t, "老评论", "user@example.com", "https://old.example.com", "approved", 1700000000000)
		// 没写 EmailVerification：此时会走「发验证邮件」的分支，但不是链接同步

		requireStatus(t, callJSON(t, "POST", "/api/comments", newCommentBody), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("邮箱未验证时不应写记录，实际 %d 条", n)
		}
	})

	t.Run("本次提交没有网址", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "true")
			setSetting(t, "verify_base_url", "https://blog.example.com")
		})
		body := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"user@example.com","content":"没有网址"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("没有网址时不应写记录，实际 %d 条", n)
		}
	})

	t.Run("没有与本次不同的历史网址", func(t *testing.T) {
		base(t, func() {
			setSetting(t, "link_sync_enabled", "true")
			setSetting(t, "verify_base_url", "https://blog.example.com")
		})
		// 历史评论的网址与本次完全相同 → 没有需要更新的历史链接
		body := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"user@example.com",` +
			`"content":"同一个网址","url":"https://old.example.com"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)
		if n := linkSyncRowCount(t); n != 0 {
			t.Errorf("历史网址与本次相同时不应写记录，实际 %d 条", n)
		}
	})
}

// TestLinkSyncDedupeAndInvalidate 同一邮箱只保留一条有效记录，同一新网址不重复发信
func TestLinkSyncDedupeAndInvalidate(t *testing.T) {
	resetState(t)
	setSetting(t, "link_sync_enabled", "true")
	setSetting(t, "verify_base_url", "https://blog.example.com")
	enableSmtpForTest(t)

	seedLinkComment(t, "老评论", "user@example.com", "https://old.example.com", "approved", 1700000000000)
	verifyEmailForTest(t, "user@example.com")

	post := func(url string) {
		t.Helper()
		body := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"user@example.com",` +
			`"content":"新网址","url":"` + url + `"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)
	}

	post("https://new1.example.com")
	first := linkSyncRow(t)
	if n := linkSyncRowCount(t); n != 1 {
		t.Fatalf("首次应只有 1 条记录，实际 %d 条", n)
	}

	// 同一邮箱 + 同一新网址：不重复发信
	post("https://new1.example.com")
	if n := linkSyncRowCount(t); n != 1 {
		t.Errorf("同一新网址不应重复写记录，实际 %d 条", n)
	}
	if again := linkSyncRow(t); again.Token != first.Token {
		t.Errorf("去重时不应换令牌：%q -> %q", first.Token, again.Token)
	}

	// 同一邮箱 + 新网址：旧记录立即作废，只保留一条
	post("https://new2.example.com")
	if n := linkSyncRowCount(t); n != 2 {
		t.Fatalf("换网址后应有 2 条历史记录，实际 %d 条", n)
	}
	second := linkSyncRow(t)
	if second.NewURL != "https://new2.example.com" {
		t.Errorf("最新记录应是新网址，实际 %q", second.NewURL)
	}

	var activeCount int
	if err := testDB.Get(&activeCount,
		`SELECT COUNT(*) FROM LinkSyncRequest WHERE email = ? AND confirmed = 0 AND expires_at >= ?`,
		"user@example.com", time.Now().UTC().Format("2006-01-02T15:04:05.000Z")); err != nil {
		t.Fatalf("统计有效记录失败: %v", err)
	}
	if activeCount != 1 {
		t.Errorf("同一邮箱只应保留一条有效待确认记录，实际 %d 条", activeCount)
	}

	// 旧令牌立即失效（已过期）
	w := callJSON(t, "GET", "/api/link-sync/confirm?token="+queryEscape(first.Token)+"&email=user@example.com", "")
	requireStatus(t, w, http.StatusOK)
	if !containsAll(w.Body.String(), []string{"同步失败", "确认链接已过期，请重新提交评论以获取新的确认邮件"}) {
		t.Errorf("被作废的旧令牌应提示已过期：%s", firstLines(w.Body.String(), 6))
	}
}

// TestLinkSyncTriggerUsesNormalizedEmailIdentity 触发条件里的「已验证」按**归一化身份**判定：
// 邮箱是链接同步的唯一身份凭据，历史评论的查询与批量改写都按 lower(trim(email)) 比对，
// 若这里用精确匹配就会自相矛盾（A@B.com 验证过、后来提交 a@b.com 时永远发不出确认邮件）。
func TestLinkSyncTriggerUsesNormalizedEmailIdentity(t *testing.T) {
	resetState(t)
	setSetting(t, "link_sync_enabled", "true")
	setSetting(t, "verify_base_url", "https://blog.example.com")
	enableSmtpForTest(t)

	seedLinkComment(t, "老评论", "alice@example.com", "https://old.example.com", "approved", 1700000000000)
	// 验证记录大小写与本次提交不同，但归一化后是同一个身份
	verifyEmailForTest(t, "Alice@Example.com")

	body := `{"post_slug":"` + linkTestSlug + `","author":"新评论","email":"alice@example.com",` +
		`"content":"新网址","url":"https://new.example.com"}`
	requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)

	row := linkSyncRow(t)
	if row.Email != "alice@example.com" {
		t.Errorf("记录里的邮箱应为归一化后的值，实际 %q", row.Email)
	}
	if row.NewURL != "https://new.example.com" {
		t.Errorf("大小写不同但身份相同也应触发确认流程，实际 %q", row.NewURL)
	}
}

// TestLinkSyncConfirmCases 确认端点的五种结果页文案
func TestLinkSyncConfirmCases(t *testing.T) {
	resetState(t)

	t.Run("缺少参数", func(t *testing.T) {
		for _, target := range []string{
			"/api/link-sync/confirm",
			"/api/link-sync/confirm?token=abc",
			"/api/link-sync/confirm?email=a@b.com",
		} {
			w := callJSON(t, "GET", target, "")
			requireStatus(t, w, http.StatusOK)
			if !containsAll(w.Body.String(), []string{"<!DOCTYPE html>", "同步失败", "缺少确认参数", "此页面由系统自动生成"}) {
				t.Errorf("%s 的结果页不正确：%s", target, firstLines(w.Body.String(), 6))
			}
		}
	})

	t.Run("查不到记录", func(t *testing.T) {
		w := callJSON(t, "GET", "/api/link-sync/confirm?token=nope&email=a@b.com", "")
		requireStatus(t, w, http.StatusOK)
		if !containsAll(w.Body.String(), []string{"同步失败", "确认链接无效"}) {
			t.Errorf("结果页不正确：%s", firstLines(w.Body.String(), 6))
		}
	})

	t.Run("已过期", func(t *testing.T) {
		resetState(t)
		if _, err := testDB.Exec(`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, confirmed, created_at)
			VALUES (?, ?, ?, ?, 0, ?)`,
			"a@b.com", "https://new.example.com", "expired-token",
			time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"),
			time.Now().Add(-25*time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")); err != nil {
			t.Fatalf("写入过期记录失败: %v", err)
		}

		w := callJSON(t, "GET", "/api/link-sync/confirm?token=expired-token&email=a@b.com", "")
		requireStatus(t, w, http.StatusOK)
		if !containsAll(w.Body.String(), []string{"同步失败", "确认链接已过期，请重新提交评论以获取新的确认邮件"}) {
			t.Errorf("结果页不正确：%s", firstLines(w.Body.String(), 6))
		}
	})

	t.Run("已确认的记录即使过期也报已完成", func(t *testing.T) {
		resetState(t)
		if _, err := testDB.Exec(`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, confirmed, created_at)
			VALUES (?, ?, ?, ?, 1, ?)`,
			"a@b.com", "https://new.example.com", "done-token",
			time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"),
			time.Now().Add(-25*time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")); err != nil {
			t.Fatalf("写入记录失败: %v", err)
		}

		w := callJSON(t, "GET", "/api/link-sync/confirm?token=done-token&email=a@b.com", "")
		requireStatus(t, w, http.StatusOK)
		if !containsAll(w.Body.String(), []string{"同步成功", "该链接同步已完成"}) {
			t.Errorf("结果页不正确：%s", firstLines(w.Body.String(), 6))
		}
	})

	t.Run("邮箱大小写与空格归一后仍能确认", func(t *testing.T) {
		resetState(t)
		if _, err := testDB.Exec(`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, confirmed, created_at)
			VALUES (?, ?, ?, ?, 0, ?)`,
			"a@b.com", "https://new.example.com", "case-token",
			time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"),
			time.Now().UTC().Format("2006-01-02T15:04:05.000Z")); err != nil {
			t.Fatalf("写入记录失败: %v", err)
		}

		w := callJSON(t, "GET", "/api/link-sync/confirm?token=case-token&email="+queryEscape(" A@B.com "), "")
		requireStatus(t, w, http.StatusOK)
		if !containsAll(w.Body.String(), []string{"同步成功", "链接同步完成！共 0 条历史评论的网址已更新"}) {
			t.Errorf("结果页不正确：%s", firstLines(w.Body.String(), 6))
		}
	})
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// containsAll 判断 body 是否同时包含全部片段
func containsAll(body string, fragments []string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(body, fragment) {
			return false
		}
	}
	return true
}
