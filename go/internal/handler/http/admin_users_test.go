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

type statsOverviewPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		TotalComments      int64 `json:"totalComments"`
		TotalUsers         int64 `json:"totalUsers"`
		TotalPosts         int64 `json:"totalPosts"`
		StatusDistribution struct {
			Approved int64 `json:"approved"`
			Pending  int64 `json:"pending"`
			Deleted  int64 `json:"deleted"`
		} `json:"statusDistribution"`
		RecentComments []struct {
			Date  string `json:"date"`
			Count int64  `json:"count"`
		} `json:"recentComments"`
		TopCommenters []struct {
			Author          string `json:"author"`
			Email           string `json:"email"`
			Count           int64  `json:"count"`
			LastCommentDate string `json:"lastCommentDate"`
		} `json:"topCommenters"`
	} `json:"data"`
}

type userStatsItem struct {
	Author           string `json:"author"`
	Email            string `json:"email"`
	CommentCount     int64  `json:"commentCount"`
	ApprovedCount    int64  `json:"approvedCount"`
	PendingCount     int64  `json:"pendingCount"`
	DeletedCount     int64  `json:"deletedCount"`
	FirstCommentDate string `json:"firstCommentDate"`
	LastCommentDate  string `json:"lastCommentDate"`
	Blacklisted      bool   `json:"blacklisted"`
	EmailVerified    bool   `json:"emailVerified"`
	EmailVerifiedAt  string `json:"emailVerifiedAt"`
}

type userListPayload struct {
	Code int `json:"code"`
	Data struct {
		Users      []userStatsItem `json:"users"`
		Pagination struct {
			Page      int   `json:"page"`
			Limit     int   `json:"limit"`
			TotalPage int64 `json:"totalPage"`
		} `json:"pagination"`
	} `json:"data"`
}

type userCommentsPayload struct {
	Code int `json:"code"`
	Data struct {
		Comments   []adminCommentItem `json:"comments"`
		Pagination struct {
			Page      int   `json:"page"`
			Limit     int   `json:"limit"`
			TotalPage int64 `json:"totalPage"`
		} `json:"pagination"`
	} `json:"data"`
}

// seedUserComments 写入一个用户的若干评论
func seedUserComments(t *testing.T, author, email string, counts map[string]int) {
	t.Helper()
	pub := int64(1_700_000_000_000)
	for status, n := range counts {
		for i := 0; i < n; i++ {
			pub++
			seedComment(t, &model.Comment{
				PostSlug: "/p", Author: author, Email: email,
				ContentText: "t", ContentHTML: "<p>t</p>", Status: status, PubDate: pub,
			})
		}
	}
}

// ---------------------------------------------------------------------------
// GET /admin/stats/overview
// ---------------------------------------------------------------------------

func TestGetStatsOverviewEndpoint(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 3, "pending": 1})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"deleted": 1})
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/overview", "", token)
	requireStatus(t, w, 200)

	var payload statsOverviewPayload
	decodeInto(t, w, &payload)

	if payload.Message != "Stats fetched successfully" {
		t.Errorf("message 不正确: %q", payload.Message)
	}
	if payload.Data.TotalComments != 5 {
		t.Errorf("totalComments 期望 5，实际 %d", payload.Data.TotalComments)
	}
	if payload.Data.TotalUsers != 2 {
		t.Errorf("totalUsers 期望 2，实际 %d", payload.Data.TotalUsers)
	}
	if payload.Data.TotalPosts != 1 {
		t.Errorf("totalPosts 期望 1，实际 %d", payload.Data.TotalPosts)
	}
	if payload.Data.StatusDistribution.Approved != 3 || payload.Data.StatusDistribution.Pending != 1 || payload.Data.StatusDistribution.Deleted != 1 {
		t.Errorf("状态分布不正确: %+v", payload.Data.StatusDistribution)
	}
	if len(payload.Data.RecentComments) != 7 {
		t.Errorf("默认 range=7 应返回 7 个分桶，实际 %d", len(payload.Data.RecentComments))
	}
	if len(payload.Data.TopCommenters) == 0 {
		t.Fatalf("topCommenters 不应为空")
	}
	if payload.Data.TopCommenters[0].Author != "alice" || payload.Data.TopCommenters[0].Count != 4 {
		t.Errorf("热门评论者首位应为 alice(4)，实际 %+v", payload.Data.TopCommenters[0])
	}
}

