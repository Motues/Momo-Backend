package http

import (
	"momo-backend-go/internal/pkg/utils"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AuthMiddleware 验证管理 Key
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")

		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"code":    401,
				"message": "Invalid token",
			})
			return
		}

		token := strings.TrimPrefix(authHeader, "Bearer ")

		if token == "" || !utils.IsTokenValid(token) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"code":    401,
				"message": "Invalid token",
			})
			return
		}

		c.Next()
	}
}

func RegisterRoutes(r *gin.Engine, h *CommentHandler) {
	// 1. 用户端公开接口
	api := r.Group("/api")
	{
		api.POST("/comments", h.PostComment)
		api.GET("/comments", h.GetComments)
		api.GET("/verify-email/verify", h.VerifyEmail)
		// 历史链接批量更新的确认端点（邮件链接即凭据，不需要登录）
		api.GET("/link-sync/confirm", h.ConfirmLinkSync)
		// 休眠链接提醒页与两个自助动作（邮件令牌即凭据，不需要登录）
		api.GET("/link-dormant/notice", h.GetDormantNoticePage)
		api.POST("/link-dormant/confirm", h.ConfirmDormantNotice)
		api.POST("/link-dormant/update", h.UpdateDormantNotice)

		// 无感验证（Turnstile 风格）
		api.POST("/verify/challenge", h.VerifyChallenge)
		api.POST("/verify/solution", h.VerifySolution)
	}

	// 2. 管理员接口
	admin := r.Group("/admin")
	{
		admin.POST("/login", h.Login)

		auth := admin.Group("/")
		auth.Use(AuthMiddleware())
		{
			auth.GET("/settings", h.GetSettings)
			auth.PUT("/settings", h.UpdateSettings)
			auth.POST("/settings/test-email", h.TestEmail)
			auth.PUT("/password", h.ChangePassword)
			auth.POST("/logout", h.Logout)
			auth.GET("/comments/list", h.ListAllComments)
			auth.PUT("/comments/status", h.UpdateCommentStatus)
			auth.PUT("/comments/edit", h.UpdateComment)
			auth.GET("/stats/overview", h.GetStatsOverview)
			// 认证记录（无感验证的签发/通过/失败统计与明细）
			auth.GET("/verify/overview", h.GetVerifyOverview)
			auth.GET("/verify/records", h.GetVerifyRecords)
			auth.GET("/stats/users", h.GetUserList)
			auth.GET("/stats/users/comments", h.GetUserComments)
			// 邮件发送日志（最底层发送函数写入，见任务规范第 3、9 节）
			auth.GET("/mails", h.ListMails)
			// 休眠链接的人工确认（TrustedLink，见 doc/link_security.md 第 4 节）
			auth.POST("/links/trust", h.TrustLink)
			auth.DELETE("/links/trust", h.RevokeLinkTrust)
			auth.POST("/users/blacklist", h.AddUserToBlacklist)
			auth.DELETE("/users/blacklist", h.RemoveUserFromBlacklist)
			auth.GET("/data/export/settings", h.ExportSettings)
			auth.GET("/data/export/comments", h.ExportComments)
			auth.POST("/data/import/comments", h.ImportComments)
			auth.POST("/data/import/settings", h.ImportSettings)
		}
	}
}
