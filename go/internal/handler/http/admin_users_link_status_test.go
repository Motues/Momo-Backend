package http

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：用户列表的「网站链接状态」筛选（`GET /admin/stats/users?linkStatus=`）与
`urlTrustedSource`（任务规范第 5、7、10 节）。

关键口径：过滤发生在**分页之前**（totalPage 反映过滤后的集合），且沿用既有的
「全部用户算一次链接状态」实现（一次分组查询 + 一次确认记录查询，无 N+1）。
*/

// fetchUserListQuery 带查询串拉取用户列表
func fetchUserListQuery(t *testing.T, token, query string) userListPayload {
	t.Helper()
	target := "/admin/stats/users?limit=100"
	if query != "" {
		target += "&" + query
	}
	w := callWithToken(t, "GET", target, "", token)
	requireStatus(t, w, http.StatusOK)

	var payload userListPayload
	decodeInto(t, w, &payload)
	return payload
}

// userListEmails 返回列表里全部行的邮箱（归一化）
func userListEmails(payload userListPayload) []string {
	out := make([]string, 0, len(payload.Data.Users))
	for _, u := range payload.Data.Users {
		out = append(out, utils.NormalizeEmail(u.Email))
	}
	return out
}

// seedLinkStatusUsers 构造覆盖四种链接状态的用户集合：
//
//	dormant@x.com  有链接、超过 N 天没来 → dormant（两条，用于验证过滤后的分页总数）
//	dormant2@x.com 同上
//	none@x.com     从来没有留过链接 → none
//	normal@x.com   有链接、刚评论过 → normal
//	trusted@x.com  有链接、有未过期的人工确认 → trusted
func seedLinkStatusUsers(t *testing.T, now, day int64) {
	t.Helper()
	seedLinkComment(t, "休眠甲", "dormant@x.com", "https://d1.example.com", "approved", now-90*day)
	seedLinkComment(t, "休眠乙", "dormant2@x.com", "https://d2.example.com", "approved", now-90*day)
	seedLinkComment(t, "无链接", "none@x.com", "", "approved", now-1*day)
	seedLinkComment(t, "正常", "normal@x.com", "https://n.example.com", "approved", now-1*day)
	seedLinkComment(t, "已确认", "trusted@x.com", "https://t.example.com", "approved", now-90*day)
}

// TestGetUserListEndpointLinkStatus 四种状态各一条 + 非法值按 all
func TestGetUserListEndpointLinkStatus(t *testing.T) {
	now := int64(1_800_000_000_000)
	day := userLinkDay

	resetState(t)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")
	seedLinkStatusUsers(t, now, day)
	// trusted@x.com：管理员人工确认（未过期）
	seedTrustedLink(t, "trusted@x.com", "https://t.example.com",
		utils.FormatTrustTime(now+30*day))
	token := adminToken(t)

	for _, tc := range []struct {
		name   string
		query  string
		emails []string
	}{
		{"dormant", "linkStatus=dormant", []string{"dormant2@x.com", "dormant@x.com"}},
		{"trusted", "linkStatus=trusted", []string{"trusted@x.com"}},
		{"normal", "linkStatus=normal", []string{"normal@x.com"}},
		{"none", "linkStatus=none", []string{"none@x.com"}},
		{"all（默认）", "", []string{"dormant2@x.com", "dormant@x.com", "none@x.com", "normal@x.com", "trusted@x.com"}},
		{"all（显式）", "linkStatus=all", []string{"dormant2@x.com", "dormant@x.com", "none@x.com", "normal@x.com", "trusted@x.com"}},
		{"无法识别的取值按 all", "linkStatus=garbage", []string{"dormant2@x.com", "dormant@x.com", "none@x.com", "normal@x.com", "trusted@x.com"}},
		{"大小写不敏感", "linkStatus=DORMANT", []string{"dormant2@x.com", "dormant@x.com"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := fetchUserListQuery(t, token, tc.query)
			got := userListEmails(payload)
			if len(got) != len(tc.emails) {
				t.Fatalf("返回条数期望 %d，实际 %d: %v", len(tc.emails), len(got), got)
			}
			for _, want := range tc.emails {
				found := false
				for _, email := range got {
					if email == want {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("结果里缺少 %s: %v", want, got)
				}
			}
		})
	}
}

// TestGetUserListEndpointLinkStatusPagination 过滤必须发生在分页之前：
// totalPage / 返回条数都反映**过滤后**的集合。
func TestGetUserListEndpointLinkStatusPagination(t *testing.T) {
	now := int64(1_800_000_000_000)
	day := userLinkDay

	resetState(t)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")
	seedLinkStatusUsers(t, now, day)
	// trusted@x.com 已人工确认（否则它也是休眠的）：本用例只留 2 个休眠用户
	seedTrustedLink(t, "trusted@x.com", "https://t.example.com", utils.FormatTrustTime(now+30*day))
	token := adminToken(t)

	w := callWithToken(t, "GET", "/admin/stats/users?page=1&limit=1&linkStatus=dormant", "", token)
	requireStatus(t, w, http.StatusOK)
	var payload userListPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Users) != 1 {
		t.Fatalf("每页 1 条时应返回 1 条，实际 %d 条", len(payload.Data.Users))
	}
	// 3 个用户里有 2 个休眠 → totalPage 必须是 2（而不是全部用户的 5）
	if payload.Data.Pagination.TotalPage != 2 {
		t.Errorf("totalPage 应反映过滤后的集合（期望 2），实际 %d", payload.Data.Pagination.TotalPage)
	}

	// 第二页仍是 1 条
	w = callWithToken(t, "GET", "/admin/stats/users?page=2&limit=1&linkStatus=dormant", "", token)
	requireStatus(t, w, http.StatusOK)
	decodeInto(t, w, &payload)
	if len(payload.Data.Users) != 1 {
		t.Errorf("第二页应返回 1 条，实际 %d 条", len(payload.Data.Users))
	}
	if payload.Data.Pagination.TotalPage != 2 {
		t.Errorf("第二页的 totalPage 仍应为 2，实际 %d", payload.Data.Pagination.TotalPage)
	}

	// 越界页：不 panic，返回 0 条
	w = callWithToken(t, "GET", "/admin/stats/users?page=99&limit=1&linkStatus=dormant", "", token)
	requireStatus(t, w, http.StatusOK)
	decodeInto(t, w, &payload)
	if len(payload.Data.Users) != 0 {
		t.Errorf("越界页应返回 0 条，实际 %d 条", len(payload.Data.Users))
	}
}

