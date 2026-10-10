package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"testing"
	"time"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/repository"
)

// isoMillisRe 与仓库层输出格式一致：2006-01-02T15:04:05.000Z（UTC）。
//
// 变量名带 Re 后缀：verifyRecord.go 里的 isoMillis(ms int64) string 是包级函数，
// 同名变量会与之冲突（编译期 redeclared）。
var isoMillisRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func daysAgoMillis(n int) int64 {
	return time.Now().UTC().AddDate(0, 0, -n).UnixMilli()
}

func minutesAgoMillis(n int) int64 {
	return time.Now().UTC().Add(-time.Duration(n) * time.Minute).UnixMilli()
}

// ---------------------------------------------------------------------------
// GetStatsOverview
// ---------------------------------------------------------------------------

// seedStatsData 构造一组覆盖多状态、多作者、多文章与多时间点的数据
func seedStatsData(t *testing.T, repo repository.CommentRepository) {
	t.Helper()
	seedComments(t, repo,
		sampleComment("/p1", "alice", "a@x.com", daysAgoMillis(0), "approved"),
		sampleComment("/p1", "alice", "a@x.com", daysAgoMillis(2), "pending"),
		sampleComment("/p2", "alice", "a@x.com", daysAgoMillis(10), "rejected"),
		sampleComment("/p3", "bob", "b@x.com", daysAgoMillis(300), "deleted"),
		sampleComment("/p3", "carol", "c@x.com", daysAgoMillis(0), "approved"),
		sampleComment("/p3", "carol", "c2@x.com", daysAgoMillis(0), "approved"),
	)
}

func TestGetStatsOverviewTotals(t *testing.T) {
	_, repo := newTestRepo(t)
	seedStatsData(t, repo)

	stats, err := repo.GetStatsOverview(context.Background(), "7")
	if err != nil {
		t.Fatalf("GetStatsOverview 失败: %v", err)
	}

	if stats.TotalComments != 6 {
		t.Errorf("总评论数期望 6，实际 %d", stats.TotalComments)
	}
	// 唯一 (author, email) 组合：alice/a@x、bob/b@x、carol/c@x、carol/c2@x
	if stats.TotalUsers != 4 {
		t.Errorf("总用户数期望 4，实际 %d", stats.TotalUsers)
	}
	if stats.TotalPosts != 3 {
		t.Errorf("总文章数期望 3，实际 %d", stats.TotalPosts)
	}
	if stats.StatusDistribution.Approved != 3 {
		t.Errorf("approved 期望 3，实际 %d", stats.StatusDistribution.Approved)
	}
	if stats.StatusDistribution.Pending != 1 {
		t.Errorf("pending 期望 1，实际 %d", stats.StatusDistribution.Pending)
	}
	if stats.StatusDistribution.Deleted != 1 {
		t.Errorf("deleted 期望 1，实际 %d", stats.StatusDistribution.Deleted)
	}
	if len(stats.TopCommenters) == 0 {
		t.Fatalf("热门评论者不应为空")
	}
	if stats.TopCommenters[0].Author != "alice" || stats.TopCommenters[0].Count != 3 {
		t.Errorf("热门评论者首位应为 alice(3)，实际 %+v", stats.TopCommenters[0])
	}
	if !isoMillisRe.MatchString(stats.TopCommenters[0].LastCommentDate) {
		t.Errorf("lastCommentDate 格式应为毫秒 ISO，实际 %q", stats.TopCommenters[0].LastCommentDate)
	}
}

func TestGetStatsOverviewEmptyDatabase(t *testing.T) {
	_, repo := newTestRepo(t)

	for _, r := range []string{"7", "all", "0", ""} {
		stats, err := repo.GetStatsOverview(context.Background(), r)
		if err != nil {
			t.Fatalf("GetStatsOverview(%q) 失败: %v", r, err)
		}
		if stats.TotalComments != 0 || stats.TotalUsers != 0 || stats.TotalPosts != 0 {
			t.Errorf("空库统计应全为 0，实际 %+v", stats)
		}
		if stats.TopCommenters == nil {
			t.Errorf("TopCommenters 应为空数组而不是 nil（避免 JSON null）")
		}
		if len(stats.RecentComments) == 0 {
			t.Errorf("RecentComments 应至少返回一个分桶")
		}
	}
}

