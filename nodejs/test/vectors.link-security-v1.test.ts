import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DAY_MS,
  DEFAULT_LINK_DORMANT_DAYS,
  DEFAULT_LINK_DORMANT_NOTICE_ENABLED,
  DEFAULT_LINK_SECURITY_ENABLED,
  DEFAULT_LINK_SYNC_ENABLED,
  LINK_DORMANT_DAYS_KEY,
  LINK_DORMANT_NOTICE_ENABLED_KEY,
  LINK_SECURITY_ENABLED_KEY,
  LINK_SECURITY_ERRORS,
  LINK_SYNC_ENABLED_KEY,
  MAX_LINK_DORMANT_DAYS,
  MIN_LINK_DORMANT_DAYS,
  isLinkDormant,
  isLinkSecurityActiveStatus,
  isTrustActive,
  linkTrustKey,
  needDormantNotice,
  normalizeLinkSwitch,
  resolveDormantDays,
  resolveLinkSwitch,
  shouldSendDormantNotice,
  validateDormantDays,
  validateLinkSwitch,
} from "../src/utils/linkSecurity";

/**
 * 链接安全审查契约 v1 的跨语言固定向量验收。
 *
 * 两个开关都是 **fail-closed**（只有 `true` 才算开启），休眠判定是
 * 「严格大于 N 天」—— 边界差 1 毫秒都会改变结论，所以逐条钉死。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "link-security-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/link-security-v1 — 常量与错误文案", () => {
  it("键名、默认值与区间与 fixture 一致", () => {
    expect(LINK_SECURITY_ENABLED_KEY).toBe(fixture.keys.securityEnabled);
    expect(LINK_DORMANT_DAYS_KEY).toBe(fixture.keys.dormantDays);
    expect(LINK_SYNC_ENABLED_KEY).toBe(fixture.keys.syncEnabled);
    expect(LINK_DORMANT_NOTICE_ENABLED_KEY).toBe(fixture.keys.dormantNotice);
    expect(DEFAULT_LINK_SECURITY_ENABLED).toBe(fixture.defaults.securityEnabled);
    expect(DEFAULT_LINK_SYNC_ENABLED).toBe(fixture.defaults.syncEnabled);
    expect(DEFAULT_LINK_DORMANT_NOTICE_ENABLED).toBe(fixture.defaults.dormantNoticeEnabled);
    expect(DEFAULT_LINK_DORMANT_DAYS).toBe(fixture.defaults.dormantDays);
    expect(MIN_LINK_DORMANT_DAYS).toBe(fixture.limits.minDormantDays);
    expect(MAX_LINK_DORMANT_DAYS).toBe(fixture.limits.maxDormantDays);
    expect(DAY_MS).toBe(fixture.limits.dayMs);
  });

  it("四条错误文案与 fixture 逐字一致", () => {
    expect(LINK_SECURITY_ERRORS).toEqual(fixture.errors);
  });
});

describe("vectors/link-security-v1 — 开关（fail-closed）", () => {
  for (const value of fixture.switches.valid) {
    it(`写入合法：${JSON.stringify(value)}`, () => {
      expect(validateLinkSwitch(value, LINK_SECURITY_ENABLED_KEY)).toBeNull();
      expect(validateLinkSwitch(value, LINK_SYNC_ENABLED_KEY)).toBeNull();
      expect(validateLinkSwitch(value, LINK_DORMANT_NOTICE_ENABLED_KEY)).toBeNull();
    });
  }
  for (const value of fixture.switches.invalid) {
    it(`写入非法：${JSON.stringify(value)}`, () => {
      expect(validateLinkSwitch(value, LINK_SECURITY_ENABLED_KEY)).toBe(
        LINK_SECURITY_ERRORS.securityEnabled
      );
      expect(validateLinkSwitch(value, LINK_SYNC_ENABLED_KEY)).toBe(
        LINK_SECURITY_ERRORS.syncEnabled
      );
      expect(validateLinkSwitch(value, LINK_DORMANT_NOTICE_ENABLED_KEY)).toBe(
        LINK_SECURITY_ERRORS.dormantNoticeEnabled
      );
    });
  }

  it("读取只有 true 才算开启（其余一律关闭）", () => {
    expect(resolveLinkSwitch("true")).toBe("true");
    expect(resolveLinkSwitch(" TRUE ")).toBe("true");
    for (const value of ["", "   ", "false", "yes", "1", "on", null, undefined]) {
      expect(resolveLinkSwitch(value)).toBe("false");
    }
  });

  it("写入时存归一化的小写值", () => {
    expect(normalizeLinkSwitch(" TRUE ")).toBe("true");
    expect(normalizeLinkSwitch("False")).toBe("false");
  });
});

describe("vectors/link-security-v1 — 休眠天数", () => {
  for (const value of fixture.days.valid) {
    it(`写入合法：${JSON.stringify(value)}`, () => {
      expect(validateDormantDays(value)).toBeNull();
    });
  }
  for (const value of fixture.days.invalid) {
    it(`写入非法：${JSON.stringify(value)}`, () => {
      expect(validateDormantDays(value)).toBe(LINK_SECURITY_ERRORS.dormantDays);
    });
  }
  for (const item of fixture.days.resolve) {
    it(`读取归一化：${JSON.stringify(item.stored)} → ${item.expect}`, () => {
      expect(resolveDormantDays(item.stored)).toBe(item.expect);
    });
  }
});

describe("vectors/link-security-v1 — 休眠判定", () => {
  for (const item of fixture.dormant) {
    it(item.name, () => {
      expect(
        isLinkDormant({
          enabled: item.enabled,
          hasUrl: item.hasUrl,
          days: item.days,
          ageMs: item.ageMs,
        })
      ).toBe(item.expect);
    });
  }

  it("参与统计的状态口径：rejected / deleted 不算「来过」", () => {
    expect(isLinkSecurityActiveStatus("approved")).toBe(true);
    expect(isLinkSecurityActiveStatus("pending")).toBe(true);
    expect(isLinkSecurityActiveStatus("rejected")).toBe(false);
    expect(isLinkSecurityActiveStatus("deleted")).toBe(false);
  });
});

/**
 * 人工确认（管理员把休眠链接标为安全）的跨语言口径。
 *
 * 有效期落库为**绝对时间**，读取时「严格大于当前时间」才算有效；
 * 只接受 `YYYY-MM-DDTHH:mm:ss.sssZ` 这一种格式（JS 的 Date.parse 比 Go 宽容得多，
 * 不钉死就会两端给出不同答案）。
 */
