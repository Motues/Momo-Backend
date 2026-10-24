import { Hono } from "hono";
import {
  getCommentBySlug,
  postComment,
  verifyEmail,
  verifyChallenge,
  verifySolution,
  linkSyncConfirm,
  linkDormantNoticePage,
  linkDormantNoticeConfirm,
  linkDormantNoticeUpdate,
} from "../api/index"; // public
import {
  getAllComments,
  changeCommentStatus,
  updateComment,
  login,
  getStatsOverview,
  getUserList,
  getUserComments,
  addUserToBlacklist,
  removeUserFromBlacklist,
  addLinkTrust,
  removeLinkTrust,
  getSettings,
  updateSettings,
  changePassword,
  logout,
  testEmail,
  importComments,
  importSettings,
  exportSettings,
  exportComments,
  verifyOverview,
  verifyRecords,
  mailList,
  health,
} from "../api/index"; // admin
import fs from "fs";
import path from "path";

const router = new Hono();

// 健康检查（容器 HEALTHCHECK / 编排探针）：公开、无认证。
// 必须注册在静态文件与 SPA fallback 之前，否则会被 index.html 兜底。
router.get("/health", health);

// Public API
router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);
router.get("/api/verify-email/verify", verifyEmail);

// 链接安全审查：历史链接批量更新的确认链接（邮件里点开的纯链接）
router.get("/api/link-sync/confirm", linkSyncConfirm);

// 链接安全审查：休眠链接提醒页（邮件里点开的纯链接；确认仍在用 / 提交新链接）
router.get("/api/link-dormant/notice", linkDormantNoticePage);
router.post("/api/link-dormant/confirm", linkDormantNoticeConfirm);
router.post("/api/link-dormant/update", linkDormantNoticeUpdate);

// 无感验证（Turnstile 风格）
router.post("/api/verify/challenge", verifyChallenge);
router.post("/api/verify/solution", verifySolution);

// Admin settings
router.get("/admin/settings", getSettings);
router.put("/admin/settings", updateSettings);
router.post("/admin/settings/test-email", testEmail);
router.put("/admin/password", changePassword);
router.post("/admin/logout", logout);

// Admin comments
router.get("/admin/comments/list", getAllComments);
router.put("/admin/comments/status", changeCommentStatus);
router.put("/admin/comments/edit", updateComment);
router.post("/admin/login", login);

// Admin stats
router.get("/admin/stats/overview", getStatsOverview);
router.get("/admin/stats/users", getUserList);
router.get("/admin/stats/users/comments", getUserComments);

// Admin verify records（认证记录：无感验证的签发/通过/失败统计与明细）
router.get("/admin/verify/overview", verifyOverview);
router.get("/admin/verify/records", verifyRecords);

// Admin 邮件管理（外发邮件日志，默认保留 30 天）
router.get("/admin/mails", mailList);

// Admin user blacklist
router.post("/admin/users/blacklist", addUserToBlacklist);
router.delete("/admin/users/blacklist", removeUserFromBlacklist);

// Admin 休眠链接的人工确认（有效期 = 确认时的 link_dormant_days 天）
router.post("/admin/links/trust", addLinkTrust);
router.delete("/admin/links/trust", removeLinkTrust);

// Admin data import/export
router.post("/admin/data/import/comments", importComments);
router.post("/admin/data/import/settings", importSettings);
router.get("/admin/data/export/settings", exportSettings);
router.get("/admin/data/export/comments", exportComments);

// SPA fallback — 管理面板前端路由
router.get("/*", async (c) => {
  const htmlPath = path.join(process.cwd(), "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");
  return c.html(html);
});

export default router;
