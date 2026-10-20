package model

import (
	"time"
)

// EmailVerification 邮箱验证记录
type EmailVerification struct {
	ID         int64   `db:"id" json:"id"`
	Email      string  `db:"email" json:"email"`
	Token      string  `db:"token" json:"token"`
	ExpiresAt  string  `db:"expires_at" json:"expiresAt"`
	Verified   int     `db:"verified" json:"verified"`
	PostSlug   *string `db:"post_slug" json:"postSlug,omitempty"`
	PostTitle  *string `db:"post_title" json:"postTitle,omitempty"`
	CreatedAt  string  `db:"created_at" json:"createdAt"`
	VerifiedAt *string `db:"verified_at" json:"verifiedAt,omitempty"`
}

// LinkSyncRequest 历史链接批量更新的待确认记录（见 doc/link_security.md 第 3.3 节）
type LinkSyncRequest struct {
	ID        int64  `db:"id" json:"id"`
	Email     string `db:"email" json:"email"`
	NewURL    string `db:"new_url" json:"newUrl"`
	Token     string `db:"token" json:"token"`
	ExpiresAt string `db:"expires_at" json:"expiresAt"`
	Confirmed int    `db:"confirmed" json:"confirmed"`
	CreatedAt string `db:"created_at" json:"createdAt"`
}

// TrustedLink 人工确认过的休眠链接（见 doc/link_security.md 第 4 节）：管理员在后台把某条
// 休眠链接确认成安全，确认后在 N 天内不再判为休眠，到期自动恢复（N = 确认那一刻的
// link_dormant_days）。同一 (email, url) 只保留一行（幂等 upsert）。
type TrustedLink struct {
	ID int64 `db:"id" json:"id"`
	// Email 归一化（trim + 小写）后的邮箱：身份凭据
	Email string `db:"email" json:"email"`
	// URL 已过 sanitizeUrl 的网址（与 Comment.url 逐字比对）
	URL string `db:"url" json:"url"`
	// ExpiresAt 到期时间（ISO 8601 UTC，`YYYY-MM-DDTHH:mm:ss.sssZ`）
	ExpiresAt string `db:"expires_at" json:"expiresAt"`
	// CreatedAt 本次确认时间（ISO 8601 UTC，同上格式）
	CreatedAt string `db:"created_at" json:"createdAt"`
	// Source 确认来源：`admin`（管理员在用户列表人工确认）| `self`（评论者本人从提醒邮件里确认）。
	// 旧库由 0005 迁移补列，默认 `admin`（历史记录都是管理员点出来的）。
	Source string `db:"source" json:"source"`
}

// TrustedLinkSourceAdmin / TrustedLinkSourceSelf 人工确认的两个来源取值（三端逐字一致）。
const (
	TrustedLinkSourceAdmin = "admin"
	TrustedLinkSourceSelf  = "self"
)

// TrustedLinkInfo 一条**未过期**的人工确认的下发口径：到期时间 + 来源。
//
// 与 doc/link_security.md 第 5 节一致：只有该 (归一化邮箱, 逐字网址) 存在未过期确认时才下发，
// 用户列表用它填 urlTrustedUntil / urlTrustedSource 两列。
type TrustedLinkInfo struct {
	// ExpiresAt 写入时的原样值（`YYYY-MM-DDTHH:mm:ss.sssZ`）
	ExpiresAt string
	// Source `admin` | `self`
	Source string
}

// MailLog 邮件发送日志的一行（一次**实际尝试过的发送** = 一行）。
//
// 类型 / 状态枚举见任务规范第 2 节；SMTP 未配置或邮件通知关闭导致的「跳过」不记录。
type MailLog struct {
	ID        int64  `db:"id" json:"id"`
	Type      string `db:"type" json:"type"`
	Recipient string `db:"recipient" json:"recipient"`
	Subject   string `db:"subject" json:"subject"`
	Status    string `db:"status" json:"status"`
	// Error 失败原因；成功时为空字符串（下发时空串，与既有接口的空串风格一致）
	Error     string `db:"error" json:"error"`
	CreatedAt string `db:"created_at" json:"createdAt"`
}

// DormantNotice 休眠链接提醒的**状态机**记录（一个 (email, url) 一行）。
//
// 同一条链接在同一「休眠周期」（该邮箱最后评论时间未变）只提醒一次；记录过期或他后来又
// 评论过（新的休眠周期）会再次提醒并刷新 token / expires_at / notify_count。
type DormantNotice struct {
	ID int64 `db:"id" json:"id"`
	// Email 归一化（trim + 小写）邮箱
	Email string `db:"email" json:"email"`
	// URL 触发休眠的那个网址（逐字）
	URL string `db:"url" json:"url"`
	// LastCommentAt 发提醒时该邮箱「最后一条评论」的毫秒时间戳
	LastCommentAt int64 `db:"last_comment_at" json:"lastCommentAt"`
	// Token 提醒页令牌（每次发信都换新的）
	Token string `db:"token" json:"token"`
	// ExpiresAt 提醒页有效期 = 发信时刻 + link_dormant_days 天（ISO 8601 UTC）
	ExpiresAt string `db:"expires_at" json:"expiresAt"`
	// NotifiedAt 本次提醒时间（ISO 8601 UTC）
	NotifiedAt string `db:"notified_at" json:"notifiedAt"`
	// NotifyCount 该 (email, url) 累计提醒次数
	NotifyCount int64 `db:"notify_count" json:"notifyCount"`
}

// Comment 对应数据库中的 Comment 表
type Comment struct {
	ID          int64   `db:"id" json:"id"`
	PubDate     int64   `db:"pub_date" json:"-"` // Unix 时间戳（秒），不直接返回
	PostSlug    string  `db:"post_slug" json:"-"`
	Author      string  `db:"author" json:"author"`
	Email       string  `db:"email" json:"email"`
	URL         *string `db:"url" json:"url,omitempty"`
	Avatar      string  `json:"avatar,omitempty"`
	IPAddress   *string `db:"ip_address" json:"ipAddress,omitempty"`
	Device      *string `db:"device" json:"device,omitempty"`
	OS          *string `db:"os" json:"os,omitempty"`
	Browser     *string `db:"browser" json:"browser,omitempty"`
	UserAgent   *string `db:"user_agent" json:"userAgent,omitempty"`
	ContentText string  `db:"content_text" json:"contentText"`
	ContentHTML string  `db:"content_html" json:"contentHtml"`
	ParentID    *int64  `db:"parent_id" json:"parentId,omitempty"`
	Status      string  `db:"status" json:"status"`

	// 业务逻辑字段：用于构建树状结构
	Replies []*Comment `db:"-" json:"replies,omitempty"`
}

// SetPubDate 设置发布时间并转换为 RFC3339 格式
func (c *Comment) SetPubDate(timestamp int64) {
	c.PubDate = timestamp
}

// GetPubDate 获取格式化后的发布时间（YYYY-MM-DD HH:MM:SS）
func (c *Comment) GetPubDate() string {
	return time.Unix(c.PubDate, 0).Format("2006-01-02 15:04:05")
}

// GetPubDateRFC3339 获取 RFC3339 格式的发布时间
func (c *Comment) GetPubDateRFC3339() string {
	return time.Unix(c.PubDate, 0).Format(time.RFC3339)
}