func TestGetStatsOverviewRecentCommentsBuckets(t *testing.T) {
	for _, tc := range []struct {
		name     string
		rangeVal string
		wantLen  int
		wantSum  int64
		dateRe   *regexp.Regexp
	}{
		{"默认 7 天", "7", 7, 4, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"显式 1 天", "1", 1, 3, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"30 天包含 10 天前", "30", 30, 5, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"400 天被夹到 365", "400", 365, 6, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"非法取值回落 7 天", "abc", 7, 4, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"负数回落 7 天", "-3", 7, 4, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"空串回落 7 天", "", 7, 4, regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)},
		{"all 返回 12 个月", "all", 12, 6, regexp.MustCompile(`^\d{4}-\d{2}$`)},
		{"ALL 大小写不敏感", "ALL", 12, 6, regexp.MustCompile(`^\d{4}-\d{2}$`)},
		{"all 带空格", " all ", 12, 6, regexp.MustCompile(`^\d{4}-\d{2}$`)},
		{"0 等价于 all", "0", 12, 6, regexp.MustCompile(`^\d{4}-\d{2}$`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, repo := newTestRepo(t)
			seedStatsData(t, repo)

			stats, err := repo.GetStatsOverview(context.Background(), tc.rangeVal)
			if err != nil {
				t.Fatalf("GetStatsOverview(%q) 失败: %v", tc.rangeVal, err)
			}
			if len(stats.RecentComments) != tc.wantLen {
				t.Fatalf("range=%q 分桶数期望 %d，实际 %d", tc.rangeVal, tc.wantLen, len(stats.RecentComments))
			}

			var sum int64
			for _, dc := range stats.RecentComments {
				if !tc.dateRe.MatchString(dc.Date) {
					t.Errorf("日期键 %q 格式不符（期望 %s）", dc.Date, tc.dateRe.String())
				}
				if dc.Count < 0 {
					t.Errorf("分桶计数不应为负: %+v", dc)
				}
				sum += dc.Count
			}
			if sum != tc.wantSum {
				t.Errorf("range=%q 分桶总计数期望 %d，实际 %d", tc.rangeVal, tc.wantSum, sum)
			}
		})
	}
}

func TestGetStatsOverviewBucketOrderAndUniqueness(t *testing.T) {
	_, repo := newTestRepo(t)
	seedStatsData(t, repo)

	stats, err := repo.GetStatsOverview(context.Background(), "7")
	if err != nil {
		t.Fatalf("GetStatsOverview 失败: %v", err)
	}

	seen := make(map[string]bool)
	for i, dc := range stats.RecentComments {
		if seen[dc.Date] {
			t.Errorf("分桶日期重复: %q", dc.Date)
		}
		seen[dc.Date] = true
		if i > 0 && dc.Date <= stats.RecentComments[i-1].Date {
			t.Errorf("分桶应按时间升序排列: %q 在 %q 之后", stats.RecentComments[i-1].Date, dc.Date)
		}
	}

	// 最后一个桶应是今天（UTC）
	today := time.Now().UTC().Format("2006-01-02")
	if last := stats.RecentComments[len(stats.RecentComments)-1].Date; last != today {
		t.Errorf("最后一个日分桶应为今天（UTC %s），实际 %q", today, last)
	}
}

func TestGetStatsOverviewMonthBuckets(t *testing.T) {
	_, repo := newTestRepo(t)

	// 一个月前与当前各一条
	seedComments(t, repo,
		sampleComment("/p", "a", "a@x.com", time.Now().UTC().AddDate(0, -1, 0).UnixMilli(), "approved"),
		sampleComment("/p", "b", "b@x.com", time.Now().UTC().UnixMilli(), "approved"),
	)

	stats, err := repo.GetStatsOverview(context.Background(), "all")
	if err != nil {
		t.Fatalf("GetStatsOverview 失败: %v", err)
	}
	if len(stats.RecentComments) != 12 {
		t.Fatalf("all 应返回 12 个月分桶，实际 %d", len(stats.RecentComments))
	}
	last := stats.RecentComments[len(stats.RecentComments)-1]
	if last.Date != time.Now().UTC().Format("2006-01") {
		t.Errorf("最后一个分桶应为当前月，实际 %q", last.Date)
	}
	var sum int64
	for _, dc := range stats.RecentComments {
		sum += dc.Count
	}
	if sum != 2 {
		t.Errorf("近两月的总计数应为 2，实际 %d", sum)
	}
}

