package http

import (
	"fmt"
	"net/http"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：休眠链接的人工确认（TrustedLink，见 doc/link_security.md 第 4 节）。

覆盖 POST /admin/links/trust（幂等 upsert、有效期 = 确认时的 link_dormant_days、参数校验）、
DELETE /admin/links/trust（撤销 / 本来就没有 / 参数校验）、两个端点的鉴权，
以及两条读取路径的豁免：用户列表的 urlTrustedUntil + urlDormant、公开评论列表的 urlDormant。
跨语言固定向量在 utils 包的 link_security_vectors_test.go。
*/

// linkTrustPayload /admin/links/trust 两个端点的响应形状
type linkTrustPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Email     string `json:"email"`
		URL       string `json:"url"`
		ExpiresAt string `json:"expiresAt"`
		Days      int    `json:"days"`
		Revoked   bool   `json:"revoked"`
	} `json:"data"`
}

// trustTime 人工确认时间的写入格式（与 new Date(ms).toISOString() 一致）
func trustTime(ms int64) string { return utils.FormatTrustTime(ms) }

// trustRowCount 统计 TrustedLink 行数
func trustRowCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM TrustedLink"); err != nil {
		t.Fatalf("统计 TrustedLink 失败: %v", err)
	}
	return n
}

// trustRow 读取唯一的 TrustedLink 行
func trustRow(t *testing.T) model.TrustedLink {
	t.Helper()
	var row model.TrustedLink
	if err := testDB.Get(&row, "SELECT * FROM TrustedLink ORDER BY id DESC LIMIT 1"); err != nil {
		t.Fatalf("读取 TrustedLink 失败: %v", err)
	}
	return row
}

// seedTrustedLink 直接往表里写一条人工确认（用于构造已过期 / 脏格式的记录）
func seedTrustedLink(t *testing.T, email, url, expiresAt string) {
	t.Helper()
	if _, err := testDB.Exec(`INSERT INTO TrustedLink (email, url, expires_at, created_at)
		VALUES (?, ?, ?, ?)`, email, url, expiresAt, trustTime(1800000000000)); err != nil {
		t.Fatalf("写入人工确认失败: %v", err)
	}
}

// trustBody 拼装 POST /admin/links/trust 的请求体
func trustBody(email, url string) string {
	return fmt.Sprintf(`{"email":%q,"url":%q}`, email, url)
}

// ---------------------------------------------------------------------------
// POST /admin/links/trust
// ---------------------------------------------------------------------------

func TestTrustLinkEndpoint(t *testing.T) {
	resetState(t)
	const day = int64(86400000)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	setSetting(t, "link_dormant_days", "10")
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/links/trust",
		trustBody(" A@B.com ", "https://a.example.com"), token)
	requireStatus(t, w, http.StatusOK)
	requireBodyCode(t, w, http.StatusOK)

	var payload linkTrustPayload
	decodeInto(t, w, &payload)

	if payload.Message != "Link trusted successfully" {
		t.Errorf("message 期望 Link trusted successfully，实际 %q", payload.Message)
	}
	if payload.Data.Email != "a@b.com" {
		t.Errorf("email 应为归一化（trim + 小写）后的值，实际 %q", payload.Data.Email)
	}
	if payload.Data.URL != "https://a.example.com" {
		t.Errorf("url 不正确，实际 %q", payload.Data.URL)
	}
	if payload.Data.Days != 10 {
		t.Errorf("days 应取当前 link_dormant_days（10），实际 %d", payload.Data.Days)
	}
	if want := trustTime(now + 10*day); payload.Data.ExpiresAt != want {
		t.Errorf("expiresAt 期望 %q（now + 10 天），实际 %q", want, payload.Data.ExpiresAt)
	}

	// 落库值应与响应一致
	row := trustRow(t)
	if row.Email != "a@b.com" || row.URL != "https://a.example.com" {
		t.Errorf("落库的 (email, url) 不正确: %+v", row)
	}
	if row.ExpiresAt != payload.Data.ExpiresAt {
		t.Errorf("落库的 expires_at 期望 %q，实际 %q", payload.Data.ExpiresAt, row.ExpiresAt)
	}
	if row.CreatedAt != trustTime(now) {
		t.Errorf("created_at 应是本次确认时间 %q，实际 %q", trustTime(now), row.CreatedAt)
	}
	if trustRowCount(t) != 1 {
		t.Errorf("应只写入 1 行，实际 %d 行", trustRowCount(t))
	}

	// url 走 sanitizeUrl：trim 后落库
	w = callWithToken(t, "POST", "/admin/links/trust",
		trustBody("b@b.com", "  https://b.example.com  "), token)
	requireStatus(t, w, http.StatusOK)
	if got := trustRow(t).URL; got != "https://b.example.com" {
		t.Errorf("url 应被 sanitizeUrl 规范化，实际 %q", got)
	}
}