describe("vectors/link-security-v1 — 人工确认有效期", () => {
  for (const item of fixture.trust.active) {
    it(item.name, () => {
      expect(isTrustActive(item.expiresAt, item.nowMs)).toBe(item.expect);
    });
  }

  it("fixture 的格式说明与实现一致（写入用 toISOString）", () => {
    expect(fixture.trust.expiresFormat).toContain("YYYY-MM-DDTHH:mm:ss.sssZ");
    expect(isTrustActive(new Date(fixture.trust.nowMs + 1000).toISOString(), fixture.trust.nowMs)).toBe(true);
  });
});

describe("vectors/link-security-v1 — 人工确认豁免休眠", () => {
  for (const item of fixture.trust.dormantOverride) {
    it(item.name, () => {
      expect(
        isLinkDormant({
          enabled: item.enabled,
          hasUrl: item.hasUrl,
          days: item.days,
          ageMs: item.ageMs,
          trusted: item.trusted,
        })
      ).toBe(item.expect);
    });
  }

  it("trusted 缺省（旧调用方）时与旧口径完全一致", () => {
    const base = { enabled: "true", hasUrl: true, days: "30", ageMs: 31 * 86400000 };
    expect(isLinkDormant(base)).toBe(true);
    expect(isLinkDormant({ ...base, trusted: false })).toBe(true);
    expect(isLinkDormant({ ...base, trusted: true })).toBe(false);
  });
});

/**
 * 休眠提醒的状态机（`needDormantNotice`）：什么时候该给评论者发提醒邮件。
 *
 * 本仓库没有定时任务，提醒是在读取公开评论列表时惰性检测的，因此「何时该发」必须有唯一口径，
 * 否则要么重复轰炸、要么永远不补发。锚点是「该邮箱最后一条评论的时间」。
 */
describe("vectors/link-security-v1 — 休眠提醒状态机", () => {
  for (const item of fixture.notice.needNotify) {
    it(item.name, () => {
      expect(
        needDormantNotice({
          dormant: item.dormant,
          hasRecord: item.hasRecord,
          recordExpired: item.recordExpired,
          recordLastCommentAt: item.recordLastCommentAt,
          currentLastCommentAt: item.currentLastCommentAt,
        })
      ).toBe(item.expect);
    });
  }
});

/**
 * 休眠提醒邮件的**发信前提**：总开关 + 提醒开关 + API 地址非空，三者缺一不发。
 *
 * 这也是后台「链接安全」页警告文案的口径来源：开关打开但 API 地址没填时，
 * 界面提示「即使这里打开，通知邮件也不会发出」，与后端判定完全一致。
 */
describe("vectors/link-security-v1 — 休眠提醒发信前提", () => {
  for (const item of fixture.notice.sendGate) {
    it(item.name, () => {
      expect(
        shouldSendDormantNotice({
          securityEnabled: item.securityEnabled,
          noticeEnabled: item.noticeEnabled,
          apiBaseUrl: item.apiBaseUrl,
        })
      ).toBe(item.expect);
    });
  }

  it("任一前提关闭时必然不发（穷举 2×2×2 种组合）", () => {
    for (const security of ["true", "false"]) {
      for (const notice of ["true", "false"]) {
        for (const baseUrl of ["https://api.example.com", ""]) {
          expect(
            shouldSendDormantNotice({
              securityEnabled: security,
              noticeEnabled: notice,
              apiBaseUrl: baseUrl,
            })
          ).toBe(security === "true" && notice === "true" && baseUrl !== "");
        }
      }
    }
  });
});

describe("vectors/link-security-v1 — 确认记录的查找键", () => {
  it("邮箱归一化后拼接，邮箱大小写/空白不影响命中", () => {
    expect(linkTrustKey("  A@B.com ", "https://a.example.com")).toBe(
      linkTrustKey("a@b.com", "https://a.example.com")
    );
  });

  it("不同网址不会互相命中（换了链接就要重新确认）", () => {
    expect(linkTrustKey("a@b.com", "https://a.example.com")).not.toBe(
      linkTrustKey("a@b.com", "https://b.example.com")
    );
  });

  it("拼接无歧义：邮箱里的分隔符不会与网址串到一起", () => {
    expect(linkTrustKey("a@b.com", "c")).not.toBe(linkTrustKey("a@b.comc", ""));
  });
});