func TestGetStatsOverviewTopCommentersLimit(t *testing.T) {
	_, repo := newTestRepo(t)

	// 6 个不同的 (author, email) 组合，评论数依次为 6,5,4,3,2,1
	for i := 0; i < 6; i++ {
		author := string(rune('a' + i))
		email := author + "@x.com"
		for j := 0; j <= 5-i; j++ {
			seedComments(t, repo, sampleComment("/p", author, email, int64(1000+i*100+j), "approved"))
		}
	}

	stats, err := repo.GetStatsOverview(context.Background(), "7")
	if err != nil {
		t.Fatalf("GetStatsOverview 失败: %v", err)
	}
	if len(stats.TopCommenters) != 5 {
		t.Fatalf("热门评论者最多 5 条，实际 %d", len(stats.TopCommenters))
	}
	for i := 1; i < len(stats.TopCommenters); i++ {
		if stats.TopCommenters[i].Count > stats.TopCommenters[i-1].Count {
			t.Errorf("热门评论者应按计数降序: %+v", stats.TopCommenters)
			break
		}
	}
	if stats.TopCommenters[0].Count != 6 {
		t.Errorf("首位计数应为 6，实际 %d", stats.TopCommenters[0].Count)
	}
	if stats.TopCommenters[4].Count != 2 {
		t.Errorf("第 5 位计数应为 2（被 LIMIT 5 截断），实际 %d", stats.TopCommenters[4].Count)
	}
}

func TestGetStatsOverviewTopCommenterLastCommentDateIsMax(t *testing.T) {
	_, repo := newTestRepo(t)

	older := daysAgoMillis(3)
	newer := daysAgoMillis(1)
	seedComments(t, repo,
		sampleComment("/p", "a", "a@x.com", older, "approved"),
		sampleComment("/p", "a", "a@x.com", newer, "approved"),
	)

	stats, err := repo.GetStatsOverview(context.Background(), "7")
	if err != nil {
		t.Fatalf("GetStatsOverview 失败: %v", err)
	}
	want := time.UnixMilli(newer).UTC().Format("2006-01-02T15:04:05.000Z")
	if stats.TopCommenters[0].LastCommentDate != want {
		t.Errorf("lastCommentDate 应取最大 pub_date，期望 %q，实际 %q", want, stats.TopCommenters[0].LastCommentDate)
	}
}

// ---------------------------------------------------------------------------
// GetUserList
// ---------------------------------------------------------------------------

// userListSeedTimes 返回实际写入的时间戳，供断言精确比对（避免 time.Now() 抖动）
type userListSeedTimes struct {
	aliceFirst int64
	aliceLast  int64
	bobDate    int64
	carolFirst int64
	carolLast  int64
}

func seedUserListData(t *testing.T, repo repository.CommentRepository) userListSeedTimes {
	t.Helper()

	times := userListSeedTimes{
		aliceFirst: daysAgoMillis(30),
		aliceLast:  daysAgoMillis(10),
		bobDate:    daysAgoMillis(5),
		carolFirst: daysAgoMillis(2),
		carolLast:  daysAgoMillis(1),
	}

	seedComments(t, repo,
		sampleComment("/p", "alice", "a@x.com", times.aliceFirst, "approved"),
		sampleComment("/p", "alice", "a@x.com", daysAgoMillis(20), "pending"),
		sampleComment("/p", "alice", "a@x.com", times.aliceLast, "rejected"),
		sampleComment("/p", "bob", "b@x.com", times.bobDate, "deleted"),
		sampleComment("/p", "carol", "c@x.com", times.carolFirst, "approved"),
		sampleComment("/p", "carol", "c@x.com", times.carolLast, "approved"),
	)
	return times
}

