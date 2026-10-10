package http

import (
	"database/sql"
	"fmt"
	"math"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/model"
)

/*
/admin/verify/overview 与 /admin/verify/records 的响应契约测试。

这两个接口是 Go / Node / Worker 三端**逐字节一致**的护栏：统计窗口与分桶键、
时间字符串格式（毫秒固定 3 位）、passRate / 环比的取整口径、榜单的空数组
（必须是 [] 而不是 null）都必须与另外两端同一口径，改动响应结构时这里会先红。
*/

// ---------------------------------------------------------------------------
// 格式与断言助手
// ---------------------------------------------------------------------------

const verifyISOLayout = "2006-01-02T15:04:05.000Z"

var (
	// 三端约定的毫秒 ISO：毫秒必须固定 3 位（不能变长/变短）
	verifyISORE      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	verifyDayKeyRE   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	verifyHourKeyRE  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}$`)
	verifyMonthKeyRE = regexp.MustCompile(`^\d{4}-\d{2}$`)
)

func verifyNowMs() int64 { return time.Now().UTC().UnixMilli() }

func verifyDaysAgoMs(n int) int64 {
	return time.Now().UTC().AddDate(0, 0, -n).UnixMilli()
}

func requireInt64(t *testing.T, name string, got, want int64) {
	t.Helper()
	if got != want {
		t.Errorf("%s 期望 %d，实际 %d", name, want, got)
	}
}

func requireString(t *testing.T, name, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s 期望 %q，实际 %q", name, want, got)
	}
}

func requireIntPtr(t *testing.T, name string, got *int64, want int64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s 期望 %d，实际 null", name, want)
		return
	}
	if *got != want {
		t.Errorf("%s 期望 %d，实际 %d", name, want, *got)
	}
}

// requireNilIntPtr 断言可空字段确实是 JSON null（nil 指针）
func requireNilIntPtr(t *testing.T, name string, got *int64) {
	t.Helper()
	if got != nil {
		t.Errorf("%s 期望 null，实际 %d", name, *got)
	}
}

func requireFloatPtr(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s 期望 %v，实际 null", name, want)
		return
	}
	if math.Abs(*got-want) > 1e-9 {
		t.Errorf("%s 期望 %v，实际 %v", name, want, *got)
	}
}

func requireNilFloatPtr(t *testing.T, name string, got *float64) {
	t.Helper()
	if got != nil {
		t.Errorf("%s 期望 null，实际 %v", name, *got)
	}
}

// requireBodyContains 直接检查原始响应体，钉住「空数组而不是 null」这类 JSON 形状
func requireBodyContains(t *testing.T, w *httptest.ResponseRecorder, fragment string) {
	t.Helper()
	if !strings.Contains(w.Body.String(), fragment) {
		t.Errorf("响应体应包含 %s，实际 %s", fragment, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 数据落库与读取助手
// ---------------------------------------------------------------------------

// verifyRecordRow 直接读取 VerifyRecord 表的一行（断言落库内容与时区口径用）
type verifyRecordRow struct {
	ID          int64          `db:"id"`
	CreatedAt   int64          `db:"created_at"`
	Event       string         `db:"event"`
	Reason      sql.NullString `db:"reason"`
	ElapsedMs   sql.NullInt64  `db:"elapsed_ms"`
	Difficulty  sql.NullInt64  `db:"difficulty"`
	ChallengeID sql.NullString `db:"challenge_id"`
	PostSlug    sql.NullString `db:"post_slug"`
	IPAddress   sql.NullString `db:"ip_address"`
	Country     sql.NullString `db:"country"`
	Network     sql.NullString `db:"network"`
	ASN         sql.NullInt64  `db:"asn"`
}

// verifyRecordSeed 是一条待写入的认证记录；nil 字段按 NULL 写入，毫秒时间戳显式给出
type verifyRecordSeed struct {
	CreatedAt   int64
	Event       string
	Reason      *string
	ElapsedMs   *int64
	Difficulty  *int64
	ChallengeID *string
	PostSlug    *string
	IPAddress   *string
	Country     *string
	Network     *string
	ASN         *int64
}

func seedVerifyRecord(t *testing.T, seed verifyRecordSeed) int64 {
	t.Helper()

	nullableString := func(v *string) interface{} {
		if v == nil {
			return nil
		}
		return *v
	}
	nullableInt := func(v *int64) interface{} {
		if v == nil {
			return nil
		}
		return *v
	}

	res, err := testDB.Exec(`INSERT INTO VerifyRecord
		(created_at, event, reason, elapsed_ms, difficulty, challenge_id, post_slug, ip_address, country, network, asn)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		seed.CreatedAt, seed.Event,
		nullableString(seed.Reason), nullableInt(seed.ElapsedMs), nullableInt(seed.Difficulty),
		nullableString(seed.ChallengeID), nullableString(seed.PostSlug), nullableString(seed.IPAddress),
		nullableString(seed.Country), nullableString(seed.Network), nullableInt(seed.ASN))
	if err != nil {
		t.Fatalf("写入 VerifyRecord 失败: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("读取 VerifyRecord 自增 ID 失败: %v", err)
	}
	return id
}

func seedVerifyRecords(t *testing.T, seeds ...verifyRecordSeed) []int64 {
	t.Helper()
	ids := make([]int64, 0, len(seeds))
	for _, seed := range seeds {
		ids = append(ids, seedVerifyRecord(t, seed))
	}
	return ids
}

// challengeAt / passAt / failAt 构造三类事件的记录，保证三端的事件取值一致
func challengeAt(createdAt int64) verifyRecordSeed {
	return verifyRecordSeed{CreatedAt: createdAt, Event: model.VerifyEventChallenge}
}

func passAt(createdAt, elapsedMs int64) verifyRecordSeed {
	return verifyRecordSeed{CreatedAt: createdAt, Event: model.VerifyEventPass, ElapsedMs: &elapsedMs}
}

func failAt(createdAt int64, reason string) verifyRecordSeed {
	return verifyRecordSeed{CreatedAt: createdAt, Event: model.VerifyEventFail, Reason: &reason}
}

// listVerifyRows 按写入顺序读取全部认证记录
func listVerifyRows(t *testing.T) []verifyRecordRow {
	t.Helper()
	rows := []verifyRecordRow{}
	if err := testDB.Select(&rows, "SELECT * FROM VerifyRecord ORDER BY id ASC"); err != nil {
		t.Fatalf("读取 VerifyRecord 失败: %v", err)
	}
	return rows
}

