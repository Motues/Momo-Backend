package utils

import (
	"crypto/md5"
	"encoding/hex"
	"strings"
	"testing"
)

// avatarBase 是 GetCravatar 的输出前缀，便于断言
const avatarBase = "https://open.motues.top/avatar?name="

func TestGetCravatarVectors(t *testing.T) {
	for _, tc := range []struct {
		name  string
		email string
		hash  string
	}{
		{"常见邮箱", "test@example.com", "55502f40dc8b7c769880b10874abc9d0"},
		{"空邮箱", "", "d41d8cd98f00b204e9800998ecf8427e"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want := avatarBase + tc.hash + "&mode=cravatar&variant=beam"
			if got := GetCravatar(tc.email); got != want {
				t.Errorf("GetCravatar(%q) 期望 %q，实际 %q", tc.email, want, got)
			}
		})
	}
}

func TestGetCravatarNormalisation(t *testing.T) {
	base := GetCravatar("user@example.com")
	if base == "" {
		t.Fatalf("头像地址不应为空")
	}

	// 大小写与首尾空白必须归一化到同一个哈希
	variants := []string{
		"USER@EXAMPLE.COM",
		"User@Example.Com",
		"  user@example.com  ",
		"\tuser@example.com\n",
		" \t User@EXAMPLE.com \n",
	}
	for _, v := range variants {
		if got := GetCravatar(v); got != base {
			t.Errorf("GetCravatar(%q) 应与 %q 归一化后一致，\n期望 %q\n实际 %q", v, "user@example.com", base, got)
		}
	}

	// 不同的邮箱必须得到不同地址
	if GetCravatar("other@example.com") == base {
		t.Errorf("不同邮箱不应得到相同头像地址")
	}
	// 内部空白不归一化（只 Trim 首尾）
	if GetCravatar("us er@example.com") == base {
		t.Errorf("邮箱中间的空白不应被移除")
	}
}

func TestGetCravatarFormat(t *testing.T) {
	got := GetCravatar("a@b.com")

	if !strings.HasPrefix(got, avatarBase) {
		t.Errorf("地址前缀应为 %q，实际 %q", avatarBase, got)
	}
	if !strings.HasSuffix(got, "&mode=cravatar&variant=beam") {
		t.Errorf("地址应以 &mode=cravatar&variant=beam 结尾，实际 %q", got)
	}

	// 从地址中取出哈希并与独立计算的 MD5 对比
	rest := strings.TrimPrefix(got, avatarBase)
	hash, _, ok := strings.Cut(rest, "&")
	if !ok {
		t.Fatalf("地址中缺少查询参数分隔符: %q", got)
	}
	if len(hash) != 32 {
		t.Errorf("MD5 十六进制哈希应为 32 字符，实际 %d（%q）", len(hash), hash)
	}
	sum := md5.Sum([]byte("a@b.com"))
	if hash != hex.EncodeToString(sum[:]) {
		t.Errorf("头像哈希与独立计算的 MD5 不一致: %q", hash)
	}
	if strings.ToLower(hash) != hash {
		t.Errorf("MD5 哈希应为小写十六进制，实际 %q", hash)
	}

	// 不应对邮箱做 URL 编码后拼进地址（哈希与邮箱无关联，天然避免注入）
	if strings.Contains(got, "a@b.com") {
		t.Errorf("地址中不应出现明文邮箱: %q", got)
	}
}

func TestGetCravatarHandlesUntrustedInput(t *testing.T) {
	// 恶意输入只会影响 MD5 结果，不应破坏 URL 结构
	for _, input := range []string{
		`"><script>alert(1)</script>`,
		"a@b.com&mode=x",
		"../../etc/passwd",
		strings.Repeat("a", 1000) + "@example.com",
		"中文@例子.中国",
	} {
		got := GetCravatar(input)
		if !strings.HasPrefix(got, avatarBase) {
			t.Errorf("输入 %q 生成的前缀异常: %q", input, got)
		}
		if !strings.HasSuffix(got, "&mode=cravatar&variant=beam") {
			t.Errorf("输入 %q 生成的后缀异常: %q", input, got)
		}
		if strings.ContainsAny(got, "<>\"'") {
			t.Errorf("输入 %q 生成的地址包含危险字符: %q", input, got)
		}
		if strings.Count(got, "?") != 1 {
			t.Errorf("输入 %q 生成的地址查询串结构异常: %q", input, got)
		}
	}
}
