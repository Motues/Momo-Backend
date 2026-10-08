package http

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"momo-backend-go/internal/repository"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/mileusna/useragent"
)

type CommentHandler struct {
	Repo    repository.CommentRepository
	Version string
}

// 字段长度上限（与前端组件约束对齐）
const (
	MaxContentLen  = 2000
	MaxContentHTMLLen = 50000
	MaxAuthorLen   = 100
	MaxEmailLen    = 254
	MaxURLLen      = 500
	MaxPostSlugLen = 200
)

// PostComment 提交评论 (POST /api/comments)
func (h *CommentHandler) PostComment(c *gin.Context) {
	var req model.CommentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid request body",
		})
		return
	}

	// 长度上限校验：避免 MB 级内容导致数据库膨胀与 Markdown 渲染 CPU 放大
	if utf8.RuneCountInString(req.Content) > MaxContentLen ||
		utf8.RuneCountInString(req.Author) > MaxAuthorLen ||
		len(req.Email) > MaxEmailLen ||
		len(req.PostSlug) > MaxPostSlugLen ||
		len(req.URL) > MaxURLLen {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": 400,
			"message": fmt.Sprintf("Field too long (content ≤ %d, author ≤ %d, email ≤ %d, url ≤ %d, post_slug ≤ %d)",
				MaxContentLen, MaxAuthorLen, MaxEmailLen, MaxURLLen, MaxPostSlugLen),
		})
		return
	}

	// 1. 获取并解析 User-Agent
	uaString := c.GetHeader("User-Agent")
	var deviceStr, browserStr, osStr string

	ua := useragent.Parse(uaString)

	osStr = ua.OS + " " + ua.OSVersion
	browserStr = ua.Name + " " + ua.Version
	if ua.Mobile {
		deviceStr = "Mobile"
	} else if ua.Tablet {
		deviceStr = "Tablet"
	} else {
		deviceStr = "Desktop"
	}

	// 2. 检查评论频率控制 (60秒冷却)
	clientIP := utils.GetClientIP(c)
	lastComment, err := h.Repo.GetLastCommentByIP(c.Request.Context(), clientIP)
	if err == nil && lastComment != nil && lastComment.PubDate > 0 {
		if time.Now().UnixMilli()-lastComment.PubDate < 60000 {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"code":    429,
				"message": "Time limit exceeded. Please wait.",
			})
			return
		}
	}

	// 3. 检查 IP 黑名单
	if utils.CheckIPBlacklist(clientIP) {
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Your IP has been blocked",
		})
		return
	}

	// 4. 检查邮箱黑名单
	if req.Email != "" && utils.CheckEmailBlacklist(req.Email) {
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Your email has been blocked",
		})
		return
	}

	// 管理员评论密钥验证
	adminEmail := utils.GetSetting("admin_email")
	adminCommentKey := utils.GetSetting("admin_comment_key")
	adminCommentKeyEnabled := utils.GetSetting("admin_comment_key_enabled")
	isAdminVerified := false
	if req.Email == adminEmail && adminCommentKey != "" && adminCommentKeyEnabled == "true" {
		if req.AdminKey == adminCommentKey {
			isAdminVerified = true
		} else {
			c.JSON(http.StatusForbidden, gin.H{
				"code":    403,
				"message": "Invalid admin key",
			})
			return
		}
	}

	// 无感验证票据校验（管理员密钥已通过的博主不受影响）
	if !isAdminVerified && utils.IsVerifyEnabled() {
		if !utils.VerifyTicket(req.VerifyTicket, clientIP, req.PostSlug) {
			c.JSON(http.StatusForbidden, gin.H{
				"code":    403,
				"message": "Human verification failed or expired",
				"reason":  "VERIFY_REQUIRED",
			})
			return
		}
	}

	// 邮箱验证检查
	needsVerification := false
	emailVerifyEnabled := utils.GetSetting("email_verify_enabled")
	if emailVerifyEnabled == "true" && !isAdminVerified && utils.GetService().IsAvailable() {
		isVerified, err := h.Repo.CheckEmailVerified(c.Request.Context(), req.Email)
		if err == nil && !isVerified {
			needsVerification = true
			hasToken, _ := h.Repo.HasUnverifiedToken(c.Request.Context(), req.Email)
			if !hasToken {
				tokenBytes := make([]byte, 32)
				rand.Read(tokenBytes)
				token := hex.EncodeToString(tokenBytes)
				expiresAt := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
				_ = h.Repo.SaveVerificationToken(c.Request.Context(), req.Email, token, expiresAt, req.PostSlug, req.PostTitle)
				// 优先使用手动配置的验证地址，否则从请求头推断
					baseURL := utils.GetSetting("verify_base_url")
					if baseURL == "" {
						origin := c.GetHeader("Origin")
						if origin == "" {
							origin = c.Request.Host
						}
						if origin != "" && !strings.HasPrefix(origin, "http") {
							if strings.Contains(origin, "localhost") || strings.Contains(origin, "127.0.0.1") {
								origin = "http://" + origin
							} else {
								origin = "https://" + origin
							}
						}
						baseURL = origin
					}
					baseURL = strings.TrimRight(baseURL, "/")
					verifyURL := fmt.Sprintf("%s/api/verify-email/verify?token=%s&email=%s",
						baseURL, url.QueryEscape(token), url.QueryEscape(req.Email))
				go func() {
					if err := utils.GetService().SendVerificationEmail(req.Email, req.Author, req.PostTitle, req.PostSlug, verifyURL); err != nil {
						log.Printf("验证邮件发送失败: %v", err)
					}
				}()
			}
		}
	}

	// 5. XSS 检查（纯文本字段使用 CheckContent，content 走 Markdown + bluemonday 完整净化）
	sanitizedAuthor := utils.CheckContent(req.Author)
	// url 走协议白名单（只允许 http/https/mailto 与相对路径）
	sanitizedURL := utils.SanitizeUrl(req.URL)
	sanitizedPostTitle := utils.CheckContent(req.PostTitle)
	sanitizedPostURL := utils.SanitizeUrl(req.PostURL)
	sanitizedContent := utils.CheckContent(req.Content)

	// 6. 构造数据库模型
	comment := &model.Comment{
		PostSlug: req.PostSlug,
		Author:   sanitizedAuthor,
		Email:    req.Email,
		URL: func() *string {
			if sanitizedURL != "" {
				return &sanitizedURL
			} else {
				return nil
			}
		}(),
		PubDate: time.Now().UnixMilli(),
		// 纯文本列存原始文本（与 Node/Worker 一致，C2）：
		// SanitizeHtml 只用于 ParseMarkdown 的输出，否则「我写 <script> 会怎样」
		// 会被 bluemonday 剥成「我写 会怎样」
		ContentText: sanitizedContent,
		ContentHTML: utils.ParseMarkdown(sanitizedContent),
		ParentID:    req.ParentID,
		IPAddress:   ptrString(clientIP),
		Device:      ptrString(deviceStr),
		Browser:     ptrString(browserStr),
		UserAgent:   ptrString(uaString),
		OS:          ptrString(osStr),
		Status: func() string {
			if isAdminVerified {
				return "approved"
			}
			if needsVerification {
				return "pending"
			}
			return utils.GetCommentStatus()
		}(),
	}

	// 4. 写入数据库
	if err := h.Repo.Create(c.Request.Context(), comment); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "存储失败",
		})
		return
	}

	// 发送邮件通知
	if utils.GetService().IsAvailable() && utils.IsEmailEnabled() {
		go func() {
			ctx := context.Background()

			if req.ParentID != nil {
				parentComment, err := h.Repo.GetByID(ctx, *req.ParentID)
				if err != nil {
					log.Printf("Failed to fetch parent comment: %v", err)
					return
				}
				if parentComment.Email != req.Email {
					err = utils.GetService().SendCommentReplyNotification(
						parentComment.Email,
						parentComment.Author,
						sanitizedPostTitle,
						parentComment.ContentText,
						sanitizedAuthor,
						sanitizedContent,
						sanitizedPostURL,
					)
					if err != nil {
						log.Printf("Failed to send reply notification: %v", err)
					} else {
						log.Printf("Reply notification sent to %s", parentComment.Email)
					}
				}
			} else {
				err := utils.GetService().SendCommentNotification(
					sanitizedPostTitle,
					sanitizedPostURL,
					sanitizedAuthor,
					sanitizedContent,
				)
				if err != nil {
					log.Printf("Failed to send admin notification: %v", err)
				} else {
					log.Printf("Admin notification sent")
				}
			}
		}()
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": func() string {
			if needsVerification {
				return "Comment submitted! Verification email sent. Please check your inbox."
			}
			return "Comment submitted"
		}(),
	})
}

