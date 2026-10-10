package utils

import (
	"sync"
	"time"
)

// 极简滑动窗口限流（进程内内存实现）。
//
// 与 Node 的 utils/rateLimit.ts、Worker 的 utils/rateLimit.ts 语义逐条对齐：
//   - 每个 key（限流维度，如 "comments:get:<ip>"）记录窗口内每次请求的时间戳；
//   - 窗口内已记录数 >= limit 即拒绝，被拒的请求不记入（不会自我延长封禁）；
//   - 每 5 分钟清扫一次过期 bucket；
//   - bucket 数量达到上限时，对**新 key 直接放行**（fail-open）：宁可少限流，
//     也不能让伪造 IP 把限流表撑爆内存。
//
// 用途：缓解公开接口被批量爬取（例如遍历 post_slug 收割 admin_email_hash）。
// 注意：IP 归属依赖 GetClientIP()，若部署在代理之后却未开启 trust_proxy，
// 所有请求会共享代理 IP，请按 README 正确配置 trust_proxy。
const (
	rateSweepInterval = 5 * time.Minute
	// Go 侧单进程通常承载全站流量，上限取与 Node 一致的 10000
	rateMaxBuckets = 10000
)

// requestLimiter 滑动窗口限流器（并发安全）
type requestLimiter struct {
	mu        sync.Mutex
	buckets   map[string][]int64
	lastSweep time.Time
}

func newRequestLimiter() *requestLimiter {
	return &requestLimiter{buckets: make(map[string][]int64), lastSweep: time.Now()}
}

// publicLimiter 公开接口共用的限流器实例
var publicLimiter = newRequestLimiter()

// AllowRequest 是否允许本次请求。
//
// key 是限流维度（建议带上接口名与 IP，如 "comments:get:1.2.3.4"），
// limit 是窗口内允许的请求数，window 是窗口长度。
func AllowRequest(key string, limit int, window time.Duration) bool {
	return publicLimiter.allow(key, limit, window, time.Now())
}

func (l *requestLimiter) allow(key string, limit int, window time.Duration, now time.Time) bool {
	windowMs := window.Milliseconds()
	nowMs := now.UnixMilli()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweep(nowMs, windowMs)

	hits := l.buckets[key]
	if hits == nil && len(l.buckets) >= rateMaxBuckets {
		// 内存保护：直接放行新 key，避免限流表无限增长
		return true
	}

	// 就地过滤出窗口内的记录（hits 为 nil 时 kept 仍为 nil，下面 append 会新建切片）
	kept := filterHits(hits, nowMs, windowMs)
	if len(kept) >= limit {
		l.buckets[key] = kept
		return false
	}
	l.buckets[key] = append(kept, nowMs)
	return true
}

// sweep 清理窗口外的记录；两次清扫之间至少间隔 rateSweepInterval
func (l *requestLimiter) sweep(nowMs, windowMs int64) {
	if nowMs-l.lastSweep.UnixMilli() < rateSweepInterval.Milliseconds() {
		return
	}
	l.lastSweep = time.UnixMilli(nowMs)

	for key, hits := range l.buckets {
		kept := filterHits(hits, nowMs, windowMs)
		if len(kept) == 0 {
			delete(l.buckets, key)
			continue
		}
		l.buckets[key] = kept
	}
}

// filterHits 返回窗口内的时间戳（复用底层数组，避免每次请求都分配新切片）
func filterHits(hits []int64, nowMs, windowMs int64) []int64 {
	if len(hits) == 0 {
		return nil
	}
	kept := hits[:0]
	for _, ts := range hits {
		if nowMs-ts < windowMs {
			kept = append(kept, ts)
		}
	}
	return kept
}
