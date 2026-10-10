package sqlite

import (
	"context"
	"fmt"
	"momo-backend-go/internal/model"
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
		now := time.Now().UTC()
		for i := 11; i >= 0; i-- {
			d := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -i, 0)
			key := d.Format("2006-01")
			monthlyMap[key] = 0
		}
		twelveMonthsAgo := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -11, 0)
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
		nowUTC := time.Now().UTC()
		for i := daysBack; i >= 0; i-- {
			d := nowUTC.AddDate(0, 0, -i)
			key := d.Format("2006-01-02")
			dateCountMap[key] = 0
		}
		var recentRows []struct {
			DateStr string `db:"date_str"`
			Count   int64  `db:"count"`
		}
		startDateStr := nowUTC.AddDate(0, 0, -daysBack).Format("2006-01-02")
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

	return stats, nil
}

func (r *commentRepo) GetUserList(ctx context.Context, offset, limit int, search string, verified string) ([]*model.UserStats, int64, error) {
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

	var total int64
	countQuery := "SELECT COUNT(*) FROM (SELECT DISTINCT author, email FROM Comment" + where + ")"
	_ = r.db.GetContext(ctx, &total, countQuery, args...)

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
		LIMIT ? OFFSET ?
	`
	queryArgs := append(args, limit, offset)
	err := r.db.SelectContext(ctx, &rows, query, queryArgs...)
	if err != nil {
		return nil, 0, err
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

	return users, total, nil
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

// CheckEmailVerified 检查邮箱是否已验证
func (r *commentRepo) CheckEmailVerified(ctx context.Context, email string) (bool, error) {
	var count int64
	err := r.db.GetContext(ctx, &count, "SELECT COUNT(*) FROM EmailVerification WHERE email = ? AND verified = 1", email)
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
