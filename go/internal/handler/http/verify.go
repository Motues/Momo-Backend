package http

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"

	"momo-backend-go/internal/model"
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

	// 认证记录：签发事件（尽力而为，写入失败不影响签发结果）。
	// 记录的是**总期望哈希次数**（而非响应里 pow.d 的单子挑战难度），与校验侧口径一致。
	difficulty := int64(utils.GetVerifyDifficulty())
	h.Repo.RecordVerifyEvent(c.Request.Context(), model.VerifyRecordInput{
		Event:       model.VerifyEventChallenge,
		ChallengeID: challenge.ChallengeID,
		Difficulty:  &difficulty,
		PostSlug:    postSlug,
		IP:          clientIP,
	})

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

	// 认证记录的公共字段：即使校验失败也尽量把「是哪一次认证」记下来
	difficulty := int64(utils.GetVerifyDifficulty())
	recordBase := model.VerifyRecordInput{
		ChallengeID: extractChallengeID(req.Prefix),
		ElapsedMs:   parseElapsedMs(req.ElapsedMs),
		Difficulty:  &difficulty,
		PostSlug:    postSlug,
		IP:          clientIP,
	}

	// 蜜罐字段被填写 => 认定为脚本，静默拒绝
	if strings.TrimSpace(req.Hp) != "" {
		recordBase.Event = model.VerifyEventFail
		recordBase.Reason = "honeypot"
		h.Repo.RecordVerifyEvent(c.Request.Context(), recordBase)

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
		recordBase.Event = model.VerifyEventFail
		recordBase.Reason = reason
		h.Repo.RecordVerifyEvent(c.Request.Context(), recordBase)

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

	recordBase.Event = model.VerifyEventPass
	h.Repo.RecordVerifyEvent(c.Request.Context(), recordBase)

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

// parseElapsedMs 解析客户端上报的求解耗时。
//
// 该字段是 json.RawMessage（与 utils.VerifySolution 的宽松判定保持一致），
// 可能是字符串、null 或畸形 JSON，解析不出来就记 NULL，绝不让它影响记录写入。
func parseElapsedMs(raw json.RawMessage) *int64 {
	if len(raw) == 0 {
		return nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	ms := int64(value)
	return &ms
}

// extractChallengeID 从挑战 prefix 里取出挑战 id（cid），仅用于把同一次认证的记录串起来。
//
// 这里**不做任何可信性判断**（签名校验是 utils.VerifySolution 的职责）：拿到的 cid
// 只是被当作不透明的分组标签，因此必须严格限制长度与类型，避免把攻击者构造的
// 超长内容写进记录表。取不到就返回空串，记录照常写入。
func extractChallengeID(prefix string) string {
	if prefix == "" || len(prefix) > 4096 {
		return ""
	}

	raw, err := base64.RawURLEncoding.DecodeString(prefix)
	if err != nil {
		// 兼容带 '=' 填充的 base64url（Node 的编码器不补填充，但答案来自客户端）
		if raw, err = base64.URLEncoding.DecodeString(prefix); err != nil {
			return ""
		}
	}

	var payload struct {
		Cid string `json:"cid"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	if payload.Cid == "" || len(payload.Cid) > 64 {
		return ""
	}
	return payload.Cid
}
