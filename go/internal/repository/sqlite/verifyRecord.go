package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"momo-backend-go/internal/model"
)

/**
 * 评论无感验证（人机验证）的认证记录 —— SQLite 实现。
 *
 * 与 Node（nodejs/src/orm/verifyRecordService.ts）/ Worker（worker/src/utils/verifyRecord.ts）
 * 的表结构、写入时机与统计口径完全一致，详见 doc/data_table.md 与 doc/api.md。
 *
 * 设计要点：
 *  - 写入是**尽力而为**：任何异常都只记日志，绝不影响验证结果本身；
 *  - 统计在 SQL 里聚合，窗口按 UTC 对齐（strftime(..., 'unixepoch') 即 UTC），避免时区偏移；
 *  - 过期清理是惰性的（每小时最多一次），由写入路径触发，启动时另清一次（见 main.go）。
 */

const (
	verifyRetentionSetting    = "comment_verify_retention_days"
	verifyLogChallengeSetting = "comment_verify_log_challenge"

	defaultVerifyRetentionDays = 30
	maxVerifyRetentionDays     = 3650
	maxVerifyOverviewDays      = 365
	maxVerifyOffset            = 120
	defaultVerifyPageSize      = 20
	maxVerifyPageSize          = 100
	verifyTopLimit             = 5
	verifyMonthCount           = 12
	verifyPruneInterval        = time.Hour
	verifyHourMS               = int64(60 * 60 * 1000)
	verifyDayMS                = 24 * verifyHourMS
)

var (
	verifyPruneMu       sync.Mutex
	verifyLastPruneTime time.Time
)

// verifyWindow 统计/查询时间窗口（毫秒整数，[Start, End) 左闭右开）
type verifyWindow struct {
	Start  int64
	End    int64
	Bucket string
	Keys   []string
}

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

type verifyTrendRow struct {
	Bucket     string `db:"bucket"`
	Challenges int64  `db:"challenges"`
	Verified   int64  `db:"verified"`
	Failed     int64  `db:"failed"`
}

type verifyReasonRow struct {
	Reason string `db:"reason"`
	Count  int64  `db:"count"`
}

// ---------------------------------------------------------------------------
// 设置项
// ---------------------------------------------------------------------------

// settingValue 直接读 Settings 表。
//
// 这里刻意**不**复用 internal/pkg/utils 的 GetSetting：utils 包自己的测试会
// import 本包来建临时库，反向依赖会形成 import cycle。仓库层的职责就是读写数据库，
// 直接查表反而更贴合分层。
func (r *commentRepo) settingValue(ctx context.Context, key string) string {
	var value string
	if err := r.db.GetContext(ctx, &value, `SELECT value FROM Settings WHERE key = ?`, key); err != nil {
		return ""
	}
	return value
}

// verifyRetentionDays 保留天数：0 = 永久保留；非法值退回默认值；上限 3650 天
func (r *commentRepo) verifyRetentionDays(ctx context.Context) int {
	raw := strings.TrimSpace(r.settingValue(ctx, verifyRetentionSetting))
	if raw == "" {
		return defaultVerifyRetentionDays
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return defaultVerifyRetentionDays
	}
	if parsed <= 0 {
		return 0
	}
	if parsed > maxVerifyRetentionDays {
		return maxVerifyRetentionDays
	}
	return parsed
}

// verifyLogChallengeEnabled 是否记录「签发挑战」事件，默认开启。
//
// 关闭后只记录通过/失败，能显著降低写入量（签发事件在评论框加载时就会产生，
// 是行数的主要来源），代价是看不到「签发了但没人提交答案」的流失情况。
func (r *commentRepo) verifyLogChallengeEnabled(ctx context.Context) bool {
	return r.settingValue(ctx, verifyLogChallengeSetting) != "false"
}

// ---------------------------------------------------------------------------
// 写入与清理
// ---------------------------------------------------------------------------