func countVerifyRecords(t *testing.T) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM VerifyRecord"); err != nil {
		t.Fatalf("统计 VerifyRecord 失败: %v", err)
	}
	return n
}

// ---------------------------------------------------------------------------
// 响应读取助手
// ---------------------------------------------------------------------------

type verifyOverviewEnvelope struct {
	Code    int                  `json:"code"`
	Message string               `json:"message"`
	Data    model.VerifyOverview `json:"data"`
}

type verifyRecordsEnvelope struct {
	Code    int                    `json:"code"`
	Message string                 `json:"message"`
	Data    model.VerifyRecordList `json:"data"`
}

func fetchVerifyOverview(t *testing.T, token, query string) (model.VerifyOverview, *httptest.ResponseRecorder) {
	t.Helper()
	w := callWithToken(t, "GET", "/admin/verify/overview"+query, "", token)
	requireStatus(t, w, 200)
	requireBodyCode(t, w, 200)

	var env verifyOverviewEnvelope
	decodeInto(t, w, &env)
	requireString(t, "message", env.Message, "Verify stats fetched successfully")
	if env.Data.Trend == nil {
		t.Errorf("trend 必须是数组而不是 null")
	}
	return env.Data, w
}

func fetchVerifyRecords(t *testing.T, token, query string) (model.VerifyRecordList, *httptest.ResponseRecorder) {
	t.Helper()
	w := callWithToken(t, "GET", "/admin/verify/records"+query, "", token)
	requireStatus(t, w, 200)
	requireBodyCode(t, w, 200)

	var env verifyRecordsEnvelope
	decodeInto(t, w, &env)
	requireString(t, "message", env.Message, "Verify records fetched successfully")
	if env.Data.List == nil {
		t.Errorf("list 必须是数组而不是 null")
	}
	return env.Data, w
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

func TestVerifyAdminEndpointsRequireToken(t *testing.T) {
	resetState(t)

	for _, target := range []string{"/admin/verify/overview", "/admin/verify/records"} {
		t.Run("无 token "+target, func(t *testing.T) {
			w := callJSON(t, "GET", target, "")
			requireStatus(t, w, 401)
			requireBodyCode(t, w, 401)
			requireString(t, "message", decodeJSON(t, w)["message"].(string), "Invalid token")
		})

		t.Run("非法 token "+target, func(t *testing.T) {
			w := call(t, "GET", target, "", map[string]string{"Authorization": "Bearer not-a-real-token"}, "")
			requireStatus(t, w, 401)
			requireBodyCode(t, w, 401)
		})
	}

	// 有效 token 必须放行：否则上面的 401 断言可能是「路由不存在」造成的假阳性
	token := adminToken(t)
	requireStatus(t, callWithToken(t, "GET", "/admin/verify/overview", "", token), 200)
	requireStatus(t, callWithToken(t, "GET", "/admin/verify/records", "", token), 200)
}

// ---------------------------------------------------------------------------
// GET /admin/verify/overview
// ---------------------------------------------------------------------------

func TestVerifyOverviewSummaryTrendAndGeoPlaceholders(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 用「今天 UTC 12:00」而不是 time.Now() 作为锚点：无论测试在几点运行，
	// 落点都稳定在同一天的分桶里，不会出现跨日/跨小时的抖动。
	today := time.Now().UTC()
	noon := time.Date(today.Year(), today.Month(), today.Day(), 12, 0, 0, 0, time.UTC).UnixMilli()
	threeDaysAgo := time.UnixMilli(noon).AddDate(0, 0, -3).UnixMilli()

	seedVerifyRecords(t,
		challengeAt(noon),
		challengeAt(noon+1000),
		challengeAt(threeDaysAgo),
		passAt(noon, 100),
		passAt(noon+1000, 200),
		passAt(noon+2000, 300),
		failAt(noon+3000, "bad nonce"),
		failAt(threeDaysAgo+1000, "bad nonce"),
	)

	data, w := fetchVerifyOverview(t, token, "?days=7")

	// range：days / offset / bucket 与窗口边界
	requireInt64(t, "range.days", int64(data.Range.Days), 7)
	requireInt64(t, "range.offset", int64(data.Range.Offset), 0)
	requireString(t, "range.bucket", data.Range.Bucket, "day")
	if !verifyISORE.MatchString(data.Range.From) || !verifyISORE.MatchString(data.Range.To) {
		t.Errorf("range.from/to 必须是毫秒 ISO（UTC），实际 %q / %q", data.Range.From, data.Range.To)
	}
	midnight := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	requireString(t, "range.from", data.Range.From, midnight.AddDate(0, 0, -6).Format(verifyISOLayout))
	requireString(t, "range.to", data.Range.To,
		time.Date(today.Year(), today.Month(), today.Day(), 23, 59, 59, 999*int(time.Millisecond), time.UTC).Format(verifyISOLayout))

	// summary
	requireInt64(t, "summary.challenges", data.Summary.Challenges, 3)
	requireInt64(t, "summary.verified", data.Summary.Verified, 3)
	requireInt64(t, "summary.failed", data.Summary.Failed, 2)
	// avgDurationMs 只统计 pass 的 elapsed_ms：(100+200+300)/3
	requireIntPtr(t, "summary.avgDurationMs", data.Summary.AvgDurationMs, 200)
	// passRate = pass/(pass+fail)*100 = 3/5
	requireFloatPtr(t, "summary.passRate", data.Summary.PassRate, 60)

	// 上一个等长窗口没有任何记录 => 环比必须是 null，而不是 0 或 100
	requireNilIntPtr(t, "summary.challengesDelta", data.Summary.ChallengesDelta)
	requireNilIntPtr(t, "summary.verifiedDelta", data.Summary.VerifiedDelta)
	requireNilIntPtr(t, "summary.failedDelta", data.Summary.FailedDelta)
	requireNilIntPtr(t, "summary.avgDurationDelta", data.Summary.AvgDurationDelta)

	// trend：按天分桶，长度必须是满窗口（补零），键为 UTC 日期
	if len(data.Trend) != 7 {
		t.Fatalf("trend 长度期望 7，实际 %d", len(data.Trend))
	}
	for i := 0; i < 7; i++ {
		wantKey := midnight.AddDate(0, 0, i-6).Format("2006-01-02")
		if data.Trend[i].Date != wantKey {
			t.Errorf("trend[%d].date 期望 %q，实际 %q", i, wantKey, data.Trend[i].Date)
		}
	}
	// 今天的分桶（最后一个）承载今天的三类事件
	requireInt64(t, "trend[6].challenges", data.Trend[6].Challenges, 2)
	requireInt64(t, "trend[6].verified", data.Trend[6].Verified, 3)
	requireInt64(t, "trend[6].failed", data.Trend[6].Failed, 1)
	// 三天前的分桶：1 次签发 + 1 次失败，其余补零
	requireInt64(t, "trend[3].challenges", data.Trend[3].Challenges, 1)
	requireInt64(t, "trend[3].verified", data.Trend[3].Verified, 0)
	requireInt64(t, "trend[3].failed", data.Trend[3].Failed, 1)
	// 没有数据的分桶必须是 0（补零），不能缺项
	requireInt64(t, "trend[0] 合计", data.Trend[0].Challenges+data.Trend[0].Verified+data.Trend[0].Failed, 0)

	var trendChallenges, trendVerified, trendFailed int64
	for _, point := range data.Trend {
		trendChallenges += point.Challenges
		trendVerified += point.Verified
		trendFailed += point.Failed
	}
	requireInt64(t, "trend 合计 challenges", trendChallenges, data.Summary.Challenges)
	requireInt64(t, "trend 合计 verified", trendVerified, data.Summary.Verified)
	requireInt64(t, "trend 合计 failed", trendFailed, data.Summary.Failed)

	// topReasons：2/8 = 25.0%（分母是窗口内全部事件数）
	if len(data.TopReasons) != 1 {
		t.Fatalf("topReasons 期望 1 项，实际 %d 项：%+v", len(data.TopReasons), data.TopReasons)
	}
	requireString(t, "topReasons[0].reason", data.TopReasons[0].Reason, "bad nonce")
	requireInt64(t, "topReasons[0].count", data.TopReasons[0].Count, 2)
	if math.Abs(data.TopReasons[0].Percent-25) > 1e-9 {
		t.Errorf("topReasons[0].percent 期望 25，实际 %v", data.TopReasons[0].Percent)
	}

	// Go 部署没有 IP 归属地数据源：geoSupported 恒为 false，两个地区榜单恒为 []（绝不是 null）
	if data.GeoSupported {
		t.Errorf("Go 端 geoSupported 必须恒为 false")
	}
	if data.TopCountries == nil || len(data.TopCountries) != 0 {
		t.Errorf("topCountries 必须是空数组，实际 %+v", data.TopCountries)
	}
	if data.TopNetworks == nil || len(data.TopNetworks) != 0 {
		t.Errorf("topNetworks 必须是空数组，实际 %+v", data.TopNetworks)
	}
	requireBodyContains(t, w, `"geoSupported":false`)
	requireBodyContains(t, w, `"topCountries":[]`)
	requireBodyContains(t, w, `"topNetworks":[]`)
	requireBodyContains(t, w, `"topReasons":[`)
}

// TestVerifyOverviewDeltaComparedWithPreviousWindow 环比必须与「上一个等长窗口」比较，
// 且窗口平移的天数按 days 计算（days=7 时上一窗口是 7 天前的那 7 天）
func TestVerifyOverviewDeltaComparedWithPreviousWindow(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	today := time.Now().UTC()
	noon := time.Date(today.Year(), today.Month(), today.Day(), 12, 0, 0, 0, time.UTC).UnixMilli()
	previous := time.UnixMilli(noon).AddDate(0, 0, -10).UnixMilli()

	// 当前窗口：2 签发 / 2 通过（100、100）/ 1 失败；平均耗时 100
	seedVerifyRecords(t,
		challengeAt(noon), challengeAt(noon+1000),
		passAt(noon, 100), passAt(noon+1000, 100),
		failAt(noon+2000, "bad nonce"),
	)
	// 上一个等长窗口：1 签发 / 2 通过（100、300，平均 200）/ 2 失败
	seedVerifyRecords(t,
		challengeAt(previous),
		passAt(previous+1000, 100), passAt(previous+2000, 300),
		failAt(previous+3000, "honeypot"), failAt(previous+4000, "bad signature"),
	)

	data, _ := fetchVerifyOverview(t, token, "?days=7")

	requireInt64(t, "summary.challenges", data.Summary.Challenges, 2)
	requireInt64(t, "summary.verified", data.Summary.Verified, 2)
	requireInt64(t, "summary.failed", data.Summary.Failed, 1)
	requireIntPtr(t, "summary.avgDurationMs", data.Summary.AvgDurationMs, 100)

	// (2-1)/1 => +100%；(2-2)/2 => 0%；(1-2)/2 => -50%；(100-200)/200 => -50%
	requireIntPtr(t, "summary.challengesDelta", data.Summary.ChallengesDelta, 100)
	requireIntPtr(t, "summary.verifiedDelta", data.Summary.VerifiedDelta, 0)
	requireIntPtr(t, "summary.failedDelta", data.Summary.FailedDelta, -50)
	requireIntPtr(t, "summary.avgDurationDelta", data.Summary.AvgDurationDelta, -50)

	// 2/(2+1) = 66.666...% => 保留一位小数 66.7
	requireFloatPtr(t, "summary.passRate", data.Summary.PassRate, 66.7)
}

func TestVerifyOverviewTopReasonsSortingAndPercent(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 全部落在最近 24 小时内（days=1 按小时分桶，窗口是滚动的 24 小时）
	now := verifyNowMs()
	seeds := []verifyRecordSeed{
		failAt(now, "bad nonce"),
		failAt(now-1, "bad nonce"),
		failAt(now-2, "bad nonce"),
		failAt(now-3, "honeypot"),
		failAt(now-4, "honeypot"),
		failAt(now-5, "slug mismatch"),
		failAt(now-6, "bad signature"),
		failAt(now-7, "ip mismatch"),
		failAt(now-8, "challenge already used"),
		// 空 reason / NULL reason 都不进榜单，但计入 failed 与占比分母
		{CreatedAt: now - 9, Event: model.VerifyEventFail},
		failAt(now-10, ""),
	}
	seedVerifyRecords(t, seeds...)

	data, _ := fetchVerifyOverview(t, token, "?days=1")

	requireInt64(t, "summary.failed", data.Summary.Failed, 11)
	requireInt64(t, "summary.challenges", data.Summary.Challenges, 0)
	requireInt64(t, "summary.verified", data.Summary.Verified, 0)
	requireFloatPtr(t, "summary.passRate", data.Summary.PassRate, 0)
	requireNilIntPtr(t, "summary.avgDurationMs", data.Summary.AvgDurationMs)

	// 榜单最多 5 项：按计数降序，计数相同按 reason 升序（与 Node/Worker 的 ORDER BY 一致）
	want := []struct {
		reason  string
		count   int64
		percent float64
	}{
		{"bad nonce", 3, 27.3}, // 3/11
		{"honeypot", 2, 18.2},  // 2/11
		{"bad signature", 1, 9.1},
		{"challenge already used", 1, 9.1},
		{"ip mismatch", 1, 9.1},
	}
	if len(data.TopReasons) != len(want) {
		t.Fatalf("topReasons 期望 %d 项，实际 %d 项：%+v", len(want), len(data.TopReasons), data.TopReasons)
	}
	for i, expected := range want {
		label := fmt.Sprintf("topReasons[%d]", i)
		requireString(t, label+".reason", data.TopReasons[i].Reason, expected.reason)
		requireInt64(t, label+".count", data.TopReasons[i].Count, expected.count)
		if math.Abs(data.TopReasons[i].Percent-expected.percent) > 1e-9 {
			t.Errorf("%s.percent 期望 %v，实际 %v", label, expected.percent, data.TopReasons[i].Percent)
		}
	}
}

// TestVerifyOverviewParameterValidation 钉住 days / offset 的默认值、上限与非法回退，
// 以及三种分桶（hour / day / month）的键格式与补零长度。
func TestVerifyOverviewParameterValidation(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	today := time.Now().UTC()

	for _, tc := range []struct {
		name       string
		rawDays    string
		rawOffset  string
		wantDays   int
		wantOffset int
		wantBucket string
		wantLen    int
		keyRE      *regexp.Regexp
	}{
		{"days 缺省为 30", "", "", 30, 0, "day", 30, verifyDayKeyRE},
		{"显式 7 天", "7", "", 7, 0, "day", 7, verifyDayKeyRE},
		{"days=1 按小时分桶", "1", "", 1, 0, "hour", 24, verifyHourKeyRE},
		{"all 按月分桶", "all", "", 0, 0, "month", 12, verifyMonthKeyRE},
		{"ALL 大小写不敏感", "ALL", "", 0, 0, "month", 12, verifyMonthKeyRE},
		{"0 等价 all", "0", "", 0, 0, "month", 12, verifyMonthKeyRE},
		{"365 在上限内", "365", "", 365, 0, "day", 365, verifyDayKeyRE},
		{"超上限夹到 365", "400", "", 365, 0, "day", 365, verifyDayKeyRE},
		{"非数字回退 30", "abc", "", 30, 0, "day", 30, verifyDayKeyRE},
		{"负数回退 30（只有 0/all 是全部）", "-5", "", 30, 0, "day", 30, verifyDayKeyRE},
		{"offset 生效", "7", "3", 7, 3, "day", 7, verifyDayKeyRE},
		{"offset 超上限夹到 120", "7", "999", 7, 120, "day", 7, verifyDayKeyRE},
		{"offset 非数字回退 0", "7", "abc", 7, 0, "day", 7, verifyDayKeyRE},
		{"offset 负数回退 0", "7", "-1", 7, 0, "day", 7, verifyDayKeyRE},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := "?days=" + queryEscape(tc.rawDays) + "&offset=" + queryEscape(tc.rawOffset)
			data, _ := fetchVerifyOverview(t, token, query)

			requireInt64(t, "range.days", int64(data.Range.Days), int64(tc.wantDays))
			requireInt64(t, "range.offset", int64(data.Range.Offset), int64(tc.wantOffset))
			requireString(t, "range.bucket", data.Range.Bucket, tc.wantBucket)

			if len(data.Trend) != tc.wantLen {
				t.Fatalf("trend 长度期望 %d，实际 %d", tc.wantLen, len(data.Trend))
			}
			seen := make(map[string]bool, len(data.Trend))
			for i, point := range data.Trend {
				if !tc.keyRE.MatchString(point.Date) {
					t.Errorf("分桶键 %q 不符合 %s 格式", point.Date, tc.keyRE.String())
				}
				if point.Challenges != 0 || point.Verified != 0 || point.Failed != 0 {
					t.Errorf("空库的分桶必须补零，实际 %+v", point)
				}
				if seen[point.Date] {
					t.Errorf("分桶键重复: %q", point.Date)
				}
				seen[point.Date] = true
				if i > 0 && point.Date <= data.Trend[i-1].Date {
					t.Errorf("分桶必须按时间升序: %q 在 %q 之后", data.Trend[i-1].Date, point.Date)
				}
			}

			// 最后一个分桶键 = 窗口末端所在的桶（offset=0 时即当前小时/天/月）
			last := data.Trend[len(data.Trend)-1].Date
			if tc.wantOffset == 0 {
				var wantLast string
				switch tc.wantBucket {
				case "hour":
					wantLast = today.Format("2006-01-02T15")
				case "month":
					wantLast = today.Format("2006-01")
				default:
					wantLast = today.Format("2006-01-02")
				}
				requireString(t, "最后一个分桶键", last, wantLast)
			}

			// 空库：summary 全 0、passRate 与耗时类指标必须是 null、榜单是空数组
			requireInt64(t, "summary.challenges", data.Summary.Challenges, 0)
			requireInt64(t, "summary.verified", data.Summary.Verified, 0)
			requireInt64(t, "summary.failed", data.Summary.Failed, 0)
			requireNilIntPtr(t, "summary.avgDurationMs", data.Summary.AvgDurationMs)
			requireNilFloatPtr(t, "summary.passRate", data.Summary.PassRate)
			requireNilIntPtr(t, "summary.challengesDelta", data.Summary.ChallengesDelta)
			requireNilIntPtr(t, "summary.avgDurationDelta", data.Summary.AvgDurationDelta)
			if data.TopReasons == nil || len(data.TopReasons) != 0 {
				t.Errorf("空库的 topReasons 必须是空数组，实际 %+v", data.TopReasons)
			}
			if data.TopCountries == nil || data.TopNetworks == nil {
				t.Errorf("topCountries/topNetworks 必须是空数组而不是 null")
			}
			if !verifyISORE.MatchString(data.Range.From) || !verifyISORE.MatchString(data.Range.To) {
				t.Errorf("range.from/to 必须是毫秒 ISO，实际 %q / %q", data.Range.From, data.Range.To)
			}

			// 窗口跨度必须与分桶数一致（日/小时分桶各桶等宽；月分桶长度不等，跳过）
			from, errFrom := time.Parse(verifyISOLayout, data.Range.From)
			to, errTo := time.Parse(verifyISOLayout, data.Range.To)
			if errFrom != nil || errTo != nil {
				t.Fatalf("range.from/to 无法按毫秒 ISO 解析: %v / %v", errFrom, errTo)
			}
			if tc.wantBucket != "month" {
				step := 24 * time.Hour
				if tc.wantBucket == "hour" {
					step = time.Hour
				}
				wantSpan := time.Duration(tc.wantLen)*step - time.Millisecond
				if span := to.Sub(from); span != wantSpan {
					t.Errorf("窗口跨度期望 %v，实际 %v", wantSpan, span)
				}
			}
		})
	}
}