func TestGetUserList(t *testing.T) {
	_, repo := newTestRepo(t)
	times := seedUserListData(t, repo)

	users, total, err := repo.GetUserList(context.Background(), 0, 20, "", "all")
	if err != nil {
		t.Fatalf("GetUserList 失败: %v", err)
	}
	if total != 3 {
		t.Errorf("唯一用户数期望 3，实际 %d", total)
	}
	if len(users) != 3 {
		t.Fatalf("用户条数期望 3，实际 %d", len(users))
	}

	byAuthor := make(map[string]*model.UserStats, len(users))
	for _, u := range users {
		byAuthor[u.Author] = u
	}

	alice, ok := byAuthor["alice"]
	if !ok {
		t.Fatalf("缺少 alice: %+v", users)
	}
	if alice.CommentCount != 3 {
		t.Errorf("alice 评论数期望 3，实际 %d", alice.CommentCount)
	}
	if alice.ApprovedCount != 1 || alice.PendingCount != 1 || alice.DeletedCount != 0 {
		t.Errorf("alice 状态计数不正确: %+v", alice)
	}
	if alice.Email != "a@x.com" {
		t.Errorf("alice 邮箱期望 a@x.com，实际 %q", alice.Email)
	}
	if !isoMillisRe.MatchString(alice.FirstCommentDate) || !isoMillisRe.MatchString(alice.LastCommentDate) {
		t.Errorf("日期格式应为毫秒 ISO，实际 %q / %q", alice.FirstCommentDate, alice.LastCommentDate)
	}
	if alice.FirstCommentDate != time.UnixMilli(times.aliceFirst).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("firstCommentDate 应取最小 pub_date，期望 %q，实际 %q",
			time.UnixMilli(times.aliceFirst).UTC().Format("2006-01-02T15:04:05.000Z"), alice.FirstCommentDate)
	}
	if alice.LastCommentDate != time.UnixMilli(times.aliceLast).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("lastCommentDate 应取最大 pub_date，期望 %q，实际 %q",
			time.UnixMilli(times.aliceLast).UTC().Format("2006-01-02T15:04:05.000Z"), alice.LastCommentDate)
	}
	if alice.EmailVerified {
		t.Errorf("未验证邮箱的 EmailVerified 应为 false")
	}
	if alice.Blacklisted {
		t.Errorf("仓库层不应设置 Blacklisted（由 handler 填充）")
	}

	// 按评论数降序
	if users[0].Author != "alice" {
		t.Errorf("应按评论数降序，首位应为 alice，实际 %q", users[0].Author)
	}
}

func TestGetUserListSearch(t *testing.T) {
	_, repo := newTestRepo(t)
	seedUserListData(t, repo)

	for _, tc := range []struct {
		name    string
		search  string
		want    int64
		authors []string
	}{
		{"按昵称前缀搜索", "ali", 1, []string{"alice"}},
		{"按邮箱搜索", "c@x", 1, []string{"carol"}},
		{"大小写不敏感（ASCII）", "ALICE", 1, []string{"alice"}},
		{"匹配多个用户", "x.com", 3, nil},
		{"搜索带空格（会被 Trim）", "  bob  ", 1, []string{"bob"}},
		{"无匹配", "zzz", 0, nil},
		// 记录当前行为：搜索词未做 LIKE 元字符转义，因此 % / _ 会被当作通配符
		{"% 被当作通配符（匹配全部）", "%", 3, nil},
		{"_ 被当作通配符（匹配全部）", "_", 3, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, total, err := repo.GetUserList(context.Background(), 0, 20, tc.search, "all")
			if err != nil {
				t.Fatalf("GetUserList 失败: %v", err)
			}
			if total != tc.want {
				t.Errorf("total 期望 %d，实际 %d", tc.want, total)
			}
			if tc.authors != nil {
				if len(users) != len(tc.authors) {
					t.Fatalf("条数期望 %d，实际 %d", len(tc.authors), len(users))
				}
				for i, want := range tc.authors {
					if users[i].Author != want {
						t.Errorf("第 %d 条作者期望 %q，实际 %q", i, want, users[i].Author)
					}
				}
			}
		})
	}
}

func TestGetUserListVerifiedFilter(t *testing.T) {
	db, repo := newTestRepo(t)
	seedUserListData(t, repo)

	// 标记 carol 的邮箱已验证
	verifiedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if _, err := db.Exec(`INSERT INTO EmailVerification (email, token, expires_at, verified, verified_at)
		VALUES ('c@x.com', 'tok-carol', ?, 1, ?)`, verifiedAt, verifiedAt); err != nil {
		t.Fatalf("插入邮箱验证记录失败: %v", err)
	}

	for _, tc := range []struct {
		name     string
		verified string
		want     int64
	}{
		{"true 仅返回已验证用户", "true", 1},
		{"false 仅返回未验证用户", "false", 2},
		{"all 不过滤", "all", 3},
		{"空值不过滤", "", 3},
		{"未知取值不过滤", "garbage", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, total, err := repo.GetUserList(context.Background(), 0, 20, "", tc.verified)
			if err != nil {
				t.Fatalf("GetUserList 失败: %v", err)
			}
			if total != tc.want {
				t.Errorf("total 期望 %d，实际 %d", tc.want, total)
			}
			if len(users) != int(tc.want) {
				t.Errorf("条数期望 %d，实际 %d", tc.want, len(users))
			}
			if tc.verified == "true" {
				for _, u := range users {
					if !u.EmailVerified {
						t.Errorf("已验证筛选中出现了未验证用户: %+v", u)
					}
					if u.EmailVerifiedAt == "" {
						t.Errorf("已验证用户的 emailVerifiedAt 不应为空: %+v", u)
					}
				}
			}
			if tc.verified == "false" {
				for _, u := range users {
					if u.EmailVerified {
						t.Errorf("未验证筛选中出现了已验证用户: %+v", u)
					}
					if u.EmailVerifiedAt != "" {
						t.Errorf("未验证用户的 emailVerifiedAt 应为空: %+v", u)
					}
				}
			}
		})
	}
}

