import Router from"@koa/router";
import { getCommentBySlug, postComment } from "../api/index" // public
import { deleteComment, getAllComments, changeCommentStatus, login } from "../api/index" // admin
import fs from "fs";
import path from "path";


const router = new Router();

router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);

router.delete("/admin/comments/delete", deleteComment);
router.get("/admin/comments/list", getAllComments);
router.put("/admin/comments/status", changeCommentStatus);
router.post("/admin/login", login);

router.get("/", async (ctx) => {
  ctx.type = "text/html";
  ctx.body = fs.createReadStream(path.join(__dirname, "../../public/index.html"));
});

export default router;