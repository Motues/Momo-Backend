package http

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"momo-backend-go/internal/repository/sqlite"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
)

// GET /health：公开、无认证，返回结构与 Node / Worker 一致。
func TestHealth(t *testing.T) {
	t.Run("数据库可用时返回 200", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/health", nil)
		w := httptest.NewRecorder()
		testRouter.ServeHTTP(w, req)

		if w.Code != 200 {
			t.Fatalf("status = %d, want 200", w.Code)
		}

		var body struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    struct {
				Status   string `json:"status"`
				Database string `json:"database"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("解析响应失败: %v", err)
		}
		if body.Code != 200 || body.Message != "ok" {
			t.Fatalf("code/message = %d/%q, want 200/ok", body.Code, body.Message)
		}
		if body.Data.Status != "ok" || body.Data.Database != "ok" {
			t.Fatalf("data = %+v, want ok/ok", body.Data)
		}
	})

	t.Run("数据库不可用时返回 503", func(t *testing.T) {
		// 独立开一个连接再关掉：不能用共享的 testDB，否则会拖垮其它用例
		broken, err := sqlx.Open("sqlite", ":memory:")
		if err != nil {
			t.Fatalf("打开临时数据库失败: %v", err)
		}
		if err := broken.Close(); err != nil {
			t.Fatalf("关闭临时数据库失败: %v", err)
		}

		router := gin.New()
		RegisterRoutes(router, &CommentHandler{
			Repo:    sqlite.NewCommentRepository(broken),
			Version: "test-version",
		})

		req := httptest.NewRequest("GET", "/health", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != 503 {
			t.Fatalf("status = %d, want 503", w.Code)
		}

		var body struct {
			Code int `json:"code"`
			Data struct {
				Database string `json:"database"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("解析响应失败: %v", err)
		}
		if body.Code != 503 || body.Data.Database != "error" {
			t.Fatalf("body = %+v, want code 503 / database error", body)
		}
	})
}