// TestTrustLinkEndpointIdempotent 连续两次只留一行，第二次刷新 expires_at / created_at
func TestTrustLinkEndpointIdempotent(t *testing.T) {
	resetState(t)
	const day = int64(86400000)
	now := int64(1_800_000_000_000)
	withFixedNow(t, now)
	setSetting(t, "link_dormant_days", "10")
	token := adminToken(t)

	requireStatus(t, callWithToken(t, "POST", "/admin/links/trust",
		trustBody("a@b.com", "https://a.example.com"), token), http.StatusOK)
	first := trustRow(t)
	if trustRowCount(t) != 1 {
		t.Fatalf("首次应只写入 1 行，实际 %d 行", trustRowCount(t))
	}

	// 时间往后推 5 天再次确认：仍然只有一行，时间被刷新
	later := now + 5*day
	withFixedNow(t, later)
	requireStatus(t, callWithToken(t, "POST", "/admin/links/trust",
		trustBody("A@B.com", "https://a.example.com"), token), http.StatusOK)

	if trustRowCount(t) != 1 {
		t.Fatalf("幂等 upsert 应只保留 1 行，实际 %d 行", trustRowCount(t))
	}
	second := trustRow(t)
	if second.ExpiresAt != trustTime(later+10*day) {
		t.Errorf("再次确认应刷新 expires_at，期望 %q，实际 %q", trustTime(later+10*day), second.ExpiresAt)
	}
	if second.CreatedAt != trustTime(later) {
		t.Errorf("再次确认应刷新 created_at，期望 %q，实际 %q", trustTime(later), second.CreatedAt)
	}
	if second.ID != first.ID {
		t.Errorf("幂等 upsert 不应换行（id %d -> %d）", first.ID, second.ID)
	}

	// 换网址：另起一行（旧网址的确认保留）
	requireStatus(t, callWithToken(t, "POST", "/admin/links/trust",
		trustBody("a@b.com", "https://new.example.com"), token), http.StatusOK)
	if trustRowCount(t) != 2 {
		t.Errorf("换网址应新增一行，实际 %d 行", trustRowCount(t))
	}
}

func TestTrustLinkEndpointValidation(t *testing.T) {
	const requiredMessage = "email and url are required"

	for _, testCase := range []struct {
		name string
		body string
	}{
		{"缺少 email", trustBody("", "https://a.example.com")},
		{"缺少 url", trustBody("a@b.com", "")},
		{"email 仅空白", trustBody("   ", "https://a.example.com")},
		{"url 仅空白", trustBody("a@b.com", "   ")},
		{"javascript 伪协议被 sanitize 成空", trustBody("a@b.com", "javascript:alert(1)")},
		{"不支持的 scheme 被 sanitize 成空", trustBody("a@b.com", "ftp://a.example.com")},
		{"非法 JSON", `{"email":`},
		{"空请求体", ``},
		{"JSON 数组", `[]`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			w := callWithToken(t, "POST", "/admin/links/trust", testCase.body, token)
			requireStatus(t, w, http.StatusBadRequest)
			requireBodyCode(t, w, http.StatusBadRequest)

			m := decodeJSON(t, w)
			if m["message"] != requiredMessage {
				t.Errorf("message 期望 %q，实际 %v", requiredMessage, m["message"])
			}
			if n := trustRowCount(t); n != 0 {
				t.Errorf("校验失败不应落库，实际 %d 行", n)
			}
		})
	}
}