// TestGetUserListEndpointLinkStatusCombinations 与 search / verified 组合
func TestGetUserListEndpointLinkStatusCombinations(t *testing.T) {
	now := int64(1_800_000_000_000)
	day := userLinkDay

	resetState(t)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")
	seedLinkStatusUsers(t, now, day)
	// 只给 dormant@x.com 标记邮箱已验证
	verifyEmailForTest(t, "dormant@x.com")
	// trusted@x.com 已人工确认（否则它也是休眠的）
	seedTrustedLink(t, "trusted@x.com", "https://t.example.com", utils.FormatTrustTime(now+30*day))
	token := adminToken(t)

	t.Run("search 与 linkStatus 同时生效", func(t *testing.T) {
		payload := fetchUserListQuery(t, token, "search=dormant&linkStatus=dormant")
		if got := userListEmails(payload); len(got) != 2 {
			t.Errorf("search=dormant 应命中 2 个休眠用户，实际 %v", got)
		}
		payload = fetchUserListQuery(t, token, "search=none&linkStatus=dormant")
		if got := userListEmails(payload); len(got) != 0 {
			t.Errorf("search 与 linkStatus 应是与的关系，实际 %v", got)
		}
	})

	t.Run("verified 与 linkStatus 同时生效", func(t *testing.T) {
		payload := fetchUserListQuery(t, token, "verified=true&linkStatus=dormant")
		got := userListEmails(payload)
		if len(got) != 1 || got[0] != "dormant@x.com" {
			t.Errorf("verified=true 应只剩已验证的那一个休眠用户，实际 %v", got)
		}
		payload = fetchUserListQuery(t, token, "verified=false&linkStatus=dormant")
		got = userListEmails(payload)
		if len(got) != 1 || got[0] != "dormant2@x.com" {
			t.Errorf("verified=false 只剩未验证的休眠用户，实际 %v", got)
		}
		// 分页总数同样反映组合过滤后的集合
		w := callWithToken(t, "GET", "/admin/stats/users?limit=1&verified=true&linkStatus=dormant", "", token)
		requireStatus(t, w, http.StatusOK)
		var listed userListPayload
		decodeInto(t, w, &listed)
		if listed.Data.Pagination.TotalPage != 1 {
			t.Errorf("组合过滤后 totalPage 期望 1，实际 %d", listed.Data.Pagination.TotalPage)
		}
	})
}