// nullIfEmpty 空字符串按 NULL 写入，与 Node / Worker 的 ?? null 口径一致
func nullIfEmpty(value string) interface{} {
	if value == "" {
		return nil
	}
	return value
}

// RecordVerifyEvent 写入一条认证记录。永不返回错误：失败只记日志。
func (r *commentRepo) RecordVerifyEvent(ctx context.Context, in model.VerifyRecordInput) {
	if in.Event == model.VerifyEventChallenge && !r.verifyLogChallengeEnabled(ctx) {
		return
	}

	_, err := r.db.ExecContext(ctx,
		`INSERT INTO VerifyRecord
			(created_at, event, reason, elapsed_ms, difficulty, challenge_id, post_slug, ip_address, country, network, asn)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(),
		in.Event,
		nullIfEmpty(in.Reason),
		in.ElapsedMs,
		in.Difficulty,
		nullIfEmpty(in.ChallengeID),
		nullIfEmpty(in.PostSlug),
		nullIfEmpty(in.IP),
		nullIfEmpty(in.Country),
		nullIfEmpty(in.Network),
		in.ASN,
	)
	if err != nil {
		log.Printf("[WARN] 写入认证记录失败（不影响验证结果）: %v", err)
		return
	}

	r.maybePruneVerifyRecords(ctx)
}

// maybePruneVerifyRecords 每小时最多触发一次清理，避免每个请求都去删一遍
func (r *commentRepo) maybePruneVerifyRecords(ctx context.Context) {
	verifyPruneMu.Lock()
	if time.Since(verifyLastPruneTime) < verifyPruneInterval {
		verifyPruneMu.Unlock()
		return
	}
	verifyLastPruneTime = time.Now()
	verifyPruneMu.Unlock()

	if _, err := r.PruneVerifyRecords(ctx); err != nil {
		log.Printf("[WARN] 清理认证记录失败: %v", err)
	}
}

// PruneVerifyRecords 删除超出保留期的认证记录（保留天数为 0 时直接返回）
func (r *commentRepo) PruneVerifyRecords(ctx context.Context) (int64, error) {
	days := r.verifyRetentionDays(ctx)
	if days <= 0 {
		return 0, nil
	}

	// 与 Node / Worker 一致：按整天毫秒数回退，不使用 AddDate（避免夏令时差异）
	cutoff := time.Now().UnixMilli() - int64(days)*verifyDayMS
	result, err := r.db.ExecContext(ctx, `DELETE FROM VerifyRecord WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}

	removed, _ := result.RowsAffected()
	if removed > 0 {
		log.Printf("[verify-record] 已清理 %d 条认证记录（保留 %d 天）", removed, days)
	}
	return removed, nil
}

// ---------------------------------------------------------------------------
// 时间窗口
// ---------------------------------------------------------------------------

func startOfUTCHour(ms int64) int64 {
	t := time.UnixMilli(ms).UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, time.UTC).UnixMilli()
}

func startOfUTCDay(ms int64) int64 {
	t := time.UnixMilli(ms).UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
}

func startOfUTCMonth(ms int64) int64 {
	t := time.UnixMilli(ms).UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
}

