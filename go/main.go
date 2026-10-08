package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	// _ "net/http/pprof" // 隐式初始化 pprof 路由
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"momo-backend-go/internal/config"
	h "momo-backend-go/internal/handler/http"
	"momo-backend-go/internal/pkg/utils"
	"momo-backend-go/internal/repository/sqlite"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

const Version = "1.5.0"

func main() {

	// go func() {
	// 	// 启动一个独立的端口供 pprof 访问
	// 	http.ListenAndServe("0.0.0.0:6060", nil)
	// }()

	// 处理命令行参数
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			fmt.Printf("momo-backend version %s\n", Version)
			os.Exit(0)
		default:
			fmt.Printf("未知的参数: %s\n", os.Args[1])
			fmt.Printf("使用 --version 或 -v 查看版本信息\n")
			os.Exit(1)
		}
	}

	gin.SetMode(gin.ReleaseMode)

	// 1. 加载配置
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("无法加载配置: %v", err)
	}

	// 2. 准备数据库环境
	dbPath := "./data/data.db"
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		log.Fatalf("无法创建数据库目录: %v", err)
	}

	// 3. 连接数据库并初始化表结构
	db, err := sqlx.Connect("sqlite", dbPath)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	if err := sqlite.InitSchema(db); err != nil {
		log.Fatalf("初始化表结构失败: %v", err)
	}

	// 4. 初始化 Settings 和 Repo
	utils.InitSettingsDB(db)
	// 客户端 IP 解析策略：环境变量 > 配置文件 > 页面设置（Settings 表 trust_proxy）。
	// 未显式配置时留空，由页面设置决定。
	utils.SetTrustProxyOverride(cfg.ResolveTrustProxy())
	// 定期清理过期 token（避免从未被访问的过期项永久驻留内存）
	utils.StartTokenJanitor(10 * time.Minute)
	repo := sqlite.NewCommentRepository(db)
	handler := &h.CommentHandler{Repo: repo, Version: Version}

	// 5. 设置 Gin 引擎
	r := gin.Default()

	// 客户端 IP 一律由 utils.GetClientIP 解析（它按设置逐请求判断是否信任代理头），
	// 这里让 gin 自身永远不信任代理头，避免两套策略不一致。
	_ = r.SetTrustedProxies(nil)

	// 全局中间件：跨域处理（从数据库读取 allow_origin）
	r.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" {
			c.Next()
			return
		}

		allowOriginStr := utils.GetSetting("allow_origin")
		allowedOrigins := strings.Split(allowOriginStr, ",")
		for i := range allowedOrigins {
			allowedOrigins[i] = strings.TrimSpace(allowedOrigins[i])
		}

		// 显式配置 * 时按通配处理（API 使用 Bearer token，不依赖 Cookie 凭据）
		allowAll := false
		isAllowed := false
		for _, o := range allowedOrigins {
			if o == "*" {
				allowAll = true
			}
			if o == origin {
				isAllowed = true
			}
		}

		if allowAll {
			c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
			c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		} else if isAllowed {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	// 6. 注册路由
	h.RegisterRoutes(r, handler)

	// 只要访问 /admin 及其子路径，都尝试返回前端页面
	// 假设你的管理后台打包后放在 ./dist 目录下
	r.Static("/assets", "./public/assets") // 如果打包后的资源路径有前缀

	// 如果你的前端管理页面是完全独立的单页应用
	r.NoRoute(func(c *gin.Context) {
		// 只有非 API 请求才返回 index.html
		path := c.Request.URL.Path
		if !strings.HasPrefix(path, "/api") && !strings.HasPrefix(path, "/admin") {
			c.File("./public/index.html")
		}
	})

	// 7. 启动服务器
	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Printf("--- 评论系统后端已启动 ---\n")
	fmt.Printf("监听地址: %s\n", addr)
	fmt.Printf("数据库路径: %s\n", dbPath)
	fmt.Printf("版本: %s\n", Version)

	srv := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务器启动失败: %v", err)
		}
	}()

	// 等待中断信号，优雅关闭
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	fmt.Println("\n正在关闭服务器...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("服务器关闭失败: %v", err)
	}

	db.Close()
	fmt.Println("服务器已退出")
}
