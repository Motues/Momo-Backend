package repository

import (
	"context"
	"momo-backend-go/internal/model"
)

type CommentRepository interface {
	Create(ctx context.Context, c *model.Comment) error
	GetByID(ctx context.Context, id int64) (*model.Comment, error)
	GetByPostSlug(ctx context.Context, slug string) ([]*model.Comment, error)
	List(ctx context.Context, offset, limit int, status string) ([]*model.Comment, int64, error)
	UpdateStatus(ctx context.Context, id int64, status string) error
	UpdateComment(ctx context.Context, id int64, fields map[string]interface{}) error
	Delete(ctx context.Context, id int64) error
	// Ping 健康检查用的轻量探针：只确认数据库连接可用，不查业务表。
	// 由 GET /health 调用（容器 HEALTHCHECK / 编排探针）。
	Ping(ctx context.Context) error

	// Stats methods
	GetStatsOverview(ctx context.Context, rangeParam string) (*model.StatsOverview, error)
	// GetUserList 返回**全部**匹配的用户（不做分页）：链接状态筛选必须发生在分页之前，
	// 因此分页由 handler 负责（见 handler/http/admin.go 的 GetUserList）。
	GetUserList(ctx context.Context, search string, verified string) ([]*model.UserStats, error)
	GetUserComments(ctx context.Context, author, email string, offset, limit int) ([]*model.AdminCommentResponse, int64, error)
	// Export
	ListAll(ctx context.Context) ([]*model.Comment, error)
	// Rate limiting
	GetLastCommentByIP(ctx context.Context, ip string) (*model.Comment, error)
	// 审核自动化：同一 IP 在时间窗内是否提交过完全相同的正文
	HasRecentDuplicate(ctx context.Context, ip, contentText string, sinceMillis int64) (bool, error)

	// Email verification
	CheckEmailVerified(ctx context.Context, email string) (bool, error)
	// IsEmailIdentityVerified 按**归一化**身份（lower(trim(email))）判断该邮箱是否已验证。
	//
	// 与 CheckEmailVerified（精确匹配，邮箱验证流程自用）刻意分开：历史链接同步把邮箱当作
	// 身份凭据（doc/link_security.md 第 2.1 节），查询与批量改写都用 lower(trim(email))，
	// 触发条件的「已验证」判定必须用同一口径，否则 A@B.com 验证过、后来提交 a@b.com 时
	// 明明找得到历史评论却永远发不出确认邮件。
	IsEmailIdentityVerified(ctx context.Context, email string) (bool, error)
	HasUnverifiedToken(ctx context.Context, email string) (bool, error)
	SaveVerificationToken(ctx context.Context, email, token, expiresAt, postSlug, postTitle string) error
	GetVerificationRecord(ctx context.Context, token, email string) (*model.EmailVerification, error)
	VerifyEmail(ctx context.Context, token, email string) (int64, error)

	// 休眠链接（见 doc/link_security.md 第 2.1 节）：按「本页评论涉及的邮箱集合」做**一次**
	// 分组查询拿到每个人的最后评论时间（避免 N+1）。emails 必须是归一化后的邮箱。
	LastCommentAtByEmails(ctx context.Context, emails []string) (map[string]int64, error)

	// LinkStatusByEmails 按「本页用户涉及的邮箱集合」做**一次**有序查询，拿到每个人的
	// 最后一条有效评论时间与最近一次非空网址（用户列表的 url / urlDormant 列专用，
	// 避免逐行查询）。emails 必须是归一化后的邮箱；返回的 map 只包含查到的邮箱。
	LinkStatusByEmails(ctx context.Context, emails []string) (map[string]model.UserLinkStatus, error)

	// 人工确认（TrustedLink，见 doc/link_security.md 第 4 节）
	//
	// UpsertTrustedLink 幂等 upsert：同一 (email, url) 已有记录时刷新 expires_at / created_at，
	// 不新增行（唯一索引 idx_tl_email_url）。
	UpsertTrustedLink(ctx context.Context, link *model.TrustedLink) error
	// DeleteTrustedLink 删除该 (email, url) 的确认，返回受影响行数（0 表示本来就没有）。
	DeleteTrustedLink(ctx context.Context, email, url string) (int64, error)
	// TrustedLinksByEmails 按「本页涉及的邮箱集合」做**一次**查询取回**未过期**的人工确认，
	// 返回「归一化邮箱 + \x00 + 逐字网址」→ {到期时间, 来源} 的映射（避免 N+1）。
	// emails 必须是归一化后的邮箱；nowMs 是「现在」（毫秒）。
	// 过期判定与 utils.IsTrustActive 完全一致：SQL 只用字典序粗筛（写入格式固定为 ISO），
	// 脏格式 / 边界值再由纯函数兜底，保证 fail-closed。
	TrustedLinksByEmails(ctx context.Context, emails []string, nowMs int64) (map[string]model.TrustedLinkInfo, error)

	// 邮件发送日志（MailLog，见任务规范第 3、9 节）
	//
	// 写入路径在 utils（最底层发送函数 SendRaw 里记一次），这里只提供管理端列表查询。
	ListMailLogs(ctx context.Context, q model.MailLogQuery) (*model.MailLogList, error)

	// 休眠链接提醒的状态机（DormantNotice，见任务规范第 4、8 节）
	//
	// DormantNoticesByEmails 按邮箱集合做**一次**查询取回提醒记录（键 = 归一化邮箱 + \x00 + 逐字网址）
	DormantNoticesByEmails(ctx context.Context, emails []string) (map[string]*model.DormantNotice, error)
	// UpsertDormantNotice 写入/刷新提醒记录（token / expires_at / notified_at 换新，notify_count 自增）
	UpsertDormantNotice(ctx context.Context, notice *model.DormantNotice) error
	// GetDormantNoticeByToken 按提醒令牌取记录；查不到返回 (nil, nil)
	GetDormantNoticeByToken(ctx context.Context, token string) (*model.DormantNotice, error)
	// DeleteDormantNoticeByToken 删除提醒记录（confirm / update 的一次性动作）
	DeleteDormantNoticeByToken(ctx context.Context, token string) error

	// 历史链接批量更新（LinkSyncRequest）
	LatestHistoricalURL(ctx context.Context, email, newURL string) (string, error)
	FindActiveLinkSyncRequest(ctx context.Context, email, newURL, now string) (*model.LinkSyncRequest, error)
	InvalidateLinkSyncRequests(ctx context.Context, email, now string) error
	CreateLinkSyncRequest(ctx context.Context, r *model.LinkSyncRequest) error
	GetLinkSyncRequest(ctx context.Context, token, email string) (*model.LinkSyncRequest, error)
	ConfirmLinkSyncRequest(ctx context.Context, id int64) error
	UpdateCommentURLsByEmail(ctx context.Context, email, newURL string) (int64, error)

	// Verify records（认证记录：评论无感验证的签发/通过/失败）
	//
	// RecordVerifyEvent 是**尽力而为**的写入：实现内部吞掉错误并只记日志，
	// 因此不返回 error —— 记录失败绝不能影响验证结果本身。
	RecordVerifyEvent(ctx context.Context, in model.VerifyRecordInput)
	GetVerifyOverview(ctx context.Context, days, offset int) (*model.VerifyOverview, error)
	ListVerifyRecords(ctx context.Context, q model.VerifyRecordQuery) (*model.VerifyRecordList, error)
	PruneVerifyRecords(ctx context.Context) (int64, error)
}
