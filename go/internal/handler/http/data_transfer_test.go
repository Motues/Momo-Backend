package http

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

type exportCommentItem struct {
	ID          int64   `json:"id"`
	PubDate     string  `json:"pubDate"`
	PostSlug    string  `json:"postSlug"`
	Author      string  `json:"author"`
	Email       string  `json:"email"`
	URL         *string `json:"url"`
	IPAddress   *string `json:"ipAddress"`
	OS          *string `json:"os"`
	Browser     *string `json:"browser"`
	ContentText string  `json:"contentText"`
	ContentHtml string  `json:"contentHtml"`
	ParentID    *int64  `json:"parentId"`
	Status      string  `json:"status"`
}

type exportCommentsPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		ExportedAt string              `json:"exportedAt"`
		Type       string              `json:"type"`
		Version    string              `json:"version"`
		Total      int                 `json:"total"`
		Comments   []exportCommentItem `json:"comments"`
	} `json:"data"`
}

type exportSettingsPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		ExportedAt       string            `json:"exportedAt"`
		Type             string            `json:"type"`
		Version          string            `json:"version"`
		SensitiveOmitted []string          `json:"sensitiveOmitted"`
		Settings         map[string]string `json:"settings"`
	} `json:"data"`
}

type importResultPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Imported int      `json:"imported"`
		Errors   []string `json:"errors"`
	} `json:"data"`
}

// importCommentsBody 把导出的评论包装成导入请求体
func importCommentsBody(t *testing.T, items []exportCommentItem) string {
	t.Helper()
	raw, err := json.Marshal(map[string]interface{}{"comments": items})
	if err != nil {
		t.Fatalf("构造导入请求体失败: %v", err)
	}
	return string(raw)
}

// ---------------------------------------------------------------------------
// 评论导出
// ---------------------------------------------------------------------------

func TestExportComments(t *testing.T) {
	resetState(t)

	root := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "root", Email: "r@x.com", URL: strPtr("https://r.com"),
		IPAddress: strPtr("203.0.113.1"), OS: strPtr("Windows"), Browser: strPtr("Chrome"),
		ContentText: "根评论", ContentHTML: "<p>根评论</p>", Status: "approved", PubDate: 1712345678000,
	})
	seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "child", Email: "c@x.com",
		ContentText: "回复", ContentHTML: "<p>回复</p>", Status: "pending", PubDate: 1712345679000,
		ParentID: &root.ID,
	})

	token := adminToken(t)
	w := callWithToken(t, "GET", "/admin/data/export/comments", "", token)
	requireStatus(t, w, 200)

	var payload exportCommentsPayload
	decodeInto(t, w, &payload)

	if payload.Data.Type != "comments" {
		t.Errorf("type 期望 comments，实际 %q", payload.Data.Type)
	}
	if payload.Data.Version != "test-version" {
		t.Errorf("version 期望 test-version，实际 %q", payload.Data.Version)
	}
	if payload.Data.Total != 2 {
		t.Errorf("total 期望 2，实际 %d", payload.Data.Total)
	}
	if len(payload.Data.Comments) != 2 {
		t.Fatalf("应导出 2 条评论，实际 %d 条", len(payload.Data.Comments))
	}
	if payload.Data.ExportedAt == "" {
		t.Errorf("exportedAt 不应为空")
	}

	first := payload.Data.Comments[0]
	if first.PubDate != "2024-04-05T19:34:38.000Z" {
		t.Errorf("pubDate 应为毫秒 ISO，实际 %q", first.PubDate)
	}
	if first.PostSlug != "/p" || first.Author != "root" || first.Email != "r@x.com" {
		t.Errorf("字段映射不正确: %+v", first)
	}
	if first.URL == nil || *first.URL != "https://r.com" {
		t.Errorf("url 映射不正确: %v", first.URL)
	}
	if first.IPAddress == nil || *first.IPAddress != "203.0.113.1" {
		t.Errorf("ipAddress 映射不正确: %v", first.IPAddress)
	}
	if first.ContentText != "根评论" || first.ContentHtml != "<p>根评论</p>" {
		t.Errorf("正文字段映射不正确: %+v", first)
	}
	if first.Status != "approved" {
		t.Errorf("status 映射不正确: %q", first.Status)
	}
	if first.ParentID != nil {
		t.Errorf("顶层评论不应带 parentId，实际 %v", first.ParentID)
	}

	// 回复必须带上 parentId，否则导入后回复关系会丢失
	second := payload.Data.Comments[1]
	if second.ParentID == nil || *second.ParentID != root.ID {
		t.Errorf("回复应导出 parentId=%d，实际 %v", root.ID, second.ParentID)
	}
	if second.Status != "pending" {
		t.Errorf("非 approved 状态也应被导出，实际 %q", second.Status)
	}
}