func TestGetUserListVerifiedIsCaseSensitiveInSQL(t *testing.T) {
	db, repo := newTestRepo(t)
	seedUserListData(t, repo)

	// verified = 1 但 email 大小写不同：SQLite 的 = 对文本区分大小写，因此不应命中
	verifiedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if _, err := db.Exec(`INSERT INTO EmailVerification (email, token, expires_at, verified, verified_at)
		VALUES ('C@X.COM', 'tok-upper', ?, 1, ?)`, verifiedAt, verifiedAt); err != nil {
		t.Fatalf("插入邮箱验证记录失败: %v", err)
	}

	_, total, err := repo.GetUserList(context.Background(), 0, 20, "", "true")
	if err != nil {
		t.Fatalf("GetUserList 失败: %v", err)
	}
	if total != 0 {
		t.Errorf("邮箱大小写不同不应命中已验证筛选（当前为精确匹配），实际 total=%d", total)
	}
}

func TestGetUserListPagination(t *testing.T) {
	_, repo := newTestRepo(t)
	seedUserListData(t, repo)

	for _, tc := range []struct {
		name    string
		offset  int
		limit   int
		wantLen int
	}{
		{"第一页", 0, 1, 1},
		{"第二页", 1, 1, 1},
		{"第三页", 2, 1, 1},
		{"越界", 10, 1, 0},
		{"limit 为 0", 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users, total, err := repo.GetUserList(context.Background(), tc.offset, tc.limit, "", "all")
			if err != nil {
				t.Fatalf("GetUserList 失败: %v", err)
			}
			if total != 3 {
				t.Errorf("total 应始终为 3，实际 %d", total)
			}
			if len(users) != tc.wantLen {
				t.Errorf("条数期望 %d，实际 %d", tc.wantLen, len(users))
			}
		})
	}
}

func TestGetUserListEmpty(t *testing.T) {
	_, repo := newTestRepo(t)

	users, total, err := repo.GetUserList(context.Background(), 0, 20, "", "all")
	if err != nil {
		t.Fatalf("GetUserList 失败: %v", err)
	}
	if total != 0 || len(users) != 0 {
		t.Errorf("空库应返回 0 条，实际 %d 条 / total=%d", len(users), total)
	}
}

// ---------------------------------------------------------------------------
// GetUserComments
// ---------------------------------------------------------------------------

func TestGetUserComments(t *testing.T) {
	_, repo := newTestRepo(t)

	seedComments(t, repo,
		sampleComment("/p1", "alice", "a@x.com", 1000, "approved"),
		sampleComment("/p2", "alice", "a@x.com", 3000, "pending"),
		sampleComment("/p3", "alice", "a@x.com", 2000, "rejected"),
		sampleComment("/p", "alice", "other@x.com", 4000, "approved"), // 同作者不同邮箱
		sampleComment("/p", "bob", "b@x.com", 5000, "approved"),
	)

	resp, total, err := repo.GetUserComments(context.Background(), "alice", "a@x.com", 0, 10)
	if err != nil {
		t.Fatalf("GetUserComments 失败: %v", err)
	}
	if total != 3 {
		t.Errorf("total 期望 3，实际 %d", total)
	}
	if len(resp) != 3 {
		t.Fatalf("条数期望 3，实际 %d", len(resp))
	}

	// 按 pub_date 降序
	if resp[0].PubDate != time.UnixMilli(3000).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("应按 pub_date 降序，首条 pubDate=%q", resp[0].PubDate)
	}
	if resp[1].PubDate <= resp[2].PubDate {
		t.Errorf("剩余条目的 pub_date 应递减: %q, %q", resp[1].PubDate, resp[2].PubDate)
	}
	if resp[0].Author != "alice" || resp[0].Email != "a@x.com" {
		t.Errorf("作者/邮箱字段不正确: %+v", resp[0])
	}
	if resp[0].Status != "pending" {
		t.Errorf("状态字段应被映射，实际 %q", resp[0].Status)
	}
	if resp[0].ContentHtml == "" || resp[0].ContentText == "" {
		t.Errorf("正文字段应被映射: %+v", resp[0])
	}
	if resp[0].IPAddress == nil || resp[0].OS == nil || resp[0].Browser == nil {
		t.Errorf("可选字段应被映射: %+v", resp[0])
	}
}

