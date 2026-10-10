import { Hono } from "hono";
import { getCommentBySlug, postComment, verifyEmail, verifyChallenge, verifySolution } from "../api/index"; // public
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
} from "../api/index"; // admin
import fs from "fs";
import path from "path";

const router = new Hono();

// Public API
router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);
router.get("/api/verify-email/verify", verifyEmail);

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

// Admin user blacklist
router.post("/admin/users/blacklist", addUserToBlacklist);
router.delete("/admin/users/blacklist", removeUserFromBlacklist);

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
