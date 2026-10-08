package http

import (
	"fmt"
	"strings"
	"testing"

	"momo-backend-go/internal/model"
)

type adminCommentItem struct {
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
	Status      string  `json:"status"`
}

type adminCommentsPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Comments   []adminCommentItem `json:"comments"`
		Pagination struct {
			Page      int   `json:"page"`
			Limit     int   `json:"limit"`
			TotalPage int64 `json:"totalPage"`
		} `json:"pagination"`
	} `json:"data"`
}

// seedAdminComments 写入 n 条评论，pub_date 依次递减以便校验排序
func seedAdminComments(t *testing.T, n int, status string) {
	t.Helper()
	for i := 0; i < n; i++ {
		seedComment(t, &model.Comment{
			PostSlug:    fmt.Sprintf("/p%d", i),
			Author:      fmt.Sprintf("author%d", i),
			Email:       fmt.Sprintf("a%d@x.com", i),
			URL:         strPtr("https://x.com"),
			IPAddress:   strPtr("203.0.113.1"),
			OS:          strPtr("Windows 10"),
			Browser:     strPtr("Chrome 120"),
			ContentText: fmt.Sprintf("内容%d", i),
			ContentHTML: fmt.Sprintf("<p>内容%d</p>", i),
			Status:      status,
			PubDate:     int64(1_700_000_000_000 - i*1000),
		})
	}
}

// ---------------------------------------------------------------------------
// GET /admin/comments/list
// ---------------------------------------------------------------------------

func TestListAllComments(t *testing.T) {
	resetState(t)
	seedAdminComments(t, 3, "approved")
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/comments/list", "", token)
	requireStatus(t, w, 200)

	var payload adminCommentsPayload
	decodeInto(t, w, &payload)

	if payload.Code != 200 || payload.Message != "Comments fetched successfully" {
		t.Errorf("响应头字段不正确: code=%d message=%q", payload.Code, payload.Message)
	}
	if len(payload.Data.Comments) != 3 {
		t.Fatalf("应返回 3 条评论，实际 %d 条", len(payload.Data.Comments))
	}
	if payload.Data.Pagination.Page != 1 || payload.Data.Pagination.Limit != 10 {
		t.Errorf("默认分页应为 page=1 limit=10，实际 %+v", payload.Data.Pagination)
	}
	if payload.Data.Pagination.TotalPage != 1 {
		t.Errorf("totalPage 期望 1，实际 %d", payload.Data.Pagination.TotalPage)
	}

	// 按 pub_date 降序（最新的在前）
	for i := 1; i < len(payload.Data.Comments); i++ {
		if payload.Data.Comments[i].PubDate >= payload.Data.Comments[i-1].PubDate {
			t.Errorf("评论应按时间降序返回: %q, %q", payload.Data.Comments[i-1].PubDate, payload.Data.Comments[i].PubDate)
			break
		}
	}

	first := payload.Data.Comments[0]
	if first.PostSlug != "/p0" || first.Author != "author0" || first.Email != "a0@x.com" {
		t.Errorf("字段映射不正确: %+v", first)
	}
	if first.Status != "approved" {
		t.Errorf("status 应为 approved，实际 %q", first.Status)
	}
	if first.URL == nil || *first.URL != "https://x.com" {
		t.Errorf("url 映射不正确: %v", first.URL)
	}
	if first.IPAddress == nil || *first.IPAddress != "203.0.113.1" {
		t.Errorf("ipAddress 映射不正确: %v", first.IPAddress)
	}
	if first.OS == nil || *first.OS != "Windows 10" || first.Browser == nil || *first.Browser != "Chrome 120" {
		t.Errorf("os/browser 映射不正确: %v / %v", first.OS, first.Browser)
	}
	if first.ContentText != "内容0" || first.ContentHtml != "<p>内容0</p>" {
		t.Errorf("正文字段映射不正确: %q / %q", first.ContentText, first.ContentHtml)
	}
	if !strings.HasSuffix(first.PubDate, "Z") || len(first.PubDate) != 24 {
		t.Errorf("pubDate 应为毫秒 ISO（UTC），实际 %q", first.PubDate)
	}
}