func TestGetUserCommentsPagination(t *testing.T) {
	_, repo := newTestRepo(t)

	for i := 0; i < 15; i++ {
		seedComments(t, repo, sampleComment("/p", "alice", "a@x.com", int64(1000+i), "approved"))
	}

	for _, tc := range []struct {
		name    string
		offset  int
		limit   int
		wantLen int
	}{
		{"第一页", 0, 10, 10},
		{"第二页", 10, 10, 5},
		{"越界", 100, 10, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, total, err := repo.GetUserComments(context.Background(), "alice", "a@x.com", tc.offset, tc.limit)
			if err != nil {
				t.Fatalf("GetUserComments 失败: %v", err)
			}
			if total != 15 {
				t.Errorf("total 应始终为 15，实际 %d", total)
			}
			if len(resp) != tc.wantLen {
				t.Errorf("条数期望 %d，实际 %d", tc.wantLen, len(resp))
			}
		})
	}
}

func TestGetUserCommentsEmpty(t *testing.T) {
	_, repo := newTestRepo(t)
	seedComments(t, repo, sampleComment("/p", "alice", "a@x.com", 1000, "approved"))

	resp, total, err := repo.GetUserComments(context.Background(), "unknown", "u@x.com", 0, 10)
	if err != nil {
		t.Fatalf("GetUserComments 失败: %v", err)
	}
	if total != 0 || len(resp) != 0 {
		t.Errorf("未知用户应返回 0 条，实际 %d 条 / total=%d", len(resp), total)
	}
}

// ---------------------------------------------------------------------------
// 邮箱验证
// ---------------------------------------------------------------------------

func TestCheckEmailVerified(t *testing.T) {
	db, repo := newTestRepo(t)

	ok, err := repo.CheckEmailVerified(context.Background(), "a@x.com")
	if err != nil {
		t.Fatalf("CheckEmailVerified 失败: %v", err)
	}
	if ok {
		t.Errorf("没有任何验证记录时应为 false")
	}

	// verified = 0 的记录不算已验证
	if _, err := db.Exec(`INSERT INTO EmailVerification (email, token, expires_at, verified) VALUES ('a@x.com','t1','2099-01-01T00:00:00.000Z',0)`); err != nil {
		t.Fatalf("插入记录失败: %v", err)
	}
	if ok, _ := repo.CheckEmailVerified(context.Background(), "a@x.com"); ok {
		t.Errorf("verified=0 的记录不应算作已验证")
	}

	// verified = 1 的记录算已验证
	if _, err := db.Exec(`INSERT INTO EmailVerification (email, token, expires_at, verified) VALUES ('a@x.com','t2','2099-01-01T00:00:00.000Z',1)`); err != nil {
		t.Fatalf("插入记录失败: %v", err)
	}
	if ok, err := repo.CheckEmailVerified(context.Background(), "a@x.com"); err != nil || !ok {
		t.Errorf("verified=1 的记录应算作已验证，got=%v err=%v", ok, err)
	}

	// 其他邮箱不受影响
	if ok, _ := repo.CheckEmailVerified(context.Background(), "b@x.com"); ok {
		t.Errorf("其他邮箱不应算作已验证")
	}
	// 大小写敏感（当前实现为精确匹配）
	if ok, _ := repo.CheckEmailVerified(context.Background(), "A@X.COM"); ok {
		t.Errorf("邮箱大小写不同不应算作已验证（当前为精确匹配）")
	}
}

