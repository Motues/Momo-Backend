package utils

import (
	"crypto/tls"
	"fmt"
	"html"
	"strconv"
	"strings"

	"gopkg.in/gomail.v2"
)

// 从数据库获取 SMTP 配置
type smtpConfig struct {
	host     string
	port     int
	user     string
	pass     string
	secure   bool
}

func getSmtpConfigFromDB() *smtpConfig {
	host := GetSetting("smtp_host")
	user := GetSetting("email_user")
	pass := GetSetting("email_password")

	if host == "" || user == "" || pass == "" {
		return nil
	}

	portStr := GetSetting("smtp_port")
	port, _ := strconv.Atoi(portStr)
	if port == 0 {
		port = 465
	}

	secure := GetSetting("email_secure") == "true"

	return &smtpConfig{
		host:   host,
		port:   port,
		user:   user,
		pass:   pass,
		secure: secure,
	}
}

// EmailService 邮件服务
type EmailService struct {
	fromEmail string
	adminMail string
	siteName  string
	dialer    *gomail.Dialer
}

// IsAvailable 服务可用性检查
func (s *EmailService) IsAvailable() bool {
	return s != nil && s.dialer != nil
}

// applyTemplate 应用模板，替换占位符
func applyTemplate(tpl string, placeholders map[string]string) string {
	result := tpl
	for key, val := range placeholders {
		result = strings.ReplaceAll(result, "{{"+key+"}}", HtmlEscape(val))
	}
	return result
}

// GetService 创建邮件服务实例（每次读取数据库配置）
func GetService() *EmailService {
	cfg := getSmtpConfigFromDB()
	if cfg == nil {
		fmt.Println("SMTP 数据库配置缺失，邮件服务不可用")
		return &EmailService{}
	}

	siteName := GetSetting("site_name")
	if siteName == "" {
		siteName = "Momo Blog"
	}

	adminMail := GetSetting("admin_email")

	dialer := gomail.NewDialer(cfg.host, cfg.port, cfg.user, cfg.pass)
	if cfg.secure {
		dialer.TLSConfig = &tls.Config{ServerName: cfg.host}
	} else {
		dialer.TLSConfig = &tls.Config{InsecureSkipVerify: true}
	}

	return &EmailService{
		dialer:    dialer,
		fromEmail: cfg.user,
		adminMail: adminMail,
		siteName:  siteName,
	}
}

// SendCommentReplyNotification 发送评论回复通知
func (s *EmailService) SendCommentReplyNotification(
	toEmail, toName, postTitle, parentComment, replyAuthor, replyContent, postUrl string,
) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	customTpl := GetTemplate("reply_template", "")
	var htmlContent string
	if customTpl != "" {
		htmlContent = applyTemplate(customTpl, map[string]string{
			"toName":        toName,
			"replyAuthor":   replyAuthor,
			"postTitle":     postTitle,
			"parentComment": parentComment,
			"replyContent":  replyContent,
			"postUrl":       postUrl,
		})
	} else {
		htmlContent = fmt.Sprintf(`
		      <div style="background-color: #f4f7f9; padding: 20px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
		  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); border: 1px solid #e1e4e8;">
		    <div style="padding: 30px;">
		      <h2 style="margin-top: 0; color: #333; font-size: 18px;">Hi %s，</h2>
		      <p style="color: #555; line-height: 1.6;">
		        <strong>%s</strong> 回复了您在 <span style="color: #007acc;">《%s》</span> 中的评论：
		      </p>
		      <div style="margin: 20px 0; padding: 12px 16px; border-left: 4px solid #dfe3e8; background-color: #fcfcfc; color: #555; font-size: 14px;">
		        %s
		      </div>
		      <p style="color: #333; font-weight: bold; margin-bottom: 8px;">最新回复：</p>
		      <div style="margin-bottom: 30px; padding: 16px; border-radius: 6px; background-color: #f0f7ff; border-left: 4px solid #007acc; color: #2c3e50; line-height: 1.6;">
		        %s
		      </div>
		      <div style="text-align: center;">
		        <a href="%s" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 5px rgba(0,122,204,0.2);">点击查看回复</a>
		      </div>
		    </div>
		    <div style="background-color: #fafbfc; padding: 15px 30px; border-top: 1px solid #eeeeee; text-align: center;">
		      <p style="margin: 0; font-size: 12px; color: #999;">此邮件由系统自动发送，请勿直接回复。<br></p>
		    </div>
		  </div>
		</div>`, HtmlEscape(toName), HtmlEscape(replyAuthor), HtmlEscape(postTitle), HtmlEscape(parentComment), HtmlEscape(replyContent), HtmlEscape(postUrl))
	}

	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.fromEmail, fmt.Sprintf("%s 评论通知", s.siteName)))
	m.SetHeader("To", toEmail)
	m.SetHeader("Subject", fmt.Sprintf("您在 %s 上的评论有了新回复", s.siteName))
	m.SetBody("text/html", htmlContent)

	return s.dialer.DialAndSend(m)
}