func TestListAllCommentsPagination(t *testing.T) {
	resetState(t)
	seedAdminComments(t, 25, "approved")
	token := adminToken(t)

	for _, tc := range []struct {
		name          string
		query         string
		wantLen       int
		wantPage      int
		wantTotalPage int64
	}{
		{"第一页", "", 10, 1, 3},
		{"第二页", "?page=2", 10, 2, 3},
		{"第三页（不满）", "?page=3", 5, 3, 3},
		{"越界页返回空", "?page=99", 0, 99, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/comments/list"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload adminCommentsPayload
			decodeInto(t, w, &payload)

			if len(payload.Data.Comments) != tc.wantLen {
				t.Errorf("条数期望 %d，实际 %d", tc.wantLen, len(payload.Data.Comments))
			}
			if payload.Data.Pagination.Page != tc.wantPage {
				t.Errorf("page 期望 %d，实际 %d", tc.wantPage, payload.Data.Pagination.Page)
			}
			if payload.Data.Pagination.TotalPage != tc.wantTotalPage {
				t.Errorf("totalPage 期望 %d，实际 %d", tc.wantTotalPage, payload.Data.Pagination.TotalPage)
			}
		})
	}
}

func TestListAllCommentsInvalidPage(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, query := range []string{"?page=0", "?page=-1", "?page=abc", "?page=", "?page=1.5", "?page=%20"} {
		t.Run(query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/comments/list"+query, "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			if m["message"] != "Invalid query parameters" {
				t.Errorf("message 期望 Invalid query parameters，实际 %v", m["message"])
			}
		})
	}
}

