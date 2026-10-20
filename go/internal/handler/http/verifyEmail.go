package http

import (
	"fmt"
	"time"
	"log"

	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *CommentHandler) VerifyEmail(c *gin.Context) {
	token := c.Query("token")
	email := c.Query("email")

	if token == "" || email == "" {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(false, "缺少验证参数")))
		return
	}

	record, err := h.Repo.GetVerificationRecord(c.Request.Context(), token, email)
	if err != nil || record == nil {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(false, "验证链接无效")))
		return
	}

	if record.Verified == 1 {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(true, "该邮箱已验证通过")))
		return
	}

	expiresAt, parseErr := time.Parse("2006-01-02T15:04:05.000Z", record.ExpiresAt)
	if parseErr != nil || time.Now().After(expiresAt) {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(false, "验证链接已过期，请重新提交评论以获取新的验证邮件")))
		return
	}

	approvedCount, err := h.Repo.VerifyEmail(c.Request.Context(), token, email)
	if err != nil {
		log.Printf("邮箱验证失败: %v", err)
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(false, "验证处理失败，请稍后重试")))
		return
	}

	msg := "邮箱验证成功！"
	if approvedCount > 0 {
		msg += fmt.Sprintf("共 %d 条评论已通过审核。", approvedCount)
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(verificationResultPage(true, msg)))
}

func verificationResultPage(success bool, message string) string {
	title := "验证成功"
	if !success {
		title = "验证失败"
	}
	return emailActionResultPage(success, title, "邮箱验证", message)
}

// emailActionResultPage 邮箱链接类端点（邮箱验证 / 链接同步）共用的纯 HTML 结果页。
//
// title 是状态标题（如“验证成功”），documentTitle 是页面标题后缀（如“邮箱验证”）。
func emailActionResultPage(success bool, title, documentTitle, message string) string {
	icon := "&#10003;"
	color := "#28a745"
	if !success {
		icon = "&#10007;"
		color = "#dc3545"
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>%s - %s</title>
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
      max-width: 420px;
      width: 90%%;
      text-align: center;
    }
    .icon {
      font-size: 64px;
      color: %s;
      margin-bottom: 16px;
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
      margin: 0 0 24px 0;
    }
    .footer {
      font-size: 12px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">%s</div>
    <h1>%s</h1>
    <p>%s</p>
    <div class="footer">此页面由系统自动生成</div>
  </div>
</body>
</html>`, title, documentTitle, color, icon, title, message)
}
