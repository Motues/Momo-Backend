import type koa from "koa";
import CommentService  from "../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../utils/url";
import { getResponseComment } from "../utils/content";


export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
    const postSlug =  getQueryString(ctx.query.post_slug as string, "");
    const page = getQueryNumber(ctx.query.page as string, 1);
    const limit = getQueryNumber(ctx.query.limit as string, 20);
    const nested = getQueryBoolean(ctx.query.nested as string, true);

    // console.log(postSlug);
    // console.log("有新的查询")

    if (postSlug === "") {
        ctx.status = 400;
        ctx.body = { error: "Invalid post_slug" };
        return;
    }

    const comments = await CommentService.getCommentBySlug(postSlug);
    // console.log(comments);
    ctx.body = await getResponseComment(comments, page, limit, nested);
}