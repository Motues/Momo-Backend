import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken, checkContent, sanitizeHtml, sanitizeUrl } from "../../utils/security";
import { parseMarkdown } from "../../utils/markdown";

// 与公开提交路径一致的字段长度上限
const MAX_CONTENT = 2000;
const MAX_CONTENT_HTML = 50000;
const MAX_AUTHOR = 100;
const MAX_EMAIL = 254;
const MAX_URL = 500;

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json();
  const id = body?.id;

  if (!id) {
    return c.json({ code: 400, message: "Invalid request parameters" }, 400);
  }

  const allowed = ["author", "email", "content_text", "content_html", "url"];
  const fields: Record<string, any> = {};
  for (const fieldKey of allowed) {
    if (body[fieldKey] !== undefined) {
      fields[fieldKey] = body[fieldKey];
    }
  }

  if (Object.keys(fields).length === 0) {
    return c.json({ code: 400, message: "No fields to update" }, 400);
  }

  if (
    (fields.author !== undefined && typeof fields.author !== "string") ||
    (fields.email !== undefined && typeof fields.email !== "string") ||
    (fields.content_text !== undefined && typeof fields.content_text !== "string") ||
    (fields.content_html !== undefined && typeof fields.content_html !== "string") ||
    (fields.url !== undefined && typeof fields.url !== "string")
  ) {
    return c.json({ code: 400, message: "Invalid field type" }, 400);
  }

  // 净化：后台写路径必须与前台一致，否则可直接写入 javascript: 链接
  if (fields.author !== undefined) fields.author = checkContent(fields.author);
  if (fields.email !== undefined) fields.email = fields.email.trim();
  if (fields.url !== undefined) fields.url = sanitizeUrl(fields.url);
  if (fields.content_text !== undefined) fields.content_text = checkContent(fields.content_text);
  if (fields.content_html !== undefined) fields.content_html = sanitizeHtml(fields.content_html);

  // 只改了 content_text 但没传 content_html 时，自动渲染 markdown
  if (fields.content_text !== undefined && fields.content_html === undefined) {
    fields.content_html = sanitizeHtml(await parseMarkdown(fields.content_text));
  }

  const overLimit =
    (fields.author !== undefined && fields.author.length > MAX_AUTHOR) ||
    (fields.email !== undefined && fields.email.length > MAX_EMAIL) ||
    (fields.content_text !== undefined && fields.content_text.length > MAX_CONTENT) ||
    (fields.content_html !== undefined && fields.content_html.length > MAX_CONTENT_HTML) ||
    (fields.url !== undefined && fields.url.length > MAX_URL);
  if (overLimit) {
    return c.json({ code: 400, message: "Field length limit exceeded" }, 400);
  }

  // 存在性校验：否则 updateComment 更新后查不到记录会抛异常，
  // 被全局 onError 兜底成 500；语义上应为 404
  const existing = await CommentService.getCommentById(Number(id));
  if (!existing) {
    return c.json({ code: 404, message: "Comment not found" }, 404);
  }

  await CommentService.updateComment(id, fields);

  return c.json({ code: 200, message: "Comment updated" });
};
