package http

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：多管理员邮箱与通知收件人（doc/admin_emails.md）。

覆盖 PUT /admin/settings 与导入路径的六条错误文案与归一化、type=basic 分组、
导出 / 导入往返、公开接口的 isBlogger / admin_email_hashes，
以及「列表里的人都享受博主特权」的端到端行为。
跨语言固定向量在 utils 包的 admin_emails_vectors_test.go。
*/

// sha256HexOf 复算邮箱哈希（与实现无关的本地副本）
func sha256HexOf(email string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(email)))
}

// ---------------------------------------------------------------------------
// PUT /admin/settings —— 写入校验
// ---------------------------------------------------------------------------

func TestUpdateSettingsAdminEmailsValidation(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body string
		want string
	}{
		{"坏 JSON", `{"admin_emails":"{oops","site_name":"不应写入"}`, "admin_emails 必须是 JSON 数组"},
		{"不是数组", `{"admin_emails":"\"a@b.com\""}`, "admin_emails 必须是 JSON 数组"},
		{"数字", `{"admin_emails":"123"}`, "admin_emails 必须是 JSON 数组"},
		{"非字符串项", `{"admin_emails":"[\"a@b.com\",1]"}`, "admin_emails 的每一项都必须是字符串"},
		{"null 项", `{"admin_emails":"[\"a@b.com\",null]"}`, "admin_emails 的每一项都必须是字符串"},
		{"非法邮箱", `{"admin_emails":"[\"nope\"]"}`, "admin_emails 包含非法邮箱地址"},
		{
			"超过 10 个",
			`{"admin_emails":"[\"a1@x.com\",\"a2@x.com\",\"a3@x.com\",\"a4@x.com\",\"a5@x.com\",\"a6@x.com\",\"a7@x.com\",\"a8@x.com\",\"a9@x.com\",\"a10@x.com\",\"a11@x.com\"]"}`,
			"admin_emails 最多 10 个邮箱",
		},
		{"notify 非法邮箱", `{"notify_email":"nope"}`, "notify_email 必须是合法的邮箱地址"},
		{"notify 不在列表里", `{"admin_emails":"[\"a@x.com\"]","notify_email":"b@y.com"}`, "notify_email 必须在管理员邮箱列表中"},
		{"列表为空时提交 notify", `{"admin_emails":"[]","notify_email":"a@x.com"}`, "notify_email 必须在管理员邮箱列表中"},
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
			// 校验发生在写入之前：同一批里的其它键也不落库
			if got := utils.GetSetting("site_name"); got == "不应写入" {
				t.Errorf("校验失败时不应写入任何设置")
			}
			if got := utils.GetSetting("admin_emails"); got != "" {
				t.Errorf("校验失败时不应写入 admin_emails，实际 %q", got)
			}
		})
	}
}