func TestHasUnverifiedToken(t *testing.T) {
	db, repo := newTestRepo(t)

	email := "a@x.com"
	future := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	past := time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02T15:04:05.000Z")

	if has, err := repo.HasUnverifiedToken(context.Background(), email); err != nil || has {
		t.Errorf("无记录时应为 false，got=%v err=%v", has, err)
	}

	if err := repo.SaveVerificationToken(context.Background(), email, "tok-future", future, "/p", "标题"); err != nil {
		t.Fatalf("SaveVerificationToken 失败: %v", err)
	}
	if has, err := repo.HasUnverifiedToken(context.Background(), email); err != nil || !has {
		t.Errorf("存在未过期未验证令牌时应为 true，got=%v err=%v", has, err)
	}

	// 已过期的令牌不算
	if err := repo.SaveVerificationToken(context.Background(), email, "tok-past", past, "/p", "标题"); err != nil {
		t.Fatalf("SaveVerificationToken 失败: %v", err)
	}
	if has, _ := repo.HasUnverifiedToken(context.Background(), "b@x.com"); has {
		t.Errorf("其他邮箱不应受影响")
	}

	// 去掉未过期令牌后应为 false
	if _, err := db.Exec("DELETE FROM EmailVerification WHERE token = 'tok-future'"); err != nil {
		t.Fatalf("删除令牌失败: %v", err)
	}
	if has, err := repo.HasUnverifiedToken(context.Background(), email); err != nil || has {
		t.Errorf("只剩过期令牌时应为 false，got=%v err=%v", has, err)
	}

	// 已验证的令牌不算未验证
	if err := repo.SaveVerificationToken(context.Background(), email, "tok-verified", future, "/p", "标题"); err != nil {
		t.Fatalf("SaveVerificationToken 失败: %v", err)
	}
	if _, err := db.Exec("UPDATE EmailVerification SET verified = 1 WHERE token = 'tok-verified'"); err != nil {
		t.Fatalf("更新令牌失败: %v", err)
	}
	if has, err := repo.HasUnverifiedToken(context.Background(), email); err != nil || has {
		t.Errorf("已验证的令牌不应算作未验证令牌，got=%v err=%v", has, err)
	}
}

func TestSaveAndGetVerificationRecord(t *testing.T) {
	db, repo := newTestRepo(t)

	email := "a@x.com"
	expires := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05.000Z")

	if err := repo.SaveVerificationToken(context.Background(), email, "tok-1", expires, "/posts/x", "文章标题"); err != nil {
		t.Fatalf("SaveVerificationToken 失败: %v", err)
	}

	rec, err := repo.GetVerificationRecord(context.Background(), "tok-1", email)
	if err != nil {
		t.Fatalf("GetVerificationRecord 失败: %v", err)
	}
	if rec.Email != email || rec.Token != "tok-1" {
		t.Errorf("记录字段不匹配: %+v", rec)
	}
	if rec.ExpiresAt != expires {
		t.Errorf("expires_at 期望 %q，实际 %q", expires, rec.ExpiresAt)
	}
	if rec.Verified != 0 {
		t.Errorf("新记录的 verified 应为 0，实际 %d", rec.Verified)
	}
	if rec.PostSlug == nil || *rec.PostSlug != "/posts/x" {
		t.Errorf("post_slug 未保存: %v", rec.PostSlug)
	}
	if rec.PostTitle == nil || *rec.PostTitle != "文章标题" {
		t.Errorf("post_title 未保存: %v", rec.PostTitle)
	}
	if rec.CreatedAt == "" {
		t.Errorf("created_at 应有默认值")
	}
	if rec.VerifiedAt != nil {
		t.Errorf("未验证时 verified_at 应为 NULL")
	}

	// 令牌必须与邮箱同时匹配
	if _, err := repo.GetVerificationRecord(context.Background(), "tok-1", "other@x.com"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("邮箱与令牌不匹配时应返回 ErrNoRows，实际 %v", err)
	}
	if _, err := repo.GetVerificationRecord(context.Background(), "not-exist", email); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("不存在的令牌应返回 ErrNoRows，实际 %v", err)
	}

	// token 唯一约束
	if err := repo.SaveVerificationToken(context.Background(), "b@x.com", "tok-1", expires, "/p", "t"); err == nil {
		t.Errorf("重复的 token 应触发唯一约束错误")
	}
	_ = db
}

