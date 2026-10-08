package model

import (
	"testing"
	"time"
)

// TestCommentPubDateHelpers 校验 SetPubDate 与两个格式化方法的一致性。
// 注意：时间格式化使用本地时区，因此断言与 time.Unix 的输出比较而不是写死字符串。
func TestCommentPubDateHelpers(t *testing.T) {
	c := &Comment{}
	c.SetPubDate(1712345678)

	if c.PubDate != 1712345678 {
		t.Errorf("SetPubDate 应把值原样写入 PubDate 字段，实际 %d", c.PubDate)
	}
	if got, want := c.GetPubDate(), time.Unix(1712345678, 0).Format("2006-01-02 15:04:05"); got != want {
		t.Errorf("GetPubDate 期望 %q，实际 %q", want, got)
	}
	if got, want := c.GetPubDateRFC3339(), time.Unix(1712345678, 0).Format(time.RFC3339); got != want {
		t.Errorf("GetPubDateRFC3339 期望 %q，实际 %q", want, got)
	}

	// 零值也不应 panic
	zero := &Comment{}
	if got := zero.GetPubDate(); got == "" {
		t.Errorf("零值时间戳也应返回可读字符串")
	}
}

// TestCommentPubDateHelpersTreatMillisAsSeconds 记录一处潜在缺陷：
// 数据库契约中 pub_date 是「Unix 毫秒整数」，但 GetPubDate / GetPubDateRFC3339
// 通过 time.Unix（秒）解释该字段，传入毫秒值会得到完全错误的时间。
// 目前这两个方法在生产代码中没有任何调用方（死代码），因此暂未造成线上影响。
func TestCommentPubDateHelpersTreatMillisAsSeconds(t *testing.T) {
	const millis = int64(1712345678901)

	c := &Comment{PubDate: millis}

	wantIfMillis := time.UnixMilli(millis).Format("2006-01-02 15:04:05")
	if got := c.GetPubDate(); got == wantIfMillis {
		t.Errorf("当前实现按秒解释毫秒时间戳，若这里相等说明行为已改变（got=%q）", got)
	}

	t.Logf("pub_date=%d 毫秒时：GetPubDate()=%q；按毫秒解释应为 %q",
		millis, c.GetPubDate(), wantIfMillis)
}
