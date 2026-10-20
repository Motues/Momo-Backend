package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"momo-backend-go/internal/repository"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite" // 注册驱动
)

type commentRepo struct {
	db *sqlx.DB
}

func NewCommentRepository(db *sqlx.DB) repository.CommentRepository {
	return &commentRepo{db: db}
}

// InitSchema 初始化数据库表结构
func InitSchema(db *sqlx.DB) error {
	// 启用外键约束
	if _, err := db.Exec("PRAGMA foreign_keys = ON;"); err != nil {
		return err
	}

	schema := `
	CREATE TABLE IF NOT EXISTS Comment (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pub_date INTEGER DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
		post_slug TEXT NOT NULL,
		author TEXT NOT NULL,
		email TEXT NOT NULL,
		url TEXT,
		ip_address TEXT,
		device TEXT,
		os TEXT,
		browser TEXT,
		user_agent TEXT,
		content_text TEXT NOT NULL,
		content_html TEXT NOT NULL,
		parent_id INTEGER,
		-- 默认值与 Node/Worker 一致（C11）：绕过应用层的写入落在最安全的 pending
		status TEXT DEFAULT 'pending',
		FOREIGN KEY (parent_id) REFERENCES Comment (id) ON DELETE SET NULL
	);
	CREATE INDEX IF NOT EXISTS idx_post_slug ON Comment(post_slug);
	CREATE INDEX IF NOT EXISTS idx_status ON Comment(status);`

	// Settings table for web-based configuration
	settingSchema := `
	CREATE TABLE IF NOT EXISTS Settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`
	if _, err := db.Exec(settingSchema); err != nil {
		return err
	}

	// EmailVerification table
	verificationSchema := `
	CREATE TABLE IF NOT EXISTS EmailVerification (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		token TEXT NOT NULL UNIQUE,
		expires_at TEXT NOT NULL,
		verified INTEGER NOT NULL DEFAULT 0,
		post_slug TEXT,
		post_title TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		verified_at TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_ev_email ON EmailVerification(email);
	CREATE INDEX IF NOT EXISTS idx_ev_token ON EmailVerification(token);`
	if _, err := db.Exec(verificationSchema); err != nil {
		return err
	}

	// VerifyRecord table：评论无感验证（人机验证）的认证记录，见 doc/data_table.md
	// 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库无需手工迁移
	verifyRecordSchema := `
	CREATE TABLE IF NOT EXISTS VerifyRecord (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at INTEGER NOT NULL,
		event TEXT NOT NULL,
		reason TEXT,
		elapsed_ms INTEGER,
		difficulty INTEGER,
		challenge_id TEXT,
		post_slug TEXT,
		ip_address TEXT,
		origin TEXT,
		country TEXT,
		network TEXT,
		asn INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_vr_created ON VerifyRecord(created_at);
	CREATE INDEX IF NOT EXISTS idx_vr_event ON VerifyRecord(event);
	CREATE INDEX IF NOT EXISTS idx_vr_cid ON VerifyRecord(challenge_id);`
	if _, err := db.Exec(verifyRecordSchema); err != nil {
		return err
	}

	// LinkSyncRequest table：历史链接批量更新的待确认记录（见 doc/link_security.md 第 3.3 节）
	// 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库由 0003 迁移补表
	linkSyncSchema := `
	CREATE TABLE IF NOT EXISTS LinkSyncRequest (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		new_url TEXT NOT NULL,
		token TEXT NOT NULL UNIQUE,
		expires_at TEXT NOT NULL,
		confirmed INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_lsr_email ON LinkSyncRequest(email);
	CREATE INDEX IF NOT EXISTS idx_lsr_token ON LinkSyncRequest(token);`
	if _, err := db.Exec(linkSyncSchema); err != nil {
		return err
	}

	// TrustedLink table：人工确认过的休眠链接（见 doc/link_security.md 第 4 节）
	// 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库由 0004 迁移补表
	// source 列由 0005 迁移在旧库上补出（默认 'admin'：历史记录都是管理员点出来的）
	trustedLinkSchema := `
	CREATE TABLE IF NOT EXISTS TrustedLink (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		url TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'admin'
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_email_url ON TrustedLink(email, url);
	CREATE INDEX IF NOT EXISTS idx_tl_email ON TrustedLink(email);`
	if _, err := db.Exec(trustedLinkSchema); err != nil {
		return err
	}

	// MailLog table：邮件发送日志（一次实际尝试过的发送 = 一行）。
	// 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库由 0006 迁移补表。
	mailLogSchema := `
	CREATE TABLE IF NOT EXISTS MailLog (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL,
		recipient TEXT NOT NULL,
		subject TEXT NOT NULL,
		status TEXT NOT NULL,
		error TEXT,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ml_created ON MailLog(created_at);
	CREATE INDEX IF NOT EXISTS idx_ml_status ON MailLog(status);`
	if _, err := db.Exec(mailLogSchema); err != nil {
		return err
	}

	// DormantNotice table：休眠链接提醒的状态机（见任务规范第 4 节）。
	// 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库由 0007 迁移补表。
	dormantNoticeSchema := `
	CREATE TABLE IF NOT EXISTS DormantNotice (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		url TEXT NOT NULL,
		last_comment_at INTEGER NOT NULL,
		token TEXT NOT NULL UNIQUE,
		expires_at TEXT NOT NULL,
		notified_at TEXT NOT NULL,
		notify_count INTEGER NOT NULL DEFAULT 1
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_dn_email_url ON DormantNotice(email, url);
	CREATE INDEX IF NOT EXISTS idx_dn_token ON DormantNotice(token);
	CREATE INDEX IF NOT EXISTS idx_dn_email ON DormantNotice(email);`
	if _, err := db.Exec(dormantNoticeSchema); err != nil {
		return err
	}

	_, err := db.Exec(schema)
	if err != nil {
		return err
	}

	// 幂等启动自迁移（数据归一化等，见 migrate.go）
	return RunMigrations(db)
}