func TestListAllCommentsStatusFilter(t *testing.T) {
	resetState(t)
	for i := 0; i < 3; i++ {
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: fmt.Sprintf("a%d", i), Email: fmt.Sprintf("a%d@x.com", i),
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: int64(1000 + i),
		})
	}
	for i := 0; i < 2; i++ {
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: fmt.Sprintf("p%d", i), Email: fmt.Sprintf("p%d@x.com", i),
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "pending", PubDate: int64(2000 + i),
		})
	}
	seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "d", Email: "d@x.com",
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "deleted", PubDate: 3000,
	})

	token := adminToken(t)
	for _, tc := range []struct {
		name          string
		query         string
		wantLen       int
		wantTotalPage int64
	}{
		{"不过滤返回全部", "", 6, 1},
		{"approved", "?status=approved", 3, 1},
		{"pending", "?status=pending", 2, 1},
		{"deleted", "?status=deleted", 1, 1},
		{"rejected 无数据", "?status=rejected", 0, 0},
		{"未知状态无数据", "?status=hacked", 0, 0},
		{"SQL 注入式状态无数据", "?status=" + queryEscape("' OR 1=1 --"), 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/comments/list"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload adminCommentsPayload
			decodeInto(t, w, &payload)

			if len(payload.Data.Comments) != tc.wantLen {
				t.Errorf("条数期望 %d，实际 %d", tc.wantLen, len(payload.Data.Comments))
			}
			if payload.Data.Pagination.TotalPage != tc.wantTotalPage {
				t.Errorf("totalPage 期望 %d，实际 %d", tc.wantTotalPage, payload.Data.Pagination.TotalPage)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// PUT /admin/comments/status
// ---------------------------------------------------------------------------

func TestUpdateCommentStatus(t *testing.T) {
	for _, status := range []string{"approved", "pending", "rejected", "deleted"} {
		t.Run("设置为 "+status, func(t *testing.T) {
			resetState(t)
			c := seedComment(t, &model.Comment{
				PostSlug: "/p", Author: "a", Email: "a@x.com",
				ContentText: "t", ContentHTML: "<p>t</p>", Status: "pending", PubDate: 1000,
			})

			token := adminToken(t)
			w := callWithToken(t, "PUT", fmt.Sprintf("/admin/comments/status?id=%d&status=%s", c.ID, queryEscape(status)), "", token)
			requireStatus(t, w, 200)
			requireBodyCode(t, w, 200)

			m := decodeJSON(t, w)
			if m["message"] != "Comment status updated" {
				t.Errorf("message 期望 Comment status updated，实际 %v", m["message"])
			}
			if got := commentByID(t, c.ID).Status; got != status {
				t.Errorf("数据库状态期望 %q，实际 %q", status, got)
			}
		})
	}
}

func TestUpdateCommentStatusInvalidEnum(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: "a@x.com",
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	for _, status := range []string{"hacked", "APPROVED", "Approved", " approved", "approved ", "", "spam", "0", "1"} {
		t.Run("status="+status, func(t *testing.T) {
			w := callWithToken(t, "PUT",
				fmt.Sprintf("/admin/comments/status?id=%d&status=%s", c.ID, queryEscape(status)), "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			msg, _ := m["message"].(string)
			if !strings.Contains(msg, "Invalid status") {
				t.Errorf("message 应说明状态非法，实际 %q", msg)
			}
			if got := commentByID(t, c.ID).Status; got != "approved" {
				t.Errorf("非法状态不应写库，实际 %q", got)
			}
		})
	}
}

func TestUpdateCommentStatusInvalidID(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, query := range []string{"", "?status=approved", "?id=&status=approved", "?id=abc&status=approved",
		"?id=1.5&status=approved", "?id=%20&status=approved"} {
		t.Run("query="+query, func(t *testing.T) {
			w := callWithToken(t, "PUT", "/admin/comments/status"+query, "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			if m["message"] != "Invalid id" {
				t.Errorf("message 期望 Invalid id，实际 %v", m["message"])
			}
		})
	}
}

func TestUpdateCommentStatusNonexistentID(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 不存在的 id 不报错（影响 0 行）
	for _, id := range []int64{0, -1, 999999} {
		w := callWithToken(t, "PUT", fmt.Sprintf("/admin/comments/status?id=%d&status=approved", id), "", token)
		requireStatus(t, w, 200)
	}
}

func TestUpdateCommentStatusCascade(t *testing.T) {
	resetState(t)

	root := seedComment(t, &model.Comment{PostSlug: "/p", Author: "root", Email: "r@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000})
	child := seedComment(t, &model.Comment{PostSlug: "/p", Author: "child", Email: "c@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 2000, ParentID: &root.ID})
	unrelated := seedComment(t, &model.Comment{PostSlug: "/p", Author: "other", Email: "o@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 3000})

	token := adminToken(t)
	w := callWithToken(t, "PUT", fmt.Sprintf("/admin/comments/status?id=%d&status=deleted", root.ID), "", token)
	requireStatus(t, w, 200)

	if got := commentByID(t, root.ID).Status; got != "deleted" {
		t.Errorf("根评论状态期望 deleted，实际 %q", got)
	}
	if got := commentByID(t, child.ID).Status; got != "deleted" {
		t.Errorf("子评论应级联为 deleted，实际 %q", got)
	}
	if got := commentByID(t, unrelated.ID).Status; got != "approved" {
		t.Errorf("无关评论不应被级联修改，实际 %q", got)
	}

	// approved 不级联
	root2 := seedComment(t, &model.Comment{PostSlug: "/p2", Author: "root", Email: "r@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "pending", PubDate: 4000})
	child2 := seedComment(t, &model.Comment{PostSlug: "/p2", Author: "child", Email: "c@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "pending", PubDate: 5000, ParentID: &root2.ID})
	w = callWithToken(t, "PUT", fmt.Sprintf("/admin/comments/status?id=%d&status=approved", root2.ID), "", token)
	requireStatus(t, w, 200)
	if got := commentByID(t, child2.ID).Status; got != "pending" {
		t.Errorf("approved 不应级联，实际 %q", got)
	}
}

// ---------------------------------------------------------------------------
// PUT /admin/comments/edit
// ---------------------------------------------------------------------------

func TestUpdateCommentContent(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "old", Email: "old@x.com", URL: strPtr("https://old.com"),
		ContentText: "old text", ContentHTML: "<p>old text</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	body := fmt.Sprintf(`{"id":%d,"author":"新作者","email":"new@x.com","content_text":"**新内容**","url":"https://new.com"}`, c.ID)
	w := callWithToken(t, "PUT", "/admin/comments/edit", body, token)
	requireStatus(t, w, 200)
	requireBodyCode(t, w, 200)

	got := commentByID(t, c.ID)
	if got.Author != "新作者" || got.Email != "new@x.com" {
		t.Errorf("作者/邮箱未更新: %+v", got)
	}
	if got.ContentText != "**新内容**" {
		t.Errorf("content_text 期望原始文本，实际 %q", got.ContentText)
	}
	// 只改 content_text 时应自动重渲染 content_html
	if !strings.Contains(got.ContentHTML, "<strong>新内容</strong>") {
		t.Errorf("content_html 应自动按 markdown 重渲染，实际 %q", got.ContentHTML)
	}
	if got.URL == nil || *got.URL != "https://new.com" {
		t.Errorf("url 未更新: %v", got.URL)
	}
	// 未传的字段保持原值
	if got.Status != "approved" || got.PubDate != 1000 || got.PostSlug != "/p" {
		t.Errorf("未传字段不应变化: %+v", got)
	}
}

func TestUpdateCommentContentHTMLIsSanitized(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: "a@x.com",
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	body := fmt.Sprintf(`{"id":%d,"content_html":"<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>"}`, c.ID)
	w := callWithToken(t, "PUT", "/admin/comments/edit", body, token)
	requireStatus(t, w, 200)

	got := commentByID(t, c.ID)
	if !strings.Contains(got.ContentHTML, "<p>ok</p>") {
		t.Errorf("正常 HTML 应保留，实际 %q", got.ContentHTML)
	}
	lower := strings.ToLower(got.ContentHTML)
	for _, bad := range []string{"<script", "onerror"} {
		if strings.Contains(lower, bad) {
			t.Errorf("后台写入路径也必须净化，残留 %q: %q", bad, got.ContentHTML)
		}
	}
}

func TestUpdateCommentSanitizesAuthorAndURL(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: "a@x.com", URL: strPtr("https://old.com"),
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	body := fmt.Sprintf(`{"id":%d,"author":"<script>alert(1)</script>正常","url":"javascript:alert(1)"}`, c.ID)
	w := callWithToken(t, "PUT", "/admin/comments/edit", body, token)
	requireStatus(t, w, 200)

	got := commentByID(t, c.ID)
	if strings.Contains(strings.ToLower(got.Author), "<script") {
		t.Errorf("author 应被清洗，实际 %q", got.Author)
	}
	// javascript: 被白名单拒绝后写入空值（记录：与提交接口写 NULL 不同）
	var url string
	if err := testDB.Get(&url, "SELECT COALESCE(url, '') FROM Comment WHERE id = ?", c.ID); err != nil {
		t.Fatalf("读取 url 失败: %v", err)
	}
	if url != "" {
		t.Errorf("危险 url 应被清空，实际 %q", url)
	}
}

func TestUpdateCommentRequiresFields(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: "a@x.com",
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		{"只有 id", fmt.Sprintf(`{"id":%d}`, c.ID)},
		{"所有可选字段为 null", fmt.Sprintf(`{"id":%d,"author":null,"email":null,"content_text":null,"content_html":null,"url":null}`, c.ID)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "PUT", "/admin/comments/edit", tc.body, token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			if m["message"] != "No fields to update" {
				t.Errorf("message 期望 No fields to update，实际 %v", m["message"])
			}
		})
	}
}

func TestUpdateCommentInvalidBody(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		{"空请求体", ""},
		{"非法 JSON", "{"},
		{"JSON 数组", "[]"},
		{"缺少 id", `{"author":"x"}`},
		{"id 为 0（required 失败）", `{"id":0,"author":"x"}`},
		{"id 为字符串", `{"id":"abc","author":"x"}`},
		{"id 为 null", `{"id":null,"author":"x"}`},
		{"author 类型错误", `{"id":1,"author":123}`},
		{"content_text 类型错误", `{"id":1,"content_text":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "PUT", "/admin/comments/edit", tc.body, token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		})
	}
}

func TestUpdateCommentLengthLimits(t *testing.T) {
	resetState(t)
	c := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: "a@x.com",
		ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000,
	})
	token := adminToken(t)

	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"author 恰好 100 个字符", fmt.Sprintf(`{"id":%d,"author":%q}`, c.ID, strings.Repeat("名", 100)), 200},
		{"author 101 个字符", fmt.Sprintf(`{"id":%d,"author":%q}`, c.ID, strings.Repeat("名", 101)), 400},
		{"content_text 恰好 2000 个字符", fmt.Sprintf(`{"id":%d,"content_text":%q}`, c.ID, strings.Repeat("字", 2000)), 200},
		{"content_text 2001 个字符", fmt.Sprintf(`{"id":%d,"content_text":%q}`, c.ID, strings.Repeat("字", 2001)), 400},
		{"content_html 恰好 50000 字节", fmt.Sprintf(`{"id":%d,"content_html":%q}`, c.ID, strings.Repeat("a", 50000)), 200},
		{"content_html 50001 字节", fmt.Sprintf(`{"id":%d,"content_html":%q}`, c.ID, strings.Repeat("a", 50001)), 400},
		{"url 恰好 500 字节", fmt.Sprintf(`{"id":%d,"url":"https://a.com/%s"}`, c.ID, strings.Repeat("u", 486)), 200},
		{"url 501 字节", fmt.Sprintf(`{"id":%d,"url":"https://a.com/%s"}`, c.ID, strings.Repeat("u", 487)), 400},
		{"email 恰好 254 字节", fmt.Sprintf(`{"id":%d,"email":%q}`, c.ID, strings.Repeat("a", 248)+"@b.com"), 200},
		{"email 255 字节", fmt.Sprintf(`{"id":%d,"email":%q}`, c.ID, strings.Repeat("a", 249)+"@b.com"), 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "PUT", "/admin/comments/edit", tc.body, token)
			requireStatus(t, w, tc.wantStatus)
			if tc.wantStatus == 400 {
				m := decodeJSON(t, w)
				if m["message"] != "Field length limit exceeded" {
					t.Errorf("message 期望 Field length limit exceeded，实际 %v", m["message"])
				}
			}
		})
	}
}

func TestUpdateCommentNonexistentID(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 不存在的 id：更新影响 0 行，接口返回成功
	w := callWithToken(t, "PUT", "/admin/comments/edit", `{"id":999999,"author":"x"}`, token)
	requireStatus(t, w, 200)
}
