package http

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

// nameCountItem 客户端分布的一项（deviceDistribution / browserDistribution / osDistribution）
type nameCountItem struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// topPostItem 热门文章的一项
type topPostItem struct {
	PostSlug        string `json:"postSlug"`
	Count           int64  `json:"count"`
	LastCommentDate string `json:"lastCommentDate"`
}

// latestCommentItem 最新评论动态的一项
type latestCommentItem struct {
	ID          int64  `json:"id"`
	Author      string `json:"author"`
	Email       string `json:"email"`
	PostSlug    string `json:"postSlug"`
	ContentText string `json:"contentText"`
	Status      string `json:"status"`
	PubDate     string `json:"pubDate"`
}

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

		// —— 扩展字段 ——
		WindowComments     int64  `json:"windowComments"`
		PrevWindowComments int64  `json:"prevWindowComments"`
		CommentsDelta      *int64 `json:"commentsDelta"`
		WindowUsers        int64  `json:"windowUsers"`
		PrevWindowUsers    int64  `json:"prevWindowUsers"`
		UsersDelta         *int64 `json:"usersDelta"`
		TodayComments      int64  `json:"todayComments"`
		Last7DaysComments  int64  `json:"last7DaysComments"`

		TopPosts []topPostItem `json:"topPosts"`

		DeviceDistribution  []nameCountItem `json:"deviceDistribution"`
		BrowserDistribution []nameCountItem `json:"browserDistribution"`
		OSDistribution      []nameCountItem `json:"osDistribution"`

		LatestComments []latestCommentItem `json:"latestComments"`
	} `json:"data"`
}

type userStatsItem struct {
	Author           string `json:"author"`
	Email            string `json:"email"`
	URL              string `json:"url"`
	URLDormant       bool   `json:"urlDormant"`
	URLTrustedUntil  string `json:"urlTrustedUntil"`
	URLTrustedSource string `json:"urlTrustedSource"`
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

	// 扩展字段：这批评论没有写 browser / os / device（全是 SQL 的 NULL），
	// 归一化后应分别合并成 未知 / 未知 / 桌面（NULL 与空串走同一分支）
	if len(payload.Data.BrowserDistribution) != 1 || payload.Data.BrowserDistribution[0].Name != "未知" ||
		payload.Data.BrowserDistribution[0].Count != 5 {
		t.Errorf("全 NULL 的 browser 应合并成 未知(5)，实际 %+v", payload.Data.BrowserDistribution)
	}
	if len(payload.Data.OSDistribution) != 1 || payload.Data.OSDistribution[0].Name != "未知" ||
		payload.Data.OSDistribution[0].Count != 5 {
		t.Errorf("全 NULL 的 os 应合并成 未知(5)，实际 %+v", payload.Data.OSDistribution)
	}
	if len(payload.Data.DeviceDistribution) != 1 || payload.Data.DeviceDistribution[0].Name != "桌面" ||
		payload.Data.DeviceDistribution[0].Count != 5 {
		t.Errorf("全 NULL 的 device 应合并成 桌面(5)，实际 %+v", payload.Data.DeviceDistribution)
	}
	if len(payload.Data.TopPosts) != 1 || payload.Data.TopPosts[0].PostSlug != "/p" || payload.Data.TopPosts[0].Count != 5 {
		t.Errorf("topPosts 应为 /p(5)，实际 %+v", payload.Data.TopPosts)
	}
	// 这些评论的 pub_date 在 2023-11（seedUserComments 的固定时间戳），落在所有窗口之外
	if payload.Data.WindowComments != 0 || payload.Data.TodayComments != 0 || payload.Data.Last7DaysComments != 0 {
		t.Errorf("陈旧数据的窗口指标应为 0，实际 %+v", payload.Data)
	}
	if payload.Data.CommentsDelta != nil || payload.Data.UsersDelta != nil {
		t.Errorf("上一窗口为 0 时两个 delta 都应为 null，实际 %v / %v",
			payload.Data.CommentsDelta, payload.Data.UsersDelta)
	}
	if len(payload.Data.LatestComments) != 5 {
		t.Errorf("latestComments 应返回全部 5 条，实际 %d", len(payload.Data.LatestComments))
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

			// 扩展字段与 range 无关地恒存在：列表必须是 []（非 null），
			// 且这批旧数据落在所有窗口之外时两个 delta 都应为 null
			if payload.Data.TopPosts == nil || payload.Data.DeviceDistribution == nil ||
				payload.Data.BrowserDistribution == nil || payload.Data.OSDistribution == nil ||
				payload.Data.LatestComments == nil {
				t.Errorf("range=%q 的列表字段应为 []，不能是 null", tc.rangeVal)
			}
			if payload.Data.CommentsDelta != nil || payload.Data.UsersDelta != nil {
				t.Errorf("range=%q 时上一窗口为空，两个 delta 都应为 null，实际 %v / %v",
					tc.rangeVal, payload.Data.CommentsDelta, payload.Data.UsersDelta)
			}
			if payload.Data.TodayComments != 0 || payload.Data.Last7DaysComments != 0 {
				t.Errorf("range=%q 时今日 / 近 7 日不应受 range 影响（旧数据应为 0），实际 %d / %d",
					tc.rangeVal, payload.Data.TodayComments, payload.Data.Last7DaysComments)
			}
		})
	}
}

