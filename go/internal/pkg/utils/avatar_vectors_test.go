package utils

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

/*
评论区头像来源契约 v1 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/avatar.md：预设模板 / 四个占位符 / 八条写入错误文案 /
读取 fail-open 回落 / 生成结果，三端必须逐条一致。
*/

// avatarV1Fixture doc/vectors/avatar-v1.json 的结构化视图
type avatarV1Fixture struct {
	Version  int `json:"version"`
	Defaults struct {
		Enabled   string `json:"enabled"`
		Source    string `json:"source"`
		CustomURL string `json:"customUrl"`
	} `json:"defaults"`
	DefaultAvatarURL string `json:"defaultAvatarUrl"`
	Enabled          struct {
		Normalize []struct {
			Value  *string `json:"value"`
			Expect string  `json:"expect"`
		} `json:"normalize"`
		Effective []struct {
			Value  *string `json:"value"`
			Expect bool    `json:"expect"`
		} `json:"effective"`
		Invalid []struct {
			Value *string `json:"value"`
			Error string  `json:"error"`
		} `json:"invalid"`
	} `json:"enabled"`
	Limits struct {
		MaxURLLen int `json:"maxUrlLen"`
	} `json:"limits"`
	Sources        []string          `json:"sources"`
	Templates      map[string]string `json:"templates"`
	Placeholders   []string          `json:"placeholders"`
	Errors         map[string]string `json:"errors"`
	ValidateSource struct {
		Valid []struct {
			Value  *string `json:"value"`
			Expect string  `json:"expect"`
		} `json:"valid"`
		Invalid []struct {
			Value *string `json:"value"`
			Error string  `json:"error"`
		} `json:"invalid"`
	} `json:"validateSource"`
	ValidateCustomURL struct {
		Valid []struct {
			Value  *string `json:"value"`
			Expect string  `json:"expect"`
		} `json:"valid"`
		Invalid []struct {
			Value *string `json:"value"`
			Error string  `json:"error"`
		} `json:"invalid"`
	} `json:"validateCustomUrl"`
	Resolve []struct {
		Name      string  `json:"name"`
		Source    *string `json:"source"`
		CustomURL *string `json:"customUrl"`
		Expect    struct {
			Source   string `json:"source"`
			Template string `json:"template"`
		} `json:"expect"`
	} `json:"resolve"`
	Build []struct {
		Name      string  `json:"name"`
		Enabled   *bool   `json:"enabled"`
		Source    *string `json:"source"`
		CustomURL *string `json:"customUrl"`
		Email     string  `json:"email"`
		Author    string  `json:"author"`
		Expect    string  `json:"expect"`
	} `json:"build"`
}

func loadAvatarV1Fixture(t *testing.T) avatarV1Fixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("avatar-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/avatar-v1.json 失败: %v", err)
	}
	var fixture avatarV1Fixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/avatar-v1.json 失败: %v", err)
	}
	return fixture
}

func avatarDeref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func TestAvatarV1Constants(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)

	if DefaultAvatarEnabled != fixture.Defaults.Enabled {
		t.Errorf("DefaultAvatarEnabled 期望 %q，实际 %q", fixture.Defaults.Enabled, DefaultAvatarEnabled)
	}
	if DefaultAvatarSource != fixture.Defaults.Source {
		t.Errorf("DefaultAvatarSource 期望 %q，实际 %q", fixture.Defaults.Source, DefaultAvatarSource)
	}
	if DefaultAvatarCustomURL != fixture.Defaults.CustomURL {
		t.Errorf("DefaultAvatarCustomURL 期望 %q，实际 %q", fixture.Defaults.CustomURL, DefaultAvatarCustomURL)
	}
	if DefaultAvatarURL != fixture.DefaultAvatarURL {
		t.Errorf("DefaultAvatarURL 与 fixture.defaultAvatarUrl 不一致")
	}
	if AvatarURLMaxLength != fixture.Limits.MaxURLLen {
		t.Errorf("AvatarURLMaxLength 期望 %d，实际 %d", fixture.Limits.MaxURLLen, AvatarURLMaxLength)
	}
	if !reflect.DeepEqual(AvatarSources, fixture.Sources) {
		t.Errorf("AvatarSources 期望 %v，实际 %v", fixture.Sources, AvatarSources)
	}
	if !reflect.DeepEqual(AvatarTemplates, fixture.Templates) {
		t.Errorf("AvatarTemplates 期望 %v，实际 %v", fixture.Templates, AvatarTemplates)
	}
	if !reflect.DeepEqual(AvatarPlaceholders, fixture.Placeholders) {
		t.Errorf("AvatarPlaceholders 期望 %v，实际 %v", fixture.Placeholders, AvatarPlaceholders)
	}
}

func TestAvatarV1Enabled(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, tc := range fixture.Enabled.Normalize {
		value := avatarDeref(tc.Value)
		if got := NormalizeAvatarEnabled(value); got != tc.Expect {
			t.Errorf("NormalizeAvatarEnabled(%q) 期望 %q，实际 %q", value, tc.Expect, got)
		}
	}
	for _, tc := range fixture.Enabled.Effective {
		value := avatarDeref(tc.Value)
		if got := IsAvatarEnabled(value); got != tc.Expect {
			t.Errorf("IsAvatarEnabled(%q) 期望 %v，实际 %v", value, tc.Expect, got)
		}
	}
	for _, tc := range fixture.Enabled.Invalid {
		value := avatarDeref(tc.Value)
		if got := ValidateAvatarEnabled(value); got != tc.Error {
			t.Errorf("ValidateAvatarEnabled(%q) 期望 %q，实际 %q", value, tc.Error, got)
		}
	}
}

