package http

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Health 健康检查（GET /health）
//
// 供容器 HEALTHCHECK / docker-compose / 反向代理探针使用，不需要认证：
//   - 进程能响应 → 200；
//   - 进程活着但数据库连接不可用 → 503（别把流量送进只会 500 的实例）。
//
// 响应结构三端（Node / Go / Worker）一致：
//
//	200 {"code":200,"message":"ok","data":{"status":"ok","database":"ok"}}
//	503 {"code":503,"message":"database unavailable","data":{"status":"error","database":"error"}}
func (h *CommentHandler) Health(c *gin.Context) {
	// 探针必须快速返回：数据库卡住时用 2s 超时兜底，避免 healthcheck 自己超时堆积
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()

	if err := h.Repo.Ping(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"code":    503,
			"message": "database unavailable",
			"data": gin.H{
				"status":   "error",
				"database": "error",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "ok",
		"data": gin.H{
			"status":   "ok",
			"database": "ok",
		},
	})
}