func TestGetStatsOverviewEmptyDatabase(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/overview", "", token)
	requireStatus(t, w, 200)

	// 空库时所有列表都必须是 []，两个 delta 必须是 null（不是 0）
	for _, want := range []string{
		`"topCommenters":[]`,
		`"topPosts":[]`,
		`"deviceDistribution":[]`,
		`"browserDistribution":[]`,
		`"osDistribution":[]`,
		`"latestComments":[]`,
		`"commentsDelta":null`,
		`"usersDelta":null`,
	} {
		if !strings.Contains(w.Body.String(), want) {
			t.Errorf("空库响应应包含 %s，实际 %s", want, w.Body.String())
		}
	}

	var payload statsOverviewPayload
	decodeInto(t, w, &payload)
	if payload.Data.TotalComments != 0 || payload.Data.TotalUsers != 0 || payload.Data.TotalPosts != 0 {
		t.Errorf("空库统计应全为 0，实际 %+v", payload.Data)
	}
	if len(payload.Data.TopCommenters) != 0 {
		t.Errorf("空库时 topCommenters 应为空，实际 %d 条", len(payload.Data.TopCommenters))
	}
	if len(payload.Data.TopPosts) != 0 || len(payload.Data.DeviceDistribution) != 0 ||
		len(payload.Data.BrowserDistribution) != 0 || len(payload.Data.OSDistribution) != 0 ||
		len(payload.Data.LatestComments) != 0 {
		t.Errorf("空库时扩展列表都应为空，实际 %+v", payload.Data)
	}
	if payload.Data.CommentsDelta != nil || payload.Data.UsersDelta != nil {
		t.Errorf("空库时两个 delta 都应为 null，实际 %v / %v",
			payload.Data.CommentsDelta, payload.Data.UsersDelta)
	}
}

