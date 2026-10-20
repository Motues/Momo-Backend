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

	"github.com/gin-gonic/gin"
)

/*
休眠链接提醒（DormantNotice，见任务规范第 4、8 节）。

三个公共端点（不需要登录，邮件令牌即凭据）：
  - GET  /api/link-dormant/notice?token=  中文 HTML 提醒页（不跳转前端）；
  - POST /api/link-dormant/confirm?token= 「我仍在使用」→ 写一条 source='self' 的 TrustedLink 并删除记录；
  - POST /api/link-dormant/update?token=  提交新链接（表单字段 url）→ 批量更新历史评论 + 同上。

两个动作都是**一次性**的：动作完成后提醒记录被删掉，同一个 token 再访问就落到「该提醒已失效或已处理」。
*/

// 结果页 / 页面文案（三端逐字一致）
const (
	dormantMsgMissingToken = "缺少提醒参数。"
	dormantMsgNotFound     = "该提醒已失效或已处理。"
	dormantMsgExpired      = "该提醒已过期，请在评论区留言或等待新的提醒邮件。"
	dormantMsgInvalidURL   = "新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。"
	dormantMsgError        = "处理失败，请稍后重试。"
)

// MaxDormantNoticesPerRequest 每次请求最多发出的休眠提醒邮件数。
//
// 老站点第一次开启这个功能时，历史上可能一下子有几十条链接同时「已经休眠」；
// 不设上限就会在第一次有人访问评论区时群发几十封邮件（容易被 SMTP 判成垃圾发信）。
// 超出上限的候选留给后续请求：状态机保证同一个休眠周期不会重复提醒，
// 因此只是把这一轮提醒分几次完成（任务规范第 8.1 节）。
const MaxDormantNoticesPerRequest = 3

// runDormantTask 异步执行「发提醒邮件 → 成功才落记录」。
//
// 抽成包级变量只为一件事：让用例能同步执行（否则断言要轮询等待 goroutine）。
// 生产路径就是 `go fn()`。
var runDormantTask = func(fn func()) { go fn() }

// resolveDormantDays 读取当前生效的休眠天数（脏值回退 30、超上限夹取 3650）
func resolveDormantDays() int {
	return utils.ResolveLinkDormantDays(utils.GetSetting(utils.LinkDormantDaysKey))
}

