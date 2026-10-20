package http

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

/*
历史链接批量更新（doc/link_security.md 第 3 节）。

流程：评论者提交带新网址的评论 → 满足全部开启条件时写一条待确认记录 + 异步发确认邮件
→ 评论者点邮件里的链接 → GET /api/link-sync/confirm 校验通过后把该邮箱所有历史评论的
url 批量改成新网址，并返回与邮箱验证同款样式的纯 HTML 结果页。
*/

// LinkSyncRequestTTL 确认链接的有效期（24 小时）
const LinkSyncRequestTTL = 24 * time.Hour

// maybeRequestLinkSync 在评论落库后判定并触发历史链接同步（doc/link_security.md 第 3.1 节）。
//
// 开启条件（全部满足才发确认邮件，任一条不满足什么都不做、评论照常落库）：
//  1. link_sync_enabled = "true"（fail-closed）；
//  2. email_verify_enabled = "true"；
//  3. SMTP 可用；
//  4. 提交评论的邮箱已经通过邮箱验证；
//  5. 本次提交的 url 非空，且该邮箱存在「url 非空且与本次不同」的历史评论。
//
// 写记录与去重是同步的（快且需要确定的结果），只有发信走 goroutine（与既有通知一致）。
func (h *CommentHandler) maybeRequestLinkSync(c *gin.Context, req model.CommentRequest, newURL string) {
	if !utils.ResolveLinkSecurityEnabled(utils.GetSetting(utils.LinkSyncEnabledKey)) {
		return
	}
	if utils.GetSetting("email_verify_enabled") != "true" {
		return
	}
	if newURL == "" {
		return
	}
	if !utils.GetService().IsAvailable() {
		return
	}

	ctx := c.Request.Context()
	email := utils.NormalizeEmail(req.Email)
	if email == "" {
		return
	}

	// 「已验证」必须用**归一化身份**判定：邮箱是链接同步的唯一身份凭据，
	// 历史评论的查询与批量改写都按 lower(trim(email)) 比对（doc/link_security.md 第 3.1 节）
	verified, err := h.Repo.IsEmailIdentityVerified(ctx, email)
	if err != nil || !verified {
		return
	}

	oldURL, err := h.Repo.LatestHistoricalURL(ctx, email, newURL)
	if err != nil {
		log.Printf("[WARN] 历史链接同步：查询历史评论失败，已跳过: %v", err)
		return
	}
	if oldURL == "" {
		return
	}

	now := time.Now().UTC()
	nowStr := now.Format("2006-01-02T15:04:05.000Z")

	// 去重：同一邮箱 + 同一新网址已有未过期未确认记录时不重复发信
	existing, err := h.Repo.FindActiveLinkSyncRequest(ctx, email, newURL, nowStr)
	if err != nil {
		log.Printf("[WARN] 历史链接同步：查询待确认记录失败，已跳过: %v", err)
		return
	}
	if existing != nil {
		return
	}

	// 同一邮箱只保留一条有效待确认记录：把既有的未确认未过期记录一并作废
	if err := h.Repo.InvalidateLinkSyncRequests(ctx, email, nowStr); err != nil {
		log.Printf("[WARN] 历史链接同步：作废旧记录失败: %v", err)
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Printf("[WARN] 历史链接同步：生成确认令牌失败，已跳过: %v", err)
		return
	}
	token := hex.EncodeToString(tokenBytes)

	record := &model.LinkSyncRequest{
		Email:     email,
		NewURL:    newURL,
		Token:     token,
		ExpiresAt: now.Add(LinkSyncRequestTTL).Format("2006-01-02T15:04:05.000Z"),
		Confirmed: 0,
		CreatedAt: nowStr,
	}
	if err := h.Repo.CreateLinkSyncRequest(ctx, record); err != nil {
		log.Printf("[WARN] 历史链接同步：写入待确认记录失败，已跳过: %v", err)
		return
	}

	baseURL := resolvePublicBaseURL(c)
	confirmURL := fmt.Sprintf("%s/api/link-sync/confirm?token=%s&email=%s",
		baseURL, url.QueryEscape(token), url.QueryEscape(email))

	postTitle := utils.CheckContent(req.PostTitle)
	postURL := utils.SanitizeUrl(req.PostURL)
	author := utils.CheckContent(req.Author)
	// 服务实例在请求协程里解析好，goroutine 里不再读设置表（避免与并发写入争 SQLite 写锁）
	mailService := utils.GetService()
	// 收件人用**访客提交的原值**（与 Node / Worker 一致）；数据库里的身份始终是归一化后的值
	recipient := req.Email

	go func() {
		if err := mailService.SendLinkSyncConfirmationEmail(
			recipient, author, oldURL, newURL, postTitle, postURL, confirmURL); err != nil {
			log.Printf("链接同步确认邮件发送失败: %v", err)
		} else {
			log.Printf("Link sync confirmation sent to %s", recipient)
		}
	}()
}

// resolvePublicBaseURL 推断对外可访问的站点根地址：优先 verify_base_url，否则从
// Origin / Host 推断（与验证邮件里的口径一致）。
func resolvePublicBaseURL(c *gin.Context) string {
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
	return strings.TrimRight(baseURL, "/")
}

// ConfirmLinkSync GET /api/link-sync/confirm?token=&email=
//
// 邮件链接即凭据（与邮箱验证同一模型），不需要登录；不写认证记录、不落 IP。
func (h *CommentHandler) ConfirmLinkSync(c *gin.Context) {
	token := c.Query("token")
	email := c.Query("email")
	if token == "" || email == "" {
		linkSyncResult(c, false, "缺少确认参数")
		return
	}

	normalized := utils.NormalizeEmail(email)
	record, err := h.Repo.GetLinkSyncRequest(c.Request.Context(), token, normalized)
	if err != nil {
		log.Printf("链接同步确认查询失败: %v", err)
		linkSyncResult(c, false, "链接同步处理失败，请稍后重试")
		return
	}
	if record == nil {
		linkSyncResult(c, false, "确认链接无效")
		return
	}
	if record.Confirmed == 1 {
		linkSyncResult(c, true, "该链接同步已完成")
		return
	}

	expiresAt, parseErr := time.Parse("2006-01-02T15:04:05.000Z", record.ExpiresAt)
	if parseErr != nil || time.Now().After(expiresAt) {
		linkSyncResult(c, false, "确认链接已过期，请重新提交评论以获取新的确认邮件")
		return
	}

	count, err := h.Repo.UpdateCommentURLsByEmail(c.Request.Context(), normalized, record.NewURL)
	if err != nil {
		log.Printf("历史评论链接批量更新失败: %v", err)
		linkSyncResult(c, false, "链接同步处理失败，请稍后重试")
		return
	}
	if err := h.Repo.ConfirmLinkSyncRequest(c.Request.Context(), record.ID); err != nil {
		log.Printf("标记链接同步记录失败: %v", err)
	}

	linkSyncResult(c, true, fmt.Sprintf("链接同步完成！共 %d 条历史评论的网址已更新", count))
}

// linkSyncResult 输出纯 HTML 结果页（与邮箱验证页同一套样式）
func linkSyncResult(c *gin.Context, success bool, message string) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(linkSyncResultPage(success, message)))
}

// linkSyncResultPage 链接同步的结果页
func linkSyncResultPage(success bool, message string) string {
	title := "同步成功"
	if !success {
		title = "同步失败"
	}
	return emailActionResultPage(success, title, "链接同步", message)
}
