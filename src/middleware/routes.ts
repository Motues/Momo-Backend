import Router from"@koa/router";
import getCommentBySlug from "../api/getCommentBySlug";
import postComment from "../api/postComment";


const router = new Router();

router.get("/api/comments", getCommentBySlug);

router.post("/api/comments", postComment);

export default router;