func TestGetStatsOverviewRangeParameter(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 1})
	token := adminToken(t)

	for _, tc := range []struct {
		rangeVal  string
		wantLen   int
		dateRegex string
	}{
		{"1", 1, `^\d{4}-\d{2}-\d{2}$`},
		{"7", 7, `^\d{4}-\d{2}-\d{2}$`},
		{"30", 30, `^\d{4}-\d{2}-\d{2}$`},
		{"365", 365, `^\d{4}-\d{2}-\d{2}$`},
		{"400", 365, `^\d{4}-\d{2}-\d{2}$`},
		{"0", 12, `^\d{4}-\d{2}$`},
		{"all", 12, `^\d{4}-\d{2}$`},
		{"ALL", 12, `^\d{4}-\d{2}$`},
		{"-1", 7, `^\d{4}-\d{2}-\d{2}$`},
		{"abc", 7, `^\d{4}-\d{2}-\d{2}$`},
		{"", 7, `^\d{4}-\d{2}-\d{2}$`},
	} {
		t.Run("range="+tc.rangeVal, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/overview?range="+queryEscape(tc.rangeVal), "", token)
			requireStatus(t, w, 200)

			var payload statsOverviewPayload
			decodeInto(t, w, &payload)

			if len(payload.Data.RecentComments) != tc.wantLen {
				t.Fatalf("分桶数期望 %d，实际 %d", tc.wantLen, len(payload.Data.RecentComments))
			}
			for _, dc := range payload.Data.RecentComments {
				if !regexpMatch(tc.dateRegex, dc.Date) {
					t.Errorf("分桶日期 %q 不符合 %s", dc.Date, tc.dateRegex)
				}
			}
		})
	}
}

func TestGetStatsOverviewEmptyDatabase(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/overview", "", token)
	requireStatus(t, w, 200)

	// 空库时 topCommenters 必须是 []，不能为 null
	if !strings.Contains(w.Body.String(), `"topCommenters":[]`) {
		t.Errorf("空库时 topCommenters 应为空数组，实际 %s", w.Body.String())
	}

	var payload statsOverviewPayload
	decodeInto(t, w, &payload)
	if payload.Data.TotalComments != 0 || payload.Data.TotalUsers != 0 || payload.Data.TotalPosts != 0 {
		t.Errorf("空库统计应全为 0，实际 %+v", payload.Data)
	}
	if len(payload.Data.TopCommenters) != 0 {
		t.Errorf("空库时 topCommenters 应为空，实际 %d 条", len(payload.Data.TopCommenters))
	}
}

// ---------------------------------------------------------------------------
// GET /admin/stats/users
// ---------------------------------------------------------------------------

func TestGetUserListEndpoint(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 2, "pending": 1})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"deleted": 1})
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/users", "", token)
	requireStatus(t, w, 200)

	var payload userListPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Users) != 2 {
		t.Fatalf("应返回 2 个用户，实际 %d 个", len(payload.Data.Users))
	}
	if payload.Data.Pagination.Page != 1 || payload.Data.Pagination.Limit != 20 {
		t.Errorf("默认分页应为 page=1 limit=20，实际 %+v", payload.Data.Pagination)
	}
	if payload.Data.Pagination.TotalPage != 1 {
		t.Errorf("totalPage 期望 1，实际 %d", payload.Data.Pagination.TotalPage)
	}

	alice := payload.Data.Users[0]
	if alice.Author != "alice" || alice.Email != "a@x.com" {
		t.Errorf("应按评论数降序，首位应为 alice，实际 %+v", alice)
	}
	if alice.CommentCount != 3 || alice.ApprovedCount != 2 || alice.PendingCount != 1 || alice.DeletedCount != 0 {
		t.Errorf("计数不正确: %+v", alice)
	}
	if alice.Blacklisted {
		t.Errorf("未加入黑名单时 blacklisted 应为 false")
	}
	if alice.EmailVerified || alice.EmailVerifiedAt != "" {
		t.Errorf("未验证邮箱时相关字段应为空/false: %+v", alice)
	}
	if !strings.HasSuffix(alice.FirstCommentDate, "Z") || !strings.HasSuffix(alice.LastCommentDate, "Z") {
		t.Errorf("日期应为 ISO 格式: %q / %q", alice.FirstCommentDate, alice.LastCommentDate)
	}
}

