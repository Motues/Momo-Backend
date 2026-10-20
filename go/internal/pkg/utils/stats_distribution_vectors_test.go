package utils

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

/*
客户端分布归一化契约 v1 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/vectors/stats-distribution-v1.json（由 scripts/gen-stats-distribution-vectors.js 生成）：
家族名去掉尾部版本号、整条原始 UA 归「未知」、设备四分类的优先级（rules.deviceOrder）。
任何一端改了正则、去版本号的边界或分类优先级，这里都会失败。
*/

// statsDistributionFixture doc/vectors/stats-distribution-v1.json 的结构化视图
type statsDistributionFixture struct {
	Version int                       `json:"version"`
	Browser []statsDistributionVector `json:"browser"`
	OS      []statsDistributionVector `json:"os"`
	Device  []statsDistributionVector `json:"device"`
}

// statsDistributionVector 一条向量；raw 用 *string 承接 fixture 里的 null
type statsDistributionVector struct {
	Raw      *string `json:"raw"`
	Expected string  `json:"expected"`
}

func loadStatsDistributionFixture(t *testing.T) statsDistributionFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("stats-distribution-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/stats-distribution-v1.json 失败: %v", err)
	}
	var fixture statsDistributionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/stats-distribution-v1.json 失败: %v", err)
	}
	return fixture
}

// vectorRaw 把 fixture 的 raw（可能是 null）映射成实现侧的取值：
// SQLite 的 NULL 由调用方 COALESCE(col, '') 取出，因此 null 与空串走同一分支。
func vectorRaw(raw *string) string {
	if raw == nil {
		return ""
	}
	return *raw
}

// vectorName 生成可读、不会因过长或含引号而难以定位的子用例名
func vectorName(raw *string) string {
	if raw == nil {
		return "null"
	}
	return vectorLabel(*raw)
}

// TestStatsDistributionVectors fixture 里的每一条 browser / os / device 向量
func TestStatsDistributionVectors(t *testing.T) {
	fixture := loadStatsDistributionFixture(t)
	if fixture.Version != 1 {
		t.Errorf("fixture 版本期望 1，实际 %d", fixture.Version)
	}
	if len(fixture.Browser) == 0 || len(fixture.OS) == 0 || len(fixture.Device) == 0 {
		t.Fatal("fixture 的 browser / os / device 段有空段，向量没有生效")
	}

	total := 0
	for _, testCase := range fixture.Browser {
		total++
		t.Run("browser:"+vectorName(testCase.Raw), func(t *testing.T) {
			if got := NormalizeBrowserFamily(vectorRaw(testCase.Raw)); got != testCase.Expected {
				t.Errorf("浏览器原始值 %q 期望 %q，实际 %q", vectorRaw(testCase.Raw), testCase.Expected, got)
			}
		})
	}
	for _, testCase := range fixture.OS {
		total++
		t.Run("os:"+vectorName(testCase.Raw), func(t *testing.T) {
			if got := NormalizeOSFamily(vectorRaw(testCase.Raw)); got != testCase.Expected {
				t.Errorf("操作系统原始值 %q 期望 %q，实际 %q", vectorRaw(testCase.Raw), testCase.Expected, got)
			}
		})
	}
	for _, testCase := range fixture.Device {
		total++
		t.Run("device:"+vectorName(testCase.Raw), func(t *testing.T) {
			if got := NormalizeDeviceType(vectorRaw(testCase.Raw)); got != testCase.Expected {
				t.Errorf("设备原始值 %q 期望 %q，实际 %q", vectorRaw(testCase.Raw), testCase.Expected, got)
			}
		})
	}

	// 三端一共 50 条向量（browser 18 + os 14 + device 18），数量对不上说明 fixture 变了
	if total != len(fixture.Browser)+len(fixture.OS)+len(fixture.Device) {
		t.Errorf("向量条数统计错误：%d", total)
	}
	t.Logf("已校验 %d 条客户端分布向量", total)
}

