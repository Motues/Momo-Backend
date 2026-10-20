package utils

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

/*
链接安全审查契约 v1 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/link_security.md：四个设置键、开关 fail-closed、休眠天数 1–3650 默认 30、
休眠判定「严格大于 N 天」，只要有一端漂移这里就会失败。
*/

// linkSecurityFixture doc/vectors/link-security-v1.json 的结构化视图
type linkSecurityFixture struct {
	Keys struct {
		SecurityEnabled string `json:"securityEnabled"`
		DormantDays     string `json:"dormantDays"`
		SyncEnabled     string `json:"syncEnabled"`
		DormantNotice   string `json:"dormantNotice"`
	} `json:"keys"`
	Defaults struct {
		SecurityEnabled      string `json:"securityEnabled"`
		DormantDays          int    `json:"dormantDays"`
		SyncEnabled          string `json:"syncEnabled"`
		DormantNoticeEnabled string `json:"dormantNoticeEnabled"`
	} `json:"defaults"`
	Limits struct {
		MinDormantDays int   `json:"minDormantDays"`
		MaxDormantDays int   `json:"maxDormantDays"`
		DayMs          int64 `json:"dayMs"`
	} `json:"limits"`
	Errors   map[string]string `json:"errors"`
	Switches struct {
		Valid   []interface{} `json:"valid"`
		Invalid []interface{} `json:"invalid"`
	} `json:"switches"`
	Days struct {
		Valid   []interface{} `json:"valid"`
		Invalid []interface{} `json:"invalid"`
		Resolve []struct {
			Stored string `json:"stored"`
			Expect int    `json:"expect"`
		} `json:"resolve"`
	} `json:"days"`
	Dormant []struct {
		Name    string `json:"name"`
		Enabled string `json:"enabled"`
		HasUrl  bool   `json:"hasUrl"`
		Days    string `json:"days"`
		AgeMs   *int64 `json:"ageMs"`
		Expect  bool   `json:"expect"`
	} `json:"dormant"`
	EmailNormalize []struct {
		Input  string `json:"input"`
		Expect string `json:"expect"`
	} `json:"emailNormalize"`
	// Trust 人工确认（doc/link_security.md 第 4 节）：到期判定 + 它对休眠判定的豁免
	Trust struct {
		NowMs         int64  `json:"nowMs"`
		ExpiresFormat string `json:"expiresFormat"`
		Active        []struct {
			Name string `json:"name"`
			// 指针：fixture 里有 expiresAt = null 的用例，必须与空串区分
			ExpiresAt *string `json:"expiresAt"`
			NowMs     int64   `json:"nowMs"`
			Expect    bool    `json:"expect"`
		} `json:"active"`
		DormantOverride []struct {
			Name    string `json:"name"`
			Enabled string `json:"enabled"`
			HasUrl  bool   `json:"hasUrl"`
			Days    string `json:"days"`
			AgeMs   *int64 `json:"ageMs"`
			Trusted bool   `json:"trusted"`
			Expect  bool   `json:"expect"`
		} `json:"dormantOverride"`
	} `json:"trust"`
	// Notice 休眠链接提醒（任务规范第 6 节）：纯函数的固定向量
	Notice struct {
		NeedNotify []struct {
			Name                  string `json:"name"`
			Dormant               bool   `json:"dormant"`
			HasRecord             bool   `json:"hasRecord"`
			RecordExpired         bool   `json:"recordExpired"`
			RecordLastCommentAt   *int64 `json:"recordLastCommentAt"`
			CurrentLastCommentAt  int64  `json:"currentLastCommentAt"`
			Expect                bool   `json:"expect"`
		} `json:"needNotify"`
		// SendGate 发信前提：总开关 + 提醒开关 + 邮箱验证
		SendGate []struct {
			Name               string `json:"name"`
			SecurityEnabled    string `json:"securityEnabled"`
			NoticeEnabled      string `json:"noticeEnabled"`
			EmailVerifyEnabled string `json:"emailVerifyEnabled"`
			Expect             bool   `json:"expect"`
		} `json:"sendGate"`
	} `json:"notice"`
}