func TestGetUserListEndpointInvalidPage(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, query := range []string{"?page=0", "?page=-1", "?page=abc", "?page=", "?page=1.5"} {
		t.Run(query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users"+query, "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		})
	}
}

func TestGetUserListEndpointLimitClamp(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 1})
	token := adminToken(t)

	for _, tc := range []struct {
		query     string
		wantLimit int
	}{
		{"", 20},
		{"?limit=50", 50},
		{"?limit=100", 100},
		{"?limit=101", 100},
		{"?limit=1000", 100},
		{"?limit=0", 20},
		{"?limit=-1", 20},
		{"?limit=abc", 20},
		{"?limit=1", 1},
	} {
		t.Run("limit "+tc.query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload userListPayload
			decodeInto(t, w, &payload)
			if payload.Data.Pagination.Limit != tc.wantLimit {
				t.Errorf("limit 期望 %d，实际 %d", tc.wantLimit, payload.Data.Pagination.Limit)
			}
		})
	}
}

func TestGetUserListEndpointSearch(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 1})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"approved": 1})
	token := adminToken(t)

	for _, tc := range []struct {
		query     string
		want      int
		wantTotal int64
	}{
		{"?search=alice", 1, 1},
		{"?search=ALICE", 1, 1},
		{"?search=b@x", 1, 1},
		{"?search=zzz", 0, 0},
		{"?search=", 2, 1},
		{"?search=%20%20", 2, 1}, // 仅空白会被 Trim，视为不过滤
	} {
		t.Run(tc.query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload userListPayload
			decodeInto(t, w, &payload)
			if len(payload.Data.Users) != tc.want {
				t.Errorf("用户数期望 %d，实际 %d", tc.want, len(payload.Data.Users))
			}
			if payload.Data.Pagination.TotalPage != tc.wantTotal {
				t.Errorf("totalPage 期望 %d，实际 %d", tc.wantTotal, payload.Data.Pagination.TotalPage)
			}
		})
	}
}

func TestGetUserListEndpointVerifiedFilter(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 1})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"approved": 1})

	// 标记 bob 已验证
	expires := time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05.000Z")
	if err := testRepo.SaveVerificationToken(t.Context(), "b@x.com", "tok-bob", expires, "/p", "t"); err != nil {
		t.Fatalf("写入验证令牌失败: %v", err)
	}
	if _, err := testRepo.VerifyEmail(t.Context(), "tok-bob", "b@x.com"); err != nil {
		t.Fatalf("验证邮箱失败: %v", err)
	}

	token := adminToken(t)
	for _, tc := range []struct {
		query      string
		want       int
		onlyVerify bool
	}{
		{"?verified=true", 1, true},
		{"?verified=false", 1, false},
		{"?verified=all", 2, false},
		{"?verified=TRUE", 1, true},
		{"?verified=garbage", 2, false},
		{"?verified=", 2, false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload userListPayload
			decodeInto(t, w, &payload)
			if len(payload.Data.Users) != tc.want {
				t.Fatalf("用户数期望 %d，实际 %d", tc.want, len(payload.Data.Users))
			}
			for _, u := range payload.Data.Users {
				if tc.query == "?verified=true" && u.Author != "bob" {
					t.Errorf("已验证筛选应只返回 bob，实际 %q", u.Author)
				}
				if tc.onlyVerify && !u.EmailVerified {
					t.Errorf("已验证用户的 emailVerified 应为 true: %+v", u)
				}
			}
		})
	}

	// 已验证用户的 emailVerifiedAt 应被填充
	w := callWithToken(t, "GET", "/admin/stats/users?verified=true", "", token)
	var payload userListPayload
	decodeInto(t, w, &payload)
	if payload.Data.Users[0].EmailVerifiedAt == "" {
		t.Errorf("已验证用户的 emailVerifiedAt 不应为空: %+v", payload.Data.Users[0])
	}
}