func TestUpdateSettingsAdminEmailsNormalization(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"admin_emails":"[\"  A@X.com \", \"b@y.com\", \"a@x.com\", \"\", \"  \"]"}`
	requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)

	want := `["a@x.com","b@y.com"]`
	if got := utils.GetSetting("admin_emails"); got != want {
		t.Errorf("落库期望 %q（trim + 小写 + 去重保序 + 丢弃空串），实际 %q", want, got)
	}

	// 空串 / 空白 = 未配置（存 []）
	for _, raw := range []string{"", "   "} {
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings",
			`{"admin_emails":`+mustJSONString(t, raw)+`}`, token), http.StatusOK)
		if got := utils.GetSetting("admin_emails"); got != "[]" {
			t.Errorf("写入 %q 后应存 []，实际 %q", raw, got)
		}
	}
}

func TestUpdateSettingsNotifyEmail(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	t.Run("用同一次请求里的新列表判定", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		body := `{"admin_emails":"[\"a@x.com\",\"b@y.com\"]","notify_email":"  B@Y.COM  "}`
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)

		if got := utils.GetSetting("notify_email"); got != "b@y.com" {
			t.Errorf("notify_email 应存归一化后的值，实际 %q", got)
		}
		if got := utils.ResolveNotifyEmailFromSettings(); got != "b@y.com" {
			t.Errorf("解析出的收件人期望 b@y.com，实际 %q", got)
		}
	})

	t.Run("未提交 admin_emails 时用库里的列表判定", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)

		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"notify_email":"b@y.com"}`, token), http.StatusOK)
		if got := utils.ResolveNotifyEmailFromSettings(); got != "b@y.com" {
			t.Errorf("解析出的收件人期望 b@y.com，实际 %q", got)
		}

		// 不在列表里 → 400
		w := callWithToken(t, "PUT", "/admin/settings", `{"notify_email":"c@z.com"}`, token)
		requireStatus(t, w, http.StatusBadRequest)
	})

	t.Run("旧键 admin_email 仍是回落来源", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		setSetting(t, "admin_email", "Old@X.com")

		if got := utils.ResolveNotifyEmailFromSettings(); got != "old@x.com" {
			t.Errorf("未配置列表时应回落到旧键，实际 %q", got)
		}
		// 旧键的列表成员同样可以命中
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"notify_email":"old@x.com"}`, token), http.StatusOK)
		if got := utils.ResolveNotifyEmailFromSettings(); got != "old@x.com" {
			t.Errorf("收件人期望 old@x.com，实际 %q", got)
		}
	})

	t.Run("清空 notify_email 后回落列表第一个", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)
		setSetting(t, "notify_email", "b@y.com")

		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"notify_email":""}`, token), http.StatusOK)
		if got := utils.ResolveNotifyEmailFromSettings(); got != "a@x.com" {
			t.Errorf("清空后应回落到列表第一个，实际 %q", got)
		}
	})
}

// ---------------------------------------------------------------------------
// 导入路径与 basic 分组
// ---------------------------------------------------------------------------

func TestImportSettingsAdminEmails(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	t.Run("导入同样校验并归一化", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		body := `{"admin_emails":"[\"  A@X.com \",\"b@y.com\"]","notify_email":" B@Y.com "}`
		requireStatus(t, callWithToken(t, "POST", "/admin/data/import/settings", body, token), http.StatusOK)

		if got := utils.GetSetting("admin_emails"); got != `["a@x.com","b@y.com"]` {
			t.Errorf("导入后 admin_emails 应被归一化，实际 %q", got)
		}
		if got := utils.GetSetting("notify_email"); got != "b@y.com" {
			t.Errorf("导入后 notify_email 应被归一化，实际 %q", got)
		}
	})

	t.Run("导入非法值被拒绝且不落库", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		w := callWithToken(t, "POST", "/admin/data/import/settings",
			`{"site_name":"不应写入","admin_emails":"{oops"}`, token)
		requireStatus(t, w, http.StatusBadRequest)

		m := decodeJSON(t, w)
		if got, _ := m["message"].(string); got != "admin_emails 必须是 JSON 数组" {
			t.Errorf("导入校验错误信息不正确: %q", got)
		}
		if got := utils.GetSetting("site_name"); got != "" {
			t.Errorf("导入校验失败时不应写入任何设置，site_name 实际 %q", got)
		}
	})

	t.Run("白名单之外的键仍被静默忽略", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		requireStatus(t, callWithToken(t, "POST", "/admin/data/import/settings",
			`{"unknown_key":"x"}`, token), http.StatusOK)
		if got := utils.GetSetting("unknown_key"); got != "" {
			t.Errorf("未知键不应落库，实际 %q", got)
		}
	})
}

func TestGetSettingsBasicGroupCarriesAdminEmails(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "admin_email", "old@x.com")
	setSetting(t, "admin_emails", `["a@x.com"]`)
	setSetting(t, "notify_email", "a@x.com")

	var payload settingsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/settings?type=basic", "", token), &payload)

	for key, want := range map[string]string{
		"admin_email":  "old@x.com",
		"admin_emails": `["a@x.com"]`,
		"notify_email": "a@x.com",
	} {
		if got := payload.Data[key]; got != want {
			t.Errorf("basic 分组 %s 期望 %q，实际 %q", key, want, got)
		}
	}
}