func TestExportCommentsEmpty(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/data/export/comments", "", token)
	requireStatus(t, w, 200)

	if !strings.Contains(w.Body.String(), `"comments":[]`) {
		t.Errorf("空库应导出空数组，实际 %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"total":0`) {
		t.Errorf("空库 total 应为 0，实际 %s", w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 评论导入
// ---------------------------------------------------------------------------

func TestExportImportCommentsRoundTrip(t *testing.T) {
	resetState(t)

	root := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "root", Email: "r@x.com", URL: strPtr("https://r.com"),
		IPAddress: strPtr("203.0.113.1"), OS: strPtr("Windows"), Browser: strPtr("Chrome"),
		ContentText: "**根评论**", ContentHTML: "<p><strong>根评论</strong></p>",
		Status: "approved", PubDate: 1712345678000,
	})
	seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "child", Email: "c@x.com",
		ContentText: "回复", ContentHTML: "<p>回复</p>", Status: "pending", PubDate: 1712345679000,
		ParentID: &root.ID,
	})

	token := adminToken(t)

	var exported exportCommentsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/data/export/comments", "", token), &exported)

	w := callWithToken(t, "POST", "/admin/data/import/comments", importCommentsBody(t, exported.Data.Comments), token)
	requireStatus(t, w, 200)

	var result importResultPayload
	decodeInto(t, w, &result)
	if result.Data.Imported != 2 {
		t.Fatalf("应导入 2 条，实际 %d 条（errors=%v）", result.Data.Imported, result.Data.Errors)
	}
	if len(result.Data.Errors) != 0 {
		t.Errorf("往返导入不应产生错误，实际 %v", result.Data.Errors)
	}
	if countComments(t) != 4 {
		t.Fatalf("导入后应有 4 条评论，实际 %d 条", countComments(t))
	}

	// 新导入的两条应保留内容与毫秒时间戳
	var imported []model.Comment
	if err := testDB.Select(&imported, "SELECT * FROM Comment WHERE id > ? ORDER BY id", root.ID+1); err != nil {
		t.Fatalf("查询导入结果失败: %v", err)
	}
	if len(imported) != 2 {
		t.Fatalf("应查询到 2 条导入记录，实际 %d 条", len(imported))
	}
	if imported[0].PubDate != 1712345678000 {
		t.Errorf("导入应保留毫秒时间戳，期望 1712345678000，实际 %d", imported[0].PubDate)
	}
	if imported[0].Author != "root" || imported[0].Email != "r@x.com" {
		t.Errorf("导入字段不正确: %+v", imported[0])
	}
	if imported[0].Status != "approved" || imported[1].Status != "pending" {
		t.Errorf("导入应保留状态: %q / %q", imported[0].Status, imported[1].Status)
	}
	if imported[1].ParentID == nil || *imported[1].ParentID != root.ID {
		t.Errorf("导入应保留 parent_id，实际 %v", imported[1].ParentID)
	}
	// content_html 由正文重新渲染，不允许直接信任导入文件
	if !strings.Contains(imported[0].ContentHTML, "<strong>根评论</strong>") {
		t.Errorf("导入应按 markdown 重新渲染 content_html，实际 %q", imported[0].ContentHTML)
	}
}

