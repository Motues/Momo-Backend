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

// applyTemplate 应用模板，替换占位符（值一律 HTML 转义）。
//
// 纯文本占位符（{{commentContent}} / {{replyContent}} / {{parentComment}} …）走这里，
// 语义与旧版完全一致，只为兼容既有自定义模板。
func applyTemplate(tpl string, placeholders map[string]string) string {
	result := tpl
	for key, val := range placeholders {
		result = strings.ReplaceAll(result, "{{"+key+"}}", HtmlEscape(val))
	}
	return result
}

// applyRawTemplate 应用模板，替换**不转义**的占位符。
//
// 只用于 *Html 占位符（{{commentContentHtml}} / {{replyContentHtml}} / {{parentCommentHtml}}）：
// 值是本站自己生成的净化 HTML（写入时 Markdown + 净化管线的产物），
// 再叠加一次短代码水合，注入的 <img src> 又只接受 https/data:image 白名单，
// 因此不需要二次转义（见 doc/mail.md 第 2、3 节）。
func applyRawTemplate(tpl string, placeholders map[string]string) string {
	result := tpl
	for key, val := range placeholders {
		result = strings.ReplaceAll(result, "{{"+key+"}}", val)
	}
	return result
}

// renderTemplate 先替换转义占位符，再替换原样占位符。
// 两组占位符名互不为前缀（commentContent vs commentContentHtml），替换顺序无关紧要。
func renderTemplate(tpl string, escaped, raw map[string]string) string {
	return applyRawTemplate(applyTemplate(tpl, escaped), raw)
}

// htmlOrEscaped 优先使用渲染后的 HTML；为空时回落到转义后的纯文本，
// 兼容只传纯文本的调用方（生产路径由 handler 通过 HydrateEmailEmoji 提供 HTML）。
func htmlOrEscaped(contentHTML, plainText string) string {
	if contentHTML != "" {
		return contentHTML
	}
	return HtmlEscape(plainText)
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

	adminMail := ResolveNotifyEmailFromSettings()

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

// SendCommentReplyNotification 发送评论回复通知。
//
// parentCommentHtml / replyContentHtml 是**渲染后（已净化 + 短代码水合）**的 HTML，
// 由调用方通过 HydrateEmailEmoji 准备；为兼容既有调用方，空串时回落到转义后的纯文本。
func (s *EmailService) SendCommentReplyNotification(
	toEmail, toName, postTitle, parentComment, replyAuthor, replyContent, postUrl,
	parentCommentHtml, replyContentHtml string,
) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	parentCommentHtml = htmlOrEscaped(parentCommentHtml, parentComment)
	replyContentHtml = htmlOrEscaped(replyContentHtml, replyContent)

	customTpl := GetTemplate("reply_template", "")
	var htmlContent string
	if customTpl != "" {
		htmlContent = renderTemplate(
			customTpl,
			map[string]string{
				"toName":        toName,
				"replyAuthor":   replyAuthor,
				"postTitle":     postTitle,
				"parentComment": parentComment,
				"replyContent":  replyContent,
				"postUrl":       postUrl,
			},
			map[string]string{
				"parentCommentHtml": parentCommentHtml,
				"replyContentHtml":  replyContentHtml,
			})
	} else {
		htmlContent = defaultReplyNotificationHTML(
			toName, replyAuthor, postTitle, postUrl, parentCommentHtml, replyContentHtml)
	}

	return s.SendRaw(
		MailTypeReplyNotify, toEmail,
		fmt.Sprintf("您在 %s 上的评论有了新回复", s.siteName), htmlContent)
}

// defaultReplyNotificationHTML 内置回复通知模板：正文用**渲染后的 HTML**（原评论 + 回复），
// 其余字段照旧 HTML 转义。抽成函数是为了让测试能直接断言「图片/链接/表情出现在邮件里」。
func defaultReplyNotificationHTML(toName, replyAuthor, postTitle, postUrl, parentCommentHtml, replyContentHtml string) string {
	return fmt.Sprintf(`
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
		</div>`, HtmlEscape(toName), HtmlEscape(replyAuthor), HtmlEscape(postTitle), parentCommentHtml, replyContentHtml, HtmlEscape(postUrl))
}