func TestVerifyOverviewOffsetShiftsWindowBackwards(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	seedVerifyRecords(t, challengeAt(verifyNowMs()))

	data0, _ := fetchVerifyOverview(t, token, "?days=7&offset=0")
	requireInt64(t, "offset=0 的 challenges", data0.Summary.Challenges, 1)

	data1, _ := fetchVerifyOverview(t, token, "?days=7&offset=1")
	requireInt64(t, "offset=1 的 challenges", data1.Summary.Challenges, 0)
	// 上一个窗口为空 => 环比与通过率必须是 null
	requireNilIntPtr(t, "offset=1 的 challengesDelta", data1.Summary.ChallengesDelta)
	requireNilFloatPtr(t, "offset=1 的 passRate", data1.Summary.PassRate)

	from0, err0 := time.Parse(verifyISOLayout, data0.Range.From)
	from1, err1 := time.Parse(verifyISOLayout, data1.Range.From)
	if err0 != nil || err1 != nil {
		t.Fatalf("range.from 解析失败: %v / %v", err0, err1)
	}
	if diff := from0.Sub(from1); diff != 7*24*time.Hour {
		t.Errorf("offset=1 应把窗口整体前移 7 天，实际前移 %v", diff)
	}
}

// ---------------------------------------------------------------------------
// GET /admin/verify/records
// ---------------------------------------------------------------------------

