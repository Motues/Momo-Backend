package utils

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

/*
多管理员邮箱契约 v1 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/admin_emails.md：邮箱判定与归一化、parseAdminEmails 的容错规则、
resolve 的旧键回落与 notify_email 回落到列表第一个，只要有一端漂移这里就会失败。
*/

// adminEmailsFixture doc/vectors/admin-emails-v1.json 的结构化视图
type adminEmailsFixture struct {
	Limits struct {
		MaxAdminEmails int `json:"maxAdminEmails"`
		MaxEmailLen    int `json:"maxEmailLen"`
	} `json:"limits"`
	Errors map[string]string `json:"errors"`
	Email  struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"email"`
	Parse []struct {
		Name   string   `json:"name"`
		Stored string   `json:"stored"`
		Expect []string `json:"expect"`
	} `json:"parse"`
	Resolve []struct {
		Name         string   `json:"name"`
		StoredAdmins string   `json:"storedAdmins"`
		LegacyAdmin  string   `json:"legacyAdmin"`
		StoredNotify string   `json:"storedNotify"`
		ExpectAdmins []string `json:"expectAdmins"`
		ExpectNotify string   `json:"expectNotify"`
	} `json:"resolve"`
}

func loadAdminEmailsFixture(t *testing.T) adminEmailsFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("admin-emails-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/admin-emails-v1.json 失败: %v", err)
	}
	var fixture adminEmailsFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/admin-emails-v1.json 失败: %v", err)
	}
	return fixture
}

// TestAdminEmailsLimits 钉死两个上限
func TestAdminEmailsLimits(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)

	if MaxAdminEmails != fixture.Limits.MaxAdminEmails {
		t.Errorf("MaxAdminEmails 期望 %d，实际 %d", fixture.Limits.MaxAdminEmails, MaxAdminEmails)
	}
	if MaxAdminEmailLength != fixture.Limits.MaxEmailLen {
		t.Errorf("MaxAdminEmailLength 期望 %d，实际 %d", fixture.Limits.MaxEmailLen, MaxAdminEmailLength)
	}
}

// TestIsValidEmailVector 邮箱判定的合法 / 非法取值（全量）
func TestIsValidEmailVector(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)
	if len(fixture.Email.Valid) == 0 || len(fixture.Email.Invalid) == 0 {
		t.Fatal("fixture 的 email 段为空，向量没有生效")
	}

	for _, value := range fixture.Email.Valid {
		t.Run("valid:"+vectorLabel(value), func(t *testing.T) {
			if !IsValidEmail(value) {
				t.Errorf("期望通过校验：%q（归一化后 %q）", value, NormalizeEmail(value))
			}
			if !IsValidEmail(NormalizeEmail(value)) {
				t.Errorf("归一化后的值也应合法：%q", NormalizeEmail(value))
			}
		})
	}
	for _, value := range fixture.Email.Invalid {
		t.Run("invalid:"+vectorLabel(value), func(t *testing.T) {
			if IsValidEmail(value) {
				t.Errorf("期望被拒：%q（归一化后 %q）", value, NormalizeEmail(value))
			}
		})
	}
}

// TestParseAdminEmailsVector 读取路径的容错解析
func TestParseAdminEmailsVector(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)
	if len(fixture.Parse) == 0 {
		t.Fatal("fixture 的 parse 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Parse {
		t.Run(testCase.Name, func(t *testing.T) {
			got := ParseAdminEmails(testCase.Stored)
			if !reflect.DeepEqual(got, expectSlice(testCase.Expect)) {
				t.Errorf("解析 %q 期望 %v，实际 %v", testCase.Stored, testCase.Expect, got)
			}
		})
	}
}

// TestResolveAdminEmailsVector 读取路径：旧键回落 + notify_email 回落列表第一个
func TestResolveAdminEmailsVector(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)
	if len(fixture.Resolve) == 0 {
		t.Fatal("fixture 的 resolve 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Resolve {
		t.Run(testCase.Name, func(t *testing.T) {
			admins := ResolveAdminEmails(testCase.StoredAdmins, testCase.LegacyAdmin)
			if !reflect.DeepEqual(admins, expectSlice(testCase.ExpectAdmins)) {
				t.Errorf("admins 期望 %v，实际 %v", testCase.ExpectAdmins, admins)
			}
			if got := ResolveNotifyEmail(testCase.StoredNotify, admins); got != testCase.ExpectNotify {
				t.Errorf("notify 期望 %q，实际 %q", testCase.ExpectNotify, got)
			}
		})
	}
}

// TestValidateAdminEmailsVector 写入路径的四条错误文案与归一化结果
func TestValidateAdminEmailsVector(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)

	for _, testCase := range []struct {
		name   string
		raw    string
		errorK string // fixture.Errors 的键；空串表示通过
		want   string // 通过时期望的归一化 JSON
	}{
		{"未配置", "", "", "[]"},
		{"空白", "   ", "", "[]"},
		{"空数组", "[]", "", "[]"},
		{"坏 JSON", "{oops", "notArray", ""},
		{"非数组", `"a@b.com"`, "notArray", ""},
		{"数字", "123", "notArray", ""},
		{"非字符串项", `["a@b.com", 1]`, "notString", ""},
		{"null 项", `["a@b.com", null]`, "notString", ""},
		{"非法邮箱", `["a@b.com","nope"]`, "badEmail", ""},
		{"尖括号邮箱", `["<a@b.com>"]`, "badEmail", ""},
		{
			"超过 10 个",
			`["a1@x.com","a2@x.com","a3@x.com","a4@x.com","a5@x.com","a6@x.com","a7@x.com","a8@x.com","a9@x.com","a10@x.com","a11@x.com"]`,
			"tooMany", "",
		},
		{"归一化 + 去重保序", `["  A@X.com ", "b@y.com", "a@x.com"]`, "", `["a@x.com","b@y.com"]`},
		{"丢弃空串", `["", "   ", "a@b.com"]`, "", `["a@b.com"]`},
		{
			"去重后不超过 10 个即可",
			`["a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com","a1@x.com"]`,
			"", `["a1@x.com"]`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			value, msg := ValidateAdminEmails(testCase.raw)
			if testCase.errorK == "" {
				if msg != "" {
					t.Fatalf("期望通过校验，实际被拒：%s", msg)
				}
				if value != testCase.want {
					t.Errorf("归一化结果期望 %q，实际 %q", testCase.want, value)
				}
				return
			}
			want, ok := fixture.Errors[testCase.errorK]
			if !ok {
				t.Fatalf("fixture 的 errors 段缺少键 %q", testCase.errorK)
			}
			if msg != want {
				t.Errorf("错误文案期望 %q，实际 %q", want, msg)
			}
		})
	}

	// 同时踩「超过 10 个」与「非法邮箱」时，与 Node / Worker 一致地先报数量
	t.Run("先报数量再报非法邮箱", func(t *testing.T) {
		raw := `["a1@x.com","a2@x.com","a3@x.com","a4@x.com","a5@x.com","a6@x.com","a7@x.com","a8@x.com","a9@x.com","a10@x.com","nope"]`
		if _, msg := ValidateAdminEmails(raw); msg != fixture.Errors["tooMany"] {
			t.Errorf("错误文案期望 %q，实际 %q", fixture.Errors["tooMany"], msg)
		}
	})
}

// TestValidateNotifyEmailVector notify_email 的两条错误文案与命中判定
func TestValidateNotifyEmailVector(t *testing.T) {
	fixture := loadAdminEmailsFixture(t)
	admins := []string{"a@x.com", "b@y.com"}

	for _, testCase := range []struct {
		name   string
		raw    string
		admins []string
		errorK string
		want   string
	}{
		{"为空表示清空", "", admins, "", ""},
		{"空白表示清空", "   ", admins, "", ""},
		{"大小写与空格归一后命中", "  B@Y.COM  ", admins, "", "b@y.com"},
		{"非法邮箱", "nope", admins, "badNotify", ""},
		{"不在列表里", "c@z.com", admins, "notifyNotInList", ""},
		{"列表为空", "a@x.com", []string{}, "notifyNotInList", ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			value, msg := ValidateNotifyEmail(testCase.raw, testCase.admins)
			if testCase.errorK == "" {
				if msg != "" {
					t.Fatalf("期望通过校验，实际被拒：%s", msg)
				}
				if value != testCase.want {
					t.Errorf("归一化结果期望 %q，实际 %q", testCase.want, value)
				}
				return
			}
			want, ok := fixture.Errors[testCase.errorK]
			if !ok {
				t.Fatalf("fixture 的 errors 段缺少键 %q", testCase.errorK)
			}
			if msg != want {
				t.Errorf("错误文案期望 %q，实际 %q", want, msg)
			}
		})
	}
}

// TestAdminEmailMembership 成员判定与哈希数组
func TestAdminEmailMembership(t *testing.T) {
	admins := []string{"a@x.com", "b@y.com"}

	for _, testCase := range []struct {
		email string
		want  bool
	}{
		{"a@x.com", true},
		{"A@X.COM", true},
		{"  b@y.com  ", true},
		{"c@z.com", false},
		{"", false},
		{"   ", false},
	} {
		if got := IsAdminEmail(testCase.email, admins); got != testCase.want {
			t.Errorf("IsAdminEmail(%q) 期望 %v，实际 %v", testCase.email, testCase.want, got)
		}
	}

	hashes := AdminEmailHashes(admins)
	if len(hashes) != 2 {
		t.Fatalf("哈希数组长度期望 2，实际 %d", len(hashes))
	}
	if hashes[0] != EmailHash("a@x.com") || hashes[1] != EmailHash("b@y.com") {
		t.Errorf("哈希数组应与列表同序：%v", hashes)
	}
	if len(hashes[0]) != 64 {
		t.Errorf("sha256 十六进制应为 64 个字符，实际 %q", hashes[0])
	}
	if got := AdminEmailHashes(nil); len(got) != 0 {
		t.Errorf("空列表应返回空数组，实际 %v", got)
	}
}