// isHttpURL 判断网址是否以 http:// 或 https:// 开头（不区分大小写）。
//
// 这是 §8.3 `update` 在 sanitizeUrl 之外的**额外**要求（口径与 Node/Worker 逐字一致）：
// sanitizeUrl 还放行 mailto: 与协议相对地址（//host），但它们不是「个人网站」，一律非法。
func isHttpURL(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// dormantNoticePageURL 拼出提醒页地址（优先 verify_base_url，否则从请求头推断）
func dormantNoticePageURL(c *gin.Context, token string) string {
	return fmt.Sprintf("%s/api/link-dormant/notice?token=%s",
		resolvePublicBaseURL(c), url.QueryEscape(token))
}

// loadDormantNotice 取记录并做「缺 token / 查不到 / 已过期」三道检查。
// 返回 (nil, "") 表示调用方可以直接把 message 输出给用户。
func (h *CommentHandler) loadDormantNotice(c *gin.Context, token string) (*model.DormantNotice, string) {
	if token == "" {
		return nil, dormantMsgMissingToken
	}
	record, err := h.Repo.GetDormantNoticeByToken(c.Request.Context(), token)
	if err != nil {
		log.Printf("[WARN] 查询休眠提醒记录失败: %v", err)
		return nil, dormantMsgError
	}
	if record == nil {
		return nil, dormantMsgNotFound
	}
	// 过期判定与人工确认同一套：严格大于 now 才算有效（格式不符同样按已过期处理）
	if !utils.IsTrustActive(record.ExpiresAt, nowMillis()) {
		return nil, dormantMsgExpired
	}
	return record, ""
}

// GetDormantNoticePage GET /api/link-dormant/notice?token=
//
// token 有效时下发中文 HTML 页面（含当前链接、两个表单与有效期说明）。
func (h *CommentHandler) GetDormantNoticePage(c *gin.Context) {
	record, message := h.loadDormantNotice(c, c.Query("token"))
	if record == nil {
		dormantResult(c, false, message)
		return
	}

	c.Data(http.StatusOK, "text/html; charset=utf-8",
		[]byte(dormantNoticePage(record.URL, c.Query("token"), resolveDormantDays())))
}

// ConfirmDormantNotice POST /api/link-dormant/confirm?token=
//
// 「我仍在使用」：写一条 source='self' 的 TrustedLink（有效期 = 现在 + link_dormant_days 天）
// 并删除该 DormantNotice 记录 —— 删记录是为了：确认到期后若仍没评论，会再次休眠并再发一封提醒。
func (h *CommentHandler) ConfirmDormantNotice(c *gin.Context) {
	token := c.Query("token")
	record, message := h.loadDormantNotice(c, token)
	if record == nil {
		dormantResult(c, false, message)
		return
	}

	days := resolveDormantDays()
	if !h.trustDormantLink(c, record.Email, record.URL, days) {
		dormantResult(c, false, dormantMsgError)
		return
	}
	if err := h.Repo.DeleteDormantNoticeByToken(c.Request.Context(), token); err != nil {
		// 删不掉也不该让用户看到失败：确认本身已经生效（记录会在过期后再提醒一次）
		log.Printf("[WARN] 删除休眠提醒记录失败: %v", err)
	}

	dormantResult(c, true, fmt.Sprintf("确认成功！该链接已恢复正常，%d 天内不会再标记为休眠。", days))
}

// UpdateDormantNotice POST /api/link-dormant/update?token=  （表单字段 url）
//
// 提交新链接：批量把该邮箱所有历史评论的 url 改成新链接（幂等），再写一条 source='self'
// 的 TrustedLink（**新链接**）并删除旧 DormantNotice 记录 —— 否则新链接会因为
// 「最后评论时间没变」立刻又被判休眠（任务规范第 8.3 节）。
func (h *CommentHandler) UpdateDormantNotice(c *gin.Context) {
	token := c.Query("token")
	record, message := h.loadDormantNotice(c, token)
	if record == nil {
		dormantResult(c, false, message)
		return
	}

	// 合法性 = 非空 + sanitizeUrl 通过 + 以 http:// / https:// 开头（不区分大小写）。
	// mailto: 与协议相对地址（//host）在本流程里也算非法：这封提醒针对的是「个人网站」。
	newURL := utils.SanitizeUrl(c.PostForm("url"))
	if newURL == "" || !isHttpURL(newURL) {
		dormantResult(c, false, dormantMsgInvalidURL)
		return
	}

	// 身份是归一化邮箱：批量改写与提醒记录都用同一个口径
	email := utils.NormalizeEmail(record.Email)
	count, err := h.Repo.UpdateCommentURLsByEmail(c.Request.Context(), email, newURL)
	if err != nil {
		log.Printf("[ERROR] 休眠提醒：批量更新历史评论网址失败: %v", err)
		dormantResult(c, false, dormantMsgError)
		return
	}

	days := resolveDormantDays()
	if !h.trustDormantLink(c, email, newURL, days) {
		dormantResult(c, false, dormantMsgError)
		return
	}
	if err := h.Repo.DeleteDormantNoticeByToken(c.Request.Context(), token); err != nil {
		log.Printf("[WARN] 删除休眠提醒记录失败: %v", err)
	}

	if count > 0 {
		dormantResult(c, true, fmt.Sprintf("链接更新成功！共 %d 条历史评论的网址已更新。", count))
		return
	}
	dormantResult(c, true, "新链接与现有链接相同，未做修改。")
}

// trustDormantLink 写入一条 source='self' 的人工确认（评论者本人从提醒邮件里确认）
func (h *CommentHandler) trustDormantLink(c *gin.Context, email, targetURL string, days int) bool {
	nowMs := nowMillis()
	if err := h.Repo.UpsertTrustedLink(c.Request.Context(), &model.TrustedLink{
		Email:     utils.NormalizeEmail(email),
		URL:       targetURL,
		ExpiresAt: utils.FormatTrustTime(nowMs + int64(days)*utils.DayMillis),
		CreatedAt: utils.FormatTrustTime(nowMs),
		Source:    model.TrustedLinkSourceSelf,
	}); err != nil {
		log.Printf("[ERROR] 休眠提醒：写入人工确认失败: %v", err)
		return false
	}
	return true
}

// dormantResult 输出纯 HTML 结果页（与邮箱验证 / 链接同步同一套样式）
func dormantResult(c *gin.Context, success bool, message string) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(dormantResultPage(success, message)))
}

