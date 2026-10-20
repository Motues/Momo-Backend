package utils

import (
	"regexp"
	"sort"
)

/*
数据统计页「客户端分布」（浏览器 / 操作系统 / 设备）的归一化口径。

唯一的判定基准是 doc/vectors/stats-distribution-v1.json（由
scripts/gen-stats-distribution-vectors.js 生成），Node / Go / Worker 三端读同一份
fixture 复算，任何一端改了正则或分类优先级都会被测试立刻抓住。

背景：Comment.browser / Comment.os 存的是 ua-parser 的原始结果「<名称> <版本号>」，
Comment.device 存的是 `model || type || vendor`。直接按原值分组会让每个版本各占一档
（Chrome 145 / Chrome 144 …），历史导入的整条原始 UA 还会独占榜首，因此三端都在
SQL 分组之后统一做一次归一化：去掉版本号得到「家族名」，原始 UA 归入「未知」，
设备归成 桌面 / 移动 / 平板 / 未知 四类。

正则一律在包级编译一次（RE2）：JS 侧的 /i 在这里写成 (?i)，\s / \d / \w 语义相同。
SQLite 的这几列可能是 NULL，调用方用 COALESCE(col, '') 取出来，
空串与 NULL 在本文件的口径里等价（设备是 桌面，浏览器 / 系统是 未知）；
字面量字符串 "null" 则按普通原始值处理，不会与 SQL 的 NULL 混淆。
*/

