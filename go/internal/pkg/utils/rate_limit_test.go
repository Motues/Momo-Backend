package utils

import (
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 滑动窗口限流器（与 Node / Worker 的 rateLimit 语义对齐）
// ---------------------------------------------------------------------------

func TestRequestLimiterAllowsUpToLimit(t *testing.T) {
	limiter := newRequestLimiter()
	now := time.Now()

	for i := 0; i < 120; i++ {
		if !limiter.allow("comments:get:1.2.3.4", 120, 60*time.Second, now) {
			t.Fatalf("第 %d 次请求应被放行", i+1)
		}
	}
	// 第 121 次被拒
	if limiter.allow("comments:get:1.2.3.4", 120, 60*time.Second, now) {
		t.Error("窗口内第 121 次请求应被拒绝")
	}
}

func TestRequestLimiterRejectedRequestDoesNotExtendWindow(t *testing.T) {
	limiter := newRequestLimiter()
	base := time.Now()

	for i := 0; i < 5; i++ {
		limiter.allow("k", 5, 60*time.Second, base)
	}
	if limiter.allow("k", 5, 60*time.Second, base) {
		t.Fatal("已到上限时应拒绝")
	}

	// 被拒的请求不应被计入：窗口滑过之后第一批记录全部过期，应重新放行
	later := base.Add(61 * time.Second)
	if !limiter.allow("k", 5, 60*time.Second, later) {
		t.Error("窗口滑过后应重新放行（被拒的请求不应延长限流）")
	}
}

func TestRequestLimiterWindowSlides(t *testing.T) {
	limiter := newRequestLimiter()
	base := time.Now()

	// 第 1 秒打满
	for i := 0; i < 3; i++ {
		limiter.allow("k", 3, 10*time.Second, base.Add(time.Duration(i)*time.Second))
	}
	if limiter.allow("k", 3, 10*time.Second, base.Add(2*time.Second)) {
		t.Fatal("窗口内应拒绝")
	}

	// 11 秒后最早的记录已过期，应放行
	if !limiter.allow("k", 3, 10*time.Second, base.Add(11*time.Second)) {
		t.Error("过期记录应被清理并放行")
	}
}

func TestRequestLimiterIsolatesKeys(t *testing.T) {
	limiter := newRequestLimiter()
	now := time.Now()

	for i := 0; i < 3; i++ {
		limiter.allow("comments:get:10.0.0.1", 3, time.Minute, now)
	}
	if limiter.allow("comments:get:10.0.0.1", 3, time.Minute, now) {
		t.Fatal("同一 key 达到上限应拒绝")
	}
	if !limiter.allow("comments:get:10.0.0.2", 3, time.Minute, now) {
		t.Error("不同 key（IP）之间必须互不影响")
	}
}

func TestRequestLimiterFailsOpenWhenTableIsFull(t *testing.T) {
	limiter := newRequestLimiter()
	now := time.Now()

	// 直接构造满表（避免真的灌 10000 个 key）
	for i := 0; i < rateMaxBuckets; i++ {
		limiter.buckets["k"+string(rune(i))] = nil
	}
	if !limiter.allow("brand-new-key", 1, time.Minute, now) {
		t.Error("限流表已满时应对新 key 放行（fail-open，避免内存被撑爆）")
	}
}

func TestRequestLimiterSweepsExpiredBuckets(t *testing.T) {
	limiter := newRequestLimiter()
	base := time.Now()

	limiter.allow("stale", 5, time.Second, base)
	if len(limiter.buckets) != 1 {
		t.Fatalf("应记录 1 个 bucket，实际 %d", len(limiter.buckets))
	}

	// 超过清扫间隔（5 分钟）后，过期 bucket 应被删除
	limiter.allow("fresh", 5, time.Second, base.Add(rateSweepInterval+time.Second))
	if _, ok := limiter.buckets["stale"]; ok {
		t.Error("过期 bucket 应在清扫时被删除")
	}
	if _, ok := limiter.buckets["fresh"]; !ok {
		t.Error("当前 bucket 应保留")
	}
}

func TestRequestLimiterIsConcurrencySafe(t *testing.T) {
	limiter := newRequestLimiter()
	now := time.Now()

	const goroutines = 20
	const perGoroutine = 10
	allowed := make([]int, goroutines)

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				if limiter.allow("shared", 100, time.Minute, now) {
					allowed[idx]++
				}
			}
		}(g)
	}
	wg.Wait()

	total := 0
	for _, n := range allowed {
		total += n
	}
	if total != 100 {
		t.Errorf("并发下应恰好放行 100 次（等于上限），实际 %d", total)
	}
}

func TestAllowRequestUsesSharedLimiter(t *testing.T) {
	// 公开接口共用一个限流器实例；这里用一个独立 key 验证接口本身可用
	key := "test:allow-request:" + time.Now().Format(time.RFC3339Nano)
	if !AllowRequest(key, 1, time.Minute) {
		t.Fatal("首次请求应放行")
	}
	if AllowRequest(key, 1, time.Minute) {
		t.Error("同一 key 超过上限应拒绝")
	}
}