func loadLinkSecurityFixture(t *testing.T) linkSecurityFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("link-security-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/link-security-v1.json 失败: %v", err)
	}
	var fixture linkSecurityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/link-security-v1.json 失败: %v", err)
	}
	return fixture
}

// TestLinkSecurityKeysAndDefaults 钉死四个设置键、默认值与取值区间
func TestLinkSecurityKeysAndDefaults(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)

	if LinkSecurityEnabledKey != fixture.Keys.SecurityEnabled {
		t.Errorf("开关键期望 %q，实际 %q", fixture.Keys.SecurityEnabled, LinkSecurityEnabledKey)
	}
	if LinkDormantDaysKey != fixture.Keys.DormantDays {
		t.Errorf("天数键期望 %q，实际 %q", fixture.Keys.DormantDays, LinkDormantDaysKey)
	}
	if LinkSyncEnabledKey != fixture.Keys.SyncEnabled {
		t.Errorf("同步键期望 %q，实际 %q", fixture.Keys.SyncEnabled, LinkSyncEnabledKey)
	}
	if LinkDormantNoticeEnabledKey != fixture.Keys.DormantNotice {
		t.Errorf("提醒开关键期望 %q，实际 %q", fixture.Keys.DormantNotice, LinkDormantNoticeEnabledKey)
	}
	if DefaultLinkDormantDays != fixture.Defaults.DormantDays {
		t.Errorf("默认天数期望 %d，实际 %d", fixture.Defaults.DormantDays, DefaultLinkDormantDays)
	}
	if MinLinkDormantDays != fixture.Limits.MinDormantDays || MaxLinkDormantDays != fixture.Limits.MaxDormantDays {
		t.Errorf("天数区间期望 %d-%d，实际 %d-%d",
			fixture.Limits.MinDormantDays, fixture.Limits.MaxDormantDays, MinLinkDormantDays, MaxLinkDormantDays)
	}
	if DayMillis != fixture.Limits.DayMs {
		t.Errorf("一天毫秒数期望 %d，实际 %d", fixture.Limits.DayMs, DayMillis)
	}
}

// TestLinkSwitchVector 写入路径：开关的合法 / 非法取值
func TestLinkSwitchVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Switches.Valid) == 0 || len(fixture.Switches.Invalid) == 0 {
		t.Fatal("fixture 的 switches 段为空，向量没有生效")
	}

	for _, value := range fixture.Switches.Valid {
		if msg := ValidateLinkSwitch(LinkSecurityEnabledKey, value); msg != "" {
			t.Errorf("取值 %#v 期望通过校验，实际被拒：%s", value, msg)
		}
	}
	for _, value := range fixture.Switches.Invalid {
		msg := ValidateLinkSwitch(LinkSecurityEnabledKey, value)
		if msg == "" {
			t.Errorf("取值 %#v 期望被拒，实际通过校验", value)
			continue
		}
		if msg != fixture.Errors["securityEnabled"] {
			t.Errorf("取值 %#v 的错误文案期望 %q，实际 %q", value, fixture.Errors["securityEnabled"], msg)
		}
	}

	// 第二个开关用的是自己的错误文案
	if msg := ValidateLinkSwitch(LinkSyncEnabledKey, "yes"); msg != fixture.Errors["syncEnabled"] {
		t.Errorf("link_sync_enabled 的错误文案期望 %q，实际 %q", fixture.Errors["syncEnabled"], msg)
	}
	// 休眠提醒开关同理：文案不能串到别的键上
	if msg := ValidateLinkSwitch(LinkDormantNoticeEnabledKey, "yes"); msg != fixture.Errors["dormantNoticeEnabled"] {
		t.Errorf("link_dormant_notice_enabled 的错误文案期望 %q，实际 %q",
			fixture.Errors["dormantNoticeEnabled"], msg)
	}
}