func TestSettingsExportImportAdminEmails(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)
	setSetting(t, "notify_email", "b@y.com")

	var payload struct {
		Data struct {
			Settings map[string]string `json:"settings"`
		} `json:"data"`
	}
	decodeInto(t, callWithToken(t, "GET", "/admin/data/export/settings", "", token), &payload)

	if got := payload.Data.Settings["admin_emails"]; got != `["a@x.com","b@y.com"]` {
		t.Errorf("导出缺少 admin_emails：%v", got)
	}
	if got := payload.Data.Settings["notify_email"]; got != "b@y.com" {
		t.Errorf("导出缺少 notify_email：%v", got)
	}
}

// ---------------------------------------------------------------------------
// 博主特权与下发字段
// ---------------------------------------------------------------------------

func TestPostCommentMultipleAdminPrivileges(t *testing.T) {
	t.Run("列表里的人都免 60 秒冷却", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)

		ip := nextIP()
		addr := ip + ":4000"

		// 先以第一个管理员评论，再以第二个管理员在同一 IP 立刻评论
		requireStatus(t, callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "A", "a@x.com", "第一条"), addr), http.StatusOK)
		requireStatus(t, callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "B", "b@y.com", "第二条"), addr), http.StatusOK)

		// 非管理员在同一 IP 立刻评论仍被限流
		w := callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "C", "c@z.com", "第三条"), addr)
		requireStatus(t, w, http.StatusTooManyRequests)
	})

	t.Run("列表里的人都通过博主密钥校验", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "true")
		setSetting(t, "comment_auto_approve", "false")

		body := `{"post_slug":"/p","author":"B","email":"B@Y.com","content":"内容","admin_key":"secret-key"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", body), http.StatusOK)
		if got := latestComment(t).Status; got != "approved" {
			t.Errorf("第二个管理员的评论应直接通过，实际 %q", got)
		}

		// 密钥错误同样被拒（命中列表才校验）
		bad := `{"post_slug":"/p","author":"B","email":"b@y.com","content":"内容","admin_key":"wrong"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", bad), http.StatusForbidden)

		// 非管理员不校验密钥，仍按审核策略待审核
		other := `{"post_slug":"/p","author":"C","email":"c@z.com","content":"内容","admin_key":"wrong"}`
		requireStatus(t, callJSON(t, "POST", "/api/comments", other), http.StatusOK)
		if got := latestComment(t).Status; got != "pending" {
			t.Errorf("非管理员仍应待审核，实际 %q", got)
		}
	})
}