func TestTrustLinkEndpointRequiresToken(t *testing.T) {
	resetState(t)

	t.Run("POST 缺 token", func(t *testing.T) {
		w := callJSON(t, "POST", "/admin/links/trust", trustBody("a@b.com", "https://a.example.com"))
		requireStatus(t, w, http.StatusUnauthorized)
		requireBodyCode(t, w, http.StatusUnauthorized)
		if m := decodeJSON(t, w); m["message"] != "Invalid token" {
			t.Errorf("message 期望 Invalid token，实际 %v", m["message"])
		}
	})

	t.Run("POST token 无效", func(t *testing.T) {
		w := callWithToken(t, "POST", "/admin/links/trust",
			trustBody("a@b.com", "https://a.example.com"), "not-a-token")
		requireStatus(t, w, http.StatusUnauthorized)
		requireBodyCode(t, w, http.StatusUnauthorized)
	})

	t.Run("DELETE 缺 token", func(t *testing.T) {
		w := callJSON(t, "DELETE",
			"/admin/links/trust?email=a@b.com&url="+queryEscape("https://a.example.com"), "")
		requireStatus(t, w, http.StatusUnauthorized)
		requireBodyCode(t, w, http.StatusUnauthorized)
	})

	if n := trustRowCount(t); n != 0 {
		t.Errorf("被 401 拦下的请求不应落库，实际 %d 行", n)
	}
}

// ---------------------------------------------------------------------------
// DELETE /admin/links/trust
// ---------------------------------------------------------------------------

func TestRevokeLinkTrustEndpoint(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	t.Run("删除成功返回 revoked: true", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		requireStatus(t, callWithToken(t, "POST", "/admin/links/trust",
			trustBody("a@b.com", "https://a.example.com"), token), http.StatusOK)
		if trustRowCount(t) != 1 {
			t.Fatalf("前置条件：应已写入 1 行")
		}

		// 大小写与转义无关：email 归一化、url 过 sanitizeUrl 后逐字比对
		w := callWithToken(t, "DELETE",
			"/admin/links/trust?email="+queryEscape(" A@B.com ")+"&url="+queryEscape("https://a.example.com"), "", token)
		requireStatus(t, w, http.StatusOK)
		requireBodyCode(t, w, http.StatusOK)

		var payload linkTrustPayload
		decodeInto(t, w, &payload)
		if payload.Message != "Link trust revoked" {
			t.Errorf("message 期望 Link trust revoked，实际 %q", payload.Message)
		}
		if !payload.Data.Revoked || payload.Data.Email != "a@b.com" || payload.Data.URL != "https://a.example.com" {
			t.Errorf("data 不正确: %+v", payload.Data)
		}
		if n := trustRowCount(t); n != 0 {
			t.Errorf("删除后不应有残留行，实际 %d 行", n)
		}

		// 再删一次：本来就没有 → revoked: false（仍然是 200）
		w = callWithToken(t, "DELETE",
			"/admin/links/trust?email=a@b.com&url="+queryEscape("https://a.example.com"), "", token)
		requireStatus(t, w, http.StatusOK)

		payload = linkTrustPayload{}
		decodeInto(t, w, &payload)
		if payload.Message != "Link is not trusted" {
			t.Errorf("message 期望 Link is not trusted，实际 %q", payload.Message)
		}
		if payload.Data.Revoked {
			t.Errorf("本来就没有记录时 revoked 应为 false")
		}
	})

	t.Run("只删逐字相等的 (email, url)", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)
		seedTrustedLink(t, "a@b.com", "https://a.example.com", trustTime(1800000000000+86400000))

		for _, target := range []string{
			"/admin/links/trust?email=a@b.com&url=" + queryEscape("https://other.example.com"),
			"/admin/links/trust?email=" + queryEscape("other@b.com") + "&url=" + queryEscape("https://a.example.com"),
		} {
			w := callWithToken(t, "DELETE", target, "", token)
			requireStatus(t, w, http.StatusOK)

			var payload linkTrustPayload
			decodeInto(t, w, &payload)
			if payload.Data.Revoked {
				t.Errorf("%s 不应删到记录", target)
			}
		}
		if n := trustRowCount(t); n != 1 {
			t.Errorf("误删后应仍剩 1 行，实际 %d 行", n)
		}
	})

	t.Run("参数校验与鉴权", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)

		for _, target := range []string{
			"/admin/links/trust",
			"/admin/links/trust?email=a@b.com",
			"/admin/links/trust?url=" + queryEscape("https://a.example.com"),
			"/admin/links/trust?email=" + queryEscape("   ") + "&url=" + queryEscape("https://a.example.com"),
			"/admin/links/trust?email=a@b.com&url=" + queryEscape("javascript:alert(1)"),
		} {
			w := callWithToken(t, "DELETE", target, "", token)
			requireStatus(t, w, http.StatusBadRequest)
			requireBodyCode(t, w, http.StatusBadRequest)

			m := decodeJSON(t, w)
			if m["message"] != "email and url are required" {
				t.Errorf("%s 的 message 期望 email and url are required，实际 %v", target, m["message"])
			}
		}

		// 缺 token / token 无效 → 401（中间件统一文案）
		for _, headers := range []map[string]string{nil, {"Authorization": "Bearer nope"}} {
			w := call(t, "DELETE", "/admin/links/trust?email=a@b.com&url="+queryEscape("https://a.example.com"),
				"", headers, "")
			requireStatus(t, w, http.StatusUnauthorized)
			requireBodyCode(t, w, http.StatusUnauthorized)
		}
	})
}