// TestLinkDormantDaysWriteVector 写入路径：休眠天数的合法 / 非法取值
func TestLinkDormantDaysWriteVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Days.Valid) == 0 || len(fixture.Days.Invalid) == 0 {
		t.Fatal("fixture 的 days 段为空，向量没有生效")
	}

	for _, value := range fixture.Days.Valid {
		normalized, msg := ValidateLinkDormantDays(value)
		if msg != "" {
			t.Errorf("取值 %#v 期望通过校验，实际被拒：%s", value, msg)
			continue
		}
		days, err := strconv.Atoi(normalized)
		if err != nil {
			t.Errorf("归一化结果 %q 不是十进制整数", normalized)
			continue
		}
		if days < MinLinkDormantDays || days > MaxLinkDormantDays {
			t.Errorf("归一化结果 %d 超出 1-3650", days)
		}
	}
	for _, value := range fixture.Days.Invalid {
		if _, msg := ValidateLinkDormantDays(value); msg != fixture.Errors["dormantDays"] {
			t.Errorf("取值 %#v 的错误文案期望 %q，实际 %q",
				value, fixture.Errors["dormantDays"], msg)
		}
	}
}

// TestLinkDormantDaysResolveVector 读取路径：脏值回退 30、超上限夹取 3650
func TestLinkDormantDaysResolveVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Days.Resolve) == 0 {
		t.Fatal("fixture 的 days.resolve 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Days.Resolve {
		if got := ResolveLinkDormantDays(testCase.Stored); got != testCase.Expect {
			t.Errorf("ResolveLinkDormantDays(%q) 期望 %d，实际 %d", testCase.Stored, testCase.Expect, got)
		}
	}
}

// TestLinkSwitchResolveFailClosed 开关一律 fail-closed
func TestLinkSwitchResolveFailClosed(t *testing.T) {
	for _, stored := range []string{"true", "TRUE", " True "} {
		if !ResolveLinkSecurityEnabled(stored) {
			t.Errorf("stored=%q 应判为开启", stored)
		}
	}
	for _, stored := range []string{"", "   ", "false", "FALSE", "yes", "1", "on", "true1", "否"} {
		if ResolveLinkSecurityEnabled(stored) {
			t.Errorf("stored=%q 应 fail-closed 判为关闭", stored)
		}
	}
}

// TestUrlDormantVector 休眠判定的全部固定用例（严格大于 N 天）
func TestUrlDormantVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Dormant) == 0 {
		t.Fatal("fixture 的 dormant 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Dormant {
		t.Run(testCase.Name, func(t *testing.T) {
			enabled := ResolveLinkSecurityEnabled(testCase.Enabled)
			days := ResolveLinkDormantDays(testCase.Days)
			known := testCase.AgeMs != nil
			var ageMs int64
			if known {
				ageMs = *testCase.AgeMs
			}
			if got := IsUrlDormant(enabled, testCase.HasUrl, days, ageMs, known, false); got != testCase.Expect {
				t.Errorf("IsUrlDormant(%v, %v, %d, %d, %v, false) 期望 %v，实际 %v",
					enabled, testCase.HasUrl, days, ageMs, known, testCase.Expect, got)
			}
		})
	}
}

// TestTrustActiveVector 人工确认的到期判定（严格大于 now；格式不符一律 fail-closed）
func TestTrustActiveVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Trust.Active) == 0 {
		t.Fatal("fixture 的 trust.active 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Trust.Active {
		t.Run(testCase.Name, func(t *testing.T) {
			expiresAt := ""
			if testCase.ExpiresAt != nil {
				expiresAt = *testCase.ExpiresAt
			}
			// nowMs 缺省时用 trust 段顶层的「现在」（向量里每条都显式带，双保险）
			nowMs := testCase.NowMs
			if nowMs == 0 {
				nowMs = fixture.Trust.NowMs
			}
			if got := IsTrustActive(expiresAt, nowMs); got != testCase.Expect {
				t.Errorf("IsTrustActive(%q, %d) 期望 %v，实际 %v", expiresAt, nowMs, testCase.Expect, got)
			}
		})
	}
}

