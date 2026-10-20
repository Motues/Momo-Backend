package model

import "momo-backend-go/internal/pkg/utils"

// CommentRequest 提交评论请求体
type CommentRequest struct {
	PostSlug     string `json:"post_slug" binding:"required"`
	Author       string `json:"author" binding:"required"`
	Email        string `json:"email" binding:"required,email"`
	URL          string `json:"url"`
	Content      string `json:"content" binding:"required"`
	ParentID     *int64 `json:"parent_id"`
	PostURL      string `json:"post_url"`
	PostTitle    string `json:"post_title"`
	AdminKey     string `json:"admin_key"`
	VerifyTicket string `json:"verify_ticket"`
}

// LoginRequest 登录请求体
type LoginRequest struct {
	Name     string `json:"name" binding:"required"`
	Password string `json:"password" binding:"required"`
}

// CommentResponse 评论响应体
type CommentResponse struct {
	ID          int64              `json:"id"`
	Author      string             `json:"author"`
	URL         *string            `json:"url"`
	Avatar      string             `json:"avatar"`
	ContentText string             `json:"contentText"`
	ContentHTML string             `json:"contentHtml"`
	PubDate     string             `json:"pubDate"`
	ParentID    *int64             `json:"parentId,omitempty"`
	Replies     []*CommentResponse `json:"replies,omitempty"`
	IsBlogger   bool               `json:"isBlogger"`
	// UrlDormant 该评论的个人网址是否处于休眠（见 doc/link_security.md 第 2.2 节）。
	// 功能关闭、无网址、无法判定时恒为 false（字段始终存在，形状稳定）。
	UrlDormant bool `json:"urlDormant"`
}