func TestGetUserListEndpointBlacklistFlag(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "A@X.com", map[string]int{"approved": 1})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"approved": 1})

	// 黑名单用不同大小写写入，标记也应命中
	setSetting(t, "email_blacklist", `["a@x.com"]`)

	token := adminToken(t)
	w := callWithToken(t, "GET", "/admin/stats/users", "", token)
	requireStatus(t, w, 200)

	var payload userListPayload
	decodeInto(t, w, &payload)
	for _, u := range payload.Data.Users {
		want := strings.EqualFold(u.Email, "a@x.com")
		if u.Blacklisted != want {
			t.Errorf("用户 %q 的 blacklisted 期望 %v，实际 %v", u.Email, want, u.Blacklisted)
		}
	}
}

func TestGetUserListEndpointPagination(t *testing.T) {
	resetState(t)
	for i := 0; i < 5; i++ {
		seedUserComments(t, fmt.Sprintf("user%d", i), fmt.Sprintf("u%d@x.com", i), map[string]int{"approved": 1})
	}
	token := adminToken(t)

	for _, tc := range []struct {
		query         string
		wantLen       int
		wantPage      int
		wantTotalPage int64
	}{
		{"?limit=2", 2, 1, 3},
		{"?limit=2&page=2", 2, 2, 3},
		{"?limit=2&page=3", 1, 3, 3},
		{"?limit=2&page=4", 0, 4, 3},
		{"?limit=100", 5, 1, 1},
	} {
		t.Run(tc.query, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users"+tc.query, "", token)
			requireStatus(t, w, 200)

			var payload userListPayload
			decodeInto(t, w, &payload)
			if len(payload.Data.Users) != tc.wantLen {
				t.Errorf("用户数期望 %d，实际 %d", tc.wantLen, len(payload.Data.Users))
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

func TestGetUserListEndpointEmpty(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/users", "", token)
	requireStatus(t, w, 200)

	if !strings.Contains(w.Body.String(), `"users":[]`) {
		t.Errorf("空库时 users 应为空数组，实际 %s", w.Body.String())
	}
	var payload userListPayload
	decodeInto(t, w, &payload)
	if payload.Data.Pagination.TotalPage != 0 {
		t.Errorf("空库时 totalPage 应为 0，实际 %d", payload.Data.Pagination.TotalPage)
	}
}

// ---------------------------------------------------------------------------
// GET /admin/stats/users/comments
// ---------------------------------------------------------------------------

func TestGetUserCommentsEndpoint(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 3})
	seedUserComments(t, "bob", "b@x.com", map[string]int{"approved": 2})
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/users/comments?author=alice&email=a@x.com", "", token)
	requireStatus(t, w, 200)

	var payload userCommentsPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Comments) != 3 {
		t.Fatalf("应返回 alice 的 3 条评论，实际 %d 条", len(payload.Data.Comments))
	}
	if payload.Data.Pagination.Limit != 10 || payload.Data.Pagination.Page != 1 {
		t.Errorf("分页应为 page=1 limit=10，实际 %+v", payload.Data.Pagination)
	}
	if payload.Data.Pagination.TotalPage != 1 {
		t.Errorf("totalPage 期望 1，实际 %d", payload.Data.Pagination.TotalPage)
	}
	for _, c := range payload.Data.Comments {
		if c.Author != "alice" || c.Email != "a@x.com" {
			t.Errorf("返回了其他用户的评论: %+v", c)
		}
	}

	// 分页
	w = callWithToken(t, "GET", "/admin/stats/users/comments?author=alice&email=a@x.com&page=2", "", token)
	requireStatus(t, w, 200)
	payload = userCommentsPayload{}
	decodeInto(t, w, &payload)
	if len(payload.Data.Comments) != 0 {
		t.Errorf("第二页应为空，实际 %d 条", len(payload.Data.Comments))
	}
}

func TestGetUserCommentsEndpointValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name        string
		query       string
		wantMessage string
	}{
		{"缺少 author", "?email=a@x.com", "author and email are required"},
		{"缺少 email", "?author=alice", "author and email are required"},
		{"都缺少", "", "author and email are required"},
		{"author 为空串", "?author=&email=a@x.com", "author and email are required"},
		{"页数非法", "?author=alice&email=a@x.com&page=0", "Invalid query parameters"},
		{"页数非数字", "?author=alice&email=a@x.com&page=abc", "Invalid query parameters"},
		{"页数为负", "?author=alice&email=a@x.com&page=-2", "Invalid query parameters"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "GET", "/admin/stats/users/comments"+tc.query, "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			if m["message"] != tc.wantMessage {
				t.Errorf("message 期望 %q，实际 %v", tc.wantMessage, m["message"])
			}
		})
	}
}