// TestStatsDistributionNullAndEmptyAgree 钉死「NULL 与空串等价、字面量 "null" 不等价」：
//
// SQLite 的这几列可能是 NULL，仓库层用 COALESCE(col, '') 取出，于是 null 与空串落在
// 同一分支（浏览器 / 系统 → 未知，设备 → 桌面）；而历史数据里真的存了字符串 "null"
// 时必须当普通原始值处理（浏览器 → "null"、设备 → 移动），不能与 SQL 的 NULL 混淆。
func TestStatsDistributionNullAndEmptyAgree(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		raw     string
		browser string
		os      string
		device  string
	}{
		{"空串", "", "未知", "未知", "桌面"},
		{"纯空白", "   ", "未知", "未知", "桌面"},
		{"字面量 null", "null", "null", "null", "移动"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := NormalizeBrowserFamily(testCase.raw); got != testCase.browser {
				t.Errorf("NormalizeBrowserFamily(%q) 期望 %q，实际 %q", testCase.raw, testCase.browser, got)
			}
			if got := NormalizeOSFamily(testCase.raw); got != testCase.os {
				t.Errorf("NormalizeOSFamily(%q) 期望 %q，实际 %q", testCase.raw, testCase.os, got)
			}
			if got := NormalizeDeviceType(testCase.raw); got != testCase.device {
				t.Errorf("NormalizeDeviceType(%q) 期望 %q，实际 %q", testCase.raw, testCase.device, got)
			}
		})
	}
}

// TestMergeDistribution 归一化 → 合并同名家族 → count DESC / name ASC → 取前 5
func TestMergeDistribution(t *testing.T) {
	t.Run("浏览器：版本合并 + 原始UA并入未知 + 截断", func(t *testing.T) {
		rows := []RawCount{
			{Name: "Chrome 145.0.0.0", Count: 2},
			{Name: "Chrome 120", Count: 1}, // 与上一行合并成 Chrome(3)
			{Name: "", Count: 1},
			{Name: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0", Count: 2},
			{Name: "Safari 17.0", Count: 2},
			{Name: "Mobile Safari 17.0", Count: 2},
			{Name: "Edge 147.0.0.0", Count: 1},
			{Name: "Firefox 121.0", Count: 1},
			{Name: "Opera 9.80", Count: 1},
		}

		want := []NameCount{
			{Name: "Chrome", Count: 3},
			{Name: "未知", Count: 3}, // 空串 1 + 原始 UA 2
			{Name: "Mobile Safari", Count: 2},
			{Name: "Safari", Count: 2},
			{Name: "Edge", Count: 1}, // 第 6 名 Firefox / Opera 被 LIMIT 5 截断
		}
		if got := MergeDistribution(rows, NormalizeBrowserFamily, 5); !reflect.DeepEqual(got, want) {
			t.Errorf("合并结果期望 %+v，实际 %+v", want, got)
		}
	})

	t.Run("设备：四分类 + 同名合并 + 中文按码点排序", func(t *testing.T) {
		rows := []RawCount{
			{Name: "Desktop", Count: 2},
			{Name: "", Count: 1}, // 空值 = 桌面
			{Name: "iPad", Count: 1},
			{Name: "Windows Phone", Count: 1}, // 移动关键词优先于桌面关键词
		}

		want := []NameCount{
			{Name: "桌面", Count: 3},
			{Name: "平板", Count: 1}, // 平(U+5E73) < 移(U+79FB)
			{Name: "移动", Count: 1},
		}
		if got := MergeDistribution(rows, NormalizeDeviceType, 5); !reflect.DeepEqual(got, want) {
			t.Errorf("合并结果期望 %+v，实际 %+v", want, got)
		}
	})

	t.Run("计数相同按名字升序（含 CJK / ASCII 混排）", func(t *testing.T) {
		rows := []RawCount{
			{Name: "b", Count: 1},
			{Name: "未知", Count: 1},
			{Name: "a", Count: 1},
		}
		want := []NameCount{
			{Name: "a", Count: 1},
			{Name: "b", Count: 1},
			{Name: "未知", Count: 1},
		}
		if got := MergeDistribution(rows, func(raw string) string { return raw }, 5); !reflect.DeepEqual(got, want) {
			t.Errorf("合并结果期望 %+v，实际 %+v", want, got)
		}
	})

	t.Run("空输入与 limit=0 都返回非 nil 空切片", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			rows  []RawCount
			limit int
		}{
			{"nil 输入", nil, 5},
			{"空输入", []RawCount{}, 5},
			{"limit=0", []RawCount{{Name: "Chrome 120", Count: 1}}, 0},
			{"limit 为负", []RawCount{{Name: "Chrome 120", Count: 1}}, -1},
		} {
			t.Run(tc.name, func(t *testing.T) {
				got := MergeDistribution(tc.rows, NormalizeBrowserFamily, tc.limit)
				if got == nil {
					t.Fatalf("应返回空数组而不是 nil（JSON 需要 []）")
				}
				if len(got) != 0 {
					t.Errorf("期望空列表，实际 %+v", got)
				}
			})
		}
	})
}
