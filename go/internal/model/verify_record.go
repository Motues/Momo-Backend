package model

// 认证记录（评论无感验证）的事件类型。三端取值完全一致，见 doc/data_table.md。
const (
	// VerifyEventChallenge 签发挑战
	VerifyEventChallenge = "challenge"
	// VerifyEventPass 答案校验通过
	VerifyEventPass = "pass"
	// VerifyEventFail 答案校验失败
	VerifyEventFail = "fail"
)

// VerifyRecordInput 写入一条认证记录。
//
// 写入是尽力而为的：Repository.RecordVerifyEvent 内部吞掉异常并只记日志，
// 绝不能让记录失败影响验证结果本身。
type VerifyRecordInput struct {
	Event       string
	Reason      string
	ElapsedMs   *int64
	Difficulty  *int64
	ChallengeID string
	PostSlug    string
	IP          string
	Country     string
	Network     string
	ASN         *int64
}

// VerifyRecordQuery 认证明细列表查询参数（语义与 Node / Worker 完全一致）
type VerifyRecordQuery struct {
	Page     int
	PageSize int
	Event    string
	Reason   string
	IP       string
	Slug     string
	Days     int
}

// VerifyOverviewRange 统计窗口描述
type VerifyOverviewRange struct {
	Days   int    `json:"days"`
	Offset int    `json:"offset"`
	From   string `json:"from"`
	To     string `json:"to"`
	Bucket string `json:"bucket"`
}

// VerifyOverviewSummary 指标卡数据（Delta 为与上一个等长窗口比较的百分比整数）
type VerifyOverviewSummary struct {
	Challenges       int64    `json:"challenges"`
	ChallengesDelta  *int64   `json:"challengesDelta"`
	Verified         int64    `json:"verified"`
	VerifiedDelta    *int64   `json:"verifiedDelta"`
	Failed           int64    `json:"failed"`
	FailedDelta      *int64   `json:"failedDelta"`
	AvgDurationMs    *int64   `json:"avgDurationMs"`
	AvgDurationDelta *int64   `json:"avgDurationDelta"`
	PassRate         *float64 `json:"passRate"`
}

// VerifyTrendPoint 趋势图上的一个分桶
type VerifyTrendPoint struct {
	Date       string `json:"date"`
	Challenges int64  `json:"challenges"`
	Verified   int64  `json:"verified"`
	Failed     int64  `json:"failed"`
}

// VerifyTopCountry 来源地区榜单项
type VerifyTopCountry struct {
	Name    string  `json:"name"`
	Count   int64   `json:"count"`
	Percent float64 `json:"percent"`
}

// VerifyTopNetwork 网络运营商榜单项
type VerifyTopNetwork struct {
	Name    string  `json:"name"`
	ASN     *int64  `json:"asn"`
	Count   int64   `json:"count"`
	Percent float64 `json:"percent"`
}

// VerifyTopReason 失败原因榜单项
type VerifyTopReason struct {
	Reason  string  `json:"reason"`
	Count   int64   `json:"count"`
	Percent float64 `json:"percent"`
}

// VerifyOverview 认证记录统计概览（GET /admin/verify/overview）
type VerifyOverview struct {
	Range   VerifyOverviewRange   `json:"range"`
	Summary VerifyOverviewSummary `json:"summary"`
	Trend   []VerifyTrendPoint    `json:"trend"`
	// GeoSupported 仅 Cloudflare Worker 部署为 true；Node / Go 没有 IP 归属地数据源
	GeoSupported bool               `json:"geoSupported"`
	TopCountries []VerifyTopCountry `json:"topCountries"`
	TopNetworks  []VerifyTopNetwork `json:"topNetworks"`
	TopReasons   []VerifyTopReason  `json:"topReasons"`
}

// VerifyRecordItem 认证明细行
type VerifyRecordItem struct {
	ID          int64  `json:"id"`
	CreatedAt   string `json:"createdAt"`
	Event       string `json:"event"`
	Reason      string `json:"reason"`
	ElapsedMs   *int64 `json:"elapsedMs"`
	Difficulty  *int64 `json:"difficulty"`
	ChallengeID string `json:"challengeId"`
	PostSlug    string `json:"postSlug"`
	IPAddress   string `json:"ipAddress"`
	Country     string `json:"country"`
	Network     string `json:"network"`
	ASN         *int64 `json:"asn"`
}

// VerifyRecordList 认证明细分页结果（GET /admin/verify/records）
type VerifyRecordList struct {
	List     []VerifyRecordItem `json:"list"`
	Total    int64              `json:"total"`
	Page     int                `json:"page"`
	PageSize int                `json:"pageSize"`
}