func TestVerifyRecordsPaginationAndOrder(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	base := verifyNowMs()
	seeds := make([]verifyRecordSeed, 0, 25)
	for i := 0; i < 25; i++ {
		seeds = append(seeds, challengeAt(base-int64(i)*1000))
	}
	ids := seedVerifyRecords(t, seeds...)

	for _, tc := range []struct {
		name         string
		query        string
		wantLen      int
		wantPage     int
		wantPageSize int
		wantFirstID  int64
	}{
		{"默认分页 page=1 pageSize=20", "", 20, 1, 20, ids[0]},
		{"第二页", "?page=2", 5, 2, 20, ids[20]},
		{"第二页 pageSize=10", "?page=2&pageSize=10", 10, 2, 10, ids[10]},
		{"pageSize 超上限夹到 100", "?pageSize=1000", 25, 1, 100, ids[0]},
		{"pageSize=0 回退 20", "?pageSize=0", 20, 1, 20, ids[0]},
		{"pageSize 负数回退 20", "?pageSize=-1", 20, 1, 20, ids[0]},
		{"pageSize 非数字回退 20", "?pageSize=abc", 20, 1, 20, ids[0]},
		{"page=0 回退 1", "?page=0", 20, 1, 20, ids[0]},
		{"page 负数回退 1", "?page=-1", 20, 1, 20, ids[0]},
		{"越界页返回空", "?page=99", 0, 99, 20, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, _ := fetchVerifyRecords(t, token, tc.query)

			requireInt64(t, "total", data.Total, 25)
			requireInt64(t, "page", int64(data.Page), int64(tc.wantPage))
			requireInt64(t, "pageSize", int64(data.PageSize), int64(tc.wantPageSize))
			if len(data.List) != tc.wantLen {
				t.Fatalf("条数期望 %d，实际 %d", tc.wantLen, len(data.List))
			}
			if tc.wantLen == 0 {
				return
			}
			// 排序口径：created_at DESC, id DESC（最新写入的在最前）。
			// 本用例里 created_at 随 id 递增而递减，所以 id 应递增、createdAt 应递减
			requireInt64(t, "首条 id", data.List[0].ID, tc.wantFirstID)
			for i := 1; i < len(data.List); i++ {
				if data.List[i].ID <= data.List[i-1].ID {
					t.Errorf("应按 created_at 降序：id %d 不应出现在 %d 之后",
						data.List[i].ID, data.List[i-1].ID)
					break
				}
				if data.List[i].CreatedAt >= data.List[i-1].CreatedAt {
					t.Errorf("createdAt 应严格递减: %q 在 %q 之后",
						data.List[i-1].CreatedAt, data.List[i].CreatedAt)
					break
				}
			}
			// createdAt 必须是毫秒 ISO，且与落库的毫秒数逐字节一致
			wantCreatedAt := time.UnixMilli(base - int64((tc.wantPage-1)*tc.wantPageSize)*1000).
				UTC().Format(verifyISOLayout)
			requireString(t, "首条 createdAt", data.List[0].CreatedAt, wantCreatedAt)
			for _, item := range data.List {
				if !verifyISORE.MatchString(item.CreatedAt) {
					t.Errorf("createdAt 必须是毫秒 ISO，实际 %q", item.CreatedAt)
				}
			}
		})
	}
}

