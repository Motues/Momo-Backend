import { describe, it, expect } from "vitest";
import {
  getSetting,
  setSetting,
  getAllSettings,
  isDefaultAdmin,
  checkAdminCredentials,
  changeAdminPassword,
  DEFAULT_ADMIN_NAME,
  DEFAULT_ADMIN_PASSWORD,
} from "../src/utils/settings";

describe("utils/settings — 键值读写", () => {
  it("未配置的键返回 null", async () => {
    expect(await getSetting("never_set_key")).toBeNull();
  });

  it("setSetting 首次写入即可读回", async () => {
    await setSetting("site_name", "我的博客");
    expect(await getSetting("site_name")).toBe("我的博客");
  });

  it("重复写入为覆盖更新（不会产生重复行）", async () => {
    await setSetting("blogger_badge_text", "第一次");
    await setSetting("blogger_badge_text", "第二次");
    expect(await getSetting("blogger_badge_text")).toBe("第二次");
    const all = await getAllSettings();
    expect(Object.keys(all).filter((k) => k === "blogger_badge_text")).toHaveLength(1);
  });

  it("空字符串会被保存并读回（与 null 区分）", async () => {
    await setSetting("placeholder_name", "");
    expect(await getSetting("placeholder_name")).toBe("");
  });

  it("getAllSettings 返回全部键值映射", async () => {
    await setSetting("k1", "v1");
    await setSetting("k2", "v2");
    const all = await getAllSettings();
    expect(all.k1).toBe("v1");
    expect(all.k2).toBe("v2");
    expect(all.site_name).toBe("我的博客");
  });
});

describe("utils/settings — 默认管理员判定", () => {
  it("未改密时 isDefaultAdmin 为 true", async () => {
    expect(await isDefaultAdmin()).toBe(true);
  });

  it("password_changed=true 后 isDefaultAdmin 为 false", async () => {
    await setSetting("password_changed", "true");
    expect(await isDefaultAdmin()).toBe(false);
    await setSetting("password_changed", "false");
    expect(await isDefaultAdmin()).toBe(true);
  });
});

describe("utils/settings — checkAdminCredentials", () => {
  it("未配置时接受默认凭据 momo/momo", async () => {
    expect(DEFAULT_ADMIN_NAME).toBe("momo");
    expect(DEFAULT_ADMIN_PASSWORD).toBe("momo");
    expect(await checkAdminCredentials("momo", "momo")).toBe(true);
  });

  it("错误用户名或密码被拒（大小写敏感）", async () => {
    expect(await checkAdminCredentials("momo", "wrong")).toBe(false);
    expect(await checkAdminCredentials("admin", "momo")).toBe(false);
    expect(await checkAdminCredentials("MOMO", "momo")).toBe(false);
    expect(await checkAdminCredentials("", "")).toBe(false);
  });

  it("只配置了 admin_name 时仍回退到默认凭据（需两者同时存在）", async () => {
    await setSetting("admin_name", "someone");
    expect(await checkAdminCredentials("momo", "momo")).toBe(true);
    expect(await checkAdminCredentials("someone", "momo")).toBe(false);
  });

  it("数据库中存明文时自动升级为 bcrypt 哈希", async () => {
    await setSetting("admin_name", "alice");
    await setSetting("admin_password", "plain-secret");
    expect(await checkAdminCredentials("alice", "plain-secret")).toBe(true);

    const stored = await getSetting("admin_password");
    expect(stored).not.toBe("plain-secret");
    expect(String(stored).startsWith("$2")).toBe(true);
  });

  it("哈希分支仍然校验用户名（不能拿正确密码换用户名登录）", async () => {
    await setSetting("admin_name", "alice");
    await setSetting("admin_password", "plain-secret");
    await checkAdminCredentials("alice", "plain-secret"); // 触发升级

    expect(await checkAdminCredentials("alice", "plain-secret")).toBe(true);
    expect(await checkAdminCredentials("bob", "plain-secret")).toBe(false);
    expect(await checkAdminCredentials("alice", "wrong-password")).toBe(false);
  });

  it("数据库中存明文但用户名不匹配时直接拒绝（不升级哈希）", async () => {
    await setSetting("admin_name", "alice");
    await setSetting("admin_password", "plain-secret");
    expect(await checkAdminCredentials("bob", "plain-secret")).toBe(false);
    // 没有触发自动升级：密码仍是明文
    expect(await getSetting("admin_password")).toBe("plain-secret");
  });

  it("数据库中直接存 bcrypt 哈希也能通过校验", async () => {
    const { hash, genSalt } = await import("bcryptjs");
    const hashed = await hash("hashed-secret", await genSalt(10));
    await setSetting("admin_name", "carol");
    await setSetting("admin_password", hashed);
    expect(await checkAdminCredentials("carol", "hashed-secret")).toBe(true);
    expect(await checkAdminCredentials("carol", "other")).toBe(false);
    expect(await checkAdminCredentials("dave", "hashed-secret")).toBe(false);
  });
});

describe("utils/settings — changeAdminPassword", () => {
  it("改密后写入哈希与 password_changed 标记", async () => {
    await changeAdminPassword("newadmin", "newpassword");

    expect(await getSetting("admin_name")).toBe("newadmin");
    expect(String(await getSetting("admin_password")).startsWith("$2")).toBe(true);
    expect(await getSetting("admin_password")).not.toBe("newpassword");
    expect(await getSetting("password_changed")).toBe("true");
    expect(await isDefaultAdmin()).toBe(false);

    expect(await checkAdminCredentials("newadmin", "newpassword")).toBe(true);
    expect(await checkAdminCredentials("momo", "momo")).toBe(false);
    expect(await checkAdminCredentials("newadmin", "momo")).toBe(false);
  });

  it("改密后密码哈希逐次随机（同一密码两次结果不同）", async () => {
    await changeAdminPassword("a", "samepassword");
    const first = await getSetting("admin_password");
    await changeAdminPassword("a", "samepassword");
    const second = await getSetting("admin_password");
    expect(first).not.toBe(second);
    expect(await checkAdminCredentials("a", "samepassword")).toBe(true);
  });
});