// TestTrustDormantOverrideVector 人工确认对休眠判定的豁免（trusted 为 true 时直接不标记）
func TestTrustDormantOverrideVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Trust.DormantOverride) == 0 {
		t.Fatal("fixture 的 trust.dormantOverride 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Trust.DormantOverride {
		t.Run(testCase.Name, func(t *testing.T) {
			enabled := ResolveLinkSecurityEnabled(testCase.Enabled)
			days := ResolveLinkDormantDays(testCase.Days)
			known := testCase.AgeMs != nil
			var ageMs int64
			if known {
				ageMs = *testCase.AgeMs
			}
			if got := IsUrlDormant(enabled, testCase.HasUrl, days, ageMs, known, testCase.Trusted); got != testCase.Expect {
				t.Errorf("IsUrlDormant(%v, %v, %d, %d, %v, %v) 期望 %v，实际 %v",
					enabled, testCase.HasUrl, days, ageMs, known, testCase.Trusted, testCase.Expect, got)
			}
		})
	}
}

// TestTrustTimeLayoutVector 写入格式与 JS 的 new Date(ms).toISOString() 逐字一致：
// 只有按这个格式写出来的串才会被 IsTrustActive 认（跨语言固定格式）。
func TestTrustTimeLayoutVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)

	// 向量里有一条「到期时间恰好等于现在」的用例，它的字符串就是 nowMs 的规范写法
	canonical := ""
	for _, testCase := range fixture.Trust.Active {
		if testCase.ExpiresAt != nil && testCase.NowMs == fixture.Trust.NowMs && !testCase.Expect {
			canonical = *testCase.ExpiresAt
			break
		}
	}
	if canonical == "" {
		t.Fatal("fixture 的 trust.active 缺少「恰好等于现在」的用例，向量没有生效")
	}
	if got := FormatTrustTime(fixture.Trust.NowMs); got != canonical {
		t.Errorf("FormatTrustTime(%d) 期望 %q（new Date(ms).toISOString()），实际 %q",
			fixture.Trust.NowMs, canonical, got)
	}
	if !hasTrustTimeLayout(canonical) {
		t.Errorf("%q 必须被格式形状校验认下", canonical)
	}

	// 自己写出来的时间必须自洽：恰好等于 now 视为已过期（严格大于），多 1 毫秒才算有效
	if IsTrustActive(FormatTrustTime(fixture.Trust.NowMs), fixture.Trust.NowMs) {
		t.Errorf("恰好等于 now 的确认必须视为已过期（严格大于）")
	}
	if !IsTrustActive(FormatTrustTime(fixture.Trust.NowMs+1), fixture.Trust.NowMs) {
		t.Errorf("now + 1 毫秒的确认必须有效")
	}
}

// TestLinkSecurityEmailNormalizeVector 邮箱归一化（身份标识口径）
func TestLinkSecurityEmailNormalizeVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.EmailNormalize) == 0 {
		t.Fatal("fixture 的 emailNormalize 段为空，向量没有生效")
	}

	for _, testCase := range fixture.EmailNormalize {
		if got := NormalizeEmail(testCase.Input); got != testCase.Expect {
			t.Errorf("NormalizeEmail(%q) 期望 %q，实际 %q", testCase.Input, testCase.Expect, got)
		}
	}
}