// TestGetUserListEndpointLinkStatusDisabled 功能关闭时没有休眠用户，其余状态照常
func TestGetUserListEndpointLinkStatusDisabled(t *testing.T) {
	now := int64(1_800_000_000_000)
	day := userLinkDay

	resetState(t)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "false")
	setSetting(t, "link_dormant_days", "30")
	seedLinkStatusUsers(t, now, day)
	seedTrustedLink(t, "trusted@x.com", "https://t.example.com", utils.FormatTrustTime(now+30*day))
	token := adminToken(t)

	if got := userListEmails(fetchUserListQuery(t, token, "linkStatus=dormant")); len(got) != 0 {
		t.Errorf("功能关闭时 dormant 应为空集，实际 %v", got)
	}
	// trusted 与开关无关
	if got := userListEmails(fetchUserListQuery(t, token, "linkStatus=trusted")); len(got) != 1 {
		t.Errorf("trusted 与开关无关，应命中 1 个，实际 %v", got)
	}
	// 有链接且未被确认的都归入 normal（不再休眠）
	if got := userListEmails(fetchUserListQuery(t, token, "linkStatus=normal")); len(got) != 3 {
		t.Errorf("功能关闭时有链接的都是 normal，应命中 3 个，实际 %v", got)
	}
	if got := userListEmails(fetchUserListQuery(t, token, "linkStatus=none")); len(got) != 1 {
		t.Errorf("none 仍按语义工作，应命中 1 个，实际 %v", got)
	}
}

// TestGetUserListEndpointUrlTrustedSource urlTrustedSource 的三种取值
func TestGetUserListEndpointUrlTrustedSource(t *testing.T) {
	now := int64(1_800_000_000_000)
	day := userLinkDay

	resetState(t)
	withFixedNow(t, now)
	setSetting(t, "link_security_enabled", "true")
	setSetting(t, "link_dormant_days", "30")
	seedLinkStatusUsers(t, now, day)
	token := adminToken(t)

	// 1. 没有确认 → 空串
	payload := fetchUserListQuery(t, token, "")
	if u := requireSingleUser(t, payload, "normal@x.com"); u.URLTrustedSource != "" {
		t.Errorf("没有人工确认时 urlTrustedSource 应为空串，实际 %q", u.URLTrustedSource)
	}

	// 2. 管理员确认（POST /admin/links/trust）→ admin
	w := callWithToken(t, "POST", "/admin/links/trust",
		`{"email":"trusted@x.com","url":"https://t.example.com"}`, token)
	requireStatus(t, w, http.StatusOK)
	payload = fetchUserListQuery(t, token, "")
	if u := requireSingleUser(t, payload, "trusted@x.com"); u.URLTrustedSource != model.TrustedLinkSourceAdmin {
		t.Errorf("管理员确认后 urlTrustedSource 期望 admin，实际 %q", u.URLTrustedSource)
	}

	// 3. 本人从提醒邮件里确认（POST /api/link-dormant/confirm）→ self
	seedDormantNotice(t, "dormant@x.com", "https://d1.example.com", "tok-self",
		utils.FormatTrustTime(now+30*day), now-90*day)
	w = callForm(t, "/api/link-dormant/confirm?token=tok-self", url.Values{})
	requireStatus(t, w, http.StatusOK)
	if !strings.Contains(w.Body.String(), "确认成功") {
		t.Fatalf("confirm 应成功：%s", firstLines(w.Body.String(), 8))
	}
	payload = fetchUserListQuery(t, token, "")
	if u := requireSingleUser(t, payload, "dormant@x.com"); u.URLTrustedSource != model.TrustedLinkSourceSelf {
		t.Errorf("本人确认后 urlTrustedSource 期望 self，实际 %q", u.URLTrustedSource)
	}
	// 该行同时从 dormant 变成 trusted
	if got := userListEmails(fetchUserListQuery(t, token, "linkStatus=trusted")); len(got) != 2 {
		t.Errorf("确认后 trusted 应有 2 个（admin + self），实际 %v", got)
	}

	// 字段恒存在（形状稳定）
	_, body := fetchUserList(t, token)
	if !strings.Contains(body, `"urlTrustedSource":""`) &&
		!strings.Contains(body, `"urlTrustedSource":"admin"`) &&
		!strings.Contains(body, `"urlTrustedSource":"self"`) {
		t.Errorf("响应应始终包含 urlTrustedSource 字段，实际 %s", body)
	}
}