func (r *commentRepo) Create(ctx context.Context, c *model.Comment) error {
	query := `INSERT INTO Comment (
				post_slug, author, email, url, ip_address, 
				device, os, browser, user_agent, 
				content_text, content_html, parent_id, status, pub_date
			  ) 
			  VALUES (
				:post_slug, :author, :email, :url, :ip_address, 
				:device, :os, :browser, :user_agent, 
				:content_text, :content_html, :parent_id, :status, :pub_date
			  )`
	res, err := r.db.NamedExecContext(ctx, query, c)
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	c.ID = id
	return nil
}

func (r *commentRepo) GetByPostSlug(ctx context.Context, slug string) ([]*model.Comment, error) {
	var comments []*model.Comment
	query := `SELECT * FROM Comment WHERE post_slug = ? AND status = 'approved' ORDER BY pub_date ASC`
	err := r.db.SelectContext(ctx, &comments, query, slug)
	return comments, err
}

func (r *commentRepo) GetByID(ctx context.Context, id int64) (*model.Comment, error) {
	var c model.Comment
	err := r.db.GetContext(ctx, &c, "SELECT * FROM Comment WHERE id = ?", id)
	return &c, err
}

func (r *commentRepo) UpdateStatus(ctx context.Context, id int64, status string) error {
	if status == "deleted" || status == "pending" {
		query := `
			WITH RECURSIVE comment_tree AS (
				SELECT id FROM Comment WHERE id = ?
				UNION ALL
				SELECT c.id FROM Comment c
				INNER JOIN comment_tree ct ON c.parent_id = ct.id
			)
			UPDATE Comment SET status = ? WHERE id IN (SELECT id FROM comment_tree)
		`
		_, err := r.db.ExecContext(ctx, query, id, status)
		return err
	} else {
		_, err := r.db.ExecContext(ctx, "UPDATE Comment SET status = ? WHERE id = ?", status, id)
		return err
	}
}