// dormantResultPage 休眠提醒的结果页
func dormantResultPage(success bool, message string) string {
	title := "操作成功"
	if !success {
		title = "操作失败"
	}
	return emailActionResultPage(success, title, "链接休眠提醒", message)
}

// dormantNoticePage 提醒页：标题 + 说明 + 当前链接 + 两个表单 + 页脚
func dormantNoticePage(targetURL, token string, dormantDays int) string {
	escapedToken := utils.HtmlEscape(url.QueryEscape(token))
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>链接已休眠 - 链接休眠提醒</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 48px 40px;
      max-width: 480px;
      width: 90%%;
      text-align: center;
    }
    h1 {
      font-size: 24px;
      color: #1a1a1a;
      margin: 0 0 12px 0;
    }
    p {
      font-size: 15px;
      color: #555;
      line-height: 1.6;
      margin: 0 0 16px 0;
    }
    .url {
      word-break: break-all;
      background: #f5f5f5;
      border-radius: 4px;
      padding: 12px;
      font-size: 14px;
      color: #0066cc;
    }
    form {
      margin: 16px 0 0 0;
    }
    input[type="text"] {
      width: 100%%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #dcdfe6;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    button {
      display: inline-block;
      background-color: #007acc;
      color: #ffffff;
      padding: 12px 28px;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
    }
    button.secondary {
      background-color: #ffffff;
      color: #007acc;
      border: 1px solid #007acc;
    }
    .footer {
      font-size: 12px;
      color: #999;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>链接已休眠</h1>
    <p>该评论者已较长时间未再来评论，此链接可能已失效或存在风险，本站已不再从评论区直接跳转它。</p>
    <p class="url">%s</p>
    <form method="POST" action="/api/link-dormant/confirm?token=%s">
      <button type="submit">我仍在使用</button>
    </form>
    <form method="POST" action="/api/link-dormant/update?token=%s">
      <input type="text" name="url" placeholder="https://example.com" value="">
      <button type="submit" class="secondary">提交新链接</button>
    </form>
    <div class="footer">确认后 %d 天内不会再标记为休眠</div>
  </div>
</body>
</html>`,
		utils.HtmlEscape(targetURL), escapedToken, escapedToken, dormantDays)
}

// maybeSendDormantNotices 惰性检测（任务规范第 8.1 节）：不引入定时任务，
// 在公开评论列表的构建路径里追加 —— 收集本页 urlDormant 的评论，用纯函数判断谁需要提醒，
// 对每一个需要的**异步**执行「发提醒邮件 → 成功才 upsert 记录」。
//
// emailsByCommentID 是「评论 id → 归一化邮箱」的反查表：CommentResponse 按公开接口的隐私
// 口径不下发 email，所以邮箱只能在 GetComments 构建响应时一并记下来。
// 任何异常只写服务端日志，绝不影响评论列表响应。
//
// **发信前提**（doc/link_security.md 第 2.7 节）：总开关 + 休眠提醒开关 + 邮箱验证都开启。
// 任一不满足就直接返回（连 DormantNotice 都不查）：打开提醒开关后第一次有人访问评论区才开始提醒。
func (h *CommentHandler) maybeSendDormantNotices(
	parent *gin.Context,
	page []*model.CommentResponse,
	emailsByCommentID map[int64]string,
	lastCommentAt map[string]int64,
	dormantDays int,
) {
	if !utils.ShouldSendDormantNotice(
		utils.GetSetting(utils.LinkSecurityEnabledKey),
		utils.GetSetting(utils.LinkDormantNoticeEnabledKey),
		utils.GetSetting("email_verify_enabled"),
	) {
		return
	}

	type pendingNotice struct {
		email  string
		url    string
		author string
		lastAt int64
	}

	// 1. 收集本页（含嵌套回复）中 urlDormant 的评论，按 (归一化邮箱, trim 后网址) 去重
	deduped := make(map[string]pendingNotice)
	var walk func(items []*model.CommentResponse)
	walk = func(items []*model.CommentResponse) {
		for _, item := range items {
			if item.UrlDormant && item.URL != nil {
				email := emailsByCommentID[item.ID]
				if email != "" {
					key := utils.TrustedLinkKey(email, *item.URL)
					if _, exists := deduped[key]; !exists {
						deduped[key] = pendingNotice{
							email:  email,
							url:    strings.TrimSpace(*item.URL),
							author: item.Author,
							lastAt: lastCommentAt[email],
						}
					}
				}
			}
			if len(item.Replies) > 0 {
				walk(item.Replies)
			}
		}
	}
	walk(page)

	if len(deduped) == 0 {
		return
	}

	// 2. 一次查询取回这些邮箱的 DormantNotice 记录
	emails := make([]string, 0, len(deduped))
	seenEmails := make(map[string]bool, len(deduped))
	for _, item := range deduped {
		if !seenEmails[item.email] {
			seenEmails[item.email] = true
			emails = append(emails, item.email)
		}
	}
	records, err := h.Repo.DormantNoticesByEmails(parent.Request.Context(), emails)
	if err != nil {
		log.Printf("[WARN] 休眠提醒：查询提醒记录失败，本次不提醒: %v", err)
		return
	}

	// 3. 纯函数判断谁需要提醒
	nowMs := nowMillis()
	type task struct {
		notice    *model.DormantNotice
		noticeURL string
		author    string
	}
	tasks := make([]task, 0, len(deduped))
	for key, item := range deduped {
		record := records[key]
		hasRecord := record != nil
		recordExpired := false
		var recordLastCommentAt *int64
		if hasRecord {
			recordExpired = !utils.IsTrustActive(record.ExpiresAt, nowMs)
			lastAt := record.LastCommentAt
			recordLastCommentAt = &lastAt
		}

		// 本项只来自 urlDormant 的评论，因此 dormant 恒为 true
		if !utils.NeedDormantNotice(true, hasRecord, recordExpired, recordLastCommentAt, item.lastAt) {
			continue
		}

		tokenBytes := make([]byte, 32)
		if _, err := rand.Read(tokenBytes); err != nil {
			log.Printf("[WARN] 休眠提醒：生成令牌失败，已跳过: %v", err)
			continue
		}
		token := hex.EncodeToString(tokenBytes)

		tasks = append(tasks, task{
			notice: &model.DormantNotice{
				Email:         item.email,
				URL:           item.url,
				LastCommentAt: item.lastAt,
				Token:         token,
				ExpiresAt:     utils.FormatTrustTime(nowMs + int64(dormantDays)*utils.DayMillis),
				NotifiedAt:    utils.FormatTrustTime(nowMs),
			},
			noticeURL: dormantNoticePageURL(parent, token),
			author:    item.author,
		})
	}

	if len(tasks) == 0 {
		return
	}

	// 单次请求的发信上限：先筛出「这次该发」的候选，再按上限截断，
	// 其余留给后续请求（同一个休眠周期不会重复提醒，只是分几次完成）。
	if len(tasks) > MaxDormantNoticesPerRequest {
		tasks = tasks[:MaxDormantNoticesPerRequest]
	}

	// 4. 发信在拿到配置之前就 return 的情形（SMTP 未配置 / 邮件通知关闭）属于「跳过」：
	// 不落记录，下次读取会重试（任务规范第 8.1 节）。
	mailService := utils.GetService()
	if !mailService.IsAvailable() || !utils.IsEmailEnabled() {
		return
	}

	repo := h.Repo
	for _, t := range tasks {
		notice := t.notice
		noticeURL := t.noticeURL
		author := t.author
		recipient := notice.Email
		runDormantTask(func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[WARN] 休眠提醒任务 panic（已忽略）: %v", r)
				}
			}()
			if err := mailService.SendDormantNoticeEmail(recipient, author, notice.URL, noticeURL, dormantDays); err != nil {
				log.Printf("休眠链接提醒邮件发送失败: %v", err)
				return
			}
			// 成功才落记录：token 换新的、expires_at = 现在 + N 天、notified_at = 现在、
			// notify_count = 已有值 + 1（没有记录时为 1，由仓储的 upsert 保证）
			if err := repo.UpsertDormantNotice(parent.Request.Context(), notice); err != nil {
				log.Printf("[WARN] 休眠提醒：写入提醒记录失败: %v", err)
			}
		})
	}
}
