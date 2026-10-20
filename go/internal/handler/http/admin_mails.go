package http

import (
	"log"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

/*
管理端邮件发送日志列表（GET /admin/mails，见任务规范第 9 节）。

写入点在最底层的发送函数（utils.EmailService.SendRaw），这里只负责读：
分页、status / type / search 筛选，按 created_at DESC, id DESC 排序，
只返回保留窗口内的行（保留天数由设置项 mail_log_retention_days 决定，默认 30 天、0 = 永久保留），
并在响应里带回 retentionDays。
*/

// ListMails GET /admin/mails
func (h *CommentHandler) ListMails(c *gin.Context) {
	pageStr := c.DefaultQuery("page", "1")
	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 1 {
		// 与用户列表一致：分页参数非法一律 400（不静默纠正）
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid query parameters"})
		return
	}

	pageSizeStr := c.DefaultQuery("pageSize", "20")
	pageSize, err := strconv.Atoi(pageSizeStr)
	// pageSize clamp：1 <= pageSize <= 100（与用户列表的 limit 口径一致）
	if err != nil || pageSize < 1 {
		pageSize = 20
	} else if pageSize > 100 {
		pageSize = 100
	}

	// status：all（默认）/ sent / failed，无法识别的取值按 all 处理
	status := strings.ToLower(strings.TrimSpace(c.DefaultQuery("status", "all")))
	if status != "sent" && status != "failed" {
		status = "all"
	}

	// type：all（默认）/ 6 种邮件类型，无法识别的取值按 all 处理
	mailType := strings.ToLower(strings.TrimSpace(c.DefaultQuery("type", "all")))
	if mailType != "all" && !utils.MailLogTypeAllowed(mailType) {
		mailType = "all"
	}

	// search：对 recipient 或 subject 做不区分大小写的模糊匹配，trim 后为空表示不筛选
	search := strings.ToLower(strings.TrimSpace(c.DefaultQuery("search", "")))

	now := nowMillis()
	// 永久保留（0）时 since 为空串，仓储据此不加时间下限
	since, _ := utils.MailLogCutoff(now)
	result, err := h.Repo.ListMailLogs(c.Request.Context(), model.MailLogQuery{
		Status: status,
		Type:   mailType,
		Search: search,
		Since:  since,
		Offset: (page - 1) * pageSize,
		Limit:  pageSize,
	})
	if err != nil {
		log.Printf("[ERROR] 查询邮件日志失败: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to fetch mails"})
		return
	}

	list := result.List
	if list == nil {
		list = []model.MailLog{}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Mails fetched successfully",
		"data": gin.H{
			"list":          list,
			"total":         result.Total,
			"page":          page,
			"pageSize":      pageSize,
			"retentionDays": utils.MailLogRetentionDaysFromSettings(),
		},
	})
}