// TestVerifyRecordsTieBreakByIDDesc created_at 相同的行必须按 id 降序（后写入的在最前），
// 否则同一毫秒内产生的多条记录在分页时顺序不稳定
func TestVerifyRecordsTieBreakByIDDesc(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	now := verifyNowMs()
	seedVerifyRecords(t,
		challengeAt(now),
		challengeAt(now),
		challengeAt(now),
	)

	data, _ := fetchVerifyRecords(t, token, "")
	if len(data.List) != 3 {
		t.Fatalf("条数期望 3，实际 %d", len(data.List))
	}
	for i, wantID := range []int64{3, 2, 1} {
		requireInt64(t, fmt.Sprintf("第 %d 条 id", i+1), data.List[i].ID, wantID)
	}
}

func TestVerifyRecordsFilters(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	now := verifyNowMs()
	old := verifyDaysAgoMs(40)

	// A: pass / B: fail("bad nonce") / C: challenge / D: 40 天前的 fail("honeypot")
	seedVerifyRecords(t,
		verifyRecordSeed{
			CreatedAt: now, Event: model.VerifyEventPass, ElapsedMs: int64Ptr(120),
			IPAddress: strPtr("203.0.113.7"), PostSlug: strPtr("/posts/a"),
		},
		verifyRecordSeed{
			CreatedAt: now - 1000, Event: model.VerifyEventFail, Reason: strPtr("bad nonce"),
			ChallengeID: strPtr("cid-b"), IPAddress: strPtr("203.0.113.8"), PostSlug: strPtr("/posts/a"),
		},
		verifyRecordSeed{
			CreatedAt: now - 2000, Event: model.VerifyEventChallenge,
			IPAddress: strPtr("198.51.100.9"), PostSlug: strPtr("/posts/b"),
		},
		verifyRecordSeed{
			CreatedAt: old, Event: model.VerifyEventFail, Reason: strPtr("honeypot"),
			IPAddress: strPtr("10.0.0.1"), PostSlug: strPtr("/posts/b"),
		},
	)

	for _, tc := range []struct {
		name  string
		query string
		want  int64
		check func(item model.VerifyRecordItem) bool
	}{
		// days 缺省 30 天：40 天前的旧记录必须被排除
		{"默认 30 天窗口", "", 3, func(model.VerifyRecordItem) bool { return true }},
		{"event=pass", "?event=pass", 1, func(i model.VerifyRecordItem) bool { return i.Event == "pass" }},
		{"event=fail（默认窗口内）", "?event=fail", 1, func(i model.VerifyRecordItem) bool { return i.Event == "fail" }},
		{"event=challenge", "?event=challenge", 1, func(i model.VerifyRecordItem) bool { return i.Event == "challenge" }},
		{"event=all 不过滤", "?event=all", 3, func(model.VerifyRecordItem) bool { return true }},
		{"event 为空不过滤", "?event=", 3, func(model.VerifyRecordItem) bool { return true }},
		{"event 未知取值返回空", "?event=unknown", 0, func(model.VerifyRecordItem) bool { return true }},
		{"reason 精确匹配", "?reason=" + queryEscape("bad nonce"), 1,
			func(i model.VerifyRecordItem) bool { return i.Reason == "bad nonce" }},
		{"reason 不做前缀匹配", "?reason=" + queryEscape("bad"), 0, func(model.VerifyRecordItem) bool { return true }},
		{"slug 精确匹配", "?slug=" + queryEscape("/posts/a"), 2,
			func(i model.VerifyRecordItem) bool { return i.PostSlug == "/posts/a" }},
		{"slug 大小写敏感", "?slug=" + queryEscape("/POSTS/A"), 0, func(model.VerifyRecordItem) bool { return true }},
		{"ip 前缀匹配", "?ip=" + queryEscape("203.0.113."), 2,
			func(i model.VerifyRecordItem) bool { return strings.HasPrefix(i.IPAddress, "203.0.113.") }},
		{"ip 完整匹配", "?ip=" + queryEscape("203.0.113.7"), 1,
			func(i model.VerifyRecordItem) bool { return i.IPAddress == "203.0.113.7" }},
		{"ip 无匹配", "?ip=" + queryEscape("203.0.113.99"), 0, func(model.VerifyRecordItem) bool { return true }},
		// LIKE 元字符必须被转义，否则管理员输入的 % / _ 会变成通配符
		{"ip 的 % 被转义", "?ip=" + queryEscape("%"), 0, func(model.VerifyRecordItem) bool { return true }},
		{"ip 的 _ 被转义", "?ip=" + queryEscape("203_0"), 0, func(model.VerifyRecordItem) bool { return true }},
		{"ip 前缀里的 % 也被转义", "?ip=" + queryEscape("203.0.113.%"), 0, func(model.VerifyRecordItem) bool { return true }},
		{"days=all 包含 40 天前的记录", "?days=all", 4, func(model.VerifyRecordItem) bool { return true }},
		{"days=0 等价 all", "?days=0", 4, func(model.VerifyRecordItem) bool { return true }},
		{"days=1 只保留最近 24 小时", "?days=1", 3, func(model.VerifyRecordItem) bool { return true }},
		{"days 非法回退 30", "?days=abc", 3, func(model.VerifyRecordItem) bool { return true }},
		{"days 负数回退 30", "?days=-3", 3, func(model.VerifyRecordItem) bool { return true }},
		{"组合筛选 event+days", "?event=fail&days=all", 2,
			func(i model.VerifyRecordItem) bool { return i.Event == "fail" }},
		{"组合筛选 ip+slug+event",
			"?ip=" + queryEscape("203.0.113.") + "&slug=" + queryEscape("/posts/a") + "&event=fail", 1,
			func(i model.VerifyRecordItem) bool {
				return i.Event == "fail" && i.PostSlug == "/posts/a" && strings.HasPrefix(i.IPAddress, "203.0.113.")
			}},
		{"无匹配返回空", "?reason=" + queryEscape("nope"), 0, func(model.VerifyRecordItem) bool { return true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, w := fetchVerifyRecords(t, token, tc.query)

			requireInt64(t, "total", data.Total, tc.want)
			if int64(len(data.List)) != tc.want {
				t.Errorf("条数期望 %d，实际 %d", tc.want, len(data.List))
			}
			for _, item := range data.List {
				if !tc.check(item) {
					t.Errorf("结果不满足筛选条件: %+v", item)
				}
			}
			if tc.want == 0 {
				// 空结果必须是 [] 而不是 null
				requireBodyContains(t, w, `"list":[]`)
				requireBodyContains(t, w, `"total":0`)
			}
		})
	}
}

