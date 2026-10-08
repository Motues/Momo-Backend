package http

import (
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/model"
)

// verifyEmailPage 请求邮箱验证接口并返回 HTML 文本
func verifyEmailPage(t *testing.T, token, email string) string {
	t.Helper()
	target := "/api/verify-email/verify?token=" + queryEscape(token) + "&email=" + queryEscape(email)
	w := callJSON(t, "GET", target, "")
	requireStatus(t, w, 200)

	contentType := w.Header().Get("Content-Type")
	if !strings.Contains(contentType, "text/html") {
		t.Errorf("Content-Type 期望 text/html，实际 %q", contentType)
	}
	return w.Body.String()
}

// saveToken 写入一条验证令牌记录
func saveToken(t *testing.T, email, token, expiresAt string) {
	t.Helper()
	if err := testRepo.SaveVerificationToken(t.Context(), email, token, expiresAt, "/p", "标题"); err != nil {
		t.Fatalf("写入验证令牌失败: %v", err)
	}
}

func futureExpiry() string {
	return time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
}

func pastExpiry() string {
	return time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
}

func TestVerifyEmailMissingParameters(t *testing.T) {
	resetState(t)

	for _, target := range []string{
		"/api/verify-email/verify",
		"/api/verify-email/verify?token=",
		"/api/verify-email/verify?email=a@x.com",
		"/api/verify-email/verify?token=abc",
		"/api/verify-email/verify?token=&email=",
	} {
		t.Run(target, func(t *testing.T) {
			w := callJSON(t, "GET", target, "")
			requireStatus(t, w, 200)

			body := w.Body.String()
			if !strings.Contains(body, "缺少验证参数") {
				t.Errorf("缺少参数时应提示“缺少验证参数”，实际页面片段: %s", firstLines(body, 3))
			}
			if !strings.Contains(body, "验证失败") {
				t.Errorf("应显示失败页面")
			}
		})
	}
}

func TestVerifyEmailInvalidToken(t *testing.T) {
	resetState(t)
	saveToken(t, "a@x.com", "valid-token", futureExpiry())

	body := verifyEmailPage(t, "wrong-token", "a@x.com")
	if !strings.Contains(body, "验证链接无效") {
		t.Errorf("令牌不匹配时应提示链接无效，实际: %s", firstLines(body, 3))
	}

	// token 正确但邮箱不匹配
	body = verifyEmailPage(t, "valid-token", "other@x.com")
	if !strings.Contains(body, "验证链接无效") {
		t.Errorf("邮箱不匹配时应提示链接无效，实际: %s", firstLines(body, 3))
	}

	// 记录未被修改
	rec, err := testRepo.GetVerificationRecord(t.Context(), "valid-token", "a@x.com")
	if err != nil {
		t.Fatalf("读取验证记录失败: %v", err)
	}
	if rec.Verified != 0 {
		t.Errorf("无效请求不应把记录标记为已验证")
	}
}

func TestVerifyEmailExpiredToken(t *testing.T) {
	resetState(t)
	saveToken(t, "a@x.com", "expired-token", pastExpiry())

	body := verifyEmailPage(t, "expired-token", "a@x.com")
	if !strings.Contains(body, "验证链接已过期") {
		t.Errorf("过期令牌应提示链接已过期，实际: %s", firstLines(body, 3))
	}

	rec, err := testRepo.GetVerificationRecord(t.Context(), "expired-token", "a@x.com")
	if err != nil {
		t.Fatalf("读取验证记录失败: %v", err)
	}
	if rec.Verified != 0 {
		t.Errorf("过期令牌不应被标记为已验证")
	}
}