// wsClass 归一化时认可的全部空白字符。
//
// 刻意写成**显式字符类**，而不是依赖各语言自带的「空白」概念（`\s` / TrimSpace）：
// JS 的 `\s` 含 NBSP 与 U+FEFF，而 Go 的 RE2 `\s` 只认 ASCII 空白、strings.TrimSpace
// 又不含 U+FEFF —— 只靠语言默认口径，从导入的脏数据里就会得到不同的家族名。
// 字符集与 doc/vectors/stats-distribution-v1.json 的向量一一对应
// （Go 的 RE2 用 \x{...} 写 Unicode 码位，JS 侧写 \uXXXX）。
const wsClass = `[ \t\n\r\f\v\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	// trimRe 同时吃掉首尾空白
	trimRe = regexp.MustCompile(`^` + wsClass + `+|` + wsClass + `+$`)

	// versionSuffixRe 尾部的「空白 + 以数字开头的 token」就是版本号：
	// `Chrome 145.0.0.0` → `Chrome`、`Mobile Safari 17.0` → `Mobile Safari`。
	// 只切末尾这一段，因此名称里自带的数字不受影响。
	versionSuffixRe = regexp.MustCompile(wsClass + `+[0-9][0-9A-Za-z_.]*$`)
)

// trimWhitespace 按 wsClass 去掉首尾空白（不能用 strings.TrimSpace：它不含 U+FEFF）
func trimWhitespace(text string) string {
	return trimRe.ReplaceAllString(text, "")
}

// 历史脏数据（整条原始 UA）的两种形态：以 Mozilla/ 开头，或只剩 AppleWebKit 片段
var (
	rawMozillaRe = regexp.MustCompile(`(?i)^Mozilla/`)
	rawWebKitRe  = regexp.MustCompile(`(?i)AppleWebKit`)
)

// 设备分类关键词。移动关键词必须排在桌面关键词之前：
// `Windows Phone` 同时含 windows 与 phone，先判桌面会把它算成桌面。
var (
	tabletRe  = regexp.MustCompile(`(?i)ipad|tablet`)
	mobileRe  = regexp.MustCompile(`(?i)mobile|android|iphone|ipod|phone`)
	desktopRe = regexp.MustCompile(`(?i)desktop|macintosh|windows|linux|mac os|chrome os|ubuntu`)
)

// NormalizeBrowserFamily 浏览器家族名：去掉尾部版本号；空值与原始 UA 一律「未知」。
func NormalizeBrowserFamily(raw string) string {
	return normalizeClientFamily(raw)
}

// NormalizeOSFamily 操作系统家族名：口径与浏览器完全一致（同一个 normalizeFamily）。
func NormalizeOSFamily(raw string) string {
	return normalizeClientFamily(raw)
}

// normalizeClientFamily 浏览器 / 操作系统共用的家族名归一化：
//
//  1. NULL / 空串 / 纯空白 → 未知（NULL 由调用方 COALESCE 成空串）；
//  2. 原始 UA（Mozilla/ 开头或含 AppleWebKit）→ 未知（拿整条 UA 去截版本号没有意义）；
//  3. 其余去掉尾部版本号再 trim；切完变成空串时也归「未知」。
func normalizeClientFamily(raw string) string {
	text := trimWhitespace(raw)
	if text == "" || isRawUserAgent(text) {
		return "未知"
	}
	family := trimWhitespace(versionSuffixRe.ReplaceAllString(text, ""))
	if family == "" {
		return "未知"
	}
	return family
}

// isRawUserAgent 判定「整条原始 UA」这种历史脏数据（fixture 的 rules.rawUserAgent）
func isRawUserAgent(text string) bool {
	return rawMozillaRe.MatchString(text) || rawWebKitRe.MatchString(text)
}

// NormalizeDeviceType 设备类型归一化，判定优先级**不可调换**（fixture 的 rules.deviceOrder）：
//
//	空（含 NULL）→ 桌面（ua-parser 对桌面端就是不下发 device，空值是正常取值）
//	原始 UA        → 未知
//	iPad | tablet  → 平板
//	移动关键词      → 移动（必须排在桌面关键词之前，见 mobileRe 的说明）
//	桌面关键词      → 桌面
//	其余非空值      → 移动（只剩机型码，如 ABR-AL60 / V2507A）
//
// 已知局限（与 Node / Worker 一致）：Android 平板只留下机型时会被算作「移动」，
// 因为 ua-parser 此时已经丢掉了 tablet 这个类型信息。
func NormalizeDeviceType(raw string) string {
	text := trimWhitespace(raw)
	if text == "" {
		return "桌面"
	}
	if isRawUserAgent(text) {
		return "未知"
	}
	if tabletRe.MatchString(text) {
		return "平板"
	}
	if mobileRe.MatchString(text) {
		return "移动"
	}
	if desktopRe.MatchString(text) {
		return "桌面"
	}
	return "移动"
}

// RawCount SQL 按原始列分组后的一行：原始值 + 计数
type RawCount struct {
	Name  string `db:"name"`
	Count int64  `db:"count"`
}

// NameCount 榜单的一项：归一化并合并同名后的名字 + 计数（响应体的形状）
type NameCount struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// MergeDistribution 归一化 → 合并同名家族 → 排序 → 截断：
//
//	ORDER BY count DESC, name ASC LIMIT limit
//
// name ASC 是「Unicode 码点序」：Go 的字符串比较就是 UTF-8 字节序，对合法 UTF-8
// 等价于码点序，与 JS 的 `<` 结果一致；同名家族先合并计数再排序（不是各占一档）。
//
// limit <= 0 时返回空列表；没有任何输入时返回长度为 0 的非 nil 切片（JSON 是 []，不是 null）。
func MergeDistribution(rows []RawCount, normalize func(string) string, limit int) []NameCount {
	merged := make(map[string]int64, len(rows))
	for _, row := range rows {
		merged[normalize(row.Name)] += row.Count
	}

	list := make([]NameCount, 0, len(merged))
	for name, count := range merged {
		list = append(list, NameCount{Name: name, Count: count})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Count != list[j].Count {
			return list[i].Count > list[j].Count
		}
		return list[i].Name < list[j].Name
	})

	if limit < 0 {
		limit = 0
	}
	if len(list) > limit {
		list = list[:limit]
	}
	return list
}
