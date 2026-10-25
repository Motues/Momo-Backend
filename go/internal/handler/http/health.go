package http

import (
	"context"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"
)

// containerized 在进程启动时判定一次：Docker / Podman 都会在根目录留下标记文件。
// 管理面板据此判断该显示「替换文件」还是「docker compose pull」步骤。
var containerized = detectContainer()

func detectContainer() bool {
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

// runtimeInfo 是 /health 的公开运行时字段（不含敏感内容）：
//
//	runtime   node | go | worker
//	container 是否运行在容器中
//	os/arch   服务端平台，Go 版本按它选择 Release 包
//
// 管理面板用这些字段自动识别部署方式，只展示对应的升级步骤。
func runtimeInfo() gin.H {
	return gin.H{
		"runtime":   "go",
		"container": containerized,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
	}
}

// Health 健康检查（GET /health）
//
// 供容器 HEALTHCHECK / docker-compose / 反向代理探针使用，不需要认证：
//   - 进程能响应 → 200；
//   - 进程活着但数据库连接不可用 → 503（别把流量送进只会 500 的实例）。
//
// 响应结构三端（Node / Go / Worker）一致：
//
//	200 {"code":200,"message":"ok","data":{"status":"ok","database":"ok","runtime":"go","container":false,"os":"linux","arch":"amd64"}}
//	503 {"code":503,"message":"database unavailable","data":{"status":"error","database":"error",...}}
//
// 数据库不可用时也会带上运行时字段，面板仍能识别部署方式。
func (h *CommentHandler) Health(c *gin.Context) {
	// 探针必须快速返回：数据库卡住时用 2s 超时兜底，避免 healthcheck 自己超时堆积
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()

	if err := h.Repo.Ping(ctx); err != nil {
		data := runtimeInfo()
		data["status"] = "error"
		data["database"] = "error"
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"code":    503,
			"message": "database unavailable",
			"data":    data,
		})
		return
	}

	data := runtimeInfo()
	data["status"] = "ok"
	data["database"] = "ok"
	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "ok",
		"data":    data,
	})
}