// TestLinkDormantDaysStrictDecimal fixture 未覆盖的边界：与 Node / Worker 的 /^\d+$/ 对齐 ——
// 带正号、超长数字都不算「十进制整数」；读取路径对超长数字一律夹取到上限。
func TestLinkDormantDaysStrictDecimal(t *testing.T) {
	for _, value := range []string{"+5", "  +5  ", "1_000", "٣٠"} {
		if _, msg := ValidateLinkDormantDays(value); msg == "" {
			t.Errorf("取值 %q 不应通过写入校验", value)
		}
		if got := ResolveLinkDormantDays(value); got != DefaultLinkDormantDays {
			t.Errorf("取值 %q 读取归一化应回退 %d，实际 %d", value, DefaultLinkDormantDays, got)
		}
	}

	// 全是数字但超出 int 范围：写入被拒，读取夹取到上限
	const huge = "99999999999999999999"
	if _, msg := ValidateLinkDormantDays(huge); msg == "" {
		t.Errorf("超出 int 范围的取值不应通过写入校验")
	}
	if got := ResolveLinkDormantDays(huge); got != MaxLinkDormantDays {
		t.Errorf("超长数字读取归一化应夹取到 %d，实际 %d", MaxLinkDormantDays, got)
	}

	// 前导零按数值处理
	if got, msg := ValidateLinkDormantDays("0030"); msg != "" || got != "30" {
		t.Errorf("0030 应归一化为 \"30\"，实际 (%q, %q)", got, msg)
	}
}

// TestShouldSendDormantNoticeVector 发信前提（doc/link_security.md 第 2.7 节 notice.sendGate）：
// 总开关 + 提醒开关 + 邮箱验证，三者缺一不发。
func TestShouldSendDormantNoticeVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Notice.SendGate) == 0 {
		t.Fatal("fixture 的 notice.sendGate 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Notice.SendGate {
		t.Run(testCase.Name, func(t *testing.T) {
			got := ShouldSendDormantNotice(
				testCase.SecurityEnabled,
				testCase.NoticeEnabled,
				testCase.EmailVerifyEnabled,
			)
			if got != testCase.Expect {
				t.Errorf("ShouldSendDormantNotice(%q, %q, %q) 期望 %v，实际 %v",
					testCase.SecurityEnabled, testCase.NoticeEnabled,
					testCase.EmailVerifyEnabled, testCase.Expect, got)
			}
		})
	}

	// 穷举 8 种组合：只有三者全为 true 才发信
	for _, security := range []string{"true", "false"} {
		for _, notice := range []string{"true", "false"} {
			for _, verify := range []string{"true", "false"} {
				want := security == "true" && notice == "true" && verify == "true"
				if got := ShouldSendDormantNotice(security, notice, verify); got != want {
					t.Errorf("ShouldSendDormantNotice(%q, %q, %q) 期望 %v，实际 %v",
						security, notice, verify, want, got)
				}
			}
		}
	}
}

// TestNeedDormantNoticeVector 休眠提醒的纯函数判定（任务规范第 6 节 notice.needNotify）：
// 同一休眠周期只提醒一次、时间变化或记录过期后再提醒。
func TestNeedDormantNoticeVector(t *testing.T) {
	fixture := loadLinkSecurityFixture(t)
	if len(fixture.Notice.NeedNotify) == 0 {
		t.Fatal("fixture 的 notice.needNotify 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Notice.NeedNotify {
		t.Run(testCase.Name, func(t *testing.T) {
			got := NeedDormantNotice(
				testCase.Dormant,
				testCase.HasRecord,
				testCase.RecordExpired,
				testCase.RecordLastCommentAt,
				testCase.CurrentLastCommentAt,
			)
			if got != testCase.Expect {
				t.Errorf("NeedDormantNotice(%v, %v, %v, %v, %d) 期望 %v，实际 %v",
					testCase.Dormant, testCase.HasRecord, testCase.RecordExpired,
					testCase.RecordLastCommentAt, testCase.CurrentLastCommentAt,
					testCase.Expect, got)
			}
		})
	}
}