func TestImportCommentsRenamesAndSanitizes(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"comments":[
		{"postSlug":"/p","author":"<script>alert(1)</script>正常","email":"a@x.com",
		 "contentText":"前<script>alert(1)</script>后","contentHtml":"<script>evil()</script>",
		 "url":"javascript:alert(1)","status":"approved"}
	]}`
	w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
	requireStatus(t, w, 200)

	var result importResultPayload
	decodeInto(t, w, &result)
	if result.Data.Imported != 1 {
		t.Fatalf("应导入 1 条，实际 %d 条（errors=%v）", result.Data.Imported, result.Data.Errors)
	}

	got := latestComment(t)
	if strings.Contains(strings.ToLower(got.Author), "<script") {
		t.Errorf("导入的作者应被清洗，实际 %q", got.Author)
	}
	if got.Author != "正常" {
		t.Errorf("作者期望 %q，实际 %q", "正常", got.Author)
	}
	if strings.Contains(strings.ToLower(got.ContentText), "<script") {
		t.Errorf("导入的正文应被清洗，实际 %q", got.ContentText)
	}
	if strings.Contains(strings.ToLower(got.ContentHTML), "<script") {
		t.Errorf("导入不应信任文件中的 contentHtml，实际 %q", got.ContentHTML)
	}
	if got.URL != nil {
		t.Errorf("危险 url 应被丢弃，实际 %v", *got.URL)
	}
}

func TestImportCommentsDefaultStatusIsPending(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"comments":[{"postSlug":"/p","author":"a","email":"a@x.com","contentText":"内容"}]}`
	w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
	requireStatus(t, w, 200)

	if got := latestComment(t).Status; got != "pending" {
		t.Errorf("缺省状态应为 pending（最安全），实际 %q", got)
	}
}

// TestImportCommentsAcceptsArbitraryStatus 记录当前行为：
// 导入路径不对 status 做枚举白名单校验，任意字符串都会写入数据库。
func TestImportCommentsAcceptsArbitraryStatus(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"comments":[
		{"postSlug":"/p","author":"a","email":"a@x.com","contentText":"内容","status":"hacked"},
		{"postSlug":"/p","author":"b","email":"b@x.com","contentText":"内容","status":"APPROVED"}
	]}`
	w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
	requireStatus(t, w, 200)

	var statuses []string
	if err := testDB.Select(&statuses, "SELECT status FROM Comment ORDER BY id"); err != nil {
		t.Fatalf("查询状态失败: %v", err)
	}
	if len(statuses) != 2 || statuses[0] != "hacked" || statuses[1] != "APPROVED" {
		t.Errorf("当前实现会原样写入任意状态字符串，实际 %v", statuses)
	}
	// 这类记录不会被前台查询命中（只查 approved）
	if utils.IsValidCommentStatus(statuses[0]) {
		t.Errorf("前置条件：hacked 不是合法状态")
	}
}

func TestImportCommentsPubDateParsing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		pubDate string // JSON 片段
		wantMs  int64  // 0 表示无法解析，应回落为当前时间
	}{
		{"毫秒整数", `1712345678901`, 1712345678901},
		{"数字字符串", `"1712345678901"`, 1712345678901},
		{"ISO 带 Z", `"2024-03-05T06:07:08.000Z"`, 1709618828000},
		{"ISO 带毫秒与偏移", `"2024-03-05T06:07:08+08:00"`, 1709590028000},
		{"空格分隔", `"2024-03-05 06:07:08"`, 1709618828000},
		{"仅日期", `"2024-03-05"`, 1709596800000},
		{"null", `null`, 0},
		{"空字符串", `""`, 0},
		{"无法解析", `"not-a-date"`, 0},
		{"零", `0`, 0},
		{"负数", `-1`, 0},
		{"浮点数", `1712345678901.5`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			body := fmt.Sprintf(`{"comments":[{"postSlug":"/p","author":"a","email":"a@x.com","contentText":"内容","pubDate":%s}]}`, tc.pubDate)
			before := time.Now().UnixMilli()
			w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
			requireStatus(t, w, 200)
			after := time.Now().UnixMilli()

			var result importResultPayload
			decodeInto(t, w, &result)
			if result.Data.Imported != 1 {
				t.Fatalf("应导入 1 条，实际 %d 条（errors=%v）", result.Data.Imported, result.Data.Errors)
			}

			got := latestComment(t).PubDate
			if tc.wantMs != 0 {
				if got != tc.wantMs {
					t.Errorf("pub_date 期望 %d，实际 %d", tc.wantMs, got)
				}
				return
			}
			if got < before || got > after {
				t.Errorf("无法解析的 pub_date 应回落为当前时间（%d~%d），实际 %d", before, after, got)
			}
		})
	}
}

func TestImportCommentsValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		{"空请求体", ""},
		{"非法 JSON", "{"},
		{"缺少 comments 字段", `{}`},
		{"comments 为空数组", `{"comments":[]}`},
		{"comments 类型错误", `{"comments":"abc"}`},
		{"comments 为 null", `{"comments":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "POST", "/admin/data/import/comments", tc.body, token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
			if countComments(t) != 0 {
				t.Errorf("校验失败时不应写入评论，实际 %d 条", countComments(t))
			}
		})
	}
}

