import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { parseMarkdown } from '../../utils/markdown';
import { checkContent, sanitizeUrl, MAX_CONTENT, MAX_CONTENT_HTML, MAX_AUTHOR, MAX_EMAIL, MAX_URL } from '../../utils/security';

export const updateComment = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json();
  const { id, ...fields } = body || {};

  if (!id) {
    return c.json({
      code: 400,
      message: "Invalid request parameters"
    }, 400);
  }

  const allowed = ['author', 'email', 'content_text', 'url'];

  for (const key of allowed) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') {
      return c.json({ code: 400, message: "Invalid field type" }, 400);
    }
  }

  // 后台写路径必须与前台一致地净化，否则可直接写入 javascript: 链接
  if (fields.author !== undefined) fields.author = checkContent(fields.author);
  if (fields.email !== undefined) fields.email = fields.email.trim();
  if (fields.url !== undefined) fields.url = sanitizeUrl(fields.url);
  if (fields.content_text !== undefined) fields.content_text = checkContent(fields.content_text);

  if (
    (fields.author !== undefined && fields.author.length > MAX_AUTHOR) ||
    (fields.email !== undefined && fields.email.length > MAX_EMAIL) ||
    (fields.content_text !== undefined && fields.content_text.length > MAX_CONTENT) ||
    (fields.url !== undefined && fields.url.length > MAX_URL)
  ) {
    return c.json({ code: 400, message: "Field length limit exceeded" }, 400);
  }

  // content_html 永不采信客户端输入：
  // Workers 运行时没有 DOM，无法执行完整的 HTML 净化，因此始终由正文重新渲染。
  let sourceText: string | undefined = fields.content_text;
  if (sourceText === undefined) {
    const row = await c.env.MOMO_DB.prepare(
      "SELECT content_text FROM Comment WHERE id = ?"
    ).bind(id).first<{ content_text: string }>();
    sourceText = row?.content_text;
  }
  if (sourceText !== undefined) {
    const rendered = parseMarkdown(sourceText);
    if (rendered.length > MAX_CONTENT_HTML) {
      return c.json({ code: 400, message: "Field length limit exceeded" }, 400);
    }
    fields.content_html = rendered;
  }

  const settable = [...allowed, 'content_html'];
  const sets: string[] = [];
  const values: any[] = [];

  for (const key of settable) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (sets.length === 0) {
    return c.json({
      code: 400,
      message: "No fields to update"
    }, 400);
  }

  values.push(id);
  const query = `UPDATE Comment SET ${sets.join(', ')} WHERE id = ?`;
  const { success } = await c.env.MOMO_DB.prepare(query).bind(...values).run();

  if (!success) {
    return c.json({
      code: 500,
      message: "Update failed"
    }, 500);
  }

  return c.json({
    code: 200,
    message: "Comment updated"
  });
};