func TestVerifyEmailAlreadyVerified(t *testing.T) {
	resetState(t)
	saveToken(t, "a@x.com", "used-token", futureExpiry())

	// 首次验证
	body := verifyEmailPage(t, "used-token", "a@x.com")
	if !strings.Contains(body, "邮箱验证成功") {
		t.Fatalf("首次验证应成功，实际: %s", firstLines(body, 3))
	}

	// 再次访问：提示已验证
	body = verifyEmailPage(t, "used-token", "a@x.com")
	if !strings.Contains(body, "该邮箱已验证通过") {
		t.Errorf("重复验证应提示已验证通过，实际: %s", firstLines(body, 3))
	}
	if !strings.Contains(body, "验证成功") {
		t.Errorf("重复验证仍应显示成功页面")
	}
}

func TestVerifyEmailApprovesPendingComments(t *testing.T) {
	resetState(t)

	email := "a@x.com"
	saveToken(t, email, "tok-1", futureExpiry())

	pending1 := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: email,
		ContentText: "待审核1", ContentHTML: "<p>待审核1</p>", Status: "pending", PubDate: 1000,
	})
	pending2 := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "a", Email: email,
		ContentText: "待审核2", ContentHTML: "<p>待审核2</p>", Status: "pending", PubDate: 2000,
	})
	other := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "b", Email: "b@x.com",
		ContentText: "他人", ContentHTML: "<p>他人</p>", Status: "pending", PubDate: 3000,
	})

	body := verifyEmailPage(t, "tok-1", email)
	if !strings.Contains(body, "邮箱验证成功") {
		t.Fatalf("验证应成功，实际: %s", firstLines(body, 3))
	}
	if !strings.Contains(body, "共 2 条评论已通过审核") {
		t.Errorf("应提示批准的评论数，实际: %s", firstLines(body, 3))
	}

	if got := commentByID(t, pending1.ID).Status; got != "approved" {
		t.Errorf("待审核评论应被批准，实际 %q", got)
	}
	if got := commentByID(t, pending2.ID).Status; got != "approved" {
		t.Errorf("待审核评论应被批准，实际 %q", got)
	}
	if got := commentByID(t, other.ID).Status; got != "pending" {
		t.Errorf("其他邮箱的评论不应被批准，实际 %q", got)
	}

	// 验证记录已落库
	rec, err := testRepo.GetVerificationRecord(t.Context(), "tok-1", email)
	if err != nil {
		t.Fatalf("读取验证记录失败: %v", err)
	}
	if rec.Verified != 1 {
		t.Errorf("记录应被标记为已验证，实际 %d", rec.Verified)
	}
	if rec.VerifiedAt == nil || *rec.VerifiedAt == "" {
		t.Errorf("verified_at 应被写入")
	}
}

func TestVerifyEmailWithoutPendingComments(t *testing.T) {
	resetState(t)
	saveToken(t, "a@x.com", "tok-none", futureExpiry())

	body := verifyEmailPage(t, "tok-none", "a@x.com")
	if !strings.Contains(body, "邮箱验证成功") {
		t.Fatalf("无待审核评论时也应验证成功，实际: %s", firstLines(body, 3))
	}
	if strings.Contains(body, "共 ") {
		t.Errorf("没有批准任何评论时不应显示计数，实际: %s", firstLines(body, 3))
	}
}

func TestVerifyEmailPageStructure(t *testing.T) {
	resetState(t)
	saveToken(t, "a@x.com", "tok-struct", futureExpiry())

	body := verifyEmailPage(t, "tok-struct", "a@x.com")
	for _, want := range []string{"<!DOCTYPE html>", "<html lang=\"zh-CN\">", "邮箱验证", "此页面由系统自动生成", "charset"} {
		if !strings.Contains(body, want) {
			t.Errorf("结果页应包含 %q，实际: %s", want, firstLines(body, 5))
		}
	}

	// 失败页面同样应是完整的 HTML
	failBody := verifyEmailPage(t, "not-exist", "a@x.com")
	for _, want := range []string{"<!DOCTYPE html>", "验证失败", "此页面由系统自动生成"} {
		if !strings.Contains(failBody, want) {
			t.Errorf("失败页应包含 %q", want)
		}
	}
}

// firstLines 截取前 n 行，便于失败信息阅读
func firstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, " | ")
}
