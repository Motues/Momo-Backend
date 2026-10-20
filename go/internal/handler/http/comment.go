package http

import (
	"context"
	"crypto/rand"
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
		utf8.RuneCountInString(req.PostSlug) > MaxPostSlugLen ||
		len(req.URL) > MaxURLLen {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": 400,
			"message": fmt.Sprintf("Field too long (content ≤ %d, author ≤ %d, email ≤ %d, url ≤ %d, post_slug ≤ %d)",
				MaxContentLen, MaxAuthorLen, MaxEmailLen, MaxURLLen, MaxPostSlugLen),
		})
		return
	}

	// 来源域名绑定（comment_verify_domain_enabled）：
	// 与下面的通用来源校验共用同一份白名单，但语义更严 —— allow_origin 未配置或为 * 时
	// **不跳过**（fail-closed），而且要求票据与本请求同域。
	//
	// 刻意排在通用来源校验**之前**：开启域名绑定时它是更严的那道闸门，让被拒请求统一拿到
	// 域名的 reason（DOMAIN_NOT_ALLOWED）而不是笼统的 ORIGIN_NOT_ALLOWED，便于博主区分
	// 「白名单没配好」与「别的站点在滥用」。位置同样早于限流 / 黑名单 / 发信路径。
	domain := utils.CheckVerifyDomain(c.GetHeader("Origin"), c.GetHeader("Referer"), req.PostURL)
	if !domain.OK {
		log.Printf("[security] 拒绝来源未授权的评论提交（域名校验）：%s origin=%q slug=%s",
			domain.Decision, domain.Origin, req.PostSlug)
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
			"reason":  "DOMAIN_NOT_ALLOWED",
		})
		return
	}

	// 服务端来源校验：CORS 只是浏览器机制，挡不住「对方站点在自己的服务端转发」。
	// allow_origin 配置成白名单（非空且不含 *）时，写接口只接受来自白名单的提交请求；
	// 判定必须早于限流 / 黑名单 / 人机验证与**一切发信路径**（验证邮件、站长通知、回复通知），
	// 否则白名单外的站点照样能借本站 SMTP 发信。口径见 doc/vectors/origin-v1.json。
	sourceDecision := utils.CheckRequestSource(utils.RequestSourceInput{
		AllowOrigin: utils.GetSetting("allow_origin"),
		Origin:      c.GetHeader("Origin"),
		Referer:     c.GetHeader("Referer"),
		PostURL:     req.PostURL,
	})
	if utils.IsSourceDenied(sourceDecision) {
		log.Printf("[security] 拒绝来源未授权的评论提交：%s %s", sourceDecision, req.PostSlug)
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
			"reason":  "ORIGIN_NOT_ALLOWED",
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

	// 2. 管理员身份判定（admin_emails 列表，旧键 admin_email 为空时回落）：
	// 必须早于限流与黑名单检查，因为管理员邮箱不受 60 秒评论冷却限制。
	admins := utils.ResolveAdminEmailsFromSettings()
	isAdminEmail := utils.IsAdminEmail(req.Email, admins)

	// 3. 检查评论频率控制 (60秒冷却，管理员邮箱不限流)
	clientIP := utils.GetClientIP(c)
	if !isAdminEmail {
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

	// 管理员评论密钥验证（admins 已在上方读取）
	adminCommentKey := utils.GetSetting("admin_comment_key")
	adminCommentKeyEnabled := utils.GetSetting("admin_comment_key_enabled")
	isAdminVerified := false
	if isAdminEmail && adminCommentKey != "" && adminCommentKeyEnabled == "true" {
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
		// 票据里的 slug 是**净化后**的值（见 verify.go 里签发票据时传入的 sanitizePostSlug），
		// 所以这里必须用同一套净化规则处理后才能比对 —— 否则只要文章标识里含有
		// CheckContent 会改写的片段（例如 <script>…</script>），签出的票据就永远兑不掉，
		// 真人会持续收到假 VERIFY_REQUIRED。
		//
		// 注意只对「票据比对」用净化值：评论落库仍用原始 req.PostSlug，
		// 因为读取端是按原始 slug 查询的，改动存储口径会让评论查不出来。
		if !utils.VerifyTicket(req.VerifyTicket, clientIP, sanitizePostSlug(req.PostSlug), domain.OrgHash) {
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
	// 邮件服务实例在**请求协程内**解析好再交给 goroutine：
	// GetService 会读若干设置（数据库读），放在 goroutine 里会与紧随其后的评论写入
	// 争抢 SQLite 的写锁（并发读写提交阶段会拿到 SQLITE_BUSY）。
	emailService := utils.GetService()
	if emailVerifyEnabled == "true" && !isAdminVerified && emailService.IsAvailable() {
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
				verifyURL := buildVerifyEmailURL(c, token, req.Email)
				go func() {
					if err := emailService.SendVerificationEmail(req.Email, req.Author, req.PostTitle, req.PostSlug, verifyURL); err != nil {
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
			// 审核自动化：只有在「本来会直接通过」时才跑垃圾规则 ——
			// comment_auto_approve = "false" 时全部评论都要人工审核，规则判定没有意义
			base := utils.GetCommentStatus()
			if base != "approved" {
				return base
			}
			if reason := spamReason(h, c, clientIP, sanitizedContent, sanitizedAuthor, sanitizedURL); reason != "" {
				log.Printf("[INFO] 评论被审核自动化判为垃圾，已转入待审核: %s (post_slug=%s)", reason, req.PostSlug)
				return "pending"
			}
			return "approved"
		}(),
	}

	// 4. 写入数据库
	if err := h.Repo.Create(c.Request.Context(), comment); err != nil {
		log.Printf("[ERROR] 评论存储失败 (post_slug=%s): %v", req.PostSlug, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "存储失败",
		})
		return
	}

	// 发送邮件通知（正文用渲染后的 HTML：净化过的 content_html + 短代码水合，见 doc/mail.md）
	// 同样先在请求协程里解析好服务实例，goroutine 里就不再读设置表
	notificationService := utils.GetService()
	if notificationService.IsAvailable() && utils.IsEmailEnabled() {
		go func() {
			ctx := context.Background()

			if req.ParentID != nil {
				parentComment, err := h.Repo.GetByID(ctx, *req.ParentID)
				if err != nil {
					log.Printf("Failed to fetch parent comment: %v", err)
					return
				}
				if parentComment.Email != req.Email {
					err = notificationService.SendCommentReplyNotification(
						parentComment.Email,
						parentComment.Author,
						sanitizedPostTitle,
						parentComment.ContentText,
						sanitizedAuthor,
						sanitizedContent,
						sanitizedPostURL,
						utils.HydrateEmailEmoji(parentComment.ContentHTML),
						utils.HydrateEmailEmoji(comment.ContentHTML),
					)
					if err != nil {
						log.Printf("Failed to send reply notification: %v", err)
					} else {
						log.Printf("Reply notification sent to %s", parentComment.Email)
					}
				}
			} else {
				err := notificationService.SendCommentNotification(
					sanitizedPostTitle,
					sanitizedPostURL,
					sanitizedAuthor,
					sanitizedContent,
					utils.HydrateEmailEmoji(comment.ContentHTML),
				)
				if err != nil {
					log.Printf("Failed to send admin notification: %v", err)
				} else {
					log.Printf("Admin notification sent")
				}
			}
		}()
	}

	// 历史链接批量更新（doc/link_security.md 第 3 节）：满足全部开启条件时写一条待确认记录
	// 并异步发确认邮件；不满足则什么都不做，评论照常落库。
	h.maybeRequestLinkSync(c, req, sanitizedURL)

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

// nowMillis 返回当前时间的毫秒值。
//
// 抽成包级变量是为了让「休眠链接」的边界用例（刚好 N 天 vs N 天 + 1 毫秒）
// 能精确固定 now；生产路径就是 time.Now().UnixMilli()。
var nowMillis = func() int64 { return time.Now().UnixMilli() }

// 公开评论列表限流：缓解批量遍历 post_slug 采集博主邮箱哈希等爬取行为
// （与 Node 的 getCommentBySlug.ts、Worker 的 getComments.ts 逐项一致：
// 同一 IP 每 60 秒最多 120 次，超出返回 429）
const (
	commentsGetRateLimit  = 120
	commentsGetRateWindow = time.Minute
)

func (h *CommentHandler) GetComments(c *gin.Context) {
	clientIP := utils.GetClientIP(c)
	if !utils.AllowRequest("comments:get:"+clientIP, commentsGetRateLimit, commentsGetRateWindow) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"code":    429,
			"message": "Too many requests. Please slow down.",
		})
		return
	}

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
	admins := utils.ResolveAdminEmailsFromSettings()
	badgeEnabled := utils.GetSetting("blogger_badge_enabled")
	if badgeEnabled == "" {
		badgeEnabled = "false"
	}
	badgeText := utils.GetSetting("blogger_badge_text")
	placeholderName := utils.GetSetting("placeholder_name")
	placeholderEmail := utils.GetSetting("placeholder_email")
	placeholderContent := utils.GetSetting("placeholder_content")
	placeholderURL := utils.GetSetting("placeholder_url")
	// 表情配置（OwO 来源）：读取路径宽容归一化，未配置时回落默认源并 fail-open 为启用；
	// 同时下发数组（v3）与数组第一个地址（兼容旧前端的 emoji_cdn_url）
	emojiCdnURLs, emojiEnabled := utils.ResolveEmojiConfig(
		utils.GetSetting(utils.EmojiCdnURLsKey),
		utils.GetSetting(utils.EmojiCdnURLKey),
		utils.GetSetting(utils.EmojiEnabledKey))
	adminCommentKey := utils.GetSetting("admin_comment_key")
	adminCommentKeyEnabled := utils.GetSetting("admin_comment_key_enabled")
	adminCommentKeyConfigured := "false"
	if adminCommentKey != "" && adminCommentKeyEnabled == "true" {
		adminCommentKeyConfigured = "true"
	}

	// 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
	// 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱。
	//
	// admin_email_hash（旧字段）= 通知邮箱的哈希，兼容旧前端；
	// admin_email_hashes（v1.8.0）= 列表里每个管理员邮箱的哈希。
	adminEmailHash := ""
	adminEmailHashes := []string{}
	if adminCommentKeyEnabled == "true" {
		if notifyEmail := utils.ResolveNotifyEmailFromSettings(); notifyEmail != "" {
			adminEmailHash = utils.EmailHash(notifyEmail)
		}
		adminEmailHashes = utils.AdminEmailHashes(admins)
	}

	// 无感验证公开配置（开关 + 按文章派生的蜜罐字段名 + 协议版本）
	verifyEnabled, verifyHoneypot, verifyVersion := utils.GetPublicVerifyConfig(slug)

	// 1. 从 Repo 获取所有已审核评论 (status = 'approved')
	allComments, err := h.Repo.GetByPostSlug(c.Request.Context(), slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "查询失败"})
		return
	}

	// 2. 转换为 Response 格式并处理头像
	//    休眠链接（doc/link_security.md 第 2 节）：功能开启时，对本页评论涉及的邮箱集合
	//    做**一次**分组查询拿到每个人的最后评论时间 + 一次查询取回未过期的人工确认，
	//    再逐条实时推导 urlDormant（不落库、不跑后台任务）；功能关闭时一律 false 且跳过查询。
	lastCommentAt := map[string]int64{}
	trustedLinks := map[string]model.TrustedLinkInfo{}
	linkSecurityEnabled := utils.ResolveLinkSecurityEnabled(utils.GetSetting(utils.LinkSecurityEnabledKey))
	linkDormantDays := utils.ResolveLinkDormantDays(utils.GetSetting(utils.LinkDormantDaysKey))
	nowMillisValue := nowMillis()
	if linkSecurityEnabled {
		emails := make([]string, 0, len(allComments))
		seen := make(map[string]bool, len(allComments))
		for _, comm := range allComments {
			if comm.URL == nil || strings.TrimSpace(*comm.URL) == "" {
				continue
			}
			email := utils.NormalizeEmail(comm.Email)
			if email == "" || seen[email] {
				continue
			}
			seen[email] = true
			emails = append(emails, email)
		}
		if len(emails) > 0 {
			result, err := h.Repo.LastCommentAtByEmails(c.Request.Context(), emails)
			if err != nil {
				// 查询失败只记日志：休眠标记是提示性功能，不能让公开评论列表整体 500
				log.Printf("[WARN] 休眠链接分组查询失败，本次一律不标记: %v", err)
			} else {
				lastCommentAt = result
			}
			// 人工确认（管理员在后台「确认安全」过、且未过期）→ 该 (邮箱, 网址) 不再休眠
			trusted, err := h.Repo.TrustedLinksByEmails(c.Request.Context(), emails, nowMillisValue)
			if err != nil {
				log.Printf("[WARN] 人工确认查询失败，本次一律按未确认处理: %v", err)
			} else {
				trustedLinks = trusted
			}
		}
	}

	var allResponses []*model.CommentResponse
	// 评论 id → 归一化邮箱：公开响应不下发 email，休眠提醒要按身份定位收件人，
	// 因此在这里顺手记一份反查表（不改变任何响应字段）。
	emailsByCommentID := make(map[int64]string, len(allComments))
	for _, comm := range allComments {
		emailsByCommentID[comm.ID] = utils.NormalizeEmail(comm.Email)
		hasURL := comm.URL != nil && strings.TrimSpace(*comm.URL) != ""
		lastAt, known := lastCommentAt[utils.NormalizeEmail(comm.Email)]
		trusted := false
		if hasURL {
			_, trusted = trustedLinks[utils.TrustedLinkKey(comm.Email, *comm.URL)]
		}
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
			IsBlogger:   utils.IsAdminEmail(comm.Email, admins),
			UrlDormant: utils.IsUrlDormant(
				linkSecurityEnabled, hasURL, linkDormantDays, nowMillisValue-lastAt, known, trusted),
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

	// 4. 惰性休眠提醒（任务规范第 8.1 节）：只在功能开启时执行；异步发信 + 成功才落记录，
	//    任何异常只写服务端日志，绝不影响本次评论列表响应。
	if linkSecurityEnabled {
		h.maybeSendDormantNotices(c, result, emailsByCommentID, lastCommentAt, linkDormantDays)
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
			"admin_email_hashes":           adminEmailHashes,
			"verify_enabled":               verifyEnabled,
			"verify_honeypot":              verifyHoneypot,
			"verify_version":               verifyVersion,
			"emoji_cdn_url":                emojiCdnURLs[0],
			"emoji_cdn_urls":               emojiCdnURLs,
			"emoji_enabled":                emojiEnabled,
		},
	})
}