func TestAvatarV1ErrorMessages(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	cases := map[string]string{
		"notString":   AvatarErrNotString,
		"badSource":   AvatarErrBadSource,
		"badScheme":   AvatarErrBadScheme,
		"tooLong":     AvatarErrTooLong,
		"controlChar": AvatarErrControlChar,
		"emptyCustom": AvatarErrEmptyCustom,
		"badEnabled":  AvatarErrBadEnabled,
	}
	for name, got := range cases {
		if want := fixture.Errors[name]; got != want {
			t.Errorf("%s 期望 %q，实际 %q", name, want, got)
		}
	}
	if got := AvatarErrBadPlaceholder + "：{foo}"; got != fixture.Errors["badPlaceholder"] {
		t.Errorf("badPlaceholder 期望 %q，实际 %q", fixture.Errors["badPlaceholder"], got)
	}
}

func TestAvatarV1ValidateSource(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, tc := range fixture.ValidateSource.Valid {
		value := avatarDeref(tc.Value)
		if got := NormalizeAvatarSource(value); got != tc.Expect {
			t.Errorf("NormalizeAvatarSource(%q) 期望 %q，实际 %q", value, tc.Expect, got)
		}
		if msg := ValidateAvatarSource(value); msg != "" {
			t.Errorf("ValidateAvatarSource(%q) 期望通过，实际 %q", value, msg)
		}
	}
	for _, tc := range fixture.ValidateSource.Invalid {
		value := avatarDeref(tc.Value)
		if msg := ValidateAvatarSource(value); msg != tc.Error {
			t.Errorf("ValidateAvatarSource(%q) 期望 %q，实际 %q", value, tc.Error, msg)
		}
	}
}

func TestAvatarV1ValidateCustomURL(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, tc := range fixture.ValidateCustomURL.Valid {
		value := avatarDeref(tc.Value)
		if msg := ValidateAvatarCustomURL(value); msg != "" {
			t.Errorf("ValidateAvatarCustomURL(%q) 期望通过，实际 %q", value, msg)
		}
		if got := NormalizeAvatarCustomURL(value); got != tc.Expect {
			t.Errorf("NormalizeAvatarCustomURL(%q) 期望 %q，实际 %q", value, tc.Expect, got)
		}
	}
	for _, tc := range fixture.ValidateCustomURL.Invalid {
		value := avatarDeref(tc.Value)
		if msg := ValidateAvatarCustomURL(value); msg != tc.Error {
			t.Errorf("ValidateAvatarCustomURL(%q) 期望 %q，实际 %q", value, tc.Error, msg)
		}
	}
}

func TestAvatarV1Resolve(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, tc := range fixture.Resolve {
		t.Run(tc.Name, func(t *testing.T) {
			got := ResolveAvatarConfig(avatarDeref(tc.Source), avatarDeref(tc.CustomURL))
			if got.Source != tc.Expect.Source || got.Template != tc.Expect.Template {
				t.Errorf("期望 %+v，实际 %+v", tc.Expect, got)
			}
		})
	}
}

func TestAvatarV1Build(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, tc := range fixture.Build {
		t.Run(tc.Name, func(t *testing.T) {
			enabled := tc.Enabled == nil || *tc.Enabled
			config := ResolveAvatarConfig(avatarDeref(tc.Source), avatarDeref(tc.CustomURL))
			if got := ResolveAvatarURL(enabled, config, tc.Email, tc.Author); got != tc.Expect {
				t.Errorf("ResolveAvatarURL 期望 %q，实际 %q", tc.Expect, got)
			}
		})
	}
}

func TestAvatarV1Disabled(t *testing.T) {
	fixture := loadAvatarV1Fixture(t)
	for _, source := range AvatarSources {
		config := ResolveAvatarConfig(source, "https://cdn.example.com/{hash}")
		if got := ResolveAvatarURL(false, config, "a@b.c", "张三"); got != fixture.DefaultAvatarURL {
			t.Errorf("关闭头像时 source=%s 期望默认头像，实际 %q", source, got)
		}
	}
	if got := ResolveAvatarURL(true, ResolveAvatarConfig("gravatar", ""), "a@b.c", "x"); got !=
		"https://gravatar.com/avatar/5d60d4e28066df254d5452f92c910092?s=200&d=identicon" {
		t.Errorf("开启头像时应按来源生成，实际 %q", got)
	}
}

func TestAvatarV1CrossFieldValidation(t *testing.T) {
	custom := "custom"
	empty := ""
	defaultSource := "default"
	template := "https://cdn.example.com/{hash}"

	if msg := ValidateAvatarSettings(AvatarSettingsInput{Source: &custom, CustomURL: &empty}, "default", ""); msg != AvatarErrEmptyCustom {
		t.Errorf("custom + 空模板应返回 %q，实际 %q", AvatarErrEmptyCustom, msg)
	}
	if msg := ValidateAvatarSettings(AvatarSettingsInput{Source: &custom}, "default", template); msg != "" {
		t.Errorf("库里有模板时应通过，实际 %q", msg)
	}
	if msg := ValidateAvatarSettings(AvatarSettingsInput{Source: &defaultSource, CustomURL: &empty}, "custom", template); msg != "" {
		t.Errorf("切回 default 并清空模板应通过，实际 %q", msg)
	}
	if msg := ValidateAvatarSettings(AvatarSettingsInput{Source: &custom}, "default", template); msg != "" {
		t.Errorf("只切来源、复用已存模板应通过，实际 %q", msg)
	}
	badEnabled := "yes"
	if msg := ValidateAvatarSettings(AvatarSettingsInput{Enabled: &badEnabled}, "default", template); msg != AvatarErrBadEnabled {
		t.Errorf("非法 avatar_enabled 应返回 %q，实际 %q", AvatarErrBadEnabled, msg)
	}
}
