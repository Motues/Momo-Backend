package http

import (
	"log"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"net/http"

	"github.com/gin-gonic/gin"
)

/*
休眠链接的**人工确认**（TrustedLink，见 doc/link_security.md 第 4 节）。

管理员在后台看过某条休眠链接、确认它没问题后写一条记录，该 `(邮箱, 网址)` 在
`expires_at` 之前不再被判为休眠；有效期 = 确认那一刻的 `link_dormant_days` 天
（脏值回退 30、上限 3650），到期自动恢复休眠 —— 读取时实时判断，不需要定时任务。

口径（三端逐字一致）：
  - `email` = trim + 小写；`url` = `sanitizeUrl(url)`（只允许 http/https/mailto/相对路径）；
  - 任一归一化后为空 → 400 `email and url are required`；
  - 不要求 `link_security_enabled` 为开：功能关着时写入的记录在功能开启后依然按 `expires_at` 生效；
  - 写入幂等（同一 (email, url) 只留一行），撤销幂等（本来就没有记录也返回 200）。
*/

// linkTrustRequiredMessage 参数校验错误文案（三端逐字一致）
const linkTrustRequiredMessage = "email and url are required"

// normalizeLinkTrustPair 归一化 (email, url)：邮箱 trim + 小写；网址过 sanitizeUrl。
//
// 请求体缺失 / 非法 / 字段类型不对时字段留空，与「字段缺失」落到同一条 400 文案
// （Node 用 `body?.email`、Worker 用 `normalizeEmail(undefined)`，行为一致）。
func normalizeLinkTrustPair(rawEmail, rawURL string) (string, string) {
	return utils.NormalizeEmail(rawEmail), utils.SanitizeUrl(rawURL)
}

// TrustLink POST /admin/links/trust  body: { email, url }
//
// 人工确认某条链接安全：幂等 upsert（重复确认只刷新 expires_at / created_at，不新增行）。
func (h *CommentHandler) TrustLink(c *gin.Context) {
	var body struct {
		Email string `json:"email"`
		URL   string `json:"url"`
	}
	// 绑定失败不单独报错：字段留空后与「缺少参数」走同一条文案
	_ = c.ShouldBindJSON(&body)

	email, targetURL := normalizeLinkTrustPair(body.Email, body.URL)
	if email == "" || targetURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": linkTrustRequiredMessage})
		return
	}

	// 有效期 = 确认时的 link_dormant_days 天（读取口径归一化后在此刻定格）
	days := utils.ResolveLinkDormantDays(utils.GetSetting(utils.LinkDormantDaysKey))
	nowMillisValue := nowMillis()
	expiresAt := utils.FormatTrustTime(nowMillisValue + int64(days)*utils.DayMillis)
	createdAt := utils.FormatTrustTime(nowMillisValue)

	if err := h.Repo.UpsertTrustedLink(c.Request.Context(), &model.TrustedLink{
		Email:     email,
		URL:       targetURL,
		ExpiresAt: expiresAt,
		CreatedAt: createdAt,
		// 管理员在用户列表点出来的确认（任务规范第 5 节）
		Source: model.TrustedLinkSourceAdmin,
	}); err != nil {
		log.Printf("[ERROR] 人工确认写入失败: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to trust link"})
		return
	}
	log.Printf("[INFO] Link trust granted: %s %s until %s", email, targetURL, expiresAt)

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Link trusted successfully",
		"data": gin.H{
			"email":     email,
			"url":       targetURL,
			"expiresAt": expiresAt,
			"days":      days,
		},
	})
}

// RevokeLinkTrust DELETE /admin/links/trust?email=&url=
//
// 撤销一条人工确认：删到记录 → `revoked: true`，本来就没有 → `revoked: false`（都是 200）。
func (h *CommentHandler) RevokeLinkTrust(c *gin.Context) {
	email, targetURL := normalizeLinkTrustPair(c.Query("email"), c.Query("url"))
	if email == "" || targetURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": linkTrustRequiredMessage})
		return
	}

	removed, err := h.Repo.DeleteTrustedLink(c.Request.Context(), email, targetURL)
	if err != nil {
		log.Printf("[ERROR] 撤销人工确认失败: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to revoke link trust"})
		return
	}

	if removed > 0 {
		log.Printf("[INFO] Link trust revoked: %s %s", email, targetURL)
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "Link trust revoked",
			"data": gin.H{
				"email":   email,
				"url":     targetURL,
				"revoked": true,
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Link is not trusted",
		"data": gin.H{
			"email":   email,
			"url":     targetURL,
			"revoked": false,
		},
	})
}