func (h *CommentHandler) GetComments(c *gin.Context) {
	slug := c.Query("post_slug")
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "post_slug is required"})
		return
	}

	// 参数解析与限流
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	nested := c.DefaultQuery("nested", "true") != "false" // 默认 true

	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 20
	}
	if page < 1 {
		page = 1
	}

	// 读取博主标识设置
	adminEmail := utils.GetSetting("admin_email")
	badgeEnabled := utils.GetSetting("blogger_badge_enabled")
	if badgeEnabled == "" {
		badgeEnabled = "false"
	}
	badgeText := utils.GetSetting("blogger_badge_text")
	placeholderName := utils.GetSetting("placeholder_name")
	placeholderEmail := utils.GetSetting("placeholder_email")
	placeholderContent := utils.GetSetting("placeholder_content")
	placeholderURL := utils.GetSetting("placeholder_url")
	adminCommentKey := utils.GetSetting("admin_comment_key")
	adminCommentKeyEnabled := utils.GetSetting("admin_comment_key_enabled")
	adminCommentKeyConfigured := "false"
	if adminCommentKey != "" && adminCommentKeyEnabled == "true" {
		adminCommentKeyConfigured = "true"
	}

	// 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
	// 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱。
	adminEmailHash := ""
	if adminEmail != "" && adminCommentKeyEnabled == "true" {
		adminEmailHash = fmt.Sprintf("%x", sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(adminEmail)))))
	}

	// 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）
	verifyEnabled, verifyHoneypot := utils.GetPublicVerifyConfig(slug)

	// 1. 从 Repo 获取所有已审核评论 (status = 'approved')
	allComments, err := h.Repo.GetByPostSlug(c.Request.Context(), slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "查询失败"})
		return
	}

	// 2. 转换为 Response 格式并处理头像
	var allResponses []*model.CommentResponse
	for _, comm := range allComments {
		res := &model.CommentResponse{
			ID:          comm.ID,
			Author:      comm.Author,
			URL:         comm.URL,
			Avatar:      utils.GetCravatar(comm.Email),
			ContentText: comm.ContentText,
			ContentHTML: comm.ContentHTML,
			PubDate:     time.UnixMilli(comm.PubDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			ParentID:    comm.ParentID,
			Replies:     []*model.CommentResponse{},
			IsBlogger:   comm.Email == adminEmail,
		}
		allResponses = append(allResponses, res)
	}

	var result []*model.CommentResponse = make([]*model.CommentResponse, 0)
	var total int

	// 3. 根据是否嵌套进行逻辑处理
	if nested {
		tree := buildCommentTree(allResponses)
		total = len(tree)

		start, end := slicePagination(total, page, limit)
		result = tree[start:end]
	} else {
		total = len(allResponses)
		start, end := slicePagination(total, page, limit)
		result = allResponses[start:end]
	}

	if result == nil {
		result = make([]*model.CommentResponse, 0)
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Comments fetched successfully",
		"data": gin.H{
			"comments": result,
			"pagination": gin.H{
				"page":      page,
				"limit":     limit,
				"totalPage": (total + limit - 1) / limit,
			},
			"blogger_badge_enabled":        badgeEnabled,
			"blogger_badge_text":           badgeText,
			"placeholder_name":             placeholderName,
			"placeholder_email":            placeholderEmail,
			"placeholder_content":          placeholderContent,
			"placeholder_url":              placeholderURL,
			"admin_comment_key_configured": adminCommentKeyConfigured,
			"admin_email_hash":             adminEmailHash,
			"verify_enabled":               verifyEnabled,
			"verify_honeypot":              verifyHoneypot,
		},
	})
}

func ptrString(s string) *string { return &s }

func buildCommentTree(comments []*model.CommentResponse) []*model.CommentResponse {
	nodes := make(map[int64]*model.CommentResponse)
	var roots []*model.CommentResponse

	for _, c := range comments {
		nodes[c.ID] = c
	}

	for _, c := range comments {
		if c.ParentID != nil {
			if parent, ok := nodes[*c.ParentID]; ok {
				parent.Replies = append(parent.Replies, c)
				continue
			}
		}
		roots = append(roots, c)
	}
	return roots
}

func slicePagination(total, page, limit int) (int, int) {
	// 越界页必须先夹取再切片：
	// page 来自查询参数且只做了下界校正（page < 1 → 1），未做上界限制。
	// 当 page 极大时 (page-1)*limit 会整数溢出为负数，
	// 既绕过下面的 start > total 分支，又让调用方以负下标切片而 panic（500）。
	// 这里把 start 夹到 [0, total]，任何越界页都退化为空区间。
	start := (page - 1) * limit
	end := start + limit
	// 上界溢出（start 为负）或下界溢出（limit 为负导致 end < start）都退化为空区间
	if start < 0 || end < start || start > total {
		return total, total
	}
	if end > total {
		end = total
	}
	return start, end
}