// SendCommentNotification 发送给站长的评论通知（收件人是解析后的 notify_email）。
//
// commentContentHtml 是**渲染后（已净化 + 短代码水合）**的 HTML，由调用方准备；
// 空串时回落到转义后的纯文本。
func (s *EmailService) SendCommentNotification(
	postTitle, postUrl, commentAuthor, commentContent, commentContentHtml string,
) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	if s.adminMail == "" {
		return fmt.Errorf("管理员邮箱未配置")
	}

	commentContentHtml = htmlOrEscaped(commentContentHtml, commentContent)

	customTpl := GetTemplate("notification_template", "")
	var htmlContent string
	if customTpl != "" {
		htmlContent = renderTemplate(
			customTpl,
			map[string]string{
				"postTitle":      postTitle,
				"commentAuthor":  commentAuthor,
				"commentContent": commentContent,
				"postUrl":        postUrl,
			},
			map[string]string{
				"commentContentHtml": commentContentHtml,
			})
	} else {
		htmlContent = defaultCommentNotificationHTML(
			commentAuthor, postTitle, postUrl, commentContentHtml)
	}

	return s.SendRaw(
		MailTypeCommentNotify, s.adminMail,
		fmt.Sprintf("您在 %s 上有新的评论", s.siteName), htmlContent)
}

// defaultCommentNotificationHTML 内置新评论通知模板：正文用**渲染后的 HTML**，
// 其余字段照旧 HTML 转义。
func defaultCommentNotificationHTML(commentAuthor, postTitle, postUrl, commentContentHtml string) string {
	return fmt.Sprintf(`
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
		</div>`, HtmlEscape(commentAuthor), HtmlEscape(postTitle), commentContentHtml, HtmlEscape(postUrl))
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

	return s.SendRaw(
		MailTypeVerify, toEmail,
		fmt.Sprintf("请验证您在 %s 上的评论邮箱", s.siteName), htmlContent)
}

// SendLinkSyncConfirmationEmail 发送历史链接批量更新的确认邮件（内置模板，不可自定义）。
//
// 主题固定为「确认更新您在 {siteName} 上的历史评论链接」，正文含旧网址 → 新网址、
// 页面地址与 24 小时有效的确认链接（见 doc/link_security.md 第 3.2 节）。
func (s *EmailService) SendLinkSyncConfirmationEmail(
	toEmail, toName, oldUrl, newUrl, postTitle, postUrl, confirmUrl string,
) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	postLine := ""
	if postTitle != "" || postUrl != "" {
		postLine = fmt.Sprintf(`
        <p style="color: #555; line-height: 1.6;">
          页面：<strong>《%s》</strong>
          <a href="%s" style="color: #0066cc; word-break: break-all;">%s</a>
        </p>`, html.EscapeString(postTitle), html.EscapeString(postUrl), html.EscapeString(postUrl))
	}

	htmlContent := fmt.Sprintf(`
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">确认更新您的历史评论链接</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi %s，<br><br>
          您刚在 <strong>%s</strong> 提交了一个新的个人网址，
          系统将把它同步到您以前的所有评论。
        </p>
        <p style="color: #555; line-height: 1.6; word-break: break-all;">
          旧网址：<span style="color: #999;">%s</span><br>
          新网址：<strong style="color: #0066cc;">%s</strong>
        </p>%s
        <p style="color: #555; line-height: 1.6;">
          请访问以下链接确认本次更新（或复制到浏览器打开）：
        </p>
        <p style="margin: 24px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #0066cc;">
          %s
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="%s" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">确认更新链接</a>
        </div>
        <p style="color: #999; font-size: 13px;">此链接 24 小时内有效。如果您没有提交新网址，请忽略此邮件，您的历史评论不会被修改。</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`,
		html.EscapeString(toName),
		html.EscapeString(s.siteName),
		html.EscapeString(oldUrl),
		html.EscapeString(newUrl),
		postLine,
		html.EscapeString(confirmUrl),
		html.EscapeString(confirmUrl))

	return s.SendRaw(
		MailTypeLinkSync, toEmail,
		fmt.Sprintf("确认更新您在 %s 上的历史评论链接", s.siteName), htmlContent)
}

// SiteName 返回站点名称
func (s *EmailService) SiteName() string {
	return s.siteName
}

