/**
 * 用户列表 / 用户详情共用的「个人网站链接」判定。
 *
 * 状态含义（与 doc/link_security.md 对齐）：
 * - 'unknown' 后端压根没下发 url 字段（老版本后端）—— 与「没有链接」含义不同，必须区分展示
 * - 'none'    没有留下过链接（字段在、但值为空）
 * - 'trusted' 管理员人工确认过该链接且未过期（后端同时会把 urlDormant 置 false）
 * - 'dormant' 链接休眠（仅在 url 非空且功能开启时后端才置 true）
 * - 'normal'  正常链接
 */

export const LINK_UNKNOWN_TITLE = '后端版本过旧，未下发该字段（请升级/重启后端）';

const formatDateTime = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN');
};

export const linkStatus = (user) => {
  if (!user) return 'unknown';
  if (user.url === undefined || user.url === null) return 'unknown';
  if (!user.url) return 'none';
  if (user.urlTrustedUntil) return 'trusted';
  return user.urlDormant ? 'dormant' : 'normal';
};

/**
 * 「已确认」的说明文案：区分「管理员人工确认」与「评论者本人从提醒邮件里确认仍在用」
 * （后端用 urlTrustedSource 区分，老后端不下发该字段时按人工确认展示）。
 */
export const trustTitle = (user) => {
  const who = user?.urlTrustedSource === 'self' ? '本人已确认仍在使用' : '已人工确认安全';
  return `${who}，${formatDateTime(user?.urlTrustedUntil)} 到期；到期后若无新评论会自动恢复休眠`;
};
