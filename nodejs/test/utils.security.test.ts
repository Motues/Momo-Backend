import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateTempKey,
  checkKey,
  revokeTempKey,
  clearAllTempKeys,
  extractToken,
  checkContent,
  sanitizeUrl,
  sanitizeHtml,
  isValidIpOrCidr,
  isValidIpBlacklistJson,
  checkIpBlacklist,
  checkEmailBlacklist,
  getCommentStatus,
  isValidCommentStatus,
  COMMENT_STATUSES,
} from "../src/utils/security";
import { setSetting } from "../src/utils/settings";

describe("utils/security — 临时密钥生命周期", () => {
  afterEach(() => clearAllTempKeys());

  it("生成的密钥可通过校验", async () => {
    const key = await generateTempKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(checkKey(key)).toBe(true);
  });

  it("每次生成都是不同的密钥", async () => {
    const a = await generateTempKey();
    const b = await generateTempKey();
    expect(a).not.toBe(b);
    expect(checkKey(a)).toBe(true);
    expect(checkKey(b)).toBe(true);
  });

  it("未知密钥 / 空串 / 非字符串 / undefined 一律拒绝", async () => {
    expect(checkKey("not-a-real-key")).toBe(false);
    expect(checkKey("")).toBe(false);
    expect(checkKey(undefined as unknown as string)).toBe(false);
    expect(checkKey(123 as unknown as string)).toBe(false);
  });

  it("前缀相近的密钥不会被误判（长度不同直接拒绝）", async () => {
    const key = await generateTempKey();
    expect(checkKey(key.slice(0, 30))).toBe(false);
    expect(checkKey(`${key}x`)).toBe(false);
  });

  it("revokeTempKey 吊销后失效，重复吊销返回 false", async () => {
    const key = await generateTempKey();
    expect(revokeTempKey(key)).toBe(true);
    expect(checkKey(key)).toBe(false);
    expect(revokeTempKey(key)).toBe(false);
  });

  it("revokeTempKey 对空密钥返回 false，且不影响其他会话", async () => {
    const key = await generateTempKey();
    expect(revokeTempKey("")).toBe(false);
    expect(checkKey(key)).toBe(true);
  });

  it("clearAllTempKeys 一次吊销全部会话", async () => {
    const a = await generateTempKey();
    const b = await generateTempKey();
    clearAllTempKeys();
    expect(checkKey(a)).toBe(false);
    expect(checkKey(b)).toBe(false);
  });

  it("20 分钟后过期：过期即失效并被清理", async () => {
    const key = await generateTempKey();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(Date.now() + 20 * 60 * 1000 - 1000);
      expect(checkKey(key)).toBe(true);
      spy.mockReturnValue(Date.now() + 20 * 60 * 1000 + 1000);
      expect(checkKey(key)).toBe(false);
      // 已被惰性清理：再次检查同样为 false
      expect(checkKey(key)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("utils/security — extractToken", () => {
  it("支持 Bearer 前缀", () => {
    expect(extractToken("Bearer abc123")).toBe("abc123");
  });

  it("没有前缀时原样返回", () => {
    expect(extractToken("abc123")).toBe("abc123");
  });

  it("空 header 返回空串", () => {
    expect(extractToken("")).toBe("");
  });

  it("Bearer 大小写敏感（小写 bearar 会被整体当作 token）", () => {
    expect(extractToken("bearer abc")).toBe("bearer abc");
  });

  it("只有 Bearer 前缀时返回空串", () => {
    expect(extractToken("Bearer ")).toBe("");
  });
});

describe("utils/security — checkContent（纯文本字段 XSS 过滤）", () => {
  it("空值原样返回", () => {
    expect(checkContent("")).toBe("");
    expect(checkContent(undefined as unknown as string)).toBe(undefined);
  });

  it("普通文本不受影响", () => {
    expect(checkContent("这是一条正常评论")).toBe("这是一条正常评论");
  });

  it("移除 script/style 块及其内容", () => {
    expect(checkContent("<script>alert(1)</script>hello")).toBe("hello");
    expect(checkContent("a<style>body{}</style>b")).toBe("ab");
  });

  it("移除事件处理属性", () => {
    expect(checkContent("<b onclick='x()'>hi</b>")).toBe("<b>hi</b>");
    expect(checkContent('<img src="a" onerror=alert(1)>')).toBe('<img src="a">');
  });

  it("移除 javascript:/vbscript: 协议链接", () => {
    expect(checkContent('<a href="javascript:alert(1)">x</a>')).toBe("<a >x</a>");
    expect(checkContent("<a href='vbscript:x'>y</a>")).toBe("<a >y</a>");
  });

  it("移除危险嵌入标签", () => {
    expect(checkContent("<iframe src=x></iframe>")).toBe("");
    expect(checkContent("a<embed src=x>b")).toBe("ab");
    expect(checkContent("<form action=/x>")).toBe("");
  });
});

describe("utils/security — sanitizeUrl（协议白名单）", () => {
  it("非字符串一律返回空串", () => {
    expect(sanitizeUrl(null)).toBe("");
    expect(sanitizeUrl(undefined)).toBe("");
    expect(sanitizeUrl(123)).toBe("");
    expect(sanitizeUrl({})).toBe("");
  });

  it("空串/纯空白返回空串", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl("   ")).toBe("");
  });

  it("允许 http / https / mailto（大小写不敏感）", () => {
    expect(sanitizeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(sanitizeUrl("HTTP://example.com")).toBe("HTTP://example.com");
    expect(sanitizeUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
  });

  it("允许相对路径与协议相对地址", () => {
    expect(sanitizeUrl("/posts/hello")).toBe("/posts/hello");
    expect(sanitizeUrl("//cdn.example.com/x.js")).toBe("//cdn.example.com/x.js");
    expect(sanitizeUrl("posts/hello")).toBe("posts/hello");
  });

  it("拒绝 javascript: / vbscript: / data: 等所有非白名单 scheme", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(sanitizeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("");
    expect(sanitizeUrl("file:///etc/passwd")).toBe("");
  });

  it("剥离控制字符后再判定 scheme（java\\nscript:）", () => {
    expect(sanitizeUrl("java\nscript:alert(1)")).toBe("");
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("");
    expect(sanitizeUrl("\u0000javascript:alert(1)")).toBe("");
  });

  it("去掉首尾空白后返回原值", () => {
    expect(sanitizeUrl("  https://example.com  ")).toBe("https://example.com");
  });
});

describe("utils/security — sanitizeHtml（DOMPurify 白名单）", () => {
  it("非字符串返回空串", () => {
    expect(sanitizeHtml(null as unknown as string)).toBe("");
    expect(sanitizeHtml(42 as unknown as string)).toBe("");
  });

  it("保留白名单标签", () => {
    expect(sanitizeHtml("<p>hi</p>")).toBe("<p>hi</p>");
    expect(sanitizeHtml("<strong>b</strong>")).toBe("<strong>b</strong>");
    expect(sanitizeHtml('<a href="https://a.com">x</a>')).toBe('<a href="https://a.com">x</a>');
  });

  it("移除 script 标签及其内容", () => {
    expect(sanitizeHtml("<p>hi</p><script>alert(1)</script>")).toBe("<p>hi</p>");
  });

  it("移除事件处理属性（onerror）", () => {
    expect(sanitizeHtml("<img src=x onerror=alert(1)>")).toBe('<img src="x">');
  });

  it("移除 javascript: 链接的 href", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("移除 iframe / object / embed 等不在白名单的标签", () => {
    expect(sanitizeHtml('<iframe src="//evil"></iframe>')).toBe("");
    expect(sanitizeHtml("<object data=x></object>")).toBe("");
  });

  it("移除行内 style 与 data-* 属性", () => {
    expect(sanitizeHtml('<div style="color:red" data-x="1">x</div>')).toBe("<div>x</div>");
  });
});

describe("utils/security — isValidIpOrCidr", () => {
  it("接受合法 IPv4 / IPv6", () => {
    expect(isValidIpOrCidr("1.2.3.4")).toBe(true);
    expect(isValidIpOrCidr("255.255.255.255")).toBe(true);
    expect(isValidIpOrCidr("2001:db8::1")).toBe(true);
    expect(isValidIpOrCidr("::1")).toBe(true);
    expect(isValidIpOrCidr("::ffff:127.0.0.1")).toBe(true);
  });

  it("接受合法 CIDR（含边界 0 与最大前缀）", () => {
    expect(isValidIpOrCidr("10.0.0.0/8")).toBe(true);
    expect(isValidIpOrCidr("0.0.0.0/0")).toBe(true);
    expect(isValidIpOrCidr("1.2.3.4/32")).toBe(true);
    expect(isValidIpOrCidr("2001:db8::/32")).toBe(true);
    expect(isValidIpOrCidr("::/0")).toBe(true);
    expect(isValidIpOrCidr("::1/128")).toBe(true);
  });

  it("拒绝非法输入", () => {
    expect(isValidIpOrCidr("")).toBe(false);
    expect(isValidIpOrCidr("   ")).toBe(false);
    expect(isValidIpOrCidr("notanip")).toBe(false);
    expect(isValidIpOrCidr("1.2.3")).toBe(false);
    expect(isValidIpOrCidr("256.1.1.1")).toBe(false);
    expect(isValidIpOrCidr("1.2.3.4/33")).toBe(false);
    expect(isValidIpOrCidr("::1/129")).toBe(false);
    expect(isValidIpOrCidr("1.2.3.4/abc")).toBe(false);
    expect(isValidIpOrCidr("1.2.3.4/-1")).toBe(false);
    expect(isValidIpOrCidr("notanip/24")).toBe(false);
    expect(isValidIpOrCidr(null)).toBe(false);
    expect(isValidIpOrCidr(123)).toBe(false);
  });
});

describe("utils/security — isValidIpBlacklistJson", () => {
  it("空串与空数组合法", () => {
    expect(isValidIpBlacklistJson("")).toBe(true);
    expect(isValidIpBlacklistJson("[]")).toBe(true);
  });

  it("合法 IP/CIDR 数组通过", () => {
    expect(isValidIpBlacklistJson('["1.2.3.4","10.0.0.0/8","2001:db8::/32"]')).toBe(true);
  });

  it("非法 JSON / 非数组 / 含非法条目都拒绝", () => {
    expect(isValidIpBlacklistJson("not json")).toBe(false);
    expect(isValidIpBlacklistJson("{}")).toBe(false);
    expect(isValidIpBlacklistJson('"1.2.3.4"')).toBe(false);
    expect(isValidIpBlacklistJson('["1.2.3.4","bad-entry"]')).toBe(false);
    expect(isValidIpBlacklistJson('[1]')).toBe(false);
  });
});

describe("utils/security — checkIpBlacklist", () => {
  it("未配置黑名单时放行", async () => {
    expect(await checkIpBlacklist("1.2.3.4")).toBe(false);
  });

  it("精确匹配 IPv4", async () => {
    await setSetting("ip_blacklist", '["1.2.3.4"]');
    expect(await checkIpBlacklist("1.2.3.4")).toBe(true);
    expect(await checkIpBlacklist("1.2.3.5")).toBe(false);
  });

  it("IPv4-mapped IPv6 归一化后能命中 IPv4 条目", async () => {
    await setSetting("ip_blacklist", '["1.2.3.4"]');
    expect(await checkIpBlacklist("::ffff:1.2.3.4")).toBe(true);
  });

  it("IPv4 条目不会误伤 IPv6 地址（family 隔离，旧实现会命中全部）", async () => {
    await setSetting("ip_blacklist", '["1.2.3.4"]');
    expect(await checkIpBlacklist("2001:db8::1")).toBe(false);
  });

  it("CIDR 网段匹配", async () => {
    await setSetting("ip_blacklist", '["10.0.0.0/8"]');
    expect(await checkIpBlacklist("10.1.2.3")).toBe(true);
    expect(await checkIpBlacklist("10.255.255.255")).toBe(true);
    expect(await checkIpBlacklist("11.0.0.1")).toBe(false);
    expect(await checkIpBlacklist("::ffff:10.1.2.3")).toBe(true);
  });

  it("IPv6 CIDR 匹配", async () => {
    await setSetting("ip_blacklist", '["2001:db8::/32"]');
    expect(await checkIpBlacklist("2001:db8:1234::1")).toBe(true);
    expect(await checkIpBlacklist("2001:db9::1")).toBe(false);
  });

  it("非法条目（notanip/24）不会命中任何 IP", async () => {
    await setSetting("ip_blacklist", '["notanip/24"]');
    expect(await checkIpBlacklist("8.8.8.8")).toBe(false);
    expect(await checkIpBlacklist("1.2.3.4")).toBe(false);
  });

  it("损坏的 JSON 配置：放行而不是全站拦截", async () => {
    await setSetting("ip_blacklist", "{oops");
    expect(await checkIpBlacklist("1.2.3.4")).toBe(false);
  });

  it("非数组配置同样放行", async () => {
    await setSetting("ip_blacklist", '{"a":1}');
    expect(await checkIpBlacklist("1.2.3.4")).toBe(false);
  });

  it("条目中的空白与非法类型被跳过", async () => {
    await setSetting("ip_blacklist", '[" 1.2.3.4 ", "", 42, null]');
    expect(await checkIpBlacklist("1.2.3.4")).toBe(true);
    expect(await checkIpBlacklist("5.5.5.5")).toBe(false);
  });

  it("双方都不是合法 IP 时退化为字符串精确比较（如测试环境的 Unknown）", async () => {
    await setSetting("ip_blacklist", '["Unknown"]');
    expect(await checkIpBlacklist("Unknown")).toBe(true);
    expect(await checkIpBlacklist("unknown")).toBe(false);
  });
});

describe("utils/security — checkEmailBlacklist", () => {
  it("未配置时放行", async () => {
    expect(await checkEmailBlacklist("a@b.com")).toBe(false);
  });

  it("大小写不敏感匹配", async () => {
    await setSetting("email_blacklist", '["bad@example.com"]');
    expect(await checkEmailBlacklist("BAD@Example.COM")).toBe(true);
    expect(await checkEmailBlacklist("good@example.com")).toBe(false);
  });

  it("损坏或非数组配置放行", async () => {
    await setSetting("email_blacklist", "oops");
    expect(await checkEmailBlacklist("a@b.com")).toBe(false);
    await setSetting("email_blacklist", '{"a":1}');
    expect(await checkEmailBlacklist("a@b.com")).toBe(false);
  });
});

describe("utils/security — 评论状态", () => {
  it("默认（未配置）自动审核通过", async () => {
    expect(await getCommentStatus()).toBe("approved");
  });

  it("comment_auto_approve=false 时进入 pending", async () => {
    await setSetting("comment_auto_approve", "false");
    expect(await getCommentStatus()).toBe("pending");
  });

  it("非 false 的其他取值都视为开启自动审核", async () => {
    await setSetting("comment_auto_approve", "true");
    expect(await getCommentStatus()).toBe("approved");
    await setSetting("comment_auto_approve", "0");
    expect(await getCommentStatus()).toBe("approved");
  });

  it("isValidCommentStatus 只接受四个白名单值", () => {
    expect(COMMENT_STATUSES).toEqual(["pending", "approved", "rejected", "deleted"]);
    for (const status of COMMENT_STATUSES) expect(isValidCommentStatus(status)).toBe(true);
    expect(isValidCommentStatus("APPROVED")).toBe(false);
    expect(isValidCommentStatus("spam")).toBe(false);
    expect(isValidCommentStatus("")).toBe(false);
    expect(isValidCommentStatus(null)).toBe(false);
    expect(isValidCommentStatus(123)).toBe(false);
  });
});
