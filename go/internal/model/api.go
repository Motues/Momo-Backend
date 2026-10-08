package model

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

// StatsOverview 统计概览
type StatsOverview struct {
	TotalComments      int64                  `json:"totalComments"`
	TotalUsers         int64                  `json:"totalUsers"`
	TotalPosts         int64                  `json:"totalPosts"`
	StatusDistribution StatusDistribution      `json:"statusDistribution"`
	RecentComments     []DateCount             `json:"recentComments"`
	TopCommenters      []TopCommenter          `json:"topCommenters"`
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

// UserStats 用户统计
type UserStats struct {
	Author           string `json:"author"`
	Email            string `json:"email"`
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