func TestImportCommentsPartialFailure(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 第 2 条缺少 email，第 3 条正文超长，第 4 条作者超长
	body := fmt.Sprintf(`{"comments":[
		{"postSlug":"/p","author":"ok","email":"ok@x.com","contentText":"正常"},
		{"postSlug":"/p","author":"noemail","contentText":"缺邮箱"},
		{"postSlug":"/p","author":"big","email":"big@x.com","contentText":%q},
		{"postSlug":"/p","author":%q,"email":"long@x.com","contentText":"正文"}
	]}`, strings.Repeat("字", 2001), strings.Repeat("名", 101))

	w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
	requireStatus(t, w, 200)

	var result importResultPayload
	decodeInto(t, w, &result)
	if result.Data.Imported != 1 {
		t.Errorf("应只有 1 条导入成功，实际 %d 条", result.Data.Imported)
	}
	if len(result.Data.Errors) != 3 {
		t.Errorf("应报告 3 条错误，实际 %d 条: %v", len(result.Data.Errors), result.Data.Errors)
	}
	if countComments(t) != 1 {
		t.Errorf("数据库应只有 1 条记录，实际 %d 条", countComments(t))
	}
	if !strings.Contains(result.Message, "成功 1 条") || !strings.Contains(result.Message, "失败 3 条") {
		t.Errorf("message 应包含成功/失败计数，实际 %q", result.Message)
	}
}

