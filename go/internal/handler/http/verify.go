package http

import (
	"strings"

	"momo-backend-go/internal/pkg/utils"

	"github.com/gin-gonic/gin"
	"net/http"
)

// VerifyChallengeRequest 签发挑战请求体
type VerifyChallengeRequest struct {
	PostSlug string `json:"post_slug"`
}

// VerifySolutionRequest 校验答案请求体
type VerifySolutionRequest struct {
	PostSlug  string `json:"post_slug"`
	Prefix    string `json:"prefix"`
	Sig       string `json:"sig"`
	Nonce     int64  `json:"nonce"`
	ElapsedMs int64  `json:"elapsed_ms"`
	Hp        string `json:"hp"`
}

// clampSlug 限制 slug 长度，避免异常输入
func clampSlug(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) > 200 {
		return raw[:200]
	}
	return raw
}

// VerifyChallenge 签发无感验证挑战 (POST /api/verify/challenge)
func (h *CommentHandler) VerifyChallenge(c *gin.Context) {
	var req VerifyChallengeRequest
	// 无请求体也允许，仅用于探测开关状态
	_ = c.ShouldBindJSON(&req)

	if !utils.IsVerifyEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "Verification disabled",
			"data":    gin.H{"enabled": false},
		})
		return
	}

	clientIP := utils.GetClientIP(c)
	challenge, err := utils.CreateVerifyChallenge(clientIP)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Internal server error",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Challenge issued",
		"data": gin.H{
			"enabled":      true,
			"post_slug":    clampSlug(req.PostSlug),
			"challenge_id": challenge.ChallengeID,
			"prefix":       challenge.Prefix,
			"difficulty":   challenge.Difficulty,
			"expires_in":   challenge.ExpiresIn,
			"sig":          challenge.Sig,
		},
	})
}

// VerifySolution 校验无感验证答案并签发票据 (POST /api/verify/solution)
func (h *CommentHandler) VerifySolution(c *gin.Context) {
	if !utils.IsVerifyEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "Verification disabled",
			"data":    gin.H{"enabled": false},
		})
		return
	}

	var req VerifySolutionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid request body",
		})
		return
	}

	clientIP := utils.GetClientIP(c)
	postSlug := clampSlug(req.PostSlug)

	// 蜜罐字段被填写 => 认定为脚本，静默拒绝
	if strings.TrimSpace(req.Hp) != "" {
		c.JSON(http.StatusForbidden, gin.H{
			"code":   403,
			"message": "Verification failed",
			"reason": "honeypot",
		})
		return
	}

	ok, reason := utils.VerifySolution(req.Prefix, req.Sig, req.Nonce, req.ElapsedMs, clientIP)
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Verification failed",
			"reason":  reason,
		})
		return
	}

	ticket, err := utils.CreateVerifyTicket(clientIP, postSlug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Internal server error",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Verification passed",
		"data": gin.H{
			"enabled":    true,
			"ticket":     ticket,
			"expires_in": utils.TicketTTLSeconds,
		},
	})
}
