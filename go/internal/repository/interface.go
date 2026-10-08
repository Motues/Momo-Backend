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

	// Email verification
	CheckEmailVerified(ctx context.Context, email string) (bool, error)
	HasUnverifiedToken(ctx context.Context, email string) (bool, error)
	SaveVerificationToken(ctx context.Context, email, token, expiresAt, postSlug, postTitle string) error
	GetVerificationRecord(ctx context.Context, token, email string) (*model.EmailVerification, error)
	VerifyEmail(ctx context.Context, token, email string) (int64, error)
}