func TestImportCommentsAllFieldsRequired(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		row  string
	}{
		{"缺少 postSlug", `{"author":"a","email":"a@x.com","contentText":"c"}`},
		{"缺少 author", `{"postSlug":"/p","email":"a@x.com","contentText":"c"}`},
		{"缺少 email", `{"postSlug":"/p","author":"a","contentText":"c"}`},
		{"缺少 contentText", `{"postSlug":"/p","author":"a","email":"a@x.com"}`},
		{"postSlug 为空串", `{"postSlug":"","author":"a","email":"a@x.com","contentText":"c"}`},
		{"author 为空串", `{"postSlug":"/p","author":"","email":"a@x.com","contentText":"c"}`},
		{"email 为空串", `{"postSlug":"/p","author":"a","email":"","contentText":"c"}`},
		{"contentText 为空串", `{"postSlug":"/p","author":"a","email":"a@x.com","contentText":""}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"comments":[` + tc.row + `]}`
			w := callWithToken(t, "POST", "/admin/data/import/comments", body, token)
			requireStatus(t, w, 200)

			var result importResultPayload
			decodeInto(t, w, &result)
			if result.Data.Imported != 0 {
				t.Errorf("缺失必填字段时不应导入，实际 %d 条", result.Data.Imported)
			}
			if len(result.Data.Errors) != 1 {
				t.Errorf("应报告 1 条错误，实际 %v", result.Data.Errors)
			}
			if countComments(t) != 0 {
				t.Errorf("不应写入数据库，实际 %d 条", countComments(t))
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 设置导出 / 导入
// ---------------------------------------------------------------------------

func TestExportSettings(t *testing.T) {
	resetState(t)
	setSetting(t, "site_name", "站点")
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_email", "admin@x.com")
	setSetting(t, "email_password", "smtp-secret")
	setSetting(t, "admin_comment_key", "blogger-key")
	setSetting(t, "ip_blacklist", `["1.2.3.4"]`)
	setSetting(t, "admin_password", "$2a$10$fakehash")
	setSetting(t, "password_changed", "true")
	setSetting(t, "comment_verify_secret", "internal-secret")

	token := adminToken(t)
	w := callWithToken(t, "GET", "/admin/data/export/settings", "", token)
	requireStatus(t, w, 200)

	var payload exportSettingsPayload
	decodeInto(t, w, &payload)

	if payload.Data.Type != "settings" {
		t.Errorf("type 期望 settings，实际 %q", payload.Data.Type)
	}
	if payload.Data.Settings["site_name"] != "站点" {
		t.Errorf("site_name 应被导出，实际 %q", payload.Data.Settings["site_name"])
	}
	// admin_name 必须导出，否则“导出→导入”会丢失管理员用户名
	if payload.Data.Settings["admin_name"] != "boss" {
		t.Errorf("admin_name 应被导出，实际 %q", payload.Data.Settings["admin_name"])
	}
	if payload.Data.Settings["ip_blacklist"] != `["1.2.3.4"]` {
		t.Errorf("ip_blacklist 应被导出，实际 %q", payload.Data.Settings["ip_blacklist"])
	}

	// 敏感字段置空并登记在 sensitiveOmitted
	if got := payload.Data.Settings["email_password"]; got != "" {
		t.Errorf("email_password 应被置空，实际 %q", got)
	}
	if got := payload.Data.Settings["admin_comment_key"]; got != "" {
		t.Errorf("admin_comment_key 应被置空，实际 %q", got)
	}
	omitted := strings.Join(payload.Data.SensitiveOmitted, ",")
	if !strings.Contains(omitted, "email_password") || !strings.Contains(omitted, "admin_comment_key") {
		t.Errorf("sensitiveOmitted 应包含两个敏感字段，实际 %v", payload.Data.SensitiveOmitted)
	}

	// 内部密钥与密码哈希绝不导出
	for _, key := range []string{"admin_password", "password_changed", "comment_verify_secret"} {
		if _, ok := payload.Data.Settings[key]; ok {
			t.Errorf("设置 %s 不应被导出", key)
		}
	}
}

func TestImportSettings(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"site_name":"导入的站点","admin_name":"newboss","ip_blacklist":"[\"10.0.0.1\"]","unknown_key":"x"}`
	w := callWithToken(t, "POST", "/admin/data/import/settings", body, token)
	requireStatus(t, w, 200)

	var resp struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Updated []string `json:"updated"`
		} `json:"data"`
	}
	decodeInto(t, w, &resp)

	updated := strings.Join(resp.Data.Updated, ",")
	for _, key := range []string{"site_name", "admin_name", "ip_blacklist"} {
		if !strings.Contains(updated, key) {
			t.Errorf("updated 应包含 %s，实际 %v", key, resp.Data.Updated)
		}
	}
	if strings.Contains(updated, "unknown_key") {
		t.Errorf("白名单之外的键不应出现在 updated 中，实际 %v", resp.Data.Updated)
	}
	if utils.GetSetting("site_name") != "导入的站点" {
		t.Errorf("site_name 未导入成功，实际 %q", utils.GetSetting("site_name"))
	}
	if utils.GetSetting("admin_name") != "newboss" {
		t.Errorf("admin_name 未导入成功，实际 %q", utils.GetSetting("admin_name"))
	}
	var count int
	if err := testDB.Get(&count, "SELECT COUNT(*) FROM Settings WHERE key = 'unknown_key'"); err != nil {
		t.Fatalf("查询设置失败: %v", err)
	}
	if count != 0 {
		t.Errorf("白名单之外的键不应落库")
	}
}

func TestImportSettingsKeepsSensitiveValuesWhenBlank(t *testing.T) {
	resetState(t)
	setSetting(t, "email_password", "existing-smtp")
	setSetting(t, "admin_comment_key", "existing-key")
	token := adminToken(t)

	body := `{"site_name":"x","email_password":"","admin_comment_key":""}`
	w := callWithToken(t, "POST", "/admin/data/import/settings", body, token)
	requireStatus(t, w, 200)

	if got := utils.GetSetting("email_password"); got != "existing-smtp" {
		t.Errorf("空值的敏感字段不应覆盖已有配置，实际 %q", got)
	}
	if got := utils.GetSetting("admin_comment_key"); got != "existing-key" {
		t.Errorf("空值的敏感字段不应覆盖已有配置，实际 %q", got)
	}

	// 非空值可以覆盖
	body = `{"email_password":"new-smtp","admin_comment_key":"new-key"}`
	w = callWithToken(t, "POST", "/admin/data/import/settings", body, token)
	requireStatus(t, w, 200)
	if got := utils.GetSetting("email_password"); got != "new-smtp" {
		t.Errorf("非空值应覆盖，实际 %q", got)
	}
	if got := utils.GetSetting("admin_comment_key"); got != "new-key" {
		t.Errorf("非空值应覆盖，实际 %q", got)
	}
}

func TestImportSettingsValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"非法 JSON", "{", 400},
		{"JSON 数组", "[]", 400},
		{"值类型错误", `{"site_name":123}`, 400},
		{"ip_blacklist 非法", `{"ip_blacklist":"not-json"}`, 400},
		{"ip_blacklist 条目非法", `{"ip_blacklist":"[\"nope\"]"}`, 400},
		{"空对象", `{}`, 200},
		{"JSON null 等价空对象", `null`, 200},
		{"合法 ip_blacklist", `{"ip_blacklist":"[\"1.2.3.4\"]"}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "POST", "/admin/data/import/settings", tc.body, token)
			requireStatus(t, w, tc.wantStatus)
			if tc.wantStatus == 400 {
				requireBodyCode(t, w, 400)
			}
		})
	}
}

