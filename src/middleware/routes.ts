import Router from"@koa/router";
import { getCommentBySlug, postComment } from "../api/index" // public
import { deleteComment, getAllComments, changeCommentStatus, login } from "../api/index" // admin


const router = new Router();

router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);

router.delete("/admin/comments/delete", deleteComment);
router.get("/admin/comments/list", getAllComments);
router.put("/admin/comments/status", changeCommentStatus);
router.post("/admin/login", login);

export default router;