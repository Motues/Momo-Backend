package utils

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// SMTP 配置解析
// ---------------------------------------------------------------------------

func TestGetSmtpConfigFromDB(t *testing.T) {
	for _, tc := range []struct {
		name       string
		settings   map[string]string
		wantNil    bool
		wantHost   string
		wantPort   int
		wantUser   string
		wantSecure bool
	}{
		{
			name:     "完全未配置",
			settings: nil,
			wantNil:  true,
		},
		{
			name:     "只有 host",
			settings: map[string]string{"smtp_host": "smtp.a.com"},
			wantNil:  true,
		},
		{
			name:     "缺少 user",
			settings: map[string]string{"smtp_host": "smtp.a.com", "email_password": "p"},
			wantNil:  true,
		},
		{
			name:     "缺少 password",
			settings: map[string]string{"smtp_host": "smtp.a.com", "email_user": "u"},
			wantNil:  true,
		},
		{
			name:     "三个必填项都为空串",
			settings: map[string]string{"smtp_host": "", "email_user": "", "email_password": ""},
			wantNil:  true,
		},
		{
			name:     "配置完整但未指定端口（默认 465）",
			settings: map[string]string{"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p"},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u", wantSecure: false,
		},
		{
			name: "端口为 0 时回落 465",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "smtp_port": "0",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u",
		},
		{
			name: "端口非法字符串时回落 465",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "smtp_port": "abc",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u",
		},
		{
			name: "指定 587",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "smtp_port": "587",
			},
			wantHost: "smtp.a.com", wantPort: 587, wantUser: "u",
		},
		{
			name: "secure 未设置时默认 false",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "email_secure": "",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u", wantSecure: false,
		},
		{
			name: "secure=true",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "email_secure": "true",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u", wantSecure: true,
		},
		{
			name: "secure=false",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "email_secure": "false",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u", wantSecure: false,
		},
		{
			name: "secure 只认小写 true",
			settings: map[string]string{
				"smtp_host": "smtp.a.com", "email_user": "u", "email_password": "p", "email_secure": "TRUE",
			},
			wantHost: "smtp.a.com", wantPort: 465, wantUser: "u", wantSecure: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			for k, v := range tc.settings {
				setSetting(t, k, v)
			}

			cfg := getSmtpConfigFromDB()
			if tc.wantNil {
				if cfg != nil {
					t.Fatalf("配置不完整时应返回 nil，实际 %+v", cfg)
				}
				return
			}
			if cfg == nil {
				t.Fatalf("配置完整时不应返回 nil")
			}
			if cfg.host != tc.wantHost {
				t.Errorf("host 期望 %q，实际 %q", tc.wantHost, cfg.host)
			}
			if cfg.port != tc.wantPort {
				t.Errorf("port 期望 %d，实际 %d", tc.wantPort, cfg.port)
			}
			if cfg.user != tc.wantUser {
				t.Errorf("user 期望 %q，实际 %q", tc.wantUser, cfg.user)
			}
			if cfg.pass != "p" {
				t.Errorf("pass 期望 %q，实际 %q", "p", cfg.pass)
			}
			if cfg.secure != tc.wantSecure {
				t.Errorf("secure 期望 %v，实际 %v", tc.wantSecure, cfg.secure)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 邮件服务
// ---------------------------------------------------------------------------

func TestGetServiceWithoutSMTPConfig(t *testing.T) {
	resetSettings(t)

	svc := GetService()
	if svc == nil {
		t.Fatalf("GetService 不应返回 nil")
	}
	if svc.IsAvailable() {
		t.Errorf("缺少 SMTP 配置时 IsAvailable 应为 false")
	}
	if svc.dialer != nil {
		t.Errorf("缺少 SMTP 配置时 dialer 应为 nil")
	}
}

func TestGetServiceWithSMTPConfig(t *testing.T) {
	resetSettings(t)
	setSetting(t, "smtp_host", "smtp.example.com")
	setSetting(t, "smtp_port", "587")
	setSetting(t, "email_user", "noreply@example.com")
	setSetting(t, "email_password", "secret")

	svc := GetService()
	if !svc.IsAvailable() {
		t.Fatalf("配置完整时 IsAvailable 应为 true")
	}
	if svc.dialer == nil {
		t.Fatalf("配置完整时应创建 dialer")
	}
	if svc.dialer.Host != "smtp.example.com" {
		t.Errorf("dialer.Host 期望 smtp.example.com，实际 %q", svc.dialer.Host)
	}
	if svc.dialer.Port != 587 {
		t.Errorf("dialer.Port 期望 587，实际 %d", svc.dialer.Port)
	}
	if svc.dialer.Username != "noreply@example.com" {
		t.Errorf("dialer.Username 期望 noreply@example.com，实际 %q", svc.dialer.Username)
	}
	if svc.fromEmail != "noreply@example.com" {
		t.Errorf("fromEmail 期望 noreply@example.com，实际 %q", svc.fromEmail)
	}
	if svc.dialer.TLSConfig == nil {
		t.Fatalf("secure=false 时也应设置 TLSConfig")
	}
	if !svc.dialer.TLSConfig.InsecureSkipVerify {
		t.Errorf("secure=false 时应跳过证书校验（当前实现行为）")
	}

	// 站点名默认值
	if svc.SiteName() != "Momo Blog" {
		t.Errorf("未配置 site_name 时应使用默认站点名，实际 %q", svc.SiteName())
	}
	setSetting(t, "site_name", "我的博客")
	if got := GetService().SiteName(); got != "我的博客" {
		t.Errorf("配置 site_name 后应生效，实际 %q", got)
	}
}

func TestGetServiceSecureTLSConfig(t *testing.T) {
	resetSettings(t)
	setSetting(t, "smtp_host", "smtp.example.com")
	setSetting(t, "email_user", "u@example.com")
	setSetting(t, "email_password", "p")
	setSetting(t, "email_secure", "true")

	svc := GetService()
	if !svc.IsAvailable() {
		t.Fatalf("配置完整时 IsAvailable 应为 true")
	}
	if svc.dialer.TLSConfig == nil {
		t.Fatalf("secure=true 时应设置 TLSConfig")
	}
	if svc.dialer.TLSConfig.InsecureSkipVerify {
		t.Errorf("secure=true 时不应跳过证书校验")
	}
	if svc.dialer.TLSConfig.ServerName != "smtp.example.com" {
		t.Errorf("TLS ServerName 应为 SMTP 主机名，实际 %q", svc.dialer.TLSConfig.ServerName)
	}
}

func TestEmailServiceUnavailableErrors(t *testing.T) {
	resetSettings(t)

	svc := GetService()
	if svc.IsAvailable() {
		t.Fatalf("前置条件：SMTP 未配置时服务应不可用")
	}

	// 所有发送接口在服务不可用时都必须快速失败，不得尝试建立连接
	if err := svc.SendRaw("a@b.com", "s", "<p>x</p>"); err == nil {
		t.Errorf("SendRaw 在服务不可用时应返回错误")
	}
	if err := svc.SendCommentNotification("t", "u", "a", "c"); err == nil {
		t.Errorf("SendCommentNotification 在服务不可用时应返回错误")
	}
	if err := svc.SendCommentReplyNotification("a@b.com", "n", "t", "p", "ra", "rc", "u"); err == nil {
		t.Errorf("SendCommentReplyNotification 在服务不可用时应返回错误")
	}
	if err := svc.SendVerificationEmail("a@b.com", "n", "t", "/s", "http://x"); err == nil {
		t.Errorf("SendVerificationEmail 在服务不可用时应返回错误")
	}

	// nil 接收者也不能 panic
	var nilSvc *EmailService
	if nilSvc.IsAvailable() {
		t.Errorf("nil 服务应视为不可用")
	}
}

func TestSendCommentNotificationRequiresAdminMail(t *testing.T) {
	resetSettings(t)
	// 配置 SMTP 但不配置管理员邮箱：必须在拨号之前就失败，不产生网络请求
	setSetting(t, "smtp_host", "127.0.0.1")
	setSetting(t, "email_user", "u@example.com")
	setSetting(t, "email_password", "p")

	svc := GetService()
	if !svc.IsAvailable() {
		t.Fatalf("前置条件：SMTP 配置完整时服务应可用")
	}

	err := svc.SendCommentNotification("标题", "https://x", "作者", "内容")
	if err == nil {
		t.Fatalf("未配置管理员邮箱时应返回错误")
	}
	if !strings.Contains(err.Error(), "管理员邮箱") {
		t.Errorf("错误信息应说明管理员邮箱未配置，实际 %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// 模板与转义
// ---------------------------------------------------------------------------

func TestApplyTemplate(t *testing.T) {
	for _, tc := range []struct {
		name         string
		tpl          string
		placeholders map[string]string
		want         string
	}{
		{
			name:         "单个占位符",
			tpl:          "Hello {{name}}!",
			placeholders: map[string]string{"name": "Tom"},
			want:         "Hello Tom!",
		},
		{
			name:         "多个占位符",
			tpl:          "{{a}}-{{b}}",
			placeholders: map[string]string{"a": "1", "b": "2"},
			want:         "1-2",
		},
		{
			name:         "同一占位符出现多次全部替换",
			tpl:          "{{x}} and {{x}}",
			placeholders: map[string]string{"x": "v"},
			want:         "v and v",
		},
		{
			name:         "未提供的占位符保持原样",
			tpl:          "{{a}} {{b}}",
			placeholders: map[string]string{"a": "1"},
			want:         "1 {{b}}",
		},
		{
			name:         "没有占位符时原样返回",
			tpl:          "<p>static</p>",
			placeholders: map[string]string{"a": "1"},
			want:         "<p>static</p>",
		},
		{
			name:         "空模板",
			tpl:          "",
			placeholders: map[string]string{"a": "1"},
			want:         "",
		},
		{
			name:         "空占位符映射",
			tpl:          "{{a}}",
			placeholders: nil,
			want:         "{{a}}",
		},
		{
			name:         "替换值为空串",
			tpl:          "[{{a}}]",
			placeholders: map[string]string{"a": ""},
			want:         "[]",
		},
		{
			name:         "替换值被 HTML 转义",
			tpl:          "<p>{{c}}</p>",
			placeholders: map[string]string{"c": `<script>alert(1)</script>`},
			want:         "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
		},
		{
			name:         "替换值中的引号被转义",
			tpl:          `<a title="{{t}}">x</a>`,
			placeholders: map[string]string{"t": `" onmouseover="alert(1)`},
			want:         `<a title="&quot; onmouseover=&quot;alert(1)">x</a>`,
		},
		{
			name:         "替换值里的 & 被转义",
			tpl:          "{{a}}",
			placeholders: map[string]string{"a": "A & B"},
			want:         "A &amp; B",
		},
		{
			name:         "占位符名大小写敏感",
			tpl:          "{{Name}}",
			placeholders: map[string]string{"name": "x"},
			want:         "{{Name}}",
		},
		{
			name:         "中文占位符值",
			tpl:          "你好 {{who}}",
			placeholders: map[string]string{"who": "世界"},
			want:         "你好 世界",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := applyTemplate(tc.tpl, tc.placeholders); got != tc.want {
				t.Errorf("applyTemplate 期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

// TestApplyTemplateEscapesUserContent 确认用户内容无法通过模板注入标签
func TestApplyTemplateEscapesUserContent(t *testing.T) {
	tpl := `<div class="content">{{commentContent}}</div>`
	got := applyTemplate(tpl, map[string]string{
		"commentContent": `<img src=x onerror="alert(1)">`,
	})
	if strings.Contains(got, "<img") {
		t.Errorf("用户内容应被转义，实际 %q", got)
	}
	if !strings.Contains(got, "&lt;img") {
		t.Errorf("用户内容应被转义为实体，实际 %q", got)
	}
	if strings.Count(got, "<div") != 1 || strings.Count(got, "</div>") != 1 {
		t.Errorf("模板自身结构不应被破坏，实际 %q", got)
	}
}

func TestGetTemplateFallbacksForEmail(t *testing.T) {
	resetSettings(t)

	for _, key := range []string{"reply_template", "notification_template"} {
		if got := GetTemplate(key, "fallback"); got != "fallback" {
			t.Errorf("未配置 %s 时应使用兜底模板，实际 %q", key, got)
		}
		setSetting(t, key, "<p>自定义 "+key+"</p>")
		if got := GetTemplate(key, "fallback"); got == "fallback" {
			t.Errorf("已配置 %s 时不应使用兜底模板", key)
		}
	}
}