func addMonths(ms int64, months int) int64 {
	t := time.UnixMilli(ms).UTC()
	return time.Date(t.Year(), t.Month()+time.Month(months), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// bucketKey 分桶键：与 SQL 里的 strftime 表达式逐字符对应
func bucketKey(bucket string, ms int64) string {
	t := time.UnixMilli(ms).UTC()
	ymd := fmt.Sprintf("%04d-%02d-%02d", t.Year(), int(t.Month()), t.Day())
	switch bucket {
	case "month":
		return fmt.Sprintf("%04d-%02d", t.Year(), int(t.Month()))
	case "hour":
		return fmt.Sprintf("%sT%02d", ymd, t.Hour())
	default:
		return ymd
	}
}

// bucketExpr 分桶的 SQL 表达式（毫秒整数 → UTC 字符串键）
func bucketExpr(bucket string) string {
	format := "%Y-%m-%d"
	switch bucket {
	case "month":
		format = "%Y-%m"
	case "hour":
		format = "%Y-%m-%dT%H"
	}
	return fmt.Sprintf("strftime('%s', created_at / 1000, 'unixepoch')", format)
}

// resolveVerifyWindow 解析统计窗口。
//
// days = 0 表示「全部」（最近 12 个月，按月分桶）；days = 1 按小时分桶；其余按天。
// offset 表示窗口向前平移的**整窗个数**（对齐界面上的左右箭头），0 = 当前窗口。
func resolveVerifyWindow(days, offset int, now int64) verifyWindow {
	shift := offset
	if shift < 0 {
		shift = 0
	}

	var start, end int64
	var bucket string

	switch {
	case days <= 0:
		bucket = "month"
		end = addMonths(startOfUTCMonth(now), 1-shift)
		start = addMonths(end, -verifyMonthCount)
	case days <= 1:
		bucket = "hour"
		end = startOfUTCHour(now) + verifyHourMS - int64(shift)*24*verifyHourMS
		start = end - 24*verifyHourMS
	default:
		bucket = "day"
		end = startOfUTCDay(now) + verifyDayMS - int64(shift)*int64(days)*verifyDayMS
		start = end - int64(days)*verifyDayMS
	}

	keys := make([]string, 0, verifyMonthCount)
	if bucket == "month" {
		for i := 0; i < verifyMonthCount; i++ {
			keys = append(keys, bucketKey(bucket, addMonths(start, i)))
		}
	} else {
		step := verifyDayMS
		if bucket == "hour" {
			step = verifyHourMS
		}
		for t := start; t < end; t += step {
			keys = append(keys, bucketKey(bucket, t))
		}
	}

	return verifyWindow{Start: start, End: end, Bucket: bucket, Keys: keys}
}

// clampVerifyInt 把 value 夹在 [min, max]；小于 min 的取值（0、负数）回退默认值，
// 与 Node / Worker 的 clamp 行为一致。
func clampVerifyInt(value, min, max, fallback int) int {
	if value < min {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}

// isoMillis 把毫秒整数格式化为与 JS toISOString() 完全一致的 UTC 字符串
// （三端响应逐字节可比，因此不能用 time.RFC3339Nano 之类会变长的布局）
func isoMillis(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
		t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond()/int(time.Millisecond))
}

// escapeLike 转义 LIKE 通配符，避免管理员输入的 % / _ 被当成模式
func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

const verifySummarySQL = `
	SELECT
		COALESCE(SUM(CASE WHEN event = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
		COALESCE(SUM(CASE WHEN event = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
		COALESCE(SUM(CASE WHEN event = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
		AVG(CASE WHEN event = 'pass' THEN elapsed_ms END) AS avg_duration
	FROM VerifyRecord
	WHERE created_at >= ? AND created_at < ?`

// verifySummary 统计窗口内的三类事件数与平均解题耗时
func (r *commentRepo) verifySummary(ctx context.Context, start, end int64) (model.VerifyOverviewSummary, error) {
	var challenges, verified, failed int64
	var avg sql.NullFloat64

	err := r.db.QueryRowxContext(ctx, verifySummarySQL, start, end).
		Scan(&challenges, &verified, &failed, &avg)
	if err != nil {
		return model.VerifyOverviewSummary{}, err
	}

	summary := model.VerifyOverviewSummary{
		Challenges: challenges,
		Verified:   verified,
		Failed:     failed,
	}
	if avg.Valid {
		value := int64(math.Round(avg.Float64))
		summary.AvgDurationMs = &value
	}
	return summary, nil
}

// deltaPct 环比：与上一个等长窗口比较的百分比整数；上一窗口为空时返回 nil
// （而不是 0/100%）—— 没有任何对照数据时不该画出一个假的涨跌。
func deltaPct(current, previous int64) *int64 {
	if previous == 0 {
		return nil
	}
	value := int64(math.Round(float64(current-previous) / float64(previous) * 100))
	return &value
}

func deltaPctNullable(current, previous *int64) *int64 {
	if current == nil || previous == nil || *previous == 0 {
		return nil
	}
	value := int64(math.Round(float64(*current-*previous) / float64(*previous) * 100))
	return &value
}

// GetVerifyOverview 认证记录统计概览
func (r *commentRepo) GetVerifyOverview(ctx context.Context, days, offset int) (*model.VerifyOverview, error) {
	now := time.Now().UnixMilli()
	safeDays := clampVerifyInt(days, 0, maxVerifyOverviewDays, 30)
	safeOffset := clampVerifyInt(offset, 0, maxVerifyOffset, 0)
	win := resolveVerifyWindow(safeDays, safeOffset, now)

	summary, err := r.verifySummary(ctx, win.Start, win.End)
	if err != nil {
		return nil, err
	}
	// 上一个等长窗口，用于卡片上的环比
	span := win.End - win.Start
	prev, err := r.verifySummary(ctx, win.Start-span, win.Start)
	if err != nil {
		return nil, err
	}

	// 趋势：SQL 只返回有数据的分桶，其余在 Go 里补零
	trendRows := []verifyTrendRow{}
	trendSQL := fmt.Sprintf(`
		SELECT
			%s AS bucket,
			COALESCE(SUM(CASE WHEN event = 'challenge' THEN 1 ELSE 0 END), 0) AS challenges,
			COALESCE(SUM(CASE WHEN event = 'pass' THEN 1 ELSE 0 END), 0) AS verified,
			COALESCE(SUM(CASE WHEN event = 'fail' THEN 1 ELSE 0 END), 0) AS failed
		FROM VerifyRecord
		WHERE created_at >= ? AND created_at < ?
		GROUP BY bucket
		ORDER BY bucket ASC`, bucketExpr(win.Bucket))
	if err := r.db.SelectContext(ctx, &trendRows, trendSQL, win.Start, win.End); err != nil {
		return nil, err
	}

	trendByKey := make(map[string]model.VerifyTrendPoint, len(trendRows))
	for _, row := range trendRows {
		trendByKey[row.Bucket] = model.VerifyTrendPoint{
			Date:       row.Bucket,
			Challenges: row.Challenges,
			Verified:   row.Verified,
			Failed:     row.Failed,
		}
	}
	trend := make([]model.VerifyTrendPoint, 0, len(win.Keys))
	for _, key := range win.Keys {
		point, ok := trendByKey[key]
		if !ok {
			point = model.VerifyTrendPoint{Date: key}
		}
		trend = append(trend, point)
	}

	total := summary.Challenges + summary.Verified + summary.Failed
	share := func(count int64) float64 {
		if total == 0 {
			return 0
		}
		return math.Round(float64(count)/float64(total)*1000) / 10
	}

	reasonRows := []verifyReasonRow{}
	reasonSQL := fmt.Sprintf(`
		SELECT reason, COUNT(*) AS count
		FROM VerifyRecord
		WHERE created_at >= ? AND created_at < ?
			AND event = 'fail' AND reason IS NOT NULL AND reason <> ''
		GROUP BY reason
		ORDER BY count DESC, reason ASC
		LIMIT %d`, verifyTopLimit)
	if err := r.db.SelectContext(ctx, &reasonRows, reasonSQL, win.Start, win.End); err != nil {
		return nil, err
	}

	topReasons := make([]model.VerifyTopReason, 0, len(reasonRows))
	for _, row := range reasonRows {
		topReasons = append(topReasons, model.VerifyTopReason{
			Reason:  row.Reason,
			Count:   row.Count,
			Percent: share(row.Count),
		})
	}

	summary.ChallengesDelta = deltaPct(summary.Challenges, prev.Challenges)
	summary.VerifiedDelta = deltaPct(summary.Verified, prev.Verified)
	summary.FailedDelta = deltaPct(summary.Failed, prev.Failed)
	summary.AvgDurationDelta = deltaPctNullable(summary.AvgDurationMs, prev.AvgDurationMs)
	// 通过率只以「已出结果的认证」为分母：签发了但没提交答案不应拉低通过率
	if summary.Verified+summary.Failed > 0 {
		rate := math.Round(float64(summary.Verified)/float64(summary.Verified+summary.Failed)*1000) / 10
		summary.PassRate = &rate
	}

	return &model.VerifyOverview{
		Range: model.VerifyOverviewRange{
			Days:   safeDays,
			Offset: safeOffset,
			From:   isoMillis(win.Start),
			To:     isoMillis(win.End - 1),
			Bucket: win.Bucket,
		},
		Summary: summary,
		Trend:   trend,
		// Go 部署没有 IP 归属地/ASN 数据源，前端据此隐藏这两块榜单
		GeoSupported: false,
		TopCountries: []model.VerifyTopCountry{},
		TopNetworks:  []model.VerifyTopNetwork{},
		TopReasons:   topReasons,
	}, nil
}

// ListVerifyRecords 认证明细列表
func (r *commentRepo) ListVerifyRecords(ctx context.Context, q model.VerifyRecordQuery) (*model.VerifyRecordList, error) {
	conditions := make([]string, 0, 6)
	args := make([]interface{}, 0, 8)

	if q.Days > 0 {
		win := resolveVerifyWindow(q.Days, 0, time.Now().UnixMilli())
		conditions = append(conditions, "created_at >= ? AND created_at < ?")
		args = append(args, win.Start, win.End)
	}
	if q.Event != "" && q.Event != "all" {
		conditions = append(conditions, "event = ?")
		args = append(args, q.Event)
	}
	if q.Reason != "" {
		conditions = append(conditions, "reason = ?")
		args = append(args, q.Reason)
	}
	if q.Slug != "" {
		conditions = append(conditions, "post_slug = ?")
		args = append(args, q.Slug)
	}
	// IP 用前缀匹配便于按网段排查
	if q.IP != "" {
		conditions = append(conditions, `ip_address LIKE ? ESCAPE '\'`)
		args = append(args, escapeLike(q.IP)+"%")
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	var total int64
	if err := r.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM VerifyRecord "+where, args...); err != nil {
		return nil, err
	}

	pageArgs := make([]interface{}, 0, len(args)+2)
	pageArgs = append(pageArgs, args...)
	pageArgs = append(pageArgs, q.PageSize, (q.Page-1)*q.PageSize)

	rows := []verifyRecordRow{}
	selectSQL := "SELECT * FROM VerifyRecord " + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
	if err := r.db.SelectContext(ctx, &rows, selectSQL, pageArgs...); err != nil {
		return nil, err
	}

	list := make([]model.VerifyRecordItem, 0, len(rows))
	for _, row := range rows {
		item := model.VerifyRecordItem{
			ID:          row.ID,
			CreatedAt:   isoMillis(row.CreatedAt),
			Event:       row.Event,
			Reason:      row.Reason.String,
			ChallengeID: row.ChallengeID.String,
			PostSlug:    row.PostSlug.String,
			IPAddress:   row.IPAddress.String,
			Country:     row.Country.String,
			Network:     row.Network.String,
		}
		if row.ElapsedMs.Valid {
			value := row.ElapsedMs.Int64
			item.ElapsedMs = &value
		}
		if row.Difficulty.Valid {
			value := row.Difficulty.Int64
			item.Difficulty = &value
		}
		if row.ASN.Valid {
			value := row.ASN.Int64
			item.ASN = &value
		}
		list = append(list, item)
	}

	return &model.VerifyRecordList{
		List:     list,
		Total:    total,
		Page:     q.Page,
		PageSize: q.PageSize,
	}, nil
}
