/**
 * 系统设置导出（`GET /admin/data/export/settings`）的「完整快照」口径。
 *
 * 背景：导出过去只输出**数据库里真实存在的键**，于是从没在面板里保存过的设置
 * （典型是表情：`emoji_*` 一直走默认值）在导出文件里完全看不到 —— 备份看不出
 * 表情到底开没开、来源是什么。现在改成：先铺一遍全部可写设置键的**生效默认值**，
 * 再用库里的值覆盖，最后把敏感键置空。
 *
 * 口径的唯一事实来源是 `doc/vectors/settings-export-v1.json`（三端读同一份）：
 *  - `defaults`：50 个键各自的生效默认值（= 各端读取该键时的实际默认行为，
 *    **不是**面板输入框的初值，例如 `email_secure` 缺省时后端视为 `"false"`）；
 *  - `sensitiveBlanked`：导出时统一置空、并登记进 `sensitiveOmitted` 的键。
 *
 * 表情是唯一的跨键回落：`emoji_cdn_urls` 为空时实际生效的是「旧单地址键
 * `emoji_cdn_url` → 内置默认源」。所以缺 `emoji_cdn_urls` 时导出**解析后的生效列表**，
 * 直接写默认源会把旧的单地址覆盖掉（导入时列表优先）。
 *
 * 导入端不变：仍只写文件里出现的键（`doc/api.md`「导入系统设置」）。
 */
import { DEFAULT_EMOJI_CDN_URL, resolveEmojiConfigs } from "./emoji";

/** 导出时置空的敏感键（与向量文件的 sensitiveBlanked 一致） */
export const SETTINGS_EXPORT_SENSITIVE_KEYS: readonly string[] = [
  "email_password",
  "admin_comment_key",
];

/**
 * 全部可写设置键的生效默认值。
 *
 * 新增可写设置键时，必须同时更新这里与 `doc/vectors/settings-export-v1.json`、
 * Go 的 `settings_export.go`、Worker 的 `utils/settingsExport.ts`。
 */
export const SETTINGS_EXPORT_DEFAULTS: Readonly<Record<string, string>> = {
  site_name: "Momo Blog",
  admin_email: "",
  admin_emails: "[]",
  notify_email: "",
  // 与 DEFAULT_ADMIN_NAME 一致：缺省时登录身份就是 momo
  admin_name: "momo",
  smtp_host: "",
  // 缺省端口：发信时回落 465
  smtp_port: "465",
  email_user: "",
  email_password: "",
  // 缺省视为「不使用 SSL/TLS」（`=== "true"` 才开启），不是面板初值的 true
  email_secure: "false",
  allow_origin: "",
  email_enabled: "true",
  reply_template: "",
  notification_template: "",
  comment_auto_approve: "true",
  comment_spam_keywords: "[]",
  comment_spam_max_links: "0",
  comment_spam_min_length: "0",
  comment_spam_duplicate_window: "0",
  ip_blacklist: "[]",
  email_blacklist: "[]",
  blogger_badge_enabled: "false",
  blogger_badge_text: "",
  placeholder_name: "",
  placeholder_email: "",
  placeholder_content: "",
  placeholder_url: "",
  admin_comment_key: "",
  admin_comment_key_enabled: "false",
  email_verify_enabled: "false",
  verify_base_url: "",
  // 外发邮件日志保留天数：0 = 永久保留
  mail_log_retention_days: "30",
  comment_verify_enabled: "false",
  // HashWX 默认总工作量（HASHWX_DEFAULT_DIFFICULTY）
  comment_verify_difficulty: "1000000",
  comment_verify_instr_enabled: "false",
  comment_verify_block_automated: "false",
  comment_verify_domain_enabled: "false",
  comment_verify_retention_days: "30",
  comment_verify_log_challenge: "true",
  trust_proxy: "false",
  // 表情：读取路径 fail-open 为启用，来源为空时回落内置默认源（见 doc/emoji.md）
  emoji_enabled: "true",
  emoji_cdn_url: "",
  emoji_cdn_urls: JSON.stringify([DEFAULT_EMOJI_CDN_URL]),
  // 评论区头像来源（见 doc/avatar.md）：缺省走内置默认源
  avatar_enabled: "true",
  avatar_source: "default",
  avatar_custom_url: "",
  // 链接安全审查（见 doc/link_security.md）
  link_security_enabled: "false",
  link_dormant_days: "30",
  link_sync_enabled: "false",
  link_dormant_notice_enabled: "false",
};

export interface ExportedSettings {
  /** 完整快照：全部 50 个键，敏感键为空串 */
  settings: Record<string, string>;
  /** 库里确实存过、且会被置空的敏感键 */
  sensitiveOmitted: string[];
}

const hasOwn = (record: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/**
 * 把库里的设置合成一份导出快照。
 *
 * @param stored `getAllSettings()` 的结果（只含库里真实存在的键）
 */
export function buildExportedSettings(stored: Record<string, string> = {}): ExportedSettings {
  const settings: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(SETTINGS_EXPORT_DEFAULTS)) {
    settings[key] = hasOwn(stored, key) ? stored[key] : fallback;
  }

  // 表情来源列表：缺键时导出「解析后的生效列表」，保住旧单地址键的回落语义
  if (!hasOwn(stored, "emoji_cdn_urls")) {
    const { urls } = resolveEmojiConfigs(
      undefined,
      stored["emoji_cdn_url"],
      stored["emoji_enabled"]
    );
    settings.emoji_cdn_urls = JSON.stringify(urls);
  }

  const sensitiveOmitted: string[] = [];
  for (const key of SETTINGS_EXPORT_SENSITIVE_KEYS) {
    // 库里存过非空值才算「被置空」；缺键或本来就是空串不登记
    if (hasOwn(stored, key) && stored[key] !== "") {
      sensitiveOmitted.push(key);
    }
    settings[key] = "";
  }

  return { settings, sensitiveOmitted };
}
