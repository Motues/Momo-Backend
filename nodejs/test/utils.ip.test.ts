import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import {
  getClientIP,
  applyTrustProxySetting,
  isTrustProxyEnabled,
  hasTrustProxyEnvOverride,
  refreshTrustProxy,
  initTrustProxy,
} from "../src/utils/ip";
import { setSetting } from "../src/utils/settings";

/** 用最小 Hono 应用观察 getClientIP 的解析结果 */
async function ipFrom(requestHeaders: Record<string, string>): Promise<string> {
  const app = new Hono();
  app.get("/ip", (c) => c.json({ ip: getClientIP(c) }));
  const res = await app.request("/ip", { headers: requestHeaders });
  const body = (await res.json()) as { ip: string };
  return body.ip;
}

afterEach(() => {
  delete process.env.TRUST_PROXY;
  applyTrustProxySetting("false");
});

describe("utils/ip — TRUST_PROXY 关闭（默认）", () => {
  it("所有代理头都被忽略，攻击者无法伪造来源 IP", async () => {
    applyTrustProxySetting("false");
    expect(
      await ipFrom({
        "cf-connecting-ip": "9.9.9.9",
        "x-real-ip": "8.8.8.8",
        "x-forwarded-for": "7.7.7.7",
      })
    ).toBe("Unknown");
  });

  it("无连接信息时返回 Unknown", async () => {
    applyTrustProxySetting("false");
    expect(await ipFrom({})).toBe("Unknown");
  });
});

describe("utils/ip — TRUST_PROXY 开启", () => {
  it("优先级 cf-connecting-ip > x-real-ip > x-forwarded-for", async () => {
    applyTrustProxySetting("true");
    expect(
      await ipFrom({
        "cf-connecting-ip": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
        "x-forwarded-for": "3.3.3.3",
      })
    ).toBe("1.1.1.1");

    expect(await ipFrom({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })).toBe("2.2.2.2");
    expect(await ipFrom({ "x-forwarded-for": "3.3.3.3" })).toBe("3.3.3.3");
  });

  it("x-forwarded-for 多跳时取最右一跳（客户端伪造的前置条目无效）", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "x-forwarded-for": "6.6.6.6, 5.5.5.5, 4.4.4.4" })).toBe("4.4.4.4");
    expect(await ipFrom({ "x-forwarded-for": "1.2.3.4,203.0.113.7" })).toBe("203.0.113.7");
  });

  it("最右一跳非法时继续向左寻找合法 IP", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "x-forwarded-for": "1.1.1.1, garbage, " })).toBe("1.1.1.1");
    expect(await ipFrom({ "x-forwarded-for": "1.1.1.1,,2.2.2.2" })).toBe("2.2.2.2");
  });

  it("头部值非法时不作为 IP 使用", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "not-an-ip" })).toBe("Unknown");
    expect(await ipFrom({ "cf-connecting-ip": "<script>alert(1)</script>" })).toBe("Unknown");
    expect(await ipFrom({ "cf-connecting-ip": "999.1.1.1" })).toBe("Unknown");
  });

  it("空白值被跳过并回退到下一个来源", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "   ", "x-real-ip": "2.2.2.2" })).toBe("2.2.2.2");
    expect(await ipFrom({ "cf-connecting-ip": "" })).toBe("Unknown");
  });

  it("去除首尾空白", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "  9.9.9.9  " })).toBe("9.9.9.9");
  });

  it("IPv4-mapped IPv6 归一化为 IPv4", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "::ffff:127.0.0.1" })).toBe("127.0.0.1");
    expect(await ipFrom({ "cf-connecting-ip": "::FFFF:1.2.3.4" })).toBe("1.2.3.4");
  });

  it("带端口的地址会剥离端口", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "1.2.3.4:5678" })).toBe("1.2.3.4");
    expect(await ipFrom({ "cf-connecting-ip": "[::1]:1234" })).toBe("::1");
    expect(await ipFrom({ "cf-connecting-ip": "[2001:db8::1]" })).toBe("2001:db8::1");
  });

  it("纯 IPv6 原样返回", async () => {
    applyTrustProxySetting("true");
    expect(await ipFrom({ "cf-connecting-ip": "2001:db8::1" })).toBe("2001:db8::1");
    expect(await ipFrom({ "cf-connecting-ip": "::1" })).toBe("::1");
  });
});

describe("utils/ip — 环境变量 TRUST_PROXY 覆盖", () => {
  it("环境变量为真值时强制开启，覆盖页面设置", async () => {
    applyTrustProxySetting("false");
    process.env.TRUST_PROXY = "true";
    expect(hasTrustProxyEnvOverride()).toBe(true);
    expect(isTrustProxyEnabled()).toBe(true);
    expect(await ipFrom({ "cf-connecting-ip": "1.1.1.1" })).toBe("1.1.1.1");
  });

  it("环境变量为假值时强制关闭", async () => {
    applyTrustProxySetting("true");
    process.env.TRUST_PROXY = "false";
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("true/1/yes/on 视为开启，false/0/no/off 视为关闭（大小写不敏感）", async () => {
    for (const raw of ["true", "1", "YES", "On", " true "]) {
      applyTrustProxySetting("false");
      process.env.TRUST_PROXY = raw;
      expect(isTrustProxyEnabled(), raw).toBe(true);
    }
    for (const raw of ["false", "0", "NO", "off"]) {
      applyTrustProxySetting("true");
      process.env.TRUST_PROXY = raw;
      expect(isTrustProxyEnabled(), raw).toBe(false);
    }
  });

  it("无法识别的取值不构成覆盖，回退到页面设置", async () => {
    process.env.TRUST_PROXY = "maybe";
    expect(hasTrustProxyEnvOverride()).toBe(false);
    applyTrustProxySetting("true");
    expect(isTrustProxyEnabled()).toBe(true);
    applyTrustProxySetting("false");
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("未设置环境变量时不构成覆盖", () => {
    expect(hasTrustProxyEnvOverride()).toBe(false);
  });
});

describe("utils/ip — 设置刷新与立即生效", () => {
  it("applyTrustProxySetting 立即改变生效值", () => {
    applyTrustProxySetting("true");
    expect(isTrustProxyEnabled()).toBe(true);
    applyTrustProxySetting("false");
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("refreshTrustProxy 从 Settings 表读取开关", async () => {
    await setSetting("trust_proxy", "true");
    await refreshTrustProxy();
    expect(isTrustProxyEnabled()).toBe(true);

    await setSetting("trust_proxy", "false");
    await refreshTrustProxy();
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("Settings 表中的非 true 值一律视为关闭", async () => {
    await setSetting("trust_proxy", "1");
    await refreshTrustProxy();
    expect(isTrustProxyEnabled()).toBe(false);
    await setSetting("trust_proxy", "TRUE");
    await refreshTrustProxy();
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("initTrustProxy 可正常预加载", async () => {
    await setSetting("trust_proxy", "true");
    await initTrustProxy();
    expect(isTrustProxyEnabled()).toBe(true);
  });

  it("环境变量覆盖时忽略 Settings 表的值", async () => {
    await setSetting("trust_proxy", "false");
    process.env.TRUST_PROXY = "true";
    await refreshTrustProxy();
    expect(isTrustProxyEnabled()).toBe(true);
  });
});