func TestGetUserCommentsEndpointUnknownUser(t *testing.T) {
	resetState(t)
	seedUserComments(t, "alice", "a@x.com", map[string]int{"approved": 1})
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/users/comments?author=nobody&email=n@x.com", "", token)
	requireStatus(t, w, 200)

	var payload userCommentsPayload
	decodeInto(t, w, &payload)
	if len(payload.Data.Comments) != 0 {
		t.Errorf("未知用户应返回空列表，实际 %d 条", len(payload.Data.Comments))
	}
	if payload.Data.Pagination.TotalPage != 0 {
		t.Errorf("未知用户的 totalPage 应为 0，实际 %d", payload.Data.Pagination.TotalPage)
	}
}

// ---------------------------------------------------------------------------
// POST / DELETE /admin/users/blacklist
// ---------------------------------------------------------------------------

func TestAddUserToBlacklist(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/users/blacklist", `{"email":"A@B.COM"}`, token)
	requireStatus(t, w, 200)

	var resp struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Email       string `json:"email"`
			Blacklisted bool   `json:"blacklisted"`
		} `json:"data"`
	}
	decodeInto(t, w, &resp)

	if resp.Message != "User added to blacklist" {
		t.Errorf("message 不正确: %q", resp.Message)
	}
	if resp.Data.Email != "a@b.com" {
		t.Errorf("邮箱应被规范化为小写，实际 %q", resp.Data.Email)
	}
	if !resp.Data.Blacklisted {
		t.Errorf("blacklisted 应为 true")
	}

	var list []string
	if err := json.Unmarshal([]byte(utils.GetSetting("email_blacklist")), &list); err != nil {
		t.Fatalf("email_blacklist 设置应为合法 JSON: %v", err)
	}
	if len(list) != 1 || list[0] != "a@b.com" {
		t.Errorf("黑名单内容期望 [a@b.com]，实际 %v", list)
	}

	// 重复添加：命中已有条目（大小写不敏感）且不产生重复项
	w = callWithToken(t, "POST", "/admin/users/blacklist", `{"email":"a@b.com"}`, token)
	requireStatus(t, w, 200)
	decodeInto(t, w, &resp)
	if resp.Message != "User is already in blacklist" {
		t.Errorf("重复添加时 message 期望 User is already in blacklist，实际 %q", resp.Message)
	}
	list = nil
	if err := json.Unmarshal([]byte(utils.GetSetting("email_blacklist")), &list); err != nil {
		t.Fatalf("email_blacklist 设置应为合法 JSON: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("重复添加不应产生重复项，实际 %v", list)
	}

	// 大小写不同也视为已存在
	w = callWithToken(t, "POST", "/admin/users/blacklist", `{"email":"A@B.com"}`, token)
	requireStatus(t, w, 200)
	decodeInto(t, w, &resp)
	if resp.Message != "User is already in blacklist" {
		t.Errorf("大小写不同也应识别为已存在，实际 %q", resp.Message)
	}
}

func TestAddUserToBlacklistValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		{"空请求体", ""},
		{"非法 JSON", "{"},
		{"JSON 数组", "[]"},
		{"缺少 email", `{}`},
		{"email 为空串", `{"email":""}`},
		{"email 仅空白", `{"email":"   "}`},
		{"email 类型错误", `{"email":123}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "POST", "/admin/users/blacklist", tc.body, token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		})
	}
}

func TestAddUserToBlacklistRepairsBrokenConfig(t *testing.T) {
	resetState(t)
	// 配置损坏时被当作空列表，添加后应写回合法 JSON
	setSetting(t, "email_blacklist", `{"broken":`)
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/users/blacklist", `{"email":"a@b.com"}`, token)
	requireStatus(t, w, 200)

	var list []string
	if err := json.Unmarshal([]byte(utils.GetSetting("email_blacklist")), &list); err != nil {
		t.Fatalf("修复后的 email_blacklist 应为合法 JSON: %v（原值 %q）", err, utils.GetSetting("email_blacklist"))
	}
	if len(list) != 1 || list[0] != "a@b.com" {
		t.Errorf("修复后黑名单期望 [a@b.com]，实际 %v", list)
	}
}

func TestRemoveUserFromBlacklist(t *testing.T) {
	resetState(t)
	setSetting(t, "email_blacklist", `["a@b.com","c@d.com"]`)
	token := adminToken(t)

	// 大小写不敏感地移除
	w := callWithToken(t, "DELETE", "/admin/users/blacklist?email="+queryEscape("A@B.COM"), "", token)
	requireStatus(t, w, 200)

	var resp struct {
		Message string `json:"message"`
		Data    struct {
			Email       string `json:"email"`
			Blacklisted bool   `json:"blacklisted"`
		} `json:"data"`
	}
	decodeInto(t, w, &resp)
	if resp.Message != "User removed from blacklist" {
		t.Errorf("message 不正确: %q", resp.Message)
	}
	if resp.Data.Email != "a@b.com" || resp.Data.Blacklisted {
		t.Errorf("返回数据不正确: %+v", resp.Data)
	}

	var list []string
	if err := json.Unmarshal([]byte(utils.GetSetting("email_blacklist")), &list); err != nil {
		t.Fatalf("email_blacklist 应为合法 JSON: %v", err)
	}
	if len(list) != 1 || list[0] != "c@d.com" {
		t.Errorf("移除后应只剩 c@d.com，实际 %v", list)
	}

	// 移除不存在的条目：成功但不修改
	w = callWithToken(t, "DELETE", "/admin/users/blacklist?email="+queryEscape("not-exist@x.com"), "", token)
	requireStatus(t, w, 200)
	decodeInto(t, w, &resp)
	if resp.Message != "User is not in blacklist" {
		t.Errorf("message 期望 User is not in blacklist，实际 %q", resp.Message)
	}
	if resp.Data.Blacklisted {
		t.Errorf("不存在的条目 blacklisted 应为 false")
	}

	// 移除最后一条后应为空数组
	w = callWithToken(t, "DELETE", "/admin/users/blacklist?email=c@d.com", "", token)
	requireStatus(t, w, 200)
	if got := utils.GetSetting("email_blacklist"); got != "[]" {
		t.Errorf("全部移除后应写回 []，实际 %q", got)
	}
}

func TestRemoveUserFromBlacklistValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, query := range []string{"", "?email=", "?email=%20%20", "?other=a@b.com"} {
		t.Run("query="+query, func(t *testing.T) {
			w := callWithToken(t, "DELETE", "/admin/users/blacklist"+query, "", token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			if m["message"] != "email is required" {
				t.Errorf("message 期望 email is required，实际 %v", m["message"])
			}
		})
	}
}

func TestRemoveUserFromBlacklistWhenEmpty(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "DELETE", "/admin/users/blacklist?email=a@b.com", "", token)
	requireStatus(t, w, 200)

	var resp struct {
		Message string `json:"message"`
	}
	decodeInto(t, w, &resp)
	if resp.Message != "User is not in blacklist" {
		t.Errorf("空黑名单移除时应提示不在黑名单中，实际 %q", resp.Message)
	}
}