// ---------------------------------------------------------------------------
// 读取路径：GET /admin/stats/users
// ---------------------------------------------------------------------------

func TestUserListLinkTrust(t *testing.T) {
	const day = int64(86400000)
	now := int64(1_800_000_000_000)
	url := "https://a.example.com"

	// seed 一个 31 天没来评论、留了网址的用户（默认会休眠）
	setup := func(t *testing.T) string {
		t.Helper()
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "甲", "a@x.com", url, "approved", now-31*day)
		seedLinkComment(t, "乙", "b@x.com", "https://b.example.com", "approved", now-31*day)
		return adminToken(t)
	}

	t.Run("有效确认：urlDormant=false 且 urlTrustedUntil 原样下发", func(t *testing.T) {
		token := setup(t)
		setSetting(t, "link_dormant_days", "10")

		w := callWithToken(t, "POST", "/admin/links/trust", trustBody("a@x.com", url), token)
		requireStatus(t, w, http.StatusOK)
		var posted linkTrustPayload
		decodeInto(t, w, &posted)

		payload, _ := fetchUserList(t, token)
		u := requireSingleUser(t, payload, "a@x.com")
		if u.URLDormant {
			t.Errorf("有未过期的人工确认时不应标记休眠: %+v", u)
		}
		if u.URLTrustedUntil != posted.Data.ExpiresAt {
			t.Errorf("urlTrustedUntil 应原样下发 %q，实际 %q", posted.Data.ExpiresAt, u.URLTrustedUntil)
		}
		if want := trustTime(now + 10*day); u.URLTrustedUntil != want {
			t.Errorf("urlTrustedUntil 期望 %q，实际 %q", want, u.URLTrustedUntil)
		}
		// 同一页里没有确认的用户照旧休眠
		if other := requireSingleUser(t, payload, "b@x.com"); !other.URLDormant || other.URLTrustedUntil != "" {
			t.Errorf("其他用户的链接状态不该被影响: %+v", other)
		}
	})

	t.Run("已过期的确认：urlDormant=true 且 urlTrustedUntil 为空串", func(t *testing.T) {
		token := setup(t)
		// 直接往表里插一条已过期记录（早于 now）
		seedTrustedLink(t, "a@x.com", url, trustTime(now-day))

		payload, body := fetchUserList(t, token)
		u := requireSingleUser(t, payload, "a@x.com")
		if !u.URLDormant {
			t.Errorf("确认已过期时应恢复休眠: %+v", u)
		}
		if u.URLTrustedUntil != "" {
			t.Errorf("没有未过期确认时 urlTrustedUntil 应为空串，实际 %q", u.URLTrustedUntil)
		}
		// 字段恒定存在（面板表格直接读），空串不是 null
		if !containsAll(body, []string{`"urlTrustedUntil":""`}) {
			t.Errorf("响应应始终包含 urlTrustedUntil（空串），实际 %s", body)
		}
	})

	t.Run("边界：expires_at 恰好等于 now 视为已过期", func(t *testing.T) {
		token := setup(t)
		seedTrustedLink(t, "a@x.com", url, trustTime(now))

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if !u.URLDormant || u.URLTrustedUntil != "" {
			t.Errorf("恰好等于 now 的确认必须视为已过期: %+v", u)
		}
	})

	t.Run("换链接不继承：确认的是旧网址", func(t *testing.T) {
		token := setup(t)
		// 确认的是旧网址；用户随后把个人网址换成了新的（较晚的一条评论带新网址，
		// 且仍然超过 N 天没来评论 → 新网址应恢复休眠）
		seedTrustedLink(t, "a@x.com", "https://old.example.com", trustTime(now+10*day))
		seedLinkComment(t, "甲", "a@x.com", "https://brand-new.example.com", "approved", now-30*day-day/2)

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URL != "https://brand-new.example.com" {
			t.Fatalf("url 应取最新一条非空网址，实际 %q", u.URL)
		}
		if u.URLTrustedUntil != "" {
			t.Errorf("确认属于旧网址，不该对新网址生效，实际 %q", u.URLTrustedUntil)
		}
		if !u.URLDormant {
			t.Errorf("新网址没有确认且已超过 N 天没来评论，应休眠: %+v", u)
		}
	})

	t.Run("功能关闭时仍然下发 urlTrustedUntil", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		// 不写 link_security_enabled：默认关闭
		seedLinkComment(t, "甲", "a@x.com", url, "approved", now-31*day)
		token := adminToken(t)
		seedTrustedLink(t, "a@x.com", url, trustTime(now+10*day))

		u := requireSingleUser(t, mustUserList(t, token), "a@x.com")
		if u.URLDormant {
			t.Errorf("功能关闭时 urlDormant 恒为 false")
		}
		if u.URLTrustedUntil != trustTime(now+10*day) {
			t.Errorf("功能关闭也应下发未过期的 urlTrustedUntil，实际 %q", u.URLTrustedUntil)
		}
	})
}

