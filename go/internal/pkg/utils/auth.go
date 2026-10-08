package utils

import (
	"crypto/rand"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// LoginLimiter 处理登录失败计数与 IP 封禁
type LoginLimiter struct {
	mu            sync.Mutex
	attempts      map[string]int
	blockedUntil  map[string]time.Time
	maxAttempts   int
	blockDuration time.Duration
}

var Limiter = &LoginLimiter{
	attempts:      make(map[string]int),
	blockedUntil:  make(map[string]time.Time),
	maxAttempts:   5,                // 最大尝试次数
	blockDuration: 30 * time.Minute, // 封禁时长
}

// TokenStore 模拟存储登录生成的临时密钥
var TokenStore = struct {
	sync.RWMutex
	Map map[string]time.Time // key: token, value: expiration time
}{Map: make(map[string]time.Time)}

// trustProxyOverride：-1 = 未指定（以页面设置 trust_proxy 为准），0 = 强制关闭，1 = 强制开启
var trustProxyOverride atomic.Int32

// trustProxySource 覆盖来源："env" / "config" / ""（页面设置）
var trustProxySource atomic.Value

func init() {
	trustProxyOverride.Store(-1)
	trustProxySource.Store("")
}

// SetTrustProxyOverride 由 main 在读取配置与环境变量后调用。
// value 为 nil 表示未显式指定，此时以页面设置（Settings 表 trust_proxy）为准。
func SetTrustProxyOverride(value *bool, source string) {
	if value == nil {
		trustProxyOverride.Store(-1)
		trustProxySource.Store("")
		return
	}
	if *value {
		trustProxyOverride.Store(1)
	} else {
		trustProxyOverride.Store(0)
	}
	trustProxySource.Store(source)
}

// TrustProxyOverrideSource 返回覆盖来源（供后台提示"页面设置不生效"）
func TrustProxyOverrideSource() string {
	if v, ok := trustProxySource.Load().(string); ok {
		return v
	}
	return ""
}

// TrustProxyEnabled 当前是否信任代理头。
// 优先级：环境变量/配置文件（显式指定时）> 页面设置 trust_proxy。
// 页面设置直接读库，因此后台一改动即刻生效。
func TrustProxyEnabled() bool {
	switch trustProxyOverride.Load() {
	case 1:
		return true
	case 0:
		return false
	}
	return GetSetting("trust_proxy") == "true"
}

// normalizeAndValidateIP 归一化并校验 IP，非法时返回空串
func normalizeAndValidateIP(value string) string {
	ip := strings.TrimSpace(value)
	if ip == "" {
		return ""
	}
	// [::1] / [::1]:1234
	if strings.HasPrefix(ip, "[") {
		if end := strings.Index(ip, "]"); end > 0 {
			ip = ip[1:end]
		}
	} else if strings.Count(ip, ":") == 1 && strings.Contains(ip, ".") {
		// 1.2.3.4:5678
		if host, _, err := net.SplitHostPort(ip); err == nil {
			ip = host
		}
	}
	// ::ffff:1.2.3.4 -> 1.2.3.4
	if strings.HasPrefix(strings.ToLower(ip), "::ffff:") {
		if parsed := net.ParseIP(ip); parsed != nil {
			if v4 := parsed.To4(); v4 != nil {
				ip = v4.String()
			}
		}
	}
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

// GetClientIP 获取真实 IP。
//
// TRUST_PROXY 关闭（默认）：只使用 TCP 连接对端地址，请求头无法影响结果。
// TRUST_PROXY 开启：按 CF-Connecting-IP → X-Real-IP → X-Forwarded-For 取值，
// 其中 X-Forwarded-For 取**最右一跳**（由最近的可信代理追加，客户端伪造的前置项无效）。
func GetClientIP(c *gin.Context) string {
	if TrustProxyEnabled() {
		if ip := normalizeAndValidateIP(c.GetHeader("CF-Connecting-IP")); ip != "" {
			return ip
		}
		if ip := normalizeAndValidateIP(c.GetHeader("X-Real-IP")); ip != "" {
			return ip
		}
		if xff := c.GetHeader("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				if ip := normalizeAndValidateIP(parts[i]); ip != "" {
					return ip
				}
			}
		}
	}

	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		return strings.Trim(c.Request.RemoteAddr, "[]")
	}
	return host
}

// IsIPBlocked 检查 IP 是否被封禁
func (l *LoginLimiter) IsIPBlocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if until, ok := l.blockedUntil[ip]; ok {
		if time.Now().Before(until) {
			return true
		}
		// 封禁到期，清理
		delete(l.blockedUntil, ip)
		delete(l.attempts, ip)
	}
	return false
}

// RecordAttempt 记录失败尝试
func (l *LoginLimiter) RecordAttempt(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempts[ip]++
	if l.attempts[ip] >= l.maxAttempts {
		l.blockedUntil[ip] = time.Now().Add(l.blockDuration)
		return true
	}
	return false
}

// ResetAttempt 登录成功后重置
func (l *LoginLimiter) ResetAttempt(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
	delete(l.blockedUntil, ip)
}

// GenerateTempKey 使用 CSPRNG 生成临时密钥
func GenerateTempKey(name string) string {
	b := make([]byte, 32)
	rand.Read(b)
	token := fmt.Sprintf("%x", b)

	// 设置 20 分钟过期时间
	expiration := time.Now().Add(20 * time.Minute)

	TokenStore.Lock()
	TokenStore.Map[token] = expiration
	TokenStore.Unlock()

	return token
}

// IsTokenValid 验证密钥有效性
func IsTokenValid(token string) bool {
	TokenStore.Lock()
	defer TokenStore.Unlock()

	expiration, ok := TokenStore.Map[token]
	if !ok {
		return false
	}

	// 检查是否过期
	if time.Now().After(expiration) {
		delete(TokenStore.Map, token)
		return false
	}

	return true
}

// RevokeToken 吊销单个 token（登出）
func RevokeToken(token string) {
	TokenStore.Lock()
	defer TokenStore.Unlock()
	delete(TokenStore.Map, token)
}

// ClearAllTokens 吊销全部会话（改密后调用）
func ClearAllTokens() {
	TokenStore.Lock()
	defer TokenStore.Unlock()
	TokenStore.Map = make(map[string]time.Time)
}

// CleanupExpiredTokens 清理过期 token，避免从未被访问的过期项永久驻留内存
func CleanupExpiredTokens() int {
	TokenStore.Lock()
	defer TokenStore.Unlock()
	now := time.Now()
	removed := 0
	for token, expiration := range TokenStore.Map {
		if now.After(expiration) {
			delete(TokenStore.Map, token)
			removed++
		}
	}
	return removed
}

// StartTokenJanitor 启动后台定期清理（main 调用一次即可）
func StartTokenJanitor(interval time.Duration) {
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			CleanupExpiredTokens()
		}
	}()
}