// buildVerifyEmailURL 拼出邮箱验证链接：优先使用手动配置的验证地址，否则从请求头推断
func buildVerifyEmailURL(c *gin.Context, token, email string) string {
	return fmt.Sprintf("%s/api/verify-email/verify?token=%s&email=%s",
		resolvePublicBaseURL(c), url.QueryEscape(token), url.QueryEscape(email))
}

func ptrString(s string) *string { return &s }

// spamReason 判定已净化后的评论是否命中垃圾规则（含「同 IP 重复内容」）。
//
// 返回命中原因，未命中返回空串。规则配置损坏或重复检测查询失败时保持放行并写日志：
// 一条坏配置不能让全站评论都卡在待审核。
func spamReason(h *CommentHandler, c *gin.Context, ip, content, author, url string) string {
	keywords, maxLinks, minLength, window := utils.GetCommentSpamSettings()

	if reason := utils.EvaluateSpamRules(content, author, url, keywords, maxLinks, minLength); reason != "" {
		return reason
	}

	if window > 0 {
		since := time.Now().UnixMilli() - int64(window)*60*1000
		duplicated, err := h.Repo.HasRecentDuplicate(c.Request.Context(), ip, content, since)
		if err != nil {
			log.Printf("[WARN] 重复评论检测失败，已跳过该规则: %v", err)
			return ""
		}
		if duplicated {
			return "duplicate:" + strconv.Itoa(window) + "m"
		}
	}

	return ""
}

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