// ---------------------------------------------------------------------------
// 读取路径：公开评论列表 GET /api/comments
// ---------------------------------------------------------------------------

func TestPublicCommentsLinkTrust(t *testing.T) {
	const day = int64(86400000)
	now := int64(1_800_000_000_000)
	url := "https://a.example.com"

	setup := func(t *testing.T) {
		t.Helper()
		resetState(t)
		withFixedNow(t, now)
		setSetting(t, "link_security_enabled", "true")
		setSetting(t, "link_dormant_days", "30")
		seedLinkComment(t, "A", "a@x.com", url, "approved", now-31*day)
		seedLinkComment(t, "B", "b@x.com", "https://b.example.com", "approved", now-31*day)
	}

	t.Run("有效确认 → 该条评论不再休眠，同页其他邮箱不受影响", func(t *testing.T) {
		setup(t)
		seedTrustedLink(t, "a@x.com", url, trustTime(now+10*day))

		comments := linkComments(t)
		if got := comments["A"]; got == nil || got.UrlDormant {
			t.Errorf("有未过期人工确认的链接不应休眠，实际 %+v", got)
		}
		if got := comments["B"]; got == nil || !got.UrlDormant {
			t.Errorf("同页其他邮箱的链接应照旧休眠，实际 %+v", got)
		}
	})

	t.Run("确认已过期 → 照旧休眠", func(t *testing.T) {
		setup(t)
		seedTrustedLink(t, "a@x.com", url, trustTime(now-day))

		comments := linkComments(t)
		if got := comments["A"]; got == nil || !got.UrlDormant {
			t.Errorf("确认过期后应恢复休眠，实际 %+v", got)
		}
	})

	t.Run("边界：expires_at 恰好等于 now 视为已过期", func(t *testing.T) {
		setup(t)
		seedTrustedLink(t, "a@x.com", url, trustTime(now))

		comments := linkComments(t)
		if got := comments["A"]; got == nil || !got.UrlDormant {
			t.Errorf("恰好等于 now 的确认必须视为已过期，实际 %+v", got)
		}
	})

	t.Run("确认的是别的网址 → 不豁免", func(t *testing.T) {
		setup(t)
		seedTrustedLink(t, "a@x.com", "https://other.example.com", trustTime(now+10*day))

		comments := linkComments(t)
		if got := comments["A"]; got == nil || !got.UrlDormant {
			t.Errorf("(邮箱, 网址) 必须逐字匹配才豁免，实际 %+v", got)
		}
	})

	t.Run("功能关闭时不查询也不豁免（恒为 false）", func(t *testing.T) {
		resetState(t)
		withFixedNow(t, now)
		// 不写 link_security_enabled：默认关闭
		seedLinkComment(t, "A", "a@x.com", url, "approved", now-31*day)
		seedTrustedLink(t, "a@x.com", url, trustTime(now+10*day))

		comments := linkComments(t)
		if got := comments["A"]; got == nil || got.UrlDormant {
			t.Errorf("功能关闭时 urlDormant 恒为 false，实际 %+v", got)
		}
	})
}
