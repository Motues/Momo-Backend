package http

import (
	"math"
	"net/http"
	"strconv"
	"strings"

	"momo-backend-go/internal/model"

	"github.com/gin-gonic/gin"
)

/**
 * 认证记录（评论无感验证）的管理接口。
 *
 * 与 Node（nodejs/src/api/admin/verifyOverview.ts、verifyRecords.ts）/
 * Worker（worker/src/api/admin/verifyOverview.ts、verifyRecords.ts）的
 * 参数语义与响应结构完全一致，见 doc/api.md。
 */

// parseQueryIntJS 复刻 JS `parseInt(raw, 10)` 的语义：取**数字前缀**，忽略尾随垃圾。
//
// 为什么不用 strconv.Atoi：本组接口的参数解析必须与 Node / Worker 逐字一致，
// 而两端用的都是 JS 的 parseInt（"7abc" → 7、"1.5" → 1、"0x10" → 0）。
// 用 Atoi 会让 `days=7abc` 在 Go 上回退 30、在另外两端变成 7，属于三端漂移。
// utils 包里的 parseIntJS 未导出且语义相同，这里为不改动 utils 的公开面而本地实现。
func parseQueryIntJS(raw string) (int, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false
	}

	index := 0
	if value[0] == '+' || value[0] == '-' {
		index = 1
	}
	start := index
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		index++
	}
	if index == start {
		// 与 parseInt 一致：一个数字都没有就是 NaN
		return 0, false
	}

	parsed, err := strconv.Atoi(value[:index])
	if err != nil {
		// 溢出等异常：按非法值处理，交给调用方回退默认值
		return 0, false
	}
	return parsed, true
}

// parseVerifyDays 解析 days 参数：默认 30 天；`all` 或 `0` 表示全部（最近 12 个月）；
// 上限 365；其它非法值（非数字、负数）回退 30。数字前缀按 parseInt 语义取用，与 Node / Worker 一致。
func parseVerifyDays(raw string) int {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "" {
		return 30
	}
	if value == "all" {
		return 0
	}
	parsed, ok := parseQueryIntJS(value)
	if !ok || parsed < 0 {
		return 30
	}
	if parsed > 365 {
		return 365
	}
	return parsed
}

// parseVerifyInt 解析整数参数并夹在 [min, max]；非法值或小于 min 的取值回退默认值
func parseVerifyInt(raw string, min, max, fallback int) int {
	parsed, ok := parseQueryIntJS(raw)
	if !ok || parsed < min {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}

// GetVerifyOverview 认证记录统计概览 (GET /admin/verify/overview)
func (h *CommentHandler) GetVerifyOverview(c *gin.Context) {
	days := parseVerifyDays(c.Query("days"))
	offset := parseVerifyInt(c.Query("offset"), 0, 120, 0)

	data, err := h.Repo.GetVerifyOverview(c.Request.Context(), days, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Internal server error",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Verify stats fetched successfully",
		"data":    data,
	})
}

// GetVerifyRecords 认证明细列表 (GET /admin/verify/records)
func (h *CommentHandler) GetVerifyRecords(c *gin.Context) {
	query := model.VerifyRecordQuery{
		Page:     parseVerifyInt(c.Query("page"), 1, math.MaxInt32, 1),
		PageSize: parseVerifyInt(c.Query("pageSize"), 1, 100, 20),
		Event:    strings.TrimSpace(c.Query("event")),
		Reason:   strings.TrimSpace(c.Query("reason")),
		IP:       strings.TrimSpace(c.Query("ip")),
		Slug:     strings.TrimSpace(c.Query("slug")),
		Days:     parseVerifyDays(c.Query("days")),
	}
	if query.Event == "" {
		query.Event = "all"
	}

	data, err := h.Repo.ListVerifyRecords(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Internal server error",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Verify records fetched successfully",
		"data":    data,
	})
}