// TestGetStatsOverviewExtendedFields 扩展字段：窗口指标 / 热门文章 / 客户端分布 / 最新评论
//
// 时间锚点用「今天 UTC 00:00」构造，窗口与今日 / 近 7 日的边界都是自然日
func TestGetStatsOverviewExtendedFields(t *testing.T) {
	resetState(t)

	now := time.Now().UTC()
	startOfToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	const day = int64(86400000)

	// clientComment 构造一条评论（browser / os / device 传 nil 即 SQL 的 NULL）
	clientComment := func(slug, author, email, content string, pub int64, status string, browser, osName, device *string) *model.Comment {
		return &model.Comment{
			PostSlug:    slug,
			Author:      author,
			Email:       email,
			ContentText: content,
			ContentHTML: "<p>" + content + "</p>",
			Status:      status,
			PubDate:     pub,
			Browser:     browser,
			OS:          osName,
			Device:      device,
		}
	}

	seedComment(t, clientComment("/hot", "alice", "a@x.com", "今天第一条", startOfToday+1000, "approved",
		strPtr("Chrome 145.0.0.0"), strPtr("Windows 10"), strPtr("Desktop")))
	seedComment(t, clientComment("/hot", "alice", "a@x.com", "今天第二条", startOfToday+2000, "pending",
		strPtr("Chrome 120"), strPtr("Windows 10.0"), strPtr("Desktop")))
	seedComment(t, clientComment("/hot", "bob", "b@x.com", "昨天", startOfToday-day+3600_000, "approved",
		strPtr("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko)"), strPtr(""), nil))
	seedComment(t, clientComment("/cold", "carol", "c@x.com", "八天前", startOfToday-7*day, "approved",
		strPtr("Safari 17.0"), strPtr("macOS 10.15.7"), strPtr("iPad")))

	token := adminToken(t)

	// range=7：窗口 = 今天前 6 天起；上一窗口 = 再往前 7 天
	w := callWithToken(t, "GET", "/admin/stats/overview?range=7", "", token)
	requireStatus(t, w, 200)

	var payload statsOverviewPayload
	decodeInto(t, w, &payload)
	data := payload.Data

	if data.WindowComments != 3 || data.PrevWindowComments != 1 {
		t.Errorf("窗口评论数期望 3/1，实际 %d/%d", data.WindowComments, data.PrevWindowComments)
	}
	if data.WindowUsers != 2 || data.PrevWindowUsers != 1 {
		t.Errorf("窗口活跃评论者期望 2/1，实际 %d/%d", data.WindowUsers, data.PrevWindowUsers)
	}
	if data.CommentsDelta == nil || *data.CommentsDelta != 200 {
		t.Errorf("commentsDelta 期望 200，实际 %v", data.CommentsDelta)
	}
	if data.UsersDelta == nil || *data.UsersDelta != 100 {
		t.Errorf("usersDelta 期望 100，实际 %v", data.UsersDelta)
	}
	if data.TodayComments != 2 {
		t.Errorf("todayComments 期望 2，实际 %d", data.TodayComments)
	}
	if data.Last7DaysComments != 3 {
		t.Errorf("last7DaysComments 期望 3，实际 %d", data.Last7DaysComments)
	}

	// 热门文章：/hot 3 条 > /cold 1 条
	if len(data.TopPosts) != 2 {
		t.Fatalf("topPosts 期望 2 条，实际 %d: %+v", len(data.TopPosts), data.TopPosts)
	}
	if data.TopPosts[0].PostSlug != "/hot" || data.TopPosts[0].Count != 3 || data.TopPosts[1].PostSlug != "/cold" {
		t.Errorf("topPosts 不正确: %+v", data.TopPosts)
	}
	wantHotDate := time.UnixMilli(startOfToday + 2000).UTC().Format("2006-01-02T15:04:05.000Z")
	if data.TopPosts[0].LastCommentDate != wantHotDate {
		t.Errorf("topPosts[0].lastCommentDate 期望 %q，实际 %q", wantHotDate, data.TopPosts[0].LastCommentDate)
	}

	// 客户端分布：版本合并 + 原始 UA / 空值 / NULL 归入未知或桌面
	wantBrowser := []nameCountItem{{Name: "Chrome", Count: 2}, {Name: "Safari", Count: 1}, {Name: "未知", Count: 1}}
	if !reflect.DeepEqual(data.BrowserDistribution, wantBrowser) {
		t.Errorf("browserDistribution 期望 %+v，实际 %+v", wantBrowser, data.BrowserDistribution)
	}
	wantOS := []nameCountItem{{Name: "Windows", Count: 2}, {Name: "macOS", Count: 1}, {Name: "未知", Count: 1}}
	if !reflect.DeepEqual(data.OSDistribution, wantOS) {
		t.Errorf("osDistribution 期望 %+v，实际 %+v", wantOS, data.OSDistribution)
	}
	wantDevice := []nameCountItem{{Name: "桌面", Count: 3}, {Name: "平板", Count: 1}}
	if !reflect.DeepEqual(data.DeviceDistribution, wantDevice) {
		t.Errorf("deviceDistribution 期望 %+v，实际 %+v", wantDevice, data.DeviceDistribution)
	}

	// 最新评论：pub_date DESC, id DESC（今天第二条 → 今天第一条 → 昨天 → 八天前）
	if len(data.LatestComments) != 4 {
		t.Fatalf("latestComments 期望 4 条，实际 %d: %+v", len(data.LatestComments), data.LatestComments)
	}
	latest := data.LatestComments[0]
	if latest.Author != "alice" || latest.Email != "a@x.com" || latest.PostSlug != "/hot" ||
		latest.ContentText != "今天第二条" || latest.Status != "pending" {
		t.Errorf("latestComments[0] 字段不正确: %+v", latest)
	}
	wantPub := time.UnixMilli(startOfToday + 2000).UTC().Format("2006-01-02T15:04:05.000Z")
	if latest.PubDate != wantPub {
		t.Errorf("latestComments[0].pubDate 期望 %q，实际 %q", wantPub, latest.PubDate)
	}
	if data.LatestComments[3].ContentText != "八天前" {
		t.Errorf("latestComments 应按时间降序，最后一条实际 %+v", data.LatestComments[3])
	}

	// range=all：窗口 = 最近 12 个自然月，四条评论全在窗口内，上一窗口为空 → 两个 delta 都是 null
	w = callWithToken(t, "GET", "/admin/stats/overview?range=all", "", token)
	requireStatus(t, w, 200)
	payload = statsOverviewPayload{}
	decodeInto(t, w, &payload)

	if payload.Data.WindowComments != 4 {
		t.Errorf("range=all 时 windowComments 期望 4（等于月度分桶之和），实际 %d", payload.Data.WindowComments)
	}
	var sum int64
	for _, dc := range payload.Data.RecentComments {
		sum += dc.Count
	}
	if sum != payload.Data.WindowComments {
		t.Errorf("range=all 时 windowComments(%d) 应等于月度分桶之和(%d)", payload.Data.WindowComments, sum)
	}
	if payload.Data.PrevWindowComments != 0 || payload.Data.CommentsDelta != nil || payload.Data.UsersDelta != nil {
		t.Errorf("range=all 时上一窗口为空，两个 delta 都应为 null，实际 %d / %v / %v",
			payload.Data.PrevWindowComments, payload.Data.CommentsDelta, payload.Data.UsersDelta)
	}
	if payload.Data.TodayComments != 2 || payload.Data.Last7DaysComments != 3 {
		t.Errorf("今日 / 近 7 日不应随 range 改变，实际 %d / %d",
			payload.Data.TodayComments, payload.Data.Last7DaysComments)
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
// GET /admin/stats/users — 网站链接是否休眠（url + urlDormant）
// ---------------------------------------------------------------------------

// userLinkDay 一天的毫秒数（与 utils.DayMillis 同义，测试里用于构造相对时间）
const userLinkDay = int64(86400000)

// fetchUserList 拉取用户列表，同时返回原始响应体（用于断言字段一定存在）
func fetchUserList(t *testing.T, token string) (userListPayload, string) {
	t.Helper()
	w := callWithToken(t, "GET", "/admin/stats/users?limit=100", "", token)
	requireStatus(t, w, 200)

	var payload userListPayload
	decodeInto(t, w, &payload)
	return payload, w.Body.String()
}

// usersByEmail 按**归一化邮箱**取出列表里的全部行
// （用户列表按 author+email 分组，同一邮箱可能对应多行——换昵称后就会多一行）
func usersByEmail(payload userListPayload, email string) []userStatsItem {
	want := utils.NormalizeEmail(email)
	var out []userStatsItem
	for _, u := range payload.Data.Users {
		if utils.NormalizeEmail(u.Email) == want {
			out = append(out, u)
		}
	}
	return out
}

// requireSingleUser 断言该邮箱恰好一行并返回它
func requireSingleUser(t *testing.T, payload userListPayload, email string) userStatsItem {
	t.Helper()
	users := usersByEmail(payload, email)
	if len(users) != 1 {
		t.Fatalf("邮箱 %s 应恰好对应 1 行，实际 %d 行", email, len(users))
	}
	return users[0]
}

/*
用户列表的「网站链接是否休眠」列（`url` + `urlDormant`）。

身份口径与公开评论区的 urlDormant 完全一致（见 doc/link_security.md 第 2 节）：按归一化邮箱
识别同一个人、跨文章统计最后一条评论、严格大于 N 天、rejected / deleted 不计入「来过」、
网址取「最近一次非空」。用例与 Node 侧 admin.stats 用例一一对应。
*/
func TestGetUserListEndpointLinkDormant(t *testing.T) {
	// 固定「现在」，让休眠边界可以精确构造（withFixedNow 定义在 link_security_test.go）
	now := int64(1_800_000_000_000)
	day := userLinkDay

	t.Run("从来没有留过网址：url 为空串、urlDormant 为 false", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		seedLinkComment(t, "甲", "a@x.com", "", "approved", now-90*day)
		setSetting(t, "link_security_enabled", "true")
		token := adminToken(t)

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URL != "" {
			t.Errorf("从未留过网址时 url 应为空串，实际 %q", u.URL)
		}
		if u.URLDormant {
			t.Errorf("从未留过网址时 urlDormant 应为 false")
		}
	})

	t.Run("功能关闭：不标记休眠，但仍然下发用户留过的网址", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		// 不写 link_security_enabled：默认关闭
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)
		token := adminToken(t)

		payload, body := fetchUserList(t, token)
		u := requireSingleUser(t, payload, "a@x.com")
		if u.URL != "https://a.example.com" {
			t.Errorf("功能关闭时 url 仍应下发，实际 %q", u.URL)
		}
		if u.URLDormant {
			t.Errorf("功能关闭时 urlDormant 应为 false")
		}
		// 两个字段必须恒定存在（后台表格直接读），哪怕是 false / 空串
		if !strings.Contains(body, `"url":`) || !strings.Contains(body, `"urlDormant":false`) {
			t.Errorf("响应应始终包含 url 与 urlDormant 字段，实际 %s", body)
		}
	})

	t.Run("超过 N 天没来评论：标记为休眠", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-31*day)
		token := adminToken(t)

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URL != "https://a.example.com" {
			t.Errorf("url 期望 https://a.example.com，实际 %q", u.URL)
		}
		if !u.URLDormant {
			t.Errorf("31 天没来（N=30）应标记休眠")
		}
	})

	t.Run("刚好 N 天/差一分钟都不算休眠（严格大于）", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			pub  int64
		}{
			{"刚好 30 天", now - 30*day},
			{"30 天差一分钟", now - 30*day + 60000},
		} {
			t.Run(tc.name, func(t *testing.T) {
				resetState(t)
				withFixedNow(t, now)
				setSetting(t, "link_security_enabled", "true")
				setSetting(t, "link_dormant_days", "30")
				seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", tc.pub)
				token := adminToken(t)

				if u := requireSingleUser(t, mustUserList(t, token), "a@x.com"); u.URLDormant {
					t.Errorf("严格大于 N 天才休眠，实际被标记（pub=%d）", tc.pub)
				}
			})
		}
	})

	t.Run("以最新链接为准：较晚的评论带新网址时取新网址", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "甲", "a@x.com", "https://old.example.com", "approved", now-60*day)
		seedLinkComment(t, "甲", "a@x.com", "https://new.example.com", "approved", now-31*day)
		token := adminToken(t)

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URL != "https://new.example.com" {
			t.Errorf("url 应取最新一条非空网址，实际 %q", u.URL)
		}
		if !u.URLDormant {
			t.Errorf("最后一条评论在 31 天前（N=30）应标记休眠")
		}
	})

	t.Run("较晚的评论没有网址时，保留最近一次非空网址", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		seedLinkComment(t, "甲", "a@x.com", "https://old.example.com", "approved", now-60*day)
		seedLinkComment(t, "甲", "a@x.com", "", "approved", now-60000)
		token := adminToken(t)

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URL != "https://old.example.com" {
			t.Errorf("较晚的空网址不应清掉旧网址，实际 %q", u.URL)
		}
		// 刚刚评论过 → 不休眠
		if u.URLDormant {
			t.Errorf("一分钟前刚评论过，不应标记休眠")
		}
	})

	t.Run("身份按邮箱归一化：换昵称后再次评论同样解除休眠", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "甲", "A@X.com", "https://a.example.com", "approved", now-90*day)
		seedLinkComment(t, "甲（改名）", " a@x.com ", "https://a.example.com", "approved", now-day)
		token := adminToken(t)

		payload, _ := fetchUserList(t, token)
		// DB 里是两行（author+email 都不同），但两行必须下发同一个链接状态
		rows := usersByEmail(payload, "a@x.com")
		if len(rows) != 2 {
			t.Fatalf("换昵称应产生 2 行，实际 %d 行", len(rows))
		}
		for _, u := range rows {
			if u.URLDormant {
				t.Errorf("该邮箱一天前刚评论过，行 %q 不应标记休眠", u.Author)
			}
			if u.URL != "https://a.example.com" {
				t.Errorf("行 %q 的 url 期望共享值 https://a.example.com，实际 %q", u.Author, u.URL)
			}
		}
	})

	t.Run("rejected / deleted 的评论不算「来过」", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-90*day)
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "deleted", now-60000)
		token := adminToken(t)

		if u := requireSingleUser(t, mustUserList(t, token), "a@x.com"); !u.URLDormant {
			t.Errorf("最近的评论是 deleted，不算法「来过」，应标记休眠")
		}
	})

	t.Run("天数脏值按默认 30 天处理", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "abc")
		seedLinkComment(t, "甲", "a@x.com", "https://a.example.com", "approved", now-31*day)
		seedLinkComment(t, "乙", "b@x.com", "https://b.example.com", "approved", now-10*day)
		token := adminToken(t)

		payload, _ := fetchUserList(t, token)
		if u := requireSingleUser(t, payload, "a@x.com"); !u.URLDormant {
			t.Errorf("脏天数回退 30，31 天前应标记休眠")
		}
		if u := requireSingleUser(t, payload, "b@x.com"); u.URLDormant {
			t.Errorf("脏天数回退 30，10 天前不应标记休眠")
		}
	})
}

// mustUserList 是「断言字段齐全」的快捷方式：链接休眠用例只关心 url / urlDormant
func mustUserList(t *testing.T, token string) userListPayload {
	t.Helper()
	payload, _ := fetchUserList(t, token)
	return payload
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
		// 后台头像默认走内置默认源，且不受 avatar_enabled 影响
		if want := "https://open.motues.top/avatar?name=743173788aa9166801df2e18f0e7ff24&mode=cravatar&variant=beam"; c.Avatar != want {
			t.Errorf("avatar 应为 %q，实际 %q", want, c.Avatar)
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