func TestGetCommentsAdminEmailHashes(t *testing.T) {
	resetState(t)

	t.Run("未启用博主密钥时不下发任何哈希", func(t *testing.T) {
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)

		var payload commentsPayload
		decodeInto(t, callJSON(t, "GET", "/api/comments?post_slug=/p", ""), &payload)
		if payload.Data.AdminEmailHash != "" {
			t.Errorf("未启用时不应下发 admin_email_hash，实际 %q", payload.Data.AdminEmailHash)
		}
	})

	t.Run("启用时下发数组哈希，并把 isBlogger 判给列表里的每个人", func(t *testing.T) {
		truncateAll()
		setSetting(t, "admin_emails", `["a@x.com","b@y.com"]`)
		setSetting(t, "notify_email", "b@y.com")
		setSetting(t, "admin_comment_key", "k")
		setSetting(t, "admin_comment_key_enabled", "true")

		seedComment(t, &model.Comment{PostSlug: "/p", Author: "A", Email: "A@X.com", ContentText: "a", ContentHTML: "<p>a</p>", PubDate: 1000})
		seedComment(t, &model.Comment{PostSlug: "/p", Author: "B", Email: "b@y.com", ContentText: "b", ContentHTML: "<p>b</p>", PubDate: 2000})
		seedComment(t, &model.Comment{PostSlug: "/p", Author: "C", Email: "c@z.com", ContentText: "c", ContentHTML: "<p>c</p>", PubDate: 3000})

		var payload struct {
			Data struct {
				Comments         []*commentResp `json:"comments"`
				AdminEmailHash   string         `json:"admin_email_hash"`
				AdminEmailHashes []string       `json:"admin_email_hashes"`
			} `json:"data"`
		}
		decodeInto(t, callJSON(t, "GET", "/api/comments?post_slug=/p", ""), &payload)

		wantHashes := []string{sha256HexOf("a@x.com"), sha256HexOf("b@y.com")}
		if len(payload.Data.AdminEmailHashes) != len(wantHashes) {
			t.Fatalf("admin_email_hashes 期望 %v，实际 %v", wantHashes, payload.Data.AdminEmailHashes)
		}
		for i := range wantHashes {
			if payload.Data.AdminEmailHashes[i] != wantHashes[i] {
				t.Errorf("admin_email_hashes[%d] 期望 %q，实际 %q", i, wantHashes[i], payload.Data.AdminEmailHashes[i])
			}
		}
		// 旧字段 = 通知邮箱（b@y.com）的哈希
		if want := sha256HexOf("b@y.com"); payload.Data.AdminEmailHash != want {
			t.Errorf("admin_email_hash 期望通知邮箱的哈希 %q，实际 %q", want, payload.Data.AdminEmailHash)
		}

		bloggers := map[string]bool{}
		for _, c := range payload.Data.Comments {
			bloggers[c.Author] = c.IsBlogger
		}
		if !bloggers["A"] || !bloggers["B"] {
			t.Errorf("列表里的每个人都应标记 isBlogger，实际 %v", bloggers)
		}
		if bloggers["C"] {
			t.Errorf("非列表成员不应标记 isBlogger，实际 %v", bloggers)
		}
	})

	t.Run("未配置列表时回落到旧键", func(t *testing.T) {
		truncateAll()
		setSetting(t, "admin_email", "Admin@X.com")
		setSetting(t, "admin_comment_key", "k")
		setSetting(t, "admin_comment_key_enabled", "true")

		var payload struct {
			Data struct {
				AdminEmailHash   string   `json:"admin_email_hash"`
				AdminEmailHashes []string `json:"admin_email_hashes"`
			} `json:"data"`
		}
		decodeInto(t, callJSON(t, "GET", "/api/comments?post_slug=/p", ""), &payload)

		want := sha256HexOf("admin@x.com")
		if payload.Data.AdminEmailHash != want {
			t.Errorf("admin_email_hash 期望 %q，实际 %q", want, payload.Data.AdminEmailHash)
		}
		if len(payload.Data.AdminEmailHashes) != 1 || payload.Data.AdminEmailHashes[0] != want {
			t.Errorf("admin_email_hashes 期望 [%s]，实际 %v", want, payload.Data.AdminEmailHashes)
		}
	})
}

// TestTestEmailUsesNotifyEmail 未配置任何管理员时测试邮件端点仍返回 400
func TestTestEmailWithoutAdmins(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/settings/test-email", "", token)
	requireStatus(t, w, http.StatusBadRequest)

	m := decodeJSON(t, w)
	if got, _ := m["message"].(string); got != "Admin email is not configured. " {
		t.Errorf("错误信息期望 %q，实际 %q", "Admin email is not configured. ", got)
	}

	// 配好列表后不再因为「没有收件人」被拒（这里没有 SMTP，因此落到下一个分支）
	setSetting(t, "admin_emails", `["a@x.com"]`)
	w = callWithToken(t, "POST", "/admin/settings/test-email", "", token)
	requireStatus(t, w, http.StatusBadRequest)
	m = decodeJSON(t, w)
	if got, _ := m["message"].(string); got == "Admin email is not configured. " {
		t.Errorf("有收件人时不应再报「未配置管理员邮箱」")
	}
}
