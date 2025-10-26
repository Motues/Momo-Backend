import Router from"@koa/router";
import getCommentBySlug from "../api/getCommentBySlug";
import postComment from "../api/postComment";
import deleteComment from "../api/deleteComment";
import getAllComments from "../api/getAllComments";


const router = new Router();

router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);

router.delete("/admin/comments/delete", deleteComment);
router.get("/admin/comments/list", getAllComments);

export default router;