func TestVerifyEmail(t *testing.T) {
	db, repo := newTestRepo(t)

	email := "a@x.com"
	otherEmail := "b@x.com"
	expires := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05.000Z")

	if err := repo.SaveVerificationToken(context.Background(), email, "tok-a", expires, "/p", "t"); err != nil {
		t.Fatalf("SaveVerificationToken 失败: %v", err)
	}

	// 该邮箱下有 2 条待审核、1 条已通过、1 条已删除；另一邮箱有 1 条待审核
	pending1 := mustCreate(t, repo, sampleComment("/p", "a", email, 1000, "pending"))
	pending2 := mustCreate(t, repo, sampleComment("/p", "a", email, 2000, "pending"))
	approved := mustCreate(t, repo, sampleComment("/p", "a", email, 3000, "approved"))
	deleted := mustCreate(t, repo, sampleComment("/p", "a", email, 4000, "deleted"))
	otherPending := mustCreate(t, repo, sampleComment("/p", "b", otherEmail, 5000, "pending"))

	count, err := repo.VerifyEmail(context.Background(), "tok-a", email)
	if err != nil {
		t.Fatalf("VerifyEmail 失败: %v", err)
	}
	if count != 2 {
		t.Errorf("应批准 2 条待审核评论，实际 %d", count)
	}

	for _, tc := range []struct {
		id     int64
		status string
	}{
		{pending1.ID, "approved"},
		{pending2.ID, "approved"},
		{approved.ID, "approved"},
		{deleted.ID, "deleted"},
		{otherPending.ID, "pending"},
	} {
		got, err := repo.GetByID(context.Background(), tc.id)
		if err != nil {
			t.Fatalf("GetByID(%d) 失败: %v", tc.id, err)
		}
		if got.Status != tc.status {
			t.Errorf("id=%d 状态期望 %q，实际 %q", tc.id, tc.status, got.Status)
		}
	}

	// 验证记录应被标记
	rec, err := repo.GetVerificationRecord(context.Background(), "tok-a", email)
	if err != nil {
		t.Fatalf("GetVerificationRecord 失败: %v", err)
	}
	if rec.Verified != 1 {
		t.Errorf("验证记录应标记为已验证，实际 %d", rec.Verified)
	}
	if rec.VerifiedAt == nil || *rec.VerifiedAt == "" {
		t.Errorf("verified_at 应被写入")
	}
	if ok, _ := repo.CheckEmailVerified(context.Background(), email); !ok {
		t.Errorf("验证后 CheckEmailVerified 应为 true")
	}

	// 重复验证：已无待审核评论，返回 0
	count, err = repo.VerifyEmail(context.Background(), "tok-a", email)
	if err != nil {
		t.Fatalf("重复 VerifyEmail 失败: %v", err)
	}
	if count != 0 {
		t.Errorf("重复验证不应再批准评论，实际 %d", count)
	}

	// 令牌与邮箱不匹配时不应产生任何影响
	count, err = repo.VerifyEmail(context.Background(), "tok-a", otherEmail)
	if err != nil {
		t.Fatalf("VerifyEmail 失败: %v", err)
	}
	if count != 1 {
		t.Errorf("令牌不匹配时仍按邮箱批准（当前实现行为），期望 1 条，实际 %d", count)
	}
	got, err := repo.GetByID(context.Background(), otherPending.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.Status != "approved" {
		t.Errorf("当前实现按邮箱而非令牌批准评论，实际状态 %q", got.Status)
	}
	_ = db
}

func TestVerifyEmailNonexistentToken(t *testing.T) {
	_, repo := newTestRepo(t)

	if _, err := repo.VerifyEmail(context.Background(), "not-exist", "a@x.com"); err != nil {
		t.Errorf("不存在的令牌不应报错（影响 0 行）: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 时间辅助函数（供统计分桶使用）
// ---------------------------------------------------------------------------

func TestGetDateRangeAndMonthRange(t *testing.T) {
	dates := getDateRange(6)
	if len(dates) != 7 {
		t.Errorf("getDateRange(6) 应返回 7 个日期，实际 %d", len(dates))
	}
	for i := 1; i < len(dates); i++ {
		if dates[i] <= dates[i-1] {
			t.Errorf("日期应升序: %v", dates)
		}
	}
	today := time.Now().UTC().Format("2006-01-02")
	if dates[len(dates)-1] != today {
		t.Errorf("最后一个日期应为今天（UTC %s），实际 %q", today, dates[len(dates)-1])
	}

	if got := getDateRange(0); len(got) != 1 || got[0] != today {
		t.Errorf("getDateRange(0) 应只返回今天，实际 %v", got)
	}

	months := getMonthRange(11)
	if len(months) != 12 {
		t.Errorf("getMonthRange(11) 应返回 12 个月，实际 %d", len(months))
	}
	if months[len(months)-1] != time.Now().UTC().Format("2006-01") {
		t.Errorf("最后一个月应为当前月，实际 %q", months[len(months)-1])
	}
	for _, m := range months {
		if len(m) != 7 {
			t.Errorf("月份格式应为 YYYY-MM，实际 %q", m)
		}
	}
}

func TestMinutesAgoHelperIsConsistent(t *testing.T) {
	// 速率限制依赖 pub_date 的毫秒差值，这里校验辅助函数本身
	got := minutesAgoMillis(1)
	if diff := time.Now().UTC().UnixMilli() - got; diff < 59000 || diff > 61000 {
		t.Errorf("minutesAgoMillis(1) 与当前时间差应约 60 秒，实际 %d 毫秒", diff)
	}
}