func (r *commentRepo) UpdateComment(ctx context.Context, id int64, fields map[string]interface{}) error {
	allowed := map[string]string{
		"author":       "author",
		"email":        "email",
		"content_text": "content_text",
		"content_html": "content_html",
		"url":          "url",
	}

	var sets []string
	var args []interface{}
	for k, v := range fields {
		col, ok := allowed[k]
		if !ok {
			continue
		}
		sets = append(sets, fmt.Sprintf("%s = ?", col))
		args = append(args, v)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	query := fmt.Sprintf("UPDATE Comment SET %s WHERE id = ?", strings.Join(sets, ", "))
	_, err := r.db.ExecContext(ctx, query, args...)
	return err
}

func (r *commentRepo) Delete(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM Comment WHERE id = ?", id)
	return err
}

func (r *commentRepo) List(ctx context.Context, offset, limit int, status string) ([]*model.Comment, int64, error) {
	var comments []*model.Comment
	var total int64

	var err error
	if status != "" {
		err = r.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM Comment WHERE status = ?", status)
		if err != nil {
			return nil, 0, err
		}
		err = r.db.SelectContext(ctx, &comments, "SELECT * FROM Comment WHERE status = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?", status, limit, offset)
	} else {
		err = r.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM Comment")
		if err != nil {
			return nil, 0, err
		}
		err = r.db.SelectContext(ctx, &comments, "SELECT * FROM Comment ORDER BY pub_date DESC LIMIT ? OFFSET ?", limit, offset)
	}

	return comments, total, err
}

func (r *commentRepo) ListAll(ctx context.Context) ([]*model.Comment, error) {
	var comments []*model.Comment
	err := r.db.SelectContext(ctx, &comments, "SELECT * FROM Comment ORDER BY pub_date ASC")
	return comments, err
}

func (r *commentRepo) GetStatsOverview(ctx context.Context, rangeParam string) (*model.StatsOverview, error) {
	stats := &model.StatsOverview{}

	// range=all / range=0：最近 12 个月按月聚合；其余：最近 N 天（默认 7，上限 365）。
	// 三端统一（C9）：此前 all 会退化成「近 365 天」
	var daysBack int
	var isAll bool
	switch strings.ToLower(strings.TrimSpace(rangeParam)) {
	case "all", "0":
		isAll = true
	default:
		if n, err := strconv.Atoi(strings.TrimSpace(rangeParam)); err == nil && n > 0 {
			if n > 365 {
				n = 365
			}
			daysBack = n - 1
		} else {
			daysBack = 6
		}
	}

	// 时间锚点：窗口 / 今日 / 近 7 日与月度分桶共用同一个 UTC「现在」，
	// 保证「窗口起点」与「分桶起点」逐毫秒一致（否则 windowComments ≠ 分桶之和）
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	// twelveMonthsAgo 就是月度趋势的第一个桶；range=0/all 的窗口起点复用它
	twelveMonthsAgo := monthStart.AddDate(0, -11, 0)
	twentyThreeMonthsAgo := monthStart.AddDate(0, -23, 0)
	startOfToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	// 窗口边界（三端必须逐字一致）：
	//   range != 0     ：winStart = startOfUtcDay(now) - (range-1) 天；prevStart = winStart - range 天
	//   range == 0/all ：winStart = 11 个月前的 1 日 00:00；prevStart = 23 个月前的 1 日 00:00
	// 窗口 = pub_date >= winStart；上一窗口 = prevStart <= pub_date < winStart
	var winStart, prevStart int64
	if isAll {
		winStart = twelveMonthsAgo.UnixMilli()
		prevStart = twentyThreeMonthsAgo.UnixMilli()
	} else {
		winStart = startOfToday.UnixMilli() - int64(daysBack)*utils.DayMillis
		prevStart = winStart - int64(daysBack+1)*utils.DayMillis
	}

	// 1. 总评论数
	_ = r.db.GetContext(ctx, &stats.TotalComments, "SELECT COUNT(*) FROM Comment")

	// 2. 总用户数 (author + email 唯一组合)
	_ = r.db.GetContext(ctx, &stats.TotalUsers, "SELECT COUNT(*) FROM (SELECT DISTINCT author, email FROM Comment)")

	// 3. 总文章数
	_ = r.db.GetContext(ctx, &stats.TotalPosts, "SELECT COUNT(DISTINCT post_slug) FROM Comment")

	// 4. 状态分布
	var rows []struct {
		Status string `db:"status"`
		Count  int64  `db:"count"`
	}
	_ = r.db.SelectContext(ctx, &rows, "SELECT status, COUNT(*) as count FROM Comment GROUP BY status")
	for _, row := range rows {
		switch row.Status {
		case "approved":
			stats.StatusDistribution.Approved = row.Count
		case "pending":
			stats.StatusDistribution.Pending = row.Count
		case "deleted":
			stats.StatusDistribution.Deleted = row.Count
		}
	}

	if isAll {
		// 最近 12 个月：按月聚合。
		// 分桶统一使用 UTC（strftime(...,'unixepoch') 就是 UTC），键也必须用 UTC 生成，
		// 否则非 UTC 时区下跨月边界会错位（C3）
		monthlyMap := make(map[string]int64)
		for i := 11; i >= 0; i-- {
			d := monthStart.AddDate(0, -i, 0)
			key := d.Format("2006-01")
			monthlyMap[key] = 0
		}
		var monthlyRows []struct {
			MonthStr string `db:"month_str"`
			Count    int64  `db:"count"`
		}
		_ = r.db.SelectContext(ctx, &monthlyRows, `
			SELECT strftime('%Y-%m', pub_date / 1000, 'unixepoch') as month_str, COUNT(*) as count
			FROM Comment
			WHERE pub_date >= ?
			GROUP BY month_str ORDER BY month_str ASC
		`, twelveMonthsAgo.UnixMilli())
		for _, row := range monthlyRows {
			if _, ok := monthlyMap[row.MonthStr]; ok {
				monthlyMap[row.MonthStr] = row.Count
			}
		}
		for _, d := range getMonthRange(11) {
			stats.RecentComments = append(stats.RecentComments, model.DateCount{Date: d, Count: monthlyMap[d]})
		}
	} else {
		// 日分桶同样统一 UTC：键与 SQL 的 strftime(...,'unixepoch') 必须落在同一时区
		dateCountMap := make(map[string]int64)
		for i := daysBack; i >= 0; i-- {
			d := now.AddDate(0, 0, -i)
			key := d.Format("2006-01-02")
			dateCountMap[key] = 0
		}
		var recentRows []struct {
			DateStr string `db:"date_str"`
			Count   int64  `db:"count"`
		}
		startDateStr := startOfToday.AddDate(0, 0, -daysBack).Format("2006-01-02")
		_ = r.db.SelectContext(ctx, &recentRows, `
			SELECT strftime('%Y-%m-%d', pub_date / 1000, 'unixepoch') as date_str, COUNT(*) as count
			FROM Comment
			WHERE date(pub_date / 1000, 'unixepoch') >= ?
			GROUP BY date_str ORDER BY date_str ASC
		`, startDateStr)

		for _, row := range recentRows {
			if _, ok := dateCountMap[row.DateStr]; ok {
				dateCountMap[row.DateStr] = row.Count
			}
		}
		for _, d := range getDateRange(daysBack) {
			stats.RecentComments = append(stats.RecentComments, model.DateCount{Date: d, Count: dateCountMap[d]})
		}
	}

	// 6. 热门评论者 Top 5
	type topCommenterRow struct {
		Author  string `db:"author"`
		Email   string `db:"email"`
		Count   int64  `db:"count"`
		MaxDate int64  `db:"max_date"`
	}
	var topRows []topCommenterRow
	_ = r.db.SelectContext(ctx, &topRows, `
		SELECT author, email, COUNT(*) as count, MAX(pub_date) as max_date
		FROM Comment
		GROUP BY author, email
		ORDER BY count DESC
		LIMIT 5
	`)
	stats.TopCommenters = make([]model.TopCommenter, 0)
	for _, row := range topRows {
		stats.TopCommenters = append(stats.TopCommenters, model.TopCommenter{
			Author:          row.Author,
			Email:           row.Email,
			Count:           row.Count,
			LastCommentDate: time.UnixMilli(row.MaxDate).UTC().Format("2006-01-02T15:04:05.000Z"),
		})
	}

	// 7. 时间窗口指标
	//
	// 含所有状态：被拒 / 删除的评论同样是「这段时间产生的评论」，否则
	// commentsDelta 会因为审核动作（而不是流量）剧烈抖动。
	_ = r.db.GetContext(ctx, &stats.WindowComments,
		"SELECT COUNT(*) FROM Comment WHERE pub_date >= ?", winStart)
	_ = r.db.GetContext(ctx, &stats.PrevWindowComments,
		"SELECT COUNT(*) FROM Comment WHERE pub_date >= ? AND pub_date < ?", prevStart, winStart)
	// 活跃评论者与 totalUsers 同口径：author + email 去重
	_ = r.db.GetContext(ctx, &stats.WindowUsers,
		"SELECT COUNT(*) FROM (SELECT DISTINCT author, email FROM Comment WHERE pub_date >= ?)", winStart)
	_ = r.db.GetContext(ctx, &stats.PrevWindowUsers,
		"SELECT COUNT(*) FROM (SELECT DISTINCT author, email FROM Comment WHERE pub_date >= ? AND pub_date < ?)",
		prevStart, winStart)
	stats.CommentsDelta = percentDelta(stats.WindowComments, stats.PrevWindowComments)
	stats.UsersDelta = percentDelta(stats.WindowUsers, stats.PrevWindowUsers)

	// 8. 今日 / 最近 7 个 UTC 自然日（含今天；同样不区分状态）
	todayStart := startOfToday.UnixMilli()
	_ = r.db.GetContext(ctx, &stats.TodayComments,
		"SELECT COUNT(*) FROM Comment WHERE pub_date >= ?", todayStart)
	_ = r.db.GetContext(ctx, &stats.Last7DaysComments,
		"SELECT COUNT(*) FROM Comment WHERE pub_date >= ?", todayStart-6*utils.DayMillis)

	// 9. 热门文章 Top 5：计数降序，计数相同时 post_slug 升序（三端确定性一致）
	type topPostRow struct {
		PostSlug string `db:"post_slug"`
		Count    int64  `db:"count"`
		MaxDate  int64  `db:"max_date"`
	}
	var topPostRows []topPostRow
	_ = r.db.SelectContext(ctx, &topPostRows, `
		SELECT post_slug, COUNT(*) as count, MAX(pub_date) as max_date
		FROM Comment
		GROUP BY post_slug
		ORDER BY count DESC, post_slug ASC
		LIMIT 5
	`)
	stats.TopPosts = make([]model.TopPost, 0, len(topPostRows))
	for _, row := range topPostRows {
		stats.TopPosts = append(stats.TopPosts, model.TopPost{
			PostSlug:        row.PostSlug,
			Count:           row.Count,
			LastCommentDate: time.UnixMilli(row.MaxDate).UTC().Format("2006-01-02T15:04:05.000Z"),
		})
	}

	// 10. 客户端分布 Top 5
	//
	// 先在 SQL 里按**原始值**分组（含所有状态），再在 Go 里归一化 + 合并同名家族：
	// 归一化必须发生在分组之后，否则 `Chrome 145` 与 `Chrome 144` 会被算成两个家族，
	// 而它们本就该合并成「Chrome」（口径见 doc/vectors/stats-distribution-v1.json）。
	stats.BrowserDistribution = r.distribution(ctx, "browser", utils.NormalizeBrowserFamily)
	stats.OSDistribution = r.distribution(ctx, "os", utils.NormalizeOSFamily)
	stats.DeviceDistribution = r.distribution(ctx, "device", utils.NormalizeDeviceType)

	// 11. 最新评论动态：pub_date DESC, id DESC 的前 5 条（含所有状态，正文不截断）
	type latestCommentRow struct {
		ID          int64  `db:"id"`
		Author      string `db:"author"`
		Email       string `db:"email"`
		PostSlug    string `db:"post_slug"`
		ContentText string `db:"content_text"`
		Status      string `db:"status"`
		PubDate     int64  `db:"pub_date"`
	}
	var latestRows []latestCommentRow
	// COALESCE 只为兜住历史脏值（NULL）：字符串列在 DDL 里是 NOT NULL，
	// 但旧库 / 外部导入可能留下 NULL，扫描进 string 会直接报错
	_ = r.db.SelectContext(ctx, &latestRows, `
		SELECT id,
		       COALESCE(author, '') AS author,
		       COALESCE(email, '') AS email,
		       COALESCE(post_slug, '') AS post_slug,
		       COALESCE(content_text, '') AS content_text,
		       COALESCE(status, '') AS status,
		       COALESCE(pub_date, 0) AS pub_date
		FROM Comment
		ORDER BY pub_date DESC, id DESC
		LIMIT 5
	`)
	stats.LatestComments = make([]model.LatestComment, 0, len(latestRows))
	for _, row := range latestRows {
		stats.LatestComments = append(stats.LatestComments, model.LatestComment{
			ID:          row.ID,
			Author:      row.Author,
			Email:       row.Email,
			PostSlug:    row.PostSlug,
			ContentText: row.ContentText,
			Status:      row.Status,
			PubDate:     time.UnixMilli(row.PubDate).UTC().Format("2006-01-02T15:04:05.000Z"),
		})
	}

	return stats, nil
}

// distribution 客户端分布的一条榜单：SQL 按原始值分组 → 归一化并合并同名 → count DESC / name ASC 取 5。
//
// column 只接包内硬编码的列名（browser / os / device），不存在注入面。
// COALESCE(col, '') 把 SQL 的 NULL 变成空串：与 Node 侧 null 落在同一分支
// （浏览器 / 系统 → 未知，设备空值是正常取值 → 桌面），
// 而字面量字符串 "null" 仍按普通原始值处理，不会被当成 NULL。
func (r *commentRepo) distribution(ctx context.Context, column string, normalize func(string) string) []utils.NameCount {
	var rows []utils.RawCount
	_ = r.db.SelectContext(ctx, &rows, fmt.Sprintf(`
		SELECT COALESCE(%s, '') AS name, COUNT(*) AS count
		FROM Comment
		GROUP BY COALESCE(%s, '')`, column, column))
	return utils.MergeDistribution(rows, normalize, 5)
}

// percentDelta 环比百分比：Math.round((cur-prev)/prev*100)；prev = 0 时返回 null
// （不是 0，也不是 100：没有可比基数时不该显示「增长 100%」）。
//
// 用 Floor(x+0.5) 而不是 math.Round：JS 的 Math.round 是「向 +∞ 取半」
// （Math.round(-0.5) === -0），math.Round 则是「远离 0 取半」（-1），
// 在 -0.5 这种边界上会与 Node / Worker 漂移。
func percentDelta(cur, prev int64) *int64 {
	if prev == 0 {
		return nil
	}
	delta := int64(math.Floor(float64(cur-prev)/float64(prev)*100 + 0.5))
	return &delta
}

// GetUserList 返回**全部**匹配的用户（按昵称/邮箱搜索、按邮箱验证筛选后的唯一 author+email），
// 不做分页 —— 分页必须在 handler 里完成：用户列表要支持按「网站链接状态」（休眠 / 已确认 /
// 普通 / 无链接）筛选，而链接状态是按邮箱实时推导出来的，只有给**全部用户**算一次状态，
// 才能保证过滤发生在分页之前（否则 totalPage 会反映过滤前的集合）。
//
// 本方法仍只做**一次**分组查询（与既有的 count 查询合并为同一个结果集），
// 调用方拿到的切片顺序与旧实现一致（commentCount DESC）。
func (r *commentRepo) GetUserList(ctx context.Context, search string, verified string) ([]*model.UserStats, error) {
	search = strings.TrimSpace(search)

	// 与评论提交时的判定保持一致：EmailVerification.email 精确匹配且 verified = 1
	const verifiedExists = "EXISTS (SELECT 1 FROM EmailVerification ev WHERE ev.email = Comment.email AND ev.verified = 1)"

	// 按昵称/邮箱搜索（SQLite LIKE 对 ASCII 不区分大小写）
	conditions := make([]string, 0, 2)
	args := make([]interface{}, 0)
	if search != "" {
		like := "%" + search + "%"
		conditions = append(conditions, "(author LIKE ? OR email LIKE ?)")
		args = append(args, like, like)
	}
	// 邮箱验证筛选：verified = "true" / "false"，其余取值（含 "all"）不筛选
	switch verified {
	case "true":
		conditions = append(conditions, verifiedExists)
	case "false":
		conditions = append(conditions, "NOT "+verifiedExists)
	}

	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}

	type userRow struct {
		Author          string `db:"author"`
		Email           string `db:"email"`
		CommentCount    int64  `db:"commentCount"`
		ApprovedCount   int64  `db:"approvedCount"`
		PendingCount    int64  `db:"pendingCount"`
		DeletedCount    int64  `db:"deletedCount"`
		MinDate         int64  `db:"min_date"`
		MaxDate         int64  `db:"max_date"`
		EmailVerified   int64  `db:"emailVerified"`
		EmailVerifiedAt string `db:"emailVerifiedAt"`
	}
	var rows []userRow
	query := `
		SELECT
			author, email,
			COUNT(*) as commentCount,
			COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) as approvedCount,
			COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pendingCount,
			COALESCE(SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END), 0) as deletedCount,
			MIN(pub_date) as min_date,
			MAX(pub_date) as max_date,
			CASE WHEN ` + verifiedExists + ` THEN 1 ELSE 0 END as emailVerified,
			COALESCE((SELECT MAX(ev.verified_at) FROM EmailVerification ev WHERE ev.email = Comment.email AND ev.verified = 1), '') as emailVerifiedAt
		FROM Comment` + where + `
		GROUP BY author, email
		ORDER BY commentCount DESC
	`
	err := r.db.SelectContext(ctx, &rows, query, args...)
	if err != nil {
		return nil, err
	}

	users := make([]*model.UserStats, 0, len(rows))
	for _, row := range rows {
		users = append(users, &model.UserStats{
			Author:           row.Author,
			Email:            row.Email,
			CommentCount:     row.CommentCount,
			ApprovedCount:    row.ApprovedCount,
			PendingCount:     row.PendingCount,
			DeletedCount:     row.DeletedCount,
			FirstCommentDate: time.UnixMilli(row.MinDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			LastCommentDate:  time.UnixMilli(row.MaxDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			EmailVerified:    row.EmailVerified == 1,
			EmailVerifiedAt:  row.EmailVerifiedAt,
		})
	}

	return users, nil
}

func getDateRange(daysBack int) []string {
	var dates []string
	// 与 SQL 的 strftime(...,'unixepoch') 对齐：必须使用 UTC 日期
	nowUTC := time.Now().UTC()
	for i := daysBack; i >= 0; i-- {
		d := nowUTC.AddDate(0, 0, -i)
		dates = append(dates, d.Format("2006-01-02"))
	}
	return dates
}

func getMonthRange(monthsBack int) []string {
	var months []string
	now := time.Now().UTC()
	for i := monthsBack; i >= 0; i-- {
		d := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -i, 0)
		months = append(months, d.Format("2006-01"))
	}
	return months
}

func (r *commentRepo) GetUserComments(ctx context.Context, author, email string, offset, limit int) ([]*model.AdminCommentResponse, int64, error) {

	var total int64
	_ = r.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM Comment WHERE author = ? AND email = ?", author, email)

	var comments []*model.Comment
	err := r.db.SelectContext(ctx, &comments, `
		SELECT * FROM Comment WHERE author = ? AND email = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?
	`, author, email, limit, offset)
	if err != nil {
		return nil, 0, err
	}

	resp := make([]*model.AdminCommentResponse, 0, len(comments))
	for _, c := range comments {
		resp = append(resp, &model.AdminCommentResponse{
			ID:          c.ID,
			PubDate:     time.UnixMilli(c.PubDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			PostSlug:    c.PostSlug,
			Author:      c.Author,
			Email:       c.Email,
			URL:         c.URL,
			IPAddress:   c.IPAddress,
			OS:          c.OS,
			Browser:     c.Browser,
			ContentText: c.ContentText,
			ContentHtml: c.ContentHTML,
			Status:      c.Status,
		})
	}

	return resp, total, nil
}


func (r *commentRepo) GetLastCommentByIP(ctx context.Context, ip string) (*model.Comment, error) {
	var c model.Comment
	err := r.db.GetContext(ctx, &c, "SELECT * FROM Comment WHERE ip_address = ? ORDER BY pub_date DESC LIMIT 1", ip)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// HasRecentDuplicate 判断同一 IP 在时间窗内是否提交过完全相同的正文（审核自动化的「重复」规则）。
//
// 不区分状态：被判为垃圾或被删除的评论同样计入 —— 否则刷屏者只要被删一次
// 就能把同一段内容无限重发。
func (r *commentRepo) HasRecentDuplicate(ctx context.Context, ip, contentText string, sinceMillis int64) (bool, error) {
	var count int64
	err := r.db.GetContext(ctx, &count,
		"SELECT COUNT(*) FROM Comment WHERE ip_address = ? AND content_text = ? AND pub_date >= ?",
		ip, contentText, sinceMillis)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// CheckEmailVerified 检查邮箱是否已验证
func (r *commentRepo) CheckEmailVerified(ctx context.Context, email string) (bool, error) {
	var count int64
	err := r.db.GetContext(ctx, &count, "SELECT COUNT(*) FROM EmailVerification WHERE email = ? AND verified = 1", email)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// IsEmailIdentityVerified 按归一化身份（lower(trim(email))）检查邮箱是否已验证。
//
// 只给「历史链接同步」的触发条件用：那里邮箱是身份凭据，历史评论的查询与批量改写
// 都按 lower(trim(email)) 比对，若「已验证」用精确匹配就会与它们自相矛盾
// （A@B.com 验证过、后来提交 a@b.com 时永远发不出确认邮件）。
func (r *commentRepo) IsEmailIdentityVerified(ctx context.Context, email string) (bool, error) {
	var count int64
	err := r.db.GetContext(ctx, &count,
		`SELECT COUNT(*) FROM EmailVerification WHERE verified = 1 AND lower(trim(email)) = ?`, email)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// HasUnverifiedToken 检查邮箱是否有未过期的未验证令牌
func (r *commentRepo) HasUnverifiedToken(ctx context.Context, email string) (bool, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	var count int64
	err := r.db.GetContext(ctx, &count,
		"SELECT COUNT(*) FROM EmailVerification WHERE email = ? AND verified = 0 AND expires_at >= ?", email, now)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// SaveVerificationToken 保存验证令牌
func (r *commentRepo) SaveVerificationToken(ctx context.Context, email, token, expiresAt, postSlug, postTitle string) error {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO EmailVerification (email, token, created_at, expires_at, post_slug, post_title) VALUES (?, ?, ?, ?, ?, ?)`,
		email, token, now, expiresAt, postSlug, postTitle)
	return err
}

// GetVerificationRecord 获取验证记录
func (r *commentRepo) GetVerificationRecord(ctx context.Context, token, email string) (*model.EmailVerification, error) {
	var record model.EmailVerification
	err := r.db.GetContext(ctx, &record,
		`SELECT * FROM EmailVerification WHERE token = ? AND email = ?`, token, email)
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// VerifyEmail 验证邮箱并批准待审核评论，返回批准的评论数
func (r *commentRepo) VerifyEmail(ctx context.Context, token, email string) (int64, error) {
	// 标记为已验证
	_, err := r.db.ExecContext(ctx,
		`UPDATE EmailVerification SET verified = 1, verified_at = datetime('now') WHERE token = ? AND email = ?`,
		token, email)
	if err != nil {
		return 0, err
	}

	// 批准待审核评论
	res, err := r.db.ExecContext(ctx,
		`UPDATE Comment SET status = 'approved' WHERE email = ? AND status = 'pending'`, email)
	if err != nil {
		return 0, err
	}
	count, _ := res.RowsAffected()
	return count, nil
}

// ---------------------------------------------------------------------------
// 休眠链接（doc/link_security.md 第 2.1 节）
// ---------------------------------------------------------------------------

// LastCommentAtByEmails 一次分组查询拿到每个邮箱（归一化）的最后一条评论时间。
//
// 计数口径：status NOT IN ('rejected', 'deleted')（pending 也算「来过」），
// 跨文章统计（不按 post_slug 过滤）。emails 必须已归一化（lower + trim）。
func (r *commentRepo) LastCommentAtByEmails(ctx context.Context, emails []string) (map[string]int64, error) {
	result := make(map[string]int64, len(emails))
	if len(emails) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(emails))
	args := make([]interface{}, len(emails))
	for i, email := range emails {
		placeholders[i] = "?"
		args[i] = email
	}

	query := fmt.Sprintf(`
		SELECT lower(trim(email)) AS email, MAX(pub_date) AS last_at
		FROM Comment
		WHERE status NOT IN ('rejected', 'deleted')
		  AND lower(trim(email)) IN (%s)
		GROUP BY lower(trim(email))`, strings.Join(placeholders, ", "))

	var rows []struct {
		Email  string `db:"email"`
		LastAt int64  `db:"last_at"`
	}
	if err := r.db.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.Email] = row.LastAt
	}
	return result, nil
}

// LinkStatusByEmails 一次有序查询拿到每个邮箱（归一化）的「最后评论时间 + 最近一次非空网址」。
//
// 只为用户列表的 url / urlDormant 两列服务（避免逐行查询）：身份口径与公开评论区一致 ——
// status NOT IN ('rejected', 'deleted')（pending 也算「来过」）、跨文章统计、身份是邮箱本身。
// 升序遍历，最后一行决定 LastAt；只在网址非空（trim 后）时覆盖 LatestURL，
// 因此「较晚的评论没留网址」不会清掉之前留下的链接（doc/link_security.md 第 2 节）。
// emails 必须已归一化（lower + trim）。
func (r *commentRepo) LinkStatusByEmails(ctx context.Context, emails []string) (map[string]model.UserLinkStatus, error) {
	result := make(map[string]model.UserLinkStatus, len(emails))
	if len(emails) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(emails))
	args := make([]interface{}, len(emails))
	for i, email := range emails {
		placeholders[i] = "?"
		args[i] = email
	}

	// COALESCE(pub_date, 0) 与 Node 侧 Number(null) === 0 的行为对齐：
	// 历史脏值（pub_date 为 NULL）不该让整条查询失败。
	query := fmt.Sprintf(`
		SELECT lower(trim(email)) AS email, COALESCE(pub_date, 0) AS at, COALESCE(url, '') AS url
		FROM Comment
		WHERE status NOT IN ('rejected', 'deleted')
		  AND lower(trim(email)) IN (%s)
		ORDER BY pub_date ASC`, strings.Join(placeholders, ", "))

	var rows []struct {
		Email string `db:"email"`
		At    int64  `db:"at"`
		URL   string `db:"url"`
	}
	if err := r.db.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, row := range rows {
		entry := result[strings.ToLower(row.Email)]
		entry.LastAt = row.At
		if url := strings.TrimSpace(row.URL); url != "" {
			entry.LatestURL = url
		}
		result[strings.ToLower(row.Email)] = entry
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// 历史链接批量更新（LinkSyncRequest）
// ---------------------------------------------------------------------------

// LatestHistoricalURL 返回该邮箱最近一条「url 非空且与本次提交的 url 不同」的历史评论的 url；
// 没有则返回空串（调用方据此判定「不存在历史评论」）。
func (r *commentRepo) LatestHistoricalURL(ctx context.Context, email, newURL string) (string, error) {
	var url string
	err := r.db.GetContext(ctx, &url, `
		SELECT url FROM Comment
		WHERE lower(trim(email)) = ?
		  AND status NOT IN ('rejected', 'deleted')
		  AND url IS NOT NULL AND trim(url) != '' AND url != ?
		ORDER BY pub_date DESC
		LIMIT 1`, email, newURL)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return url, nil
}

// FindActiveLinkSyncRequest 查找同一邮箱 + 同一新网址的「未确认且未过期」记录（用于去重）。
func (r *commentRepo) FindActiveLinkSyncRequest(ctx context.Context, email, newURL, now string) (*model.LinkSyncRequest, error) {
	var record model.LinkSyncRequest
	err := r.db.GetContext(ctx, &record, `
		SELECT * FROM LinkSyncRequest
		WHERE email = ? AND new_url = ? AND confirmed = 0 AND expires_at >= ?
		ORDER BY id DESC
		LIMIT 1`, email, newURL, now)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &record, nil
}

// InvalidateLinkSyncRequests 作废该邮箱既有的「未确认且未过期」记录：
// 置为已过期（而不是删除），确认页才能给出「已过期」而不是「无效」的提示。
func (r *commentRepo) InvalidateLinkSyncRequests(ctx context.Context, email, now string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE LinkSyncRequest SET expires_at = ? WHERE email = ? AND confirmed = 0 AND expires_at >= ?`,
		now, email, now)
	return err
}

// CreateLinkSyncRequest 写入一条待确认记录
func (r *commentRepo) CreateLinkSyncRequest(ctx context.Context, record *model.LinkSyncRequest) error {
	res, err := r.db.NamedExecContext(ctx, `INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, confirmed, created_at)
		VALUES (:email, :new_url, :token, :expires_at, :confirmed, :created_at)`, record)
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	record.ID = id
	return nil
}

// GetLinkSyncRequest 按 token + 邮箱（已归一化）取记录
func (r *commentRepo) GetLinkSyncRequest(ctx context.Context, token, email string) (*model.LinkSyncRequest, error) {
	var record model.LinkSyncRequest
	err := r.db.GetContext(ctx, &record,
		`SELECT * FROM LinkSyncRequest WHERE token = ? AND email = ?`, token, email)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &record, nil
}

// ConfirmLinkSyncRequest 标记记录已确认（一次性，不可重放）
func (r *commentRepo) ConfirmLinkSyncRequest(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `UPDATE LinkSyncRequest SET confirmed = 1 WHERE id = ?`, id)
	return err
}

// UpdateCommentURLsByEmail 把该邮箱（归一化后相同）所有「状态未被拒/未删除且 url 不等于新网址」
// 的评论的 url 批量改成新网址，返回受影响行数。
//
// 只改 url 字段，不动 content_html / content_text；NULL url 的比较结果不是真值，
// 因此不会被写入（幂等：重复确认不会产生额外写入）。
func (r *commentRepo) UpdateCommentURLsByEmail(ctx context.Context, email, newURL string) (int64, error) {
	res, err := r.db.ExecContext(ctx, `
		UPDATE Comment SET url = ?
		WHERE lower(trim(email)) = ?
		  AND status NOT IN ('rejected', 'deleted')
		  AND url != ?`, newURL, email, newURL)
	if err != nil {
		return 0, err
	}
	count, _ := res.RowsAffected()
	return count, nil
}

// ---------------------------------------------------------------------------
// 人工确认（TrustedLink，见 doc/link_security.md 第 4 节）
// ---------------------------------------------------------------------------

// UpsertTrustedLink 幂等 upsert：同一 (email, url) 已有记录时刷新 expires_at / created_at /
// source，不新增行（唯一索引 idx_tl_email_url）。email 必须是归一化后的邮箱、url 必须是
// sanitizeUrl 的输出、两个时间必须是 `YYYY-MM-DDTHH:mm:ss.sssZ` 格式（调用方保证）。
//
// Source 为空时按 `admin` 落库（与建表默认值一致，保证历史调用方语义不变）。
func (r *commentRepo) UpsertTrustedLink(ctx context.Context, link *model.TrustedLink) error {
	source := link.Source
	if source == "" {
		source = model.TrustedLinkSourceAdmin
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO TrustedLink (email, url, expires_at, created_at, source)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(email, url) DO UPDATE SET
			expires_at = excluded.expires_at,
			created_at = excluded.created_at,
			source = excluded.source`,
		link.Email, link.URL, link.ExpiresAt, link.CreatedAt, source)
	return err
}

// DeleteTrustedLink 删除该 (email, url) 的人工确认，返回受影响行数（0 表示本来就没有）。
//
// 已过期的记录同样会被删除：管理员点「撤销」的意思是「这条链接不再有人工确认」，
// 与它是否还在有效期内无关。
func (r *commentRepo) DeleteTrustedLink(ctx context.Context, email, url string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM TrustedLink WHERE email = ? AND url = ?`, email, url)
	if err != nil {
		return 0, err
	}
	count, _ := res.RowsAffected()
	return count, nil
}

// TrustedLinksByEmails 一次查询取回这批邮箱（归一化）中**未过期**的人工确认，避免 N+1。
//
// nowMs 与 expires_at 都是本端写出的 `YYYY-MM-DDTHH:mm:ss.sssZ` 格式（定宽、UTC），
// 因此 `expires_at > now` 的字典序比较与时间先后一致 —— SQL 只用它做粗筛，
// 取回的值再用 utils.IsTrustActive 兜底判定（脏格式一律 fail-closed 视为无效）。
// 返回的键是 utils.TrustedLinkKey（归一化邮箱 + \x00 + trim 后的网址），
// 值是到期时间 + 来源（用户列表要一并下发 urlTrustedSource）。
func (r *commentRepo) TrustedLinksByEmails(ctx context.Context, emails []string, nowMs int64) (map[string]model.TrustedLinkInfo, error) {
	result := make(map[string]model.TrustedLinkInfo, len(emails))
	if len(emails) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(emails))
	args := make([]interface{}, 0, len(emails)+1)
	for i, email := range emails {
		placeholders[i] = "?"
		args = append(args, email)
	}
	args = append(args, utils.FormatTrustTime(nowMs))

	query := fmt.Sprintf(`
		SELECT email, url, expires_at, COALESCE(source, '') AS source FROM TrustedLink
		WHERE lower(trim(email)) IN (%s)
		  AND expires_at > ?`, strings.Join(placeholders, ", "))

	var rows []struct {
		Email     string `db:"email"`
		URL       string `db:"url"`
		ExpiresAt string `db:"expires_at"`
		Source    string `db:"source"`
	}
	if err := r.db.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, row := range rows {
		if !utils.IsTrustActive(row.ExpiresAt, nowMs) {
			continue
		}
		source := row.Source
		if source == "" {
			source = model.TrustedLinkSourceAdmin
		}
		result[utils.TrustedLinkKey(row.Email, row.URL)] = model.TrustedLinkInfo{
			ExpiresAt: row.ExpiresAt,
			Source:    source,
		}
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// 邮件发送日志（MailLog）
// ---------------------------------------------------------------------------

// ListMailLogs 管理端邮件列表：只返回保留窗口（Since；空串表示永久保留、不加时间下限）内的行，
// 按 `created_at DESC, id DESC` 排序（并列时 id 倒序，保证稳定），并支持 status / type / search 三个筛选。
//
// search 对 recipient 或 subject 做不区分大小写的模糊匹配（SQLite 的 LIKE 对 ASCII 天然如此，
// 这里额外 lower() 一次，保证与调用方的 trim + 小写口径一致）。
// error 列可能为 NULL（成功行），用 COALESCE 兜成空串。
func (r *commentRepo) ListMailLogs(ctx context.Context, q model.MailLogQuery) (*model.MailLogList, error) {
	conditions := []string{}
	args := []interface{}{}
	if q.Since != "" {
		conditions = append(conditions, "created_at >= ?")
		args = append(args, q.Since)
	}

	switch q.Status {
	case "sent", "failed":
		conditions = append(conditions, "status = ?")
		args = append(args, q.Status)
	}
	if q.Type != "" && q.Type != "all" {
		conditions = append(conditions, "type = ?")
		args = append(args, q.Type)
	}
	if q.Search != "" {
		like := "%" + strings.ToLower(q.Search) + "%"
		conditions = append(conditions, "(lower(recipient) LIKE ? OR lower(subject) LIKE ?)")
		args = append(args, like, like)
	}

	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}

	var total int64
	if err := r.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM MailLog"+where, args...); err != nil {
		return nil, err
	}

	var logs []model.MailLog
	query := `
		SELECT id,
		       COALESCE(type, '') AS type,
		       COALESCE(recipient, '') AS recipient,
		       COALESCE(subject, '') AS subject,
		       COALESCE(status, '') AS status,
		       COALESCE(error, '') AS error,
		       COALESCE(created_at, '') AS created_at
		FROM MailLog` + where + `
		ORDER BY created_at DESC, id DESC
		LIMIT ? OFFSET ?`
	queryArgs := append(args, q.Limit, q.Offset)
	if err := r.db.SelectContext(ctx, &logs, query, queryArgs...); err != nil {
		return nil, err
	}
	if logs == nil {
		logs = []model.MailLog{}
	}
	return &model.MailLogList{List: logs, Total: total}, nil
}

// ---------------------------------------------------------------------------
// 休眠链接提醒的状态机（DormantNotice）
// ---------------------------------------------------------------------------

// DormantNoticesByEmails 一次查询取回这批邮箱（归一化）的全部提醒记录，键同样是
// utils.TrustedLinkKey（归一化邮箱 + \x00 + trim 后的网址），避免逐条查询。
// 与 TrustedLinksByEmails 一样按邮箱集合粗筛、在 Go 里精确匹配 (email, url)。
func (r *commentRepo) DormantNoticesByEmails(ctx context.Context, emails []string) (map[string]*model.DormantNotice, error) {
	result := make(map[string]*model.DormantNotice, len(emails))
	if len(emails) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(emails))
	args := make([]interface{}, len(emails))
	for i, email := range emails {
		placeholders[i] = "?"
		args[i] = email
	}

	query := fmt.Sprintf(`
		SELECT * FROM DormantNotice
		WHERE lower(trim(email)) IN (%s)`, strings.Join(placeholders, ", "))

	var rows []*model.DormantNotice
	if err := r.db.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[utils.TrustedLinkKey(row.Email, row.URL)] = row
	}
	return result, nil
}

// UpsertDormantNotice 写入/刷新一条提醒记录：没有记录时 notify_count = 1，
// 已有记录时在同一语句里自增（避免读-改-写的竞态）。
func (r *commentRepo) UpsertDormantNotice(ctx context.Context, notice *model.DormantNotice) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at, notify_count)
		VALUES (?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT(email, url) DO UPDATE SET
			last_comment_at = excluded.last_comment_at,
			token = excluded.token,
			expires_at = excluded.expires_at,
			notified_at = excluded.notified_at,
			notify_count = DormantNotice.notify_count + 1`,
		notice.Email, notice.URL, notice.LastCommentAt, notice.Token, notice.ExpiresAt, notice.NotifiedAt)
	return err
}

// GetDormantNoticeByToken 按令牌取提醒记录；查不到返回 (nil, nil)。
func (r *commentRepo) GetDormantNoticeByToken(ctx context.Context, token string) (*model.DormantNotice, error) {
	var notice model.DormantNotice
	err := r.db.GetContext(ctx, &notice, `SELECT * FROM DormantNotice WHERE token = ?`, token)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &notice, nil
}

// DeleteDormantNoticeByToken 删除一条提醒记录（confirm / update 完成后的一次性动作）。
func (r *commentRepo) DeleteDormantNoticeByToken(ctx context.Context, token string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM DormantNotice WHERE token = ?`, token)
	return err
}