func TestExportImportSettingsRoundTrip(t *testing.T) {
	resetState(t)
	setSetting(t, "site_name", "往返站点")
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_email", "admin@x.com")
	setSetting(t, "comment_auto_approve", "false")
	setSetting(t, "blogger_badge_enabled", "true")
	setSetting(t, "email_password", "keep-me")
	setSetting(t, "admin_comment_key", "keep-key")

	token := adminToken(t)

	var exported exportSettingsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/data/export/settings", "", token), &exported)

	raw, err := json.Marshal(exported.Data.Settings)
	if err != nil {
		t.Fatalf("编码导出设置失败: %v", err)
	}

	// 先清空再导入，验证往返不丢数据
	truncateAll()
	utils.ClearAllTokens()

	token = adminToken(t)
	w := callWithToken(t, "POST", "/admin/data/import/settings", string(raw), token)
	requireStatus(t, w, 200)

	for key, want := range map[string]string{
		"site_name":             "往返站点",
		"admin_name":            "boss",
		"admin_email":           "admin@x.com",
		"comment_auto_approve":  "false",
		"blogger_badge_enabled": "true",
	} {
		if got := utils.GetSetting(key); got != want {
			t.Errorf("往返后设置 %s 期望 %q，实际 %q", key, want, got)
		}
	}
	// 被置空的敏感字段在导入时跳过，因此不会写入空值
	if got := utils.GetSetting("email_password"); got != "" {
		t.Errorf("导出时被置空的 email_password 不应写入，实际 %q", got)
	}
}