func TestVerifyRecordsFieldMappingAndNulls(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	now := verifyNowMs()
	seedVerifyRecords(t,
		// 最新的在最前：一条所有可空字段都为 NULL 的记录
		verifyRecordSeed{CreatedAt: now, Event: model.VerifyEventChallenge},
		// 一条字段齐全的记录
		verifyRecordSeed{
			CreatedAt:   now - 1000,
			Event:       model.VerifyEventPass,
			Reason:      strPtr("unused"),
			ElapsedMs:   int64Ptr(1234),
			Difficulty:  int64Ptr(1000000),
			ChallengeID: strPtr("cid-full"),
			PostSlug:    strPtr("/posts/full"),
			IPAddress:   strPtr("1.2.3.4"),
			Country:     strPtr("US"),
			Network:     strPtr("Cloudflare"),
			ASN:         int64Ptr(64512),
		},
	)

	data, w := fetchVerifyRecords(t, token, "")

	if len(data.List) != 2 {
		t.Fatalf("条数期望 2，实际 %d", len(data.List))
	}

	// 第一行：所有可空字段都必须是 null / 空串（三端一致的「空值」表示）
	minimal := data.List[0]
	requireString(t, "minimal.event", minimal.Event, model.VerifyEventChallenge)
	requireNilIntPtr(t, "minimal.elapsedMs", minimal.ElapsedMs)
	requireNilIntPtr(t, "minimal.difficulty", minimal.Difficulty)
	requireNilIntPtr(t, "minimal.asn", minimal.ASN)
	requireString(t, "minimal.reason", minimal.Reason, "")
	requireString(t, "minimal.challengeId", minimal.ChallengeID, "")
	requireString(t, "minimal.postSlug", minimal.PostSlug, "")
	requireString(t, "minimal.ipAddress", minimal.IPAddress, "")
	requireString(t, "minimal.country", minimal.Country, "")
	requireString(t, "minimal.network", minimal.Network, "")
	requireBodyContains(t, w, `"elapsedMs":null`)
	requireBodyContains(t, w, `"difficulty":null`)
	requireBodyContains(t, w, `"asn":null`)

	// 第二行：字段逐项映射，createdAt 与落库毫秒数逐字节一致
	full := data.List[1]
	requireString(t, "full.createdAt", full.CreatedAt, time.UnixMilli(now-1000).UTC().Format(verifyISOLayout))
	requireString(t, "full.event", full.Event, model.VerifyEventPass)
	requireString(t, "full.reason", full.Reason, "unused")
	requireString(t, "full.challengeId", full.ChallengeID, "cid-full")
	requireString(t, "full.postSlug", full.PostSlug, "/posts/full")
	requireString(t, "full.ipAddress", full.IPAddress, "1.2.3.4")
	requireString(t, "full.country", full.Country, "US")
	requireString(t, "full.network", full.Network, "Cloudflare")
	requireIntPtr(t, "full.elapsedMs", full.ElapsedMs, 1234)
	requireIntPtr(t, "full.difficulty", full.Difficulty, 1000000)
	requireIntPtr(t, "full.asn", full.ASN, 64512)
	requireBodyContains(t, w, `"elapsedMs":1234`)
	requireBodyContains(t, w, `"asn":64512`)
}