type AdminCommentResponse struct {
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

// Pagination 分页元数据
type Pagination struct {
	Page      int   `json:"page"`
	Limit     int   `json:"limit"`
	TotalPage int64 `json:"totalPage"`
}

// StatsOverview 统计概览（管理后台首页）
//
// 新增字段一律是**追加**的：已有字段的名称 / 类型 / 格式保持不变。
// 窗口类指标的边界与口径见 sqlite.commentRepo.GetStatsOverview；
// 客户端分布的归一化口径由 doc/vectors/stats-distribution-v1.json 钉死。
type StatsOverview struct {
	TotalComments      int64              `json:"totalComments"`
	TotalUsers         int64              `json:"totalUsers"`
	TotalPosts         int64              `json:"totalPosts"`
	StatusDistribution StatusDistribution `json:"statusDistribution"`
	RecentComments     []DateCount        `json:"recentComments"`
	TopCommenters      []TopCommenter     `json:"topCommenters"`

	// —— 时间窗口指标。窗口 = range 参数；range=0/all 时窗口 = 最近 12 个自然月
	// （起点与 recentComments 的月度分桶完全相同，因此 windowComments 等于分桶之和）——
	WindowComments     int64 `json:"windowComments"`
	PrevWindowComments int64 `json:"prevWindowComments"`
	// CommentsDelta 环比百分比，Math.round((cur-prev)/prev*100)；
	// 上一窗口为 0 时是 null（不是 0 也不是 100）
	CommentsDelta      *int64 `json:"commentsDelta"`
	WindowUsers        int64  `json:"windowUsers"`
	PrevWindowUsers    int64  `json:"prevWindowUsers"`
	UsersDelta         *int64 `json:"usersDelta"`
	TodayComments      int64  `json:"todayComments"`
	Last7DaysComments  int64  `json:"last7DaysComments"`

	// —— 热门文章 Top 5（COUNT DESC, post_slug ASC）——
	TopPosts []TopPost `json:"topPosts"`

	// —— 客户端分布 Top 5（归一化后的家族名，含所有状态）——
	// 元素类型复用 utils.NameCount：它就是「name + count」这一响应形状的唯一来源
	DeviceDistribution  []utils.NameCount `json:"deviceDistribution"`
	BrowserDistribution []utils.NameCount `json:"browserDistribution"`
	OSDistribution      []utils.NameCount `json:"osDistribution"`

	// —— 最新评论动态（pub_date DESC, id DESC 的前 5 条，含所有状态）——
	LatestComments []LatestComment `json:"latestComments"`
}

// TopPost 热门文章的一项
type TopPost struct {
	PostSlug        string `json:"postSlug"`
	Count           int64  `json:"count"`
	LastCommentDate string `json:"lastCommentDate"`
}

// LatestComment 最新评论动态的一项（字段原样下发，不截断正文）
type LatestComment struct {
	ID          int64  `json:"id"`
	Author      string `json:"author"`
	Email       string `json:"email"`
	PostSlug    string `json:"postSlug"`
	ContentText string `json:"contentText"`
	Status      string `json:"status"`
	PubDate     string `json:"pubDate"`
}

type StatusDistribution struct {
	Approved int64 `json:"approved"`
	Pending  int64 `json:"pending"`
	Deleted  int64 `json:"deleted"`
}

type DateCount struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

type TopCommenter struct {
	Author          string `json:"author"`
	Email           string `json:"email"`
	Count           int64  `json:"count"`
	LastCommentDate string `json:"lastCommentDate"`
}

// UserLinkStatus 某个归一化邮箱的「最后一条有效评论时间 + 最近一次非空网址」。
//
// 身份按归一化邮箱（lower(trim(email))）聚合，与公开评论区的 urlDormant 同一口径
// （doc/link_security.md 第 2 节）：用户列表按 author+email 分组，但共享同一邮箱的
// 多行必须下发同一个链接状态。
type UserLinkStatus struct {
	// LastAt 该邮箱最后一条有效评论的 pub_date（毫秒）；无记录时为零值
	LastAt int64
	// LatestURL 该邮箱最近一次非空 url（已 trim）；从未留过时为空字符串
	LatestURL string
}

// UserStats 用户统计
type UserStats struct {
	Author string `json:"author"`
	Email  string `json:"email"`
	// URL 该邮箱最近一次留下的非空个人网站（跨文章聚合）；从未留过时为空字符串。
	// 与 urlDormant 不同，功能关闭时也会下发（后台照样能看到用户留的链接）。
	URL string `json:"url"`
	// URLDormant 该网站链接当前是否休眠（doc/link_security.md 第 2.1 节）
	URLDormant bool `json:"urlDormant"`
	// URLTrustedUntil 该网站链接的人工确认到期时间（ISO 8601 UTC，**原样**下发写入值）；
	// 没有未过期的确认时为空字符串（不是 null）。功能关闭时也会下发 —— 确认本身独立生效。
	URLTrustedUntil string `json:"urlTrustedUntil"`
	// URLTrustedSource 该网站链接人工确认的来源：`""`（没有未过期确认）| `admin` | `self`。
	// 与 urlTrustedUntil 同一条件，形状稳定。
	URLTrustedSource string `json:"urlTrustedSource"`
	CommentCount     int64  `json:"commentCount"`
	ApprovedCount    int64  `json:"approvedCount"`
	PendingCount     int64  `json:"pendingCount"`
	DeletedCount     int64  `json:"deletedCount"`
	FirstCommentDate string `json:"firstCommentDate"`
	LastCommentDate  string `json:"lastCommentDate"`
	Blacklisted      bool   `json:"blacklisted"`
	// EmailVerified 该邮箱是否已通过邮箱验证（EmailVerification 中存在 verified = 1 的记录）
	EmailVerified bool `json:"emailVerified"`
	// EmailVerifiedAt 最近一次验证通过时间，未验证时为空字符串
	EmailVerifiedAt string `json:"emailVerifiedAt"`
}

// UserListData 用户列表响应数据
type UserListData struct {
	Users      []UserStats `json:"users"`
	Pagination Pagination  `json:"pagination"`
}

// UserCommentsData 用户评论列表响应数据
type UserCommentsData struct {
	Comments   []AdminCommentResponse `json:"comments"`
	Pagination Pagination              `json:"pagination"`
}

// MailLogQuery 管理端邮件列表（GET /admin/mails）的查询条件。
//
// Status / Type 只接受枚举值，其余取值（含 all）在 handler 层已被归一化为「不筛选」；
// Since 是 30 天保留窗口的起点（ISO 8601 UTC，与 created_at 同一格式，可直接字典序比较）。
type MailLogQuery struct {
	Status string
	Type   string
	Search string
	Since  string
	Offset int
	Limit  int
}

// MailLogList 邮件列表的查询结果（分页元信息由 handler 拼装）
type MailLogList struct {
	List  []MailLog `json:"list"`
	Total int64     `json:"total"`
}