// SendDormantNoticeEmail 发送休眠链接提醒邮件（内置模板，不可自定义）。
//
// 主题逐字为「您在 {siteName} 的个人网站链接已进入休眠」；正文含问候、休眠说明、
// **完整显示该链接**、指向提醒页的按钮与明文 URL、两个选项（「我仍在使用」/ 提交新链接）、
// 有效期说明与「忽略本邮件」提示（见任务规范第 8.2 节）。
//
// dormantDays 是当前读取口径下的 link_dormant_days（有效期文案里的 N）。
func (s *EmailService) SendDormantNoticeEmail(toEmail, toName, targetURL, noticeURL string, dormantDays int) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}

	htmlContent := fmt.Sprintf(`
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">您的个人网站链接已进入休眠</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi %s，<br><br>
          您在 <strong>%s</strong> 留下的这个个人网站链接已经很久没有新的评论活动了。
          为防止域名被抢注/指向钓鱼，本站已不再从评论区直接跳转它。
        </p>
        <p style="color: #555; line-height: 1.6; word-break: break-all;">
          当前链接：<strong style="color: #0066cc;">%s</strong>
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="%s" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">查看并确认</a>
        </div>
        <p style="margin: 24px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #0066cc;">
          %s
        </p>
        <p style="color: #555; line-height: 1.6;">
          打开上面的页面后，您可以：点「我仍在使用」即可让该链接恢复正常；
          或者直接在页面里提交一个新的链接，我们会同步更新您的历史评论。
        </p>
        <p style="color: #999; font-size: 13px;">此链接 %d 天内有效。如果这不是您本人或您已不再使用该链接，忽略本邮件即可。</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`,
		html.EscapeString(toName),
		html.EscapeString(s.siteName),
		html.EscapeString(targetURL),
		html.EscapeString(noticeURL),
		html.EscapeString(noticeURL),
		dormantDays)

	return s.SendRaw(
		MailTypeDormantNotice, toEmail,
		fmt.Sprintf("您在 %s 的个人网站链接已进入休眠", s.siteName), htmlContent)
}

// sendMailHook 测试注入点：非 nil 时替代真实的 SMTP 投递（签名与 SendRaw 一致）。
//
// 生产路径永远是 nil（走 gomail 的 DialAndSend）；测试用 SetSendMailHookForTest
// 注入假发送器，既能构造「发送成功」也能构造「发送失败」。
var sendMailHook func(mailType, to, subject, htmlContent string) error

// SetSendMailHookForTest 仅供测试注入假发送器；传 nil 恢复真实 SMTP 投递。
//
// 注意：这是进程级全局状态，用例结束必须还原（否则会污染同包内其它用例）。
func SetSendMailHookForTest(hook func(mailType, to, subject, htmlContent string) error) {
	sendMailHook = hook
}

// SendRaw 发送一封自定义邮件（**唯一的底层发送出口**）。
//
// 所有上层发送函数（验证 / 链接同步 / 休眠提醒 / 评论通知 / 回复通知 / 测试邮件）都汇聚到这里，
// 因此这里也是**邮件发送日志（MailLog）的唯一写入点**：一次实际尝试过的发送 = 一行。
//
// mailType 见 mail_log.go 的枚举；SMTP 未配置（IsAvailable 为 false）属于「跳过」而不算
// 「尝试过的发送」，直接返回错误**不记日志** —— 调用方在拿到配置之前就会 return。
func (s *EmailService) SendRaw(mailType, to, subject, htmlContent string) error {
	if !s.IsAvailable() {
		return fmt.Errorf("邮件服务未配置")
	}
	// 邮件通知关闭同样是「跳过」而不是「尝试过的发送」：不写日志
	// （与 doc/mail.md 第 5 节「email_enabled = false 时一封都不发」一致）
	if !IsEmailEnabled() {
		return fmt.Errorf("邮件通知已关闭")
	}

	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.fromEmail, fmt.Sprintf("%s 评论通知", s.siteName)))
	m.SetHeader("To", to)
	m.SetHeader("Subject", subject)
	m.SetBody("text/html", htmlContent)

	var err error
	if sendMailHook != nil {
		err = sendMailHook(mailType, to, subject, htmlContent)
	} else {
		err = s.dialer.DialAndSend(m)
	}

	if err != nil {
		// 日志绝不能改变既有的发送/失败语义：记完照旧把错误抛给调用方
		RecordMailLog(mailType, to, subject, MailStatusFailed, err.Error())
		return err
	}
	RecordMailLog(mailType, to, subject, MailStatusSent, "")
	return nil
}