func TestVerifyRecordsEmptyResult(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	data, w := fetchVerifyRecords(t, token, "")

	requireInt64(t, "total", data.Total, 0)
	requireInt64(t, "page", int64(data.Page), 1)
	requireInt64(t, "pageSize", int64(data.PageSize), 20)
	if data.List == nil || len(data.List) != 0 {
		t.Errorf("空结果必须是 [] 而不是 null，实际 %+v", data.List)
	}
	requireBodyContains(t, w, `"list":[]`)
	requireBodyContains(t, w, `"total":0`)
	requireBodyContains(t, w, `"page":1`)
	requireBodyContains(t, w, `"pageSize":20`)
}

// ---------------------------------------------------------------------------
// 写入时机
// ---------------------------------------------------------------------------

// TestVerifyRecordsNotWrittenWhenDisabled 未开启验证时不得写任何记录
func TestVerifyRecordsNotWrittenWhenDisabled(t *testing.T) {
	resetState(t)
	setSetting(t, "comment_verify_enabled", "false")

	requireStatus(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), 200)
	requireStatus(t, callJSON(t, "POST", "/api/verify/solution",
		`{"post_slug":"/p","prefix":"x","sig":"y","nonces":["1"],"elapsed_ms":500}`), 200)

	if n := countVerifyRecords(t); n != 0 {
		t.Errorf("未开启验证时不应写入认证记录，实际 %d 条", n)
	}
}

// TestVerifyRecordsChallengeLogToggle comment_verify_log_challenge=false 时只跳过
// 签发事件，通过/失败仍要落库（否则后台会看不到真实结果）
func TestVerifyRecordsChallengeLogToggle(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")
	setSetting(t, "comment_verify_log_challenge", "false")

	requireStatus(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), 200)

	// 用一份必然失败的答案触发 fail 事件
	failResp := callJSON(t, "POST", "/api/verify/solution",
		`{"post_slug":"/p","prefix":"!!!","sig":"sig","nonces":["1","1","1","1"],"elapsed_ms":500}`)
	requireStatus(t, failResp, 403)
	var failPayload verifySolutionPayload
	decodeInto(t, failResp, &failPayload)

	rows := listVerifyRows(t)
	if len(rows) != 1 {
		t.Fatalf("关闭签发事件后应只有 1 条记录（fail），实际 %d 条: %+v", len(rows), rows)
	}
	if rows[0].Event != model.VerifyEventFail {
		t.Errorf("唯一的记录应是 fail，实际 %q", rows[0].Event)
	}
	if !rows[0].Reason.Valid || rows[0].Reason.String != failPayload.Reason {
		t.Errorf("reason 期望 %q，实际 %q", failPayload.Reason, rows[0].Reason.String)
	}

	// 打开开关后，签发事件必须重新落库
	setSetting(t, "comment_verify_log_challenge", "true")
	requireStatus(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), 200)
	rows = listVerifyRows(t)
	if len(rows) != 2 {
		t.Fatalf("打开开关后应有 2 条记录，实际 %d 条", len(rows))
	}
	if last := rows[len(rows)-1]; last.Event != model.VerifyEventChallenge {
		t.Errorf("最后一条应是 challenge，实际 %q", last.Event)
	}
}

