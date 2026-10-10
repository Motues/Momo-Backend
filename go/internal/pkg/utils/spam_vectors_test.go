package utils

import (
	"encoding/json"
	"os"
	"testing"
)

/*
审核自动化（垃圾规则）的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

链接统计口径、长度单位（Unicode 码点，不是字节/码元）、阈值语义（0 = 不启用）
与规则优先级只要有一端漂移，这里就会立刻失败。
*/

type spamKeywordVector struct {
	Name string   `json:"name"`
	Raw  string   `json:"raw"`
	Want []string `json:"want"`
}

type spamNumberVector struct {
	Name     string `json:"name"`
	Raw      string `json:"raw"`
	Fallback int    `json:"fallback"`
	Max      int    `json:"max"`
	Want     int    `json:"want"`
}

type spamLinkVector struct {
	Name string `json:"name"`
	Text string `json:"text"`
	Want int    `json:"want"`
}

type spamEvaluateVector struct {
	Name       string   `json:"name"`
	Content    string   `json:"content"`
	Author     string   `json:"author"`
	URL        string   `json:"url"`
	Keywords   []string `json:"keywords"`
	MaxLinks   int      `json:"maxLinks"`
	MinLength  int      `json:"minLength"`
	WantReason *string  `json:"wantReason"`
}

type spamValidateVector struct {
	Name      string `json:"name"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	WantError bool   `json:"wantError"`
}

type spamFixture struct {
	Defaults struct {
		MaxLinks               int `json:"maxLinks"`
		MinLength              int `json:"minLength"`
		DuplicateWindowMinutes int `json:"duplicateWindowMinutes"`
	} `json:"defaults"`
	Limits struct {
		MaxKeywords               int `json:"maxKeywords"`
		MaxKeywordLength          int `json:"maxKeywordLength"`
		MaxLinks                  int `json:"maxLinks"`
		MaxMinLength              int `json:"maxMinLength"`
		MaxDuplicateWindowMinutes int `json:"maxDuplicateWindowMinutes"`
	} `json:"limits"`
	ParseKeywords []spamKeywordVector  `json:"parseKeywords"`
	ParseNumber   []spamNumberVector   `json:"parseNumber"`
	CountLinks    []spamLinkVector     `json:"countLinks"`
	Evaluate      []spamEvaluateVector `json:"evaluate"`
	Validate      []spamValidateVector `json:"validate"`
}

func loadSpamFixture(t *testing.T) spamFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("spam-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/spam-v1.json 失败: %v", err)
	}
	var fixture spamFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/spam-v1.json 失败: %v", err)
	}
	return fixture
}

func TestSpamVectorsDefaultsAndLimits(t *testing.T) {
	fixture := loadSpamFixture(t)

	if SpamDefaultMaxLinks != fixture.Defaults.MaxLinks {
		t.Errorf("链接数默认阈值与 fixture 不一致: %d != %d", SpamDefaultMaxLinks, fixture.Defaults.MaxLinks)
	}
	if SpamDefaultMinLength != fixture.Defaults.MinLength {
		t.Errorf("最短长度默认值与 fixture 不一致: %d != %d", SpamDefaultMinLength, fixture.Defaults.MinLength)
	}
	if SpamDefaultDuplicateWindow != fixture.Defaults.DuplicateWindowMinutes {
		t.Errorf("重复窗口默认值与 fixture 不一致: %d != %d", SpamDefaultDuplicateWindow, fixture.Defaults.DuplicateWindowMinutes)
	}
	if SpamMaxKeywords != fixture.Limits.MaxKeywords ||
		SpamMaxKeywordLength != fixture.Limits.MaxKeywordLength ||
		SpamMaxLinks != fixture.Limits.MaxLinks ||
		SpamMaxMinLength != fixture.Limits.MaxMinLength ||
		SpamMaxDuplicateWindowMinutes != fixture.Limits.MaxDuplicateWindowMinutes {
		t.Errorf("配置上限与 fixture 不一致")
	}
}

func TestSpamVectorsParseKeywords(t *testing.T) {
	fixture := loadSpamFixture(t)

	for _, v := range fixture.ParseKeywords {
		t.Run(v.Name, func(t *testing.T) {
			got := ParseSpamKeywords(v.Raw)
			if len(got) != len(v.Want) {
				t.Fatalf("期望 %v，实际 %v", v.Want, got)
			}
			for i := range v.Want {
				if got[i] != v.Want[i] {
					t.Errorf("第 %d 项期望 %q，实际 %q", i, v.Want[i], got[i])
				}
			}
		})
	}
}

func TestSpamVectorsParseNumber(t *testing.T) {
	fixture := loadSpamFixture(t)

	for _, v := range fixture.ParseNumber {
		t.Run(v.Name, func(t *testing.T) {
			if got := ParseSpamNumber(v.Raw, v.Fallback, v.Max); got != v.Want {
				t.Errorf("期望 %d，实际 %d", v.Want, got)
			}
		})
	}
}

func TestSpamVectorsCountLinks(t *testing.T) {
	fixture := loadSpamFixture(t)

	for _, v := range fixture.CountLinks {
		t.Run(v.Name, func(t *testing.T) {
			if got := CountLinks(v.Text); got != v.Want {
				t.Errorf("期望 %d，实际 %d", v.Want, got)
			}
		})
	}
}

func TestSpamVectorsEvaluate(t *testing.T) {
	fixture := loadSpamFixture(t)

	for _, v := range fixture.Evaluate {
		t.Run(v.Name, func(t *testing.T) {
			want := ""
			if v.WantReason != nil {
				want = *v.WantReason
			}
			if got := EvaluateSpamRules(v.Content, v.Author, v.URL, v.Keywords, v.MaxLinks, v.MinLength); got != want {
				t.Errorf("期望 %q，实际 %q", want, got)
			}
		})
	}
}

func TestSpamVectorsValidate(t *testing.T) {
	fixture := loadSpamFixture(t)

	for _, v := range fixture.Validate {
		t.Run(v.Name, func(t *testing.T) {
			msg := ValidateSpamSetting(v.Key, v.Value)
			if v.WantError && msg == "" {
				t.Error("期望校验失败，实际通过")
			}
			if !v.WantError && msg != "" {
				t.Errorf("期望校验通过，实际 %q", msg)
			}
		})
	}
}
