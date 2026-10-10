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

	// Stats methods
	GetStatsOverview(ctx context.Context, rangeParam string) (*model.StatsOverview, error)
	GetUserList(ctx context.Context, offset, limit int, search string, verified string) ([]*model.UserStats, int64, error)
	GetUserComments(ctx context.Context, author, email string, offset, limit int) ([]*model.AdminCommentResponse, int64, error)
	// Export
	ListAll(ctx context.Context) ([]*model.Comment, error)
	// Rate limiting
	GetLastCommentByIP(ctx context.Context, ip string) (*model.Comment, error)
	// 审核自动化：同一 IP 在时间窗内是否提交过完全相同的正文
	HasRecentDuplicate(ctx context.Context, ip, contentText string, sinceMillis int64) (bool, error)

	// Email verification
	CheckEmailVerified(ctx context.Context, email string) (bool, error)
	HasUnverifiedToken(ctx context.Context, email string) (bool, error)
	SaveVerificationToken(ctx context.Context, email, token, expiresAt, postSlug, postTitle string) error
	GetVerificationRecord(ctx context.Context, token, email string) (*model.EmailVerification, error)
	VerifyEmail(ctx context.Context, token, email string) (int64, error)

	// Verify records（认证记录：评论无感验证的签发/通过/失败）
	//
	// RecordVerifyEvent 是**尽力而为**的写入：实现内部吞掉错误并只记日志，
	// 因此不返回 error —— 记录失败绝不能影响验证结果本身。
	RecordVerifyEvent(ctx context.Context, in model.VerifyRecordInput)
	GetVerifyOverview(ctx context.Context, days, offset int) (*model.VerifyOverview, error)
	ListVerifyRecords(ctx context.Context, q model.VerifyRecordQuery) (*model.VerifyRecordList, error)
	PruneVerifyRecords(ctx context.Context) (int64, error)
}