// TestVerifyRecordWriteFailureDoesNotAffectVerification 埋点写入是**尽力而为**的：
// VerifyRecord 写不进去（这里把表临时改名）也不能影响验证结果本身。
func TestVerifyRecordWriteFailureDoesNotAffectVerification(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	// 让写入必然失败；用例结束时（t.Cleanup 后注册先执行）立刻把表名恢复
	if _, err := testDB.Exec("ALTER TABLE VerifyRecord RENAME TO VerifyRecordBroken"); err != nil {
		t.Fatalf("重命名 VerifyRecord 失败: %v", err)
	}
	restored := false
	t.Cleanup(func() {
		if restored {
			return
		}
		if _, err := testDB.Exec("ALTER TABLE VerifyRecordBroken RENAME TO VerifyRecord"); err != nil {
			t.Fatalf("恢复 VerifyRecord 表失败: %v", err)
		}
	})

	ip := nextIP()
	addr := ip + ":1234"
	const slug = "/posts/broken"

	// 签发挑战仍必须成功
	challenge := requestChallenge(t, slug, addr)
	if challenge.Data.ChallengeID == "" || challenge.Data.Sig == "" {
		t.Fatalf("写入失败时挑战仍应完整签发: %+v", challenge.Data)
	}

	// 答案校验仍必须通过并签发票据
	w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
		Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
	}), addr)
	requireStatus(t, w, 200)

	var solution verifySolutionPayload
	decodeInto(t, w, &solution)
	if solution.Data.Ticket == "" {
		t.Errorf("写入失败时仍应签发票据，实际 %+v", solution.Data)
	}

	// 表恢复后，落库功能必须照常工作
	if _, err := testDB.Exec("ALTER TABLE VerifyRecordBroken RENAME TO VerifyRecord"); err != nil {
		t.Fatalf("恢复 VerifyRecord 表失败: %v", err)
	}
	restored = true
	requireStatus(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), 200)
	if n := countVerifyRecords(t); n != 1 {
		t.Errorf("恢复后应能正常写入认证记录，实际 %d 条", n)
	}
}

// TestPruneVerifyRecordsRespectsRetentionSetting 保留天数必须来自
// comment_verify_retention_days：0（或负数）表示永久保留，非法值退回默认 30 天。
func TestPruneVerifyRecordsRespectsRetentionSetting(t *testing.T) {
	resetState(t)
	ctx := t.Context()

	setRetention := func(value string) {
		t.Helper()
		if _, err := testDB.Exec(`INSERT INTO Settings (key, value) VALUES ('comment_verify_retention_days', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, value); err != nil {
			t.Fatalf("写入保留天数失败: %v", err)
		}
	}

	now := verifyNowMs()
	day := int64(24 * 60 * 60 * 1000)
	seed := func() {
		t.Helper()
		seedVerifyRecords(t,
			challengeAt(now),
			challengeAt(now-10*day),
			challengeAt(now-40*day),
		)
	}

	for _, tc := range []struct {
		name        string
		setting     string
		wantRemoved int64
		wantLeft    int
	}{
		{"缺省保留 30 天", "", 1, 2},
		{"显式保留 7 天", "7", 2, 1},
		{"0 表示永久保留", "0", 0, 3},
		{"负数也按永久保留", "-5", 0, 3},
		{"非法值退回 30 天", "abc", 1, 2},
		{"超上限夹到 3650 天", "99999", 0, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := testDB.Exec("DELETE FROM VerifyRecord"); err != nil {
				t.Fatalf("清空认证记录失败: %v", err)
			}
			setRetention(tc.setting)
			seed()

			removed, err := testRepo.PruneVerifyRecords(ctx)
			if err != nil {
				t.Fatalf("PruneVerifyRecords 失败: %v", err)
			}
			requireInt64(t, "removed", removed, tc.wantRemoved)
			if left := countVerifyRecords(t); left != tc.wantLeft {
				t.Errorf("剩余条数期望 %d，实际 %d", tc.wantLeft, left)
			}
		})
	}
}

// TestVerifyQueryParamsFollowJSParseInt 钉住参数解析的容错口径。
//
// 三端都用 JS `parseInt(raw, 10)` 语义（取数字前缀、忽略尾随垃圾）：
// 若这里换成 strconv.Atoi，`days=7abc` 会在 Go 上回退 30、在 Node/Worker 上变成 7，
// 同一个后台在不同后端下会显示不同的窗口 —— 这类漂移肉眼很难发现，因此用测试锁死。
func TestVerifyQueryParamsFollowJSParseInt(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
	}{
		{"", 30},
		{"abc", 30},
		{"-5", 30},
		{"7", 7},
		{"7abc", 7},
		{"1.5", 1},
		{"0x10", 0}, // radix=10：读到 "0" 就停在 'x'
		{"+7", 7},
		{" 12 ", 12},
		{"365", 365},
		{"999", 365}, // 上限截断
	} {
		if got := parseVerifyDays(tc.raw); got != tc.want {
			t.Errorf("parseVerifyDays(%q) 期望 %d，实际 %d", tc.raw, tc.want, got)
		}
	}
	// all 大小写不敏感
	if got := parseVerifyDays("ALL"); got != 0 {
		t.Errorf("parseVerifyDays(\"ALL\") 期望 0，实际 %d", got)
	}

	for _, tc := range []struct {
		raw      string
		min      int
		max      int
		fallback int
		want     int
	}{
		{"3", 1, 100, 20, 3},
		{"3x", 1, 100, 20, 3},
		{"1.5", 1, 100, 20, 1},
		{"0", 1, 100, 20, 20},   // 小于 min 回退默认值
		{"-1", 1, 100, 20, 20},  // 负数回退默认值
		{"abc", 1, 100, 20, 20}, // 完全非法回退默认值
		{"", 1, 100, 20, 20},
		{"1000", 1, 100, 20, 100}, // 上限截断
		{"-1", 0, 120, 0, 0},      // offset：min=0 时负数回退 fallback=0
		{"5x", 0, 120, 0, 5},
	} {
		if got := parseVerifyInt(tc.raw, tc.min, tc.max, tc.fallback); got != tc.want {
			t.Errorf("parseVerifyInt(%q) 期望 %d，实际 %d", tc.raw, tc.want, got)
		}
	}
}