// SendCommentNotification 发送给站长的评论通知
func (s *EmailService) SendCommentNotification(
	postTitle, postUrl, commentAuthor, commentContent string,
) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	if s.adminMail == "" {
		return fmt.Errorf("管理员邮箱未配置")
	}

	customTpl := GetTemplate("notification_template", "")
	var htmlContent string
	if customTpl != "" {
		htmlContent = applyTemplate(customTpl, map[string]string{
			"postTitle":      postTitle,
			"commentAuthor":  commentAuthor,
			"commentContent": commentContent,
			"postUrl":        postUrl,
		})
	} else {
		htmlContent = fmt.Sprintf(`
		       <div style="background-color: #f6f8fa; padding: 40px 20px; min-height: 100%%; font-family: 'PingFang SC', 'Microsoft YaHei', Helvetica, Arial, sans-serif;">
		  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); overflow: hidden;">
		    <div style="height: 4px; background: linear-gradient(90deg, #007acc, #00c6ff);"></div>
		    <div style="padding: 32px;">
		      <h2 style="margin: 0 0 16px 0; color: #1a1a1a; font-size: 20px; line-height: 1.4;">有人在您的文章下发表了评论</h2>
		      <p style="color: #555; font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
		        <strong style="color: #007acc;">%s</strong> 评论了您的文章
		        <b style="color: #1a1a1a;">《%s》</b>：
		      </p>
		      <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; border: 1px dashed #e1e4e8; margin-bottom: 32px;">
		        <div style="color: #444; font-size: 15px; line-height: 1.8; word-break: break-all;">%s</div>
		      </div>
		      <div style="text-align: center;">
		        <a href="%s" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 50px; font-weight: 500; font-size: 15px; transition: all 0.3s ease;">立即前往查看</a>
		      </div>
		    </div>
		    <div style="background-color: #fafbfc; padding: 20px; text-align: center; border-top: 1px solid #f0f0f0;">
		      <p style="margin: 0; font-size: 13px; color: #99aab5; line-height: 1.5;">此邮件由系统自动发送，请勿直接回复。</p>
		    </div>
		  </div>
		</div>`, HtmlEscape(commentAuthor), HtmlEscape(postTitle), HtmlEscape(commentContent), HtmlEscape(postUrl))
	}

	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.fromEmail, fmt.Sprintf("%s 评论通知", s.siteName)))
	m.SetHeader("To", s.adminMail)
	m.SetHeader("Subject", fmt.Sprintf("您在 %s 上有新的评论", s.siteName))
	m.SetBody("text/html", htmlContent)

	return s.dialer.DialAndSend(m)
}

// SendVerificationEmail 发送邮箱验证邮件
func (s *EmailService) SendVerificationEmail(toEmail, toName, postTitle, postSlug, verifyURL string) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	htmlContent := fmt.Sprintf(`
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">验证您的邮箱地址</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi %s，<br><br>
          您在 <strong>%s</strong> 的文章
          <strong>《%s》</strong> 中提交了评论。
        </p>
        <p style="color: #555; line-height: 1.6;">
          请访问以下链接验证您的邮箱（或复制到浏览器打开）：
        </p>
        <p style="margin: 24px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #0066cc;">
          %s
        </p>
        <p style="color: #999; font-size: 13px;">此链接 24 小时内有效。如果您没有提交评论，请忽略此邮件。</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`, html.EscapeString(toName), html.EscapeString(s.siteName), html.EscapeString(postTitle), html.EscapeString(verifyURL))
	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.fromEmail, fmt.Sprintf("%s 评论通知", s.siteName)))
	m.SetHeader("To", toEmail)
	m.SetHeader("Subject", fmt.Sprintf("请验证您在 %s 上的评论邮箱", s.siteName))
	m.SetBody("text/html", htmlContent)

	return s.dialer.DialAndSend(m)
}

// SiteName 返回站点名称
func (s *EmailService) SiteName() string {
	return s.siteName
}

// SendRaw 发送自定义邮件（用于测试等场景）
func (s *EmailService) SendRaw(to, subject, htmlContent string) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.fromEmail, fmt.Sprintf("%s 评论通知", s.siteName)))
	m.SetHeader("To", to)
	m.SetHeader("Subject", subject)
	m.SetBody("text/html", htmlContent)

	return s.dialer.DialAndSend(m)
}
