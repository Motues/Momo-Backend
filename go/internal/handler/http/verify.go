package http

import (
	"encoding/json"
	"strings"

	"momo-backend-go/internal/pkg/utils"

	"github.com/gin-gonic/gin"
	"net/http"
)

// VerifyChallengeRequest 签发挑战请求体
type VerifyChallengeRequest struct {
	PostSlug string `json:"post_slug"`
}

// VerifySolutionRequest 校验答案请求体（协议 v2）
//
// nonces / elapsed_ms 用 json.RawMessage 承载：Node 侧对它们做的是
// 「Array.isArray」与「Number()」这类宽松判定，先按具体类型绑定会在类型不符时
// 提前返回 400，破坏 reason 的可比性。
type VerifySolutionRequest struct {
	PostSlug  string          `json:"post_slug"`
	Prefix    string          `json:"prefix"`
	Sig       string          `json:"sig"`
	Nonces    json.RawMessage `json:"nonces"`
	ElapsedMs json.RawMessage `json:"elapsed_ms"`
	Hp        string          `json:"hp"`
	Instr     map[string]any  `json:"instr"`
}

// verifyDisabledData 验证关闭时的 data 载荷（与 Node 一致：只有 enabled / version）
type verifyDisabledData struct {
	Enabled bool `json:"enabled"`
	Version int  `json:"version"`
}

// verifyChallengeData 挑战响应载荷
type verifyChallengeData struct {
	Enabled     bool                            `json:"enabled"`
	Version     int                             `json:"version"`
	PostSlug    string                          `json:"post_slug"`
	ChallengeID string                          `json:"challenge_id"`
	Prefix      string                          `json:"prefix"`
	Sig         string                          `json:"sig"`
	ExpiresIn   int                             `json:"expires_in"`
	Pow         utils.VerifyPowSpec             `json:"pow"`
	Instr       *utils.InstrumentationChallenge `json:"instr,omitempty"`
}

// verifySolutionData 校验成功响应载荷
type verifySolutionData struct {
	Enabled   bool   `json:"enabled"`
	Version   int    `json:"version"`
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expires_in"`
}

// maxPostSlugRunes post_slug 的最大长度，单位是 **Unicode 码点**
// （与 Node/Worker 的 MAX_POST_SLUG 语义一致，不是字节数）
const maxPostSlugRunes = 200

// sanitizePostSlug 净化并按码点限制 post_slug 长度。
//
// 与 Node/Worker 的 `sanitizePostSlug` 等价：checkContent 后按**码点**截断到 200。
//
// 为什么按码点而不是字节：按字节截会把多字节字符从中间切断，产出非法 UTF-8，
// 与 Node/Worker 的结果不一致；而让 JS 侧按 UTF-16 码元截又会切出孤立代理项，
// 传到 Go 会变成 U+FFFD。码点是唯一能让三端逐字节一致的切法。
//
// 挑战签发、答案校验与提交评论时的票据校验**必须**共用这一个函数：slug 会被签进挑战载荷，
// 三处规则只要有一点差异，就会出现「同一篇文章的挑战兑换自己的票据却被拒」的假失败。
func sanitizePostSlug(raw string) string {
	return utils.TruncateRunes(utils.CheckContent(raw), maxPostSlugRunes)
}

// VerifyChallenge 签发无感验证挑战 (POST /api/verify/challenge)
func (h *CommentHandler) VerifyChallenge(c *gin.Context) {
	var req VerifyChallengeRequest
	// 无请求体也允许，仅用于探测开关状态
	_ = c.ShouldBindJSON(&req)

	postSlug := sanitizePostSlug(req.PostSlug)

	if !utils.IsVerifyEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "Verification disabled",
			"data": verifyDisabledData{
				Enabled: false,
				Version: utils.VerifyProtocolVersion,
			},
		})
		return
	}

	clientIP := utils.GetClientIP(c)
	// post_slug 必须传进挑战：它会被签进载荷，从而把这份挑战绑定到该文章，
	// 避免一次工作量证明被拿去兑换任意文章的票据。
	challenge, err := utils.CreateVerifyChallenge(clientIP, postSlug)
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
		"data": verifyChallengeData{
			Enabled:     true,
			Version:     utils.VerifyProtocolVersion,
			PostSlug:    postSlug,
			ChallengeID: challenge.ChallengeID,
			Prefix:      challenge.Prefix,
			Sig:         challenge.Sig,
			ExpiresIn:   challenge.ExpiresIn,
			Pow:         challenge.Pow,
			Instr:       challenge.Instr,
		},
	})
}

// VerifySolution 校验无感验证答案并签发票据 (POST /api/verify/solution)
func (h *CommentHandler) VerifySolution(c *gin.Context) {
	if !utils.IsVerifyEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "Verification disabled",
			"data": verifyDisabledData{
				Enabled: false,
				Version: utils.VerifyProtocolVersion,
			},
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
	// 与签发挑战时使用同一套净化规则，否则会出现「同一篇文章两次净化结果不同」的假拒绝
	postSlug := sanitizePostSlug(req.PostSlug)

	// 蜜罐字段被填写 => 认定为脚本，静默拒绝
	if strings.TrimSpace(req.Hp) != "" {
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Verification failed",
			"reason":  "honeypot",
		})
		return
	}

	ok, reason := utils.VerifySolution(utils.VerifySolutionInput{
		Prefix:    req.Prefix,
		Sig:       req.Sig,
		Nonces:    req.Nonces,
		ElapsedMs: req.ElapsedMs,
		IP:        clientIP,
		// 必须与签发挑战时的 post_slug 完全一致（挑战载荷里的 slug 由签名保护）
		PostSlug: postSlug,
		Instr:    req.Instr,
	})
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
		"data": verifySolutionData{
			Enabled:   true,
			Version:   utils.VerifyProtocolVersion,
			Ticket:    ticket,
			ExpiresIn: utils.TicketTTLSeconds,
		},
	})
